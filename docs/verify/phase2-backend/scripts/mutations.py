"""Phase 2 backend mutation run (B7, B9, game-tools.changed).

From packages/hub:  python -I ../../docs/verify/phase2-backend/scripts/mutations.py
Each guarded line is broken in turn, the listed test files run, and the file is restored. A mutant is "caught" when
vitest exits non-zero.
"""
import pathlib
import subprocess
import sys

HUB = pathlib.Path.cwd()
assert (HUB / "src" / "hub.ts").exists(), "run from packages/hub"

PROJ = ["src/api/projects.test.ts", "src/api/gameProject.test.ts"]
SEED = ["src/services/SeedBots.test.ts"]
LOOK = ["src/agent/lookBackTurn.test.ts", "src/providers/claudeLookBack.test.ts"]
EVENT = ["src/services/BlenderHost.test.ts", "src/api/gameTools.test.ts"]

MUTANTS = [
    ("B7 kind stored", "src/services/ProjectService.ts", "template?.version ?? null, template?.kind ?? null,", "template?.version ?? null, null,", PROJ + ["src/agent/blenderTurn.test.ts"]),
    ("B7 game folders", "src/services/ProjectService.ts", "for (const f of template?.folders ?? []) {", "for (const f of [] as string[]) {", PROJ),
    ("B7 .gitkeep", "src/services/ProjectService.ts", "if (!fs.existsSync(keep)) fs.writeFileSync(keep, '');", "", PROJ),
    ("B7 team:true means dev", "src/services/ProjectService.ts", "input.team ? TEAM_TEMPLATES.dev : null", "input.team ? TEAM_TEMPLATES.game : null", PROJ),
    ("B7 keep an existing repo", "src/services/ProjectService.ts", "if (fs.existsSync(path.join(dir, '.git'))) return 'exists';", "", PROJ),
    ("B7 git failure is reported", "src/services/ProjectService.ts", "      return 'failed';\n    }\n  }", "      return 'created';\n    }\n  }", PROJ),
    ("B7 route: setup only for game", "src/api/projects.ts", "if (made.project.kind !== 'game') return send(res, 200, made);", "if (made.project.kind === 'nothing') return send(res, 200, made);", PROJ),
    ("B7 route: template enum", "src/api/projects.ts", "template: z.enum(TEAM_TEMPLATE_IDS).optional(),", "template: z.any().optional(),", PROJ),
    ("B7 route: hub principal only", "src/api/projects.ts", "principalOf(req)?.kind === 'hub' ? actorOf(req) : null", "actorOf(req)", PROJ),
    ("B7 Studio: no launcher writes nothing", "src/api/gameTools.ts", "if (studio.reason === 'unsupported' || studio.reason === 'no-mcp-bat') return studio.reason;", "", PROJ),
    ("B7 seed: win32 only", "src/services/SeedBots.ts", "if ((opts.platform ?? process.platform) !== 'win32') return [];", "", SEED),
    ("B7 seed: once", "src/services/SeedBots.ts", "    if (fs.existsSync(marker)) continue;\n    fs.writeFileSync(marker, '');\n    if (taken.has(d.handle)) continue;", "    fs.writeFileSync(marker, '');\n    if (taken.has(d.handle)) continue;", SEED),
    ("B9 game rooms only", "src/agent/lookBacks.ts", "  if (!o.game) return names;\n", "", LOOK),
    ("B9 built-in blender only", "src/agent/lookBacks.ts", "if (o.blender && o.mounted.includes(o.blender)) names.add(o.blender.name);", "if (o.mounted.some((s) => s.name === 'blender')) names.add('blender');", LOOK),
    ("B9 other servers refused", "src/agent/lookBacks.ts", "  for (const s of servers) if (toolName.startsWith('mcp__' + s + '__')) return true;\n  return false;", "  return servers.size > 0;", LOOK),
    ("B9 path stripped", "src/agent/BotRunner.ts", "const shown = lookBack ? stripCliImagePaths(output) : output;", "const shown = output;", LOOK),
    ("B9 store only look-back tools", "src/agent/BotRunner.ts", "const ref = lookBack && image && this.media ? storeLookBack(this.media, image) : null;", "const ref = image && this.media ? storeLookBack(this.media, image) : null;", LOOK),
    ("B9 size precheck", "src/agent/lookBacks.ts", "  if (Math.floor(image.data.length / 4) * 3 > MAX_ATTACHMENT_IMAGE_BYTES + 3) return null;\n", "", LOOK),
    ("B9 image from the SDK", "src/providers/claude.ts", "!!block.is_error, firstImage(block.content));", "!!block.is_error, undefined);", LOOK),
    ("B9 base64 only", "src/providers/claude.ts", "if (src?.type === 'base64' && typeof", "if (typeof", LOOK),
    ("B9 attachments saved", "src/db/repos.ts", "m.attachments?.length ? JSON.stringify(m.attachments) : null, id);", "cur.attachments?.length ? JSON.stringify(cur.attachments) : null, id);", LOOK),
    ("event: BlenderHost", "src/services/BlenderHost.ts", "private changed() { this.deps.onChange?.(); }", "private changed() { /* mutant */ }", EVENT),
    ("event: Studio setup", "src/api/gameTools.ts", "        recordAudit(db, actor, 'game_tools.studio_setup', room.id, STUDIO_SERVER);\n        deps.onChange?.();", "        recordAudit(db, actor, 'game_tools.studio_setup', room.id, STUDIO_SERVER);", EVENT),
]

caught = 0
for name, rel, old, new, tests in MUTANTS:
    f = HUB / rel
    src = f.read_bytes().decode("utf8")
    if src.count(old) != 1:
        print(f"SKIP  {name}: pattern found {src.count(old)} times")
        continue
    f.write_bytes(src.replace(old, new).encode("utf8"))
    try:
        r = subprocess.run(["npx.cmd" if sys.platform == "win32" else "npx", "vitest", "run", *tests], cwd=HUB, capture_output=True, text=True, encoding="utf8", errors="replace", timeout=600)
    finally:
        f.write_bytes(src.encode("utf8"))
    ok = r.returncode != 0
    caught += ok
    summary = [l.strip() for l in (r.stdout + r.stderr).splitlines() if l.strip().startswith("Tests ")]
    print(f"{'CAUGHT' if ok else 'SURVIVED'}  {name}  ({rel})  {summary[-1] if summary else ''}")
print(f"\n{caught} of {len(MUTANTS)} mutants caught")
