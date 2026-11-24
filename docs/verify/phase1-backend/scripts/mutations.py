# Phase 1 backend (B1, B6, B2, B5) fail-then-pass: break one guarded line at a time, run the targeted tests, restore.
# Run from packages/hub:  python -I ../../docs/verify/phase1-backend/scripts/mutations.py
import re
import subprocess

TESTS = [
    "src/services/gameTools.test.ts",
    "src/services/gameToolsInstall.test.ts",
    "src/api/gameTools.test.ts",
]
SVC = "src/services/gameTools.ts"
API = "src/api/gameTools.ts"
MUTATIONS = [
    # B1
    (SVC, "B1: Blender version asked without -b", "['-b', '--factory-startup', '--version']", "['--version']"),
    (SVC, "B1: a changed add-on still counts as installed", "if (actual !== recorded) return", "if (false) return"),
    (SVC, "B1: crash cap not reported", "if (s.crashes > MAX_CRASHES) return", "if (false) return"),
    (SVC, "B1: detection reads the owner's Blender add-ons", "    const exe = findBlenderExe(this.env, this.platform, this.fs);",
     "    try { this.fs.readdirSync(path.join(this.env.APPDATA ?? '', 'Blender Foundation')); } catch { /* */ }\n    const exe = findBlenderExe(this.env, this.platform, this.fs);"),
    # B6
    (SVC, "B6: uv zip written before the hash check", "    if (sha256(buf) !== (this.deps.pins?.uvSha256 ?? UV_SHA256)) return { ok: false, result: 'hash-mismatch', changed: [] };\n    const stage",
     "    const early = path.join(this.toolsDir, 'uv.zip'); this.fs.mkdirSync(this.toolsDir, { recursive: true }); this.fs.writeFileSync(early, buf);\n    if (sha256(buf) !== (this.deps.pins?.uvSha256 ?? UV_SHA256)) return { ok: false, result: 'hash-mismatch', changed: [] };\n    const stage"),
    (SVC, "B6: no uv hash check", "if (sha256(buf) !== (this.deps.pins?.uvSha256 ?? UV_SHA256)) return", "if (false) return"),
    (SVC, "B6: failed unpack leaves staging", "      this.fs.rmSync(stage, { recursive: true, force: true });\n      return { ok: false, result: 'unpack-failed'", "      return { ok: false, result: 'unpack-failed'"),
    (SVC, "B6: uv added to the user PATH", "      this.fs.renameSync(stage, this.uvDir);",
     "      this.fs.renameSync(stage, this.uvDir);\n      await this.run('setx', ['PATH', this.uvDir], { env: baseChildEnv(), timeoutMs: 10_000 });"),
    (SVC, "B6: add-on hash not checked", "if (addonSha256 !== (this.deps.pins?.addonSha256 ?? BLENDER_ADDON_SHA256)) return fail('addon-mismatch');", ""),
    (SVC, "B6: Studio edited while it runs", "if (procs.some((p) => p.name.toLowerCase() === STUDIO_PROCESS.toLowerCase())) return", "if (false) return"),
    (SVC, "B6: no .toki-bak", "        this.fs.copyFileSync(file, file + '.toki-bak');\n", ""),
    (SVC, "B6: setting replaced instead of merged (drops other keys)", "const next = { ...v, 'mcp-server': { ...v['mcp-server'], enabled: true } };",
     "const next = { 'mcp-server': { enabled: true } };"),
    (SVC, "B6: also turns on prompt sharing", "const next = { ...v, 'mcp-server': { ...v['mcp-server'], enabled: true } };",
     "const next = { ...v, 'mcp-prompt-sharing': { enabled: true }, 'mcp-server': { ...v['mcp-server'], enabled: true } };"),
    (SVC, "B6: a file without the key is rewritten", "if (!isObj(v) || !isObj(v['mcp-server'])) { skipped++; continue; }", "if (!isObj(v)) { skipped++; continue; }"),
    (SVC, "B6: settings written in place, not atomically", "        this.fs.writeFileSync(tmp, text);\n        this.fs.renameSync(tmp, file);", "        this.fs.writeFileSync(file, text);"),
    # B2
    (API, "B2: fix body not strict (a field could reach a step)", "const FixBody = z.object({}).strict();", "const FixBody = z.object({}).passthrough();"),
    (API, "B2: Studio setup body not strict", "const StudioSetupBody = z.object({ roomId: z.string().min(1).max(100) }).strict();", "const StudioSetupBody = z.object({ roomId: z.string().min(1).max(100) }).passthrough();"),
    (API, "B2: handler lets any principal through (pipeline still guards)", "if (principalOf(req)?.kind !== 'hub' || !actor) return", "if (!actor) return"),
    (API, "B2: no one-at-a-time lock", "if (running) return send(", "if (false) return send("),
    (API, "B2: writes not audited", "          recordAudit(db, actor, AUDIT[step],", "          void (db, actor, AUDIT[step],"),
    ("src/services/AuditLog.ts", "B2: generic request row also written", "  /^\\/api\\/game-tools(\\/|$)/,\n", ""),
    # B5
    (API, "B5: crash log not redacted", "{ log: log === null ? null : redact(log) }", "{ log }"),
    ("src/api/mcpServers.ts", "B5: Studio check words dropped", "const more = found ? await deps.runtimeCheck?.(name) ?? null : null;", "const more: string | null = null;"),
]

def run():
    r = subprocess.run("npx vitest run " + " ".join(TESTS), shell=True, capture_output=True, text=True, encoding="utf8", errors="replace")
    out = r.stdout + r.stderr
    summary = re.search(r"Tests\s+(.+)", out)
    failed = sorted(set(re.findall(r"FAIL\s+\S+ > (.+)", out)))
    return (summary.group(1).strip() if summary else "no summary"), failed

for f, name, old, new in MUTATIONS:
    orig = open(f, encoding="utf8").read()
    assert orig.count(old) == 1, name
    try:
        open(f, "w", encoding="utf8", newline="").write(orig.replace(old, new))
        summary, failed = run()
        print("## mutation: " + name)
        print("   " + summary)
        for x in failed:
            print("   FAIL " + x)
    finally:
        open(f, "w", encoding="utf8", newline="").write(orig)
print("## restored: " + run()[0])
