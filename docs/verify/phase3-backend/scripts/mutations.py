"""Phase 3 backend mutation run (B10, B11, seed on demand, hub dir).

From packages/hub:  python -I ../../docs/verify/phase3-backend/scripts/mutations.py [first mutant number, default 1]
Each guarded line is broken in turn, the listed test files run, and the file is restored byte for byte. A mutant is
"caught" when vitest exits non-zero.
"""
import pathlib
import subprocess
import sys

HUB = pathlib.Path.cwd()
assert (HUB / "src" / "hub.ts").exists(), "run from packages/hub"

ROUTE = ["src/api/hostStubs.test.ts"]
SVC = ["src/services/RemoteProjects.test.ts"]
BOTS = ["src/agent/stubsNeverReachBots.test.ts"]
NOTE = ["src/services/UsageTracker.test.ts", "src/api/usageNote.test.ts"]
SEED = ["src/api/gameSeedOnDemand.test.ts", "src/api/projects.test.ts"]
CFG = ["src/config.test.ts"]

MUTANTS = [
    # B10: who may write
    ("B10 handler: a password session may write", "src/api/projects.ts", "if (p?.kind !== 'hub' || p.sessionId) return", "if (p?.kind !== 'hub') return", ROUTE),
    ("B10 handler: no principal check", "src/api/projects.ts", "if (p?.kind !== 'hub' || p.sessionId) return", "if (false) return", ROUTE),
    ("B10 handler: any host name", "src/api/projects.ts", "if (!(REMOTE_HOST_IDS as readonly string[]).includes(host)) return", "if (host === '') return", ROUTE),
    ("B10 handler: PUT only", "src/api/projects.ts", "if (method !== 'PUT') return send(res, 405", "if (method === 'PATCH') return send(res, 405", ROUTE),
    # B10: what may be written
    ("B10 schema: 500 cap", "../shared/src/hosts.ts", "z.array(ProjectStubInputSchema).max(MAX_STUBS_PER_HOST).optional()", "z.array(ProjectStubInputSchema).optional()", ROUTE),
    ("B10 schema: slug rule", "../shared/src/hosts.ts", ".regex(PROJECT_SLUG_RE, 'not a project slug')", "", ROUTE),
    ("B10 schema: slug length", "../shared/src/hosts.ts", "slug: z.string().min(1).max(40)", "slug: z.string().min(1)", ROUTE),
    ("B10 schema: name rule (project names)", "../shared/src/hosts.ts", "export const ProjectNameSchema = z.string().trim().min(1).max(60);", "export const ProjectNameSchema = z.string();", ROUTE),
    ("B10 schema: control and bidi characters", "../shared/src/hosts.ts", "name: ProjectNameSchema.refine((n) => !UNSAFE_TEXT.test(n), 'has control characters'),", "name: ProjectNameSchema,", ROUTE),
    ("B10 schema: no extra fields", "../shared/src/hosts.ts", "  name: ProjectNameSchema.refine((n) => !UNSAFE_TEXT.test(n), 'has control characters'),\n}).strict();", "  name: ProjectNameSchema.refine((n) => !UNSAFE_TEXT.test(n), 'has control characters'),\n});", ROUTE),
    ("B10 schema: connected required", "../shared/src/hosts.ts", "  connected: z.boolean(),\n  projects:", "  connected: z.boolean().optional().default(true),\n  projects:", ROUTE),
    # B10: storage and events
    ("B10 store: connected-only keeps stubs", "src/services/RemoteProjects.ts", "      if (!input.projects) return;\n", "", ROUTE + SVC),
    ("B10 store: replace, not append", "src/services/RemoteProjects.ts", "      this.deps.db.run('DELETE FROM project_stubs WHERE host=?', host);\n", "", ROUTE + SVC),
    ("B10 store: one transaction", "src/services/RemoteProjects.ts", "    this.deps.db.tx(() => {", "    ((f: () => void) => f())(() => {", SVC),
    ("B10 event: hosts.changed", "src/api/projects.ts", "    events.emitEvent({ type: 'hosts.changed' });\n", "", ROUTE),
    ("B10 GET: stubs listed", "src/api/projects.ts", "...(remote?.list() ?? [])]", "]", ROUTE),
    ("B10 GET: local tagged pc", "src/api/projects.ts", "({ ...p, host: 'pc' as const })", "({ ...p })", ROUTE),
    # B10: stubs never reach a bot
    ("B10 bots: knownSlugs includes stubs", "src/services/ProjectService.ts", "return this.db.all('SELECT slug FROM projects').map(", "return this.db.all('SELECT slug FROM projects UNION SELECT slug FROM project_stubs').map(", BOTS),
    ("B10 bots: list includes stubs", "src/services/ProjectService.ts", "return this.db.all('SELECT * FROM projects ORDER BY name').map(", "return this.db.all(\"SELECT slug, name, room_id, template_version, kind, created_at FROM projects UNION ALL SELECT slug, name, NULL, NULL, NULL, seen_at FROM project_stubs ORDER BY name\").map(", BOTS),
    ("B10 bots: a bot path imports RemoteProjects", "src/agent/BotRunner.ts", "import type { ProjectService } from '../services/ProjectService.js';", "import type { ProjectService } from '../services/ProjectService.js';\nimport type { RemoteProjects as _R } from '../services/RemoteProjects.js';\nexport type _Leak = _R;", BOTS),
    # B11
    ("B11: note only when a server is known", "src/services/UsageTracker.ts", "return this.deps.serverHostKnown?.() ? SHARED_SUBSCRIPTION_NOTE : null;", "return SHARED_SUBSCRIPTION_NOTE;", NOTE),
    ("B11: route leaves the field out when null", "src/api/rest.ts", "    if (note) res.subscriptionNote = note;", "    res.subscriptionNote = note as string;", NOTE),
    ("B11: hub wires the known host", "src/hub.ts", "serverHostKnown: () => remoteProjects.known('server')", "serverHostKnown: () => false", NOTE),
    # Seed on demand
    ("seed: game bots back at startup", "src/hub.ts", "    const seeded = seedDefaultBots(repos, memory);", "    const seeded = [...seedDefaultBots(repos, memory), ...seedGameBots(repos, memory, { dataDir: opts.gameTools?.dataDir, platform: opts.gameTools?.platform })];", SEED),
    ("seed: hook not wired", "src/hub.ts", "    seedSources: opts.seedBots\n", "    seedSources: false\n", SEED),
    ("seed: before the skill check", "src/services/ProjectService.ts", "    const pool = this.deps.repos.listSkills();\n", "    this.deps.seedSources?.(template);\n    const pool = this.deps.repos.listSkills();\n", SEED),
    # Hub dir
    ("hub dir: by node_modules again", "src/config.ts", "if (exists(path.join(dir, 'package.json'))) return dir;", "if (exists(path.join(dir, 'node_modules'))) return dir;", CFG),
]

START = int(sys.argv[1]) if len(sys.argv) > 1 else 1
RUN = MUTANTS[START - 1:]
caught = 0
for n, (name, rel, old, new, tests) in enumerate(RUN, START):
    f = HUB / rel
    raw = f.read_bytes()
    src = raw.decode("utf8")
    if src.count(old) != 1:
        print(f"{n:>2} SKIP  {name}: pattern found {src.count(old)} times")
        continue
    f.write_bytes(src.replace(old, new).encode("utf8"))
    try:
        r = subprocess.run(["npx.cmd" if sys.platform == "win32" else "npx", "vitest", "run", *tests], cwd=HUB, capture_output=True, text=True, encoding="utf8", errors="replace", timeout=600)
    finally:
        f.write_bytes(raw)
    ok = r.returncode != 0
    caught += ok
    summary = [l.strip() for l in (r.stdout + r.stderr).splitlines() if l.strip().startswith("Tests ")]
    print(f"{n:>2} {'CAUGHT' if ok else 'SURVIVED'}  {name}  ({rel})  {summary[-1] if summary else ''}", flush=True)
print(f"\n{caught} of {len(RUN)} mutants caught (mutants {START} to {START + len(RUN) - 1} of {len(MUTANTS)})")
