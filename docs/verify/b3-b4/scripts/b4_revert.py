"""B4 fail-then-pass: take B4's source change (b4d4875) out of the current tree, keep its tests, run them, restore.

From packages/hub:  python -I ../../docs/verify/b3-b4/scripts/b4_revert.py
b4d4875's reverse patch no longer applies as-is (a later commit added OUTSIDE_READONLY_MESSAGE to the same import), so
each hunk is reversed here by exact text. Every file is restored byte for byte afterwards.
"""
import pathlib
import subprocess
import sys

sys.stdout.reconfigure(encoding="utf-8")

HUB = pathlib.Path.cwd()
assert (HUB / "src" / "hub.ts").exists(), "run from packages/hub"

EDITS = {
    "src/permissions/PermissionBroker.ts": [
        ("import { OUTSIDE_READONLY_MESSAGE, outsideCardInput, outsideCodeField, outsideTooLarge } from '../services/outsideMcp.js';",
         "import { OUTSIDE_READONLY_MESSAGE, outsideCardInput, outsideTooLarge } from '../services/outsideMcp.js';"),
        ("/** A tool of an outside MCP server (not the hub's own, not the browser); group 1 is the bare tool name. */\nconst OUTSIDE_TOOL = /^mcp__(?!pocketrocket__|browser__)[a-z0-9_-]+?__(.+)$/;\n", ""),
        ("    const outside = OUTSIDE_TOOL.exec(toolName);\n    if (outside) {\n      // An outside server's own key can sit in its input: the card shows it redacted, with any script as code.\n      const shown = outsideCardInput(input);\n      const codeField = outsideCodeField(outside[1] ?? '', shown);\n      return this.promptUser(ctx, toolName, shown, reason, danger, { ...opts, ...(codeField ? { codeField } : {}) });\n    }\n", ""),
        ("    const codeField = outsideCodeField(tool, shown);\n", ""),
        ("{ server, tool, input: shown },", "{ server, tool, input: JSON.stringify(shown) },"),
        ("false, { signal, once: true, ...(codeField ? { codeField } : {}) },", "false, { signal, once: true },"),
        ("opts: { signal: AbortSignal; suggestions?: PermissionUpdate[]; codeField?: string },", "opts: { signal: AbortSignal; suggestions?: PermissionUpdate[] },"),
        ("opts: { signal: AbortSignal; once?: boolean; codeField?: string },", "opts: { signal: AbortSignal; once?: boolean },"),
        ("      ...(opts.codeField ? { codeField: opts.codeField } : {}),\n", ""),
    ],
    "src/services/outsideMcp.ts": [
        ("const CODE_TOOLS = new Set(['execute_blender_code', 'execute_luau']);\n/** The input field the card shows as code, for tools whose input is a script. */\nexport function outsideCodeField(tool: string, input: Record<string, unknown>): 'code' | undefined {\n  return CODE_TOOLS.has(tool) && typeof input.code === 'string' ? 'code' : undefined;\n}\n\n", ""),
    ],
}
TESTS = ["src/permissions/outsideMcpApproval.test.ts"]


def run(label):
    r = subprocess.run(["npx.cmd" if sys.platform == "win32" else "npx", "vitest", "run", *TESTS], cwd=HUB,
                       capture_output=True, text=True, encoding="utf8", errors="replace", timeout=600)
    keep = ("✓", "×", "FAIL", "AssertionError", "Expected", "Received", "Test Files", "Tests ", "- ", "+ ")
    print(f"== {label}: exit {r.returncode} ==")
    for line in (r.stdout + r.stderr).splitlines():
        s = line.strip()
        if s.startswith(keep) or "toolInput" in s or "codeField" in s:
            print("  " + s)
    print(flush=True)


saved = {rel: (HUB / rel).read_bytes() for rel in EDITS}
try:
    for rel, pairs in EDITS.items():
        src = saved[rel].decode("utf8")
        for old, new in pairs:
            assert src.count(old) == 1, f"{rel}: pattern found {src.count(old)} times: {old[:60]}"
            src = src.replace(old, new)
        (HUB / rel).write_bytes(src.encode("utf8"))
    run("B4 source reverted, B4 tests kept (expect fail)")
finally:
    for rel, raw in saved.items():
        (HUB / rel).write_bytes(raw)
run("B4 source restored (expect pass)")
