"""B3 and B4 mutation run: outsideMcpStep, the outside PreToolUse hook, redactValue, codeField and the card paths.

From packages/hub:  python -I ../../docs/verify/b3-b4/scripts/mutations.py [first mutant number, default 1]
Each guarded line is broken in turn, the B3/B4 tests run, and the file is restored byte for byte. A mutant is
"caught" when vitest exits non-zero. After each mutant `git diff --stat` must be empty, or the run stops.
"""
import pathlib
import subprocess
import sys

sys.stdout.reconfigure(encoding="utf-8")
HUB = pathlib.Path.cwd()
assert (HUB / "src" / "hub.ts").exists(), "run from packages/hub"

TESTS = [
    "src/services/outsideMcp.test.ts",
    "src/permissions/outsideMcpMode.test.ts",
    "src/permissions/outsideMcpApproval.test.ts",
    "src/providers/claudeOutsideMcp.test.ts",
    "src/api/studioRecipeApproval.test.ts",
]
OM = "src/services/outsideMcp.ts"
CL = "src/providers/claude.ts"
PB = "src/permissions/PermissionBroker.ts"
RD = "src/providers/redact.ts"

NO_GATE = ": 'This outside tool needs the owner\\'s approval, and none can be asked for here.';"

MUTANTS = [
    # B3: outsideMcpStep
    ("B3 step: wm refusal dropped", OM, "  if (blenderWmRefused(server.name, tool, input)) return { kind: 'refuse', message: BLENDER_WM_MESSAGE };\n", ""),
    ("B3 step: wm refusal for any server", OM, "return server === 'blender' && tool === 'execute_blender_code' &&", "return tool === 'execute_blender_code' &&"),
    ("B3 step: wm refusal for any blender tool", OM, "return server === 'blender' && tool === 'execute_blender_code' &&", "return server === 'blender' &&"),
    ("B3 step: wm text check narrowed", OM, ".includes('bpy.ops.wm.');", ".includes('bpy.ops.wm.save_mainfile');"),
    ("B3 step: other approve values take the mode path", OM, "  if (server.approve !== 'mode') return outsideMcpNeedsCard", "  if (server.approve === 'every-call') return outsideMcpNeedsCard"),
    ("B3 step: bypass ignored", OM, "  if (o.bypass) return { kind: 'pass' };\n", ""),
    ("B3 step: bypass allows silently", OM, "  if (o.bypass) return { kind: 'pass' };", "  if (o.bypass) return { kind: 'allow' };"),
    ("B3 step: readTools not allowed", OM, "  if (server.readTools.includes(tool)) return { kind: 'allow' };\n", ""),
    ("B3 step: every tool treated as a read tool", OM, "  if (server.readTools.includes(tool)) return { kind: 'allow' };", "  if (true) return { kind: 'allow' };"),
    ("B3 step: read-only refusal dropped", OM, "  if (o.readOnly) return { kind: 'refuse', message: OUTSIDE_READONLY_MESSAGE };\n", ""),
    ("B3 step: large input not refused", OM, "  return big ? { kind: 'refuse', message: big } : { kind: 'pass' };", "  return { kind: 'pass' };"),
    ("B3 needsCard: mode cards once-only", OM, "  if (server.approve === 'none' || server.approve === 'mode') return false;", "  if (server.approve === 'none') return false;"),
    ("B3 needsCard: writes cards reads too", OM, "  if (server.approve === 'writes') return !server.readTools.includes(tool);", "  if (server.approve === 'writes') return true;"),
    ("B3 hooked: blender with approve none not hooked", OM, "return server.approve !== 'none' || server.name === 'blender';", "return server.approve !== 'none';"),
    ("B3 hooked: nothing hooked", OM, "return server.approve !== 'none' || server.name === 'blender';", "return false;"),
    ("B3 cap: 8000 raised", OM, "export const OUTSIDE_INPUT_CAP = 8000;", "export const OUTSIDE_INPUT_CAP = 80000;"),
    # B3: the hook in the Claude provider
    ("B3 hook: bypass always on", CL, "{ bypass: !!ctx.bypassPermissions, readOnly: !!ctx.approvalsReadOnly }", "{ bypass: true, readOnly: !!ctx.approvalsReadOnly }"),
    ("B3 hook: bypass always off", CL, "{ bypass: !!ctx.bypassPermissions, readOnly: !!ctx.approvalsReadOnly }", "{ bypass: false, readOnly: !!ctx.approvalsReadOnly }"),
    ("B3 hook: read-only not passed", CL, "{ bypass: !!ctx.bypassPermissions, readOnly: !!ctx.approvalsReadOnly }", "{ bypass: !!ctx.bypassPermissions, readOnly: false }"),
    ("B3 hook: pass goes to the once-only gate", CL, "              if (step.kind === 'pass') return {};\n", ""),
    ("B3 hook: allow goes to the gate", CL, "                : step.kind === 'allow' ? null\n", ""),
    ("B3 hook: refusal turned into allow", CL, "              const why = step.kind === 'refuse' ? step.message", "              const why = step.kind === 'refuse' ? null"),
    ("B3 hook: no gate wired allows", CL, NO_GATE, ": null;"),
    ("B3 hook: deny decision becomes allow", CL,
     "                  ? { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: why }\n                  : {",
     "                  ? { hookEventName: 'PreToolUse' as const, permissionDecision: 'allow' as const, permissionDecisionReason: why }\n                  : {"),
    ("B3 hook: blender with approve none not hooked", CL, "const gatedOutside = (ctx.outsideMcp ?? []).filter(outsideMcpHooked);", "const gatedOutside = (ctx.outsideMcp ?? []).filter((s) => s.approve !== 'none');"),
    ("B12 hook: Blender started for a refused call", CL, "const down = step.kind !== 'refuse' && s.name === 'blender'", "const down = s.name === 'blender'"),
    ("B12 hook: Blender down not refused", CL, "              if (down) return { hookSpecificOutput:", "              if (false) return { hookSpecificOutput:"),
    # B3/B4: redaction of the card input
    ("redactValue: strings kept", RD, "  if (typeof v === 'string') return redact(v);", "  if (typeof v === 'string') return v;"),
    ("redactValue: arrays not walked", RD, "  if (Array.isArray(v)) return v.map(redactValue);", "  if (Array.isArray(v)) return v;"),
    ("redactValue: keys not redacted", RD, "Object.entries(v).map(([k, x]) => [redact(k), redactValue(x)])", "Object.entries(v).map(([k, x]) => [k, redactValue(x)])"),
    ("redactValue: nested values not walked", RD, "Object.entries(v).map(([k, x]) => [redact(k), redactValue(x)])", "Object.entries(v).map(([k, x]) => [redact(k), x])"),
    ("outsideCardInput: not redacted", OM, "  return redactValue(input ?? {}) as Record<string, unknown>;", "  return (input ?? {}) as Record<string, unknown>;"),
    # B4: codeField and the two card paths
    ("B4 codeField: execute_luau not a code tool", OM, "new Set(['execute_blender_code', 'execute_luau'])", "new Set(['execute_blender_code'])"),
    ("B4 codeField: execute_blender_code not a code tool", OM, "new Set(['execute_blender_code', 'execute_luau'])", "new Set(['execute_luau'])"),
    ("B4 codeField: non-string code named", OM, "CODE_TOOLS.has(tool) && typeof input.code === 'string' ? 'code'", "CODE_TOOLS.has(tool) ? 'code'"),
    ("B4 codeField: any tool", OM, "CODE_TOOLS.has(tool) && typeof input.code === 'string' ? 'code'", "typeof input.code === 'string' ? 'code'"),
    ("B4 once card: input as a string again", PB, "{ server, tool, input: shown },", "{ server, tool, input: JSON.stringify(shown) },"),
    ("B4 once card: codeField dropped", PB, "false, { signal, once: true, ...(codeField ? { codeField } : {}) },", "false, { signal, once: true },"),
    ("B4 once card: too-large check dropped", PB, "    if (big) return { allowed: false, message: big };\n", ""),
    ("B4 payload: codeField not sent", PB, "      ...(opts.codeField ? { codeField: opts.codeField } : {}),\n", ""),
    ("B4 normal card: raw input shown", PB,
     "      return this.promptUser(ctx, toolName, shown, reason, danger, { ...opts, ...(codeField ? { codeField } : {}) });",
     "      return this.promptUser(ctx, toolName, input, reason, danger, { ...opts, ...(codeField ? { codeField } : {}) });"),
    ("B4 normal card: codeField dropped", PB,
     "      return this.promptUser(ctx, toolName, shown, reason, danger, { ...opts, ...(codeField ? { codeField } : {}) });",
     "      return this.promptUser(ctx, toolName, shown, reason, danger, opts);"),
    ("B4 normal card: branch off", PB, "    if (outside) {\n      // An outside server's own key", "    if (false) {\n      // An outside server's own key"),
    ("B4 normal card: hub tools treated as outside", PB, "/^mcp__(?!pocketrocket__|browser__)[a-z0-9_-]+?__(.+)$/", "/^mcp__[a-z0-9_-]+?__(.+)$/"),
]

START = int(sys.argv[1]) if len(sys.argv) > 1 else 1
RUN = MUTANTS[START - 1:]
caught = 0
for n, (name, rel, old, new) in enumerate(RUN, START):
    f = HUB / rel
    raw = f.read_bytes()
    src = raw.decode("utf8")
    if src.count(old) != 1:
        print(f"{n:>2} SKIP  {name}: pattern found {src.count(old)} times", flush=True)
        continue
    f.write_bytes(src.replace(old, new).encode("utf8"))
    try:
        r = subprocess.run(["npx.cmd" if sys.platform == "win32" else "npx", "vitest", "run", *TESTS], cwd=HUB, capture_output=True,
                           text=True, encoding="utf8", errors="replace", timeout=600)
    finally:
        f.write_bytes(raw)
    ok = r.returncode != 0
    caught += ok
    out = (r.stdout + r.stderr).splitlines()
    summary = [l.strip() for l in out if l.strip().startswith("Tests ")]
    first_fail = next((l.strip()[len("FAIL  "):] for l in out if l.strip().startswith("FAIL  ") and " > " in l), "")
    line = f"{n:>2} {'CAUGHT' if ok else 'SURVIVED'}  {name}  ({rel})  {summary[-1] if summary else ''}"
    if first_fail:
        line += f"\n        first: {first_fail}"
    print(line, flush=True)
    dirty = subprocess.run(["git", "diff", "--stat"], cwd=HUB, capture_output=True, text=True).stdout.strip()
    if dirty:
        sys.exit(f"tree not clean after mutant {n}: {dirty}")
print(f"\n{caught} of {len(RUN)} mutants caught (mutants {START} to {START + len(RUN) - 1} of {len(MUTANTS)}); git diff --stat clean after each")
