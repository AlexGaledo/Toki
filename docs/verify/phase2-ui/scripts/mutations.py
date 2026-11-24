"""Break each guarded line in turn and check that its test catches it.

From packages/web: python -I ../../docs/verify/phase2-ui/scripts/mutations.py
Every file is restored after each mutation, also on failure.
"""
import pathlib
import subprocess
import sys

ROOT = pathlib.Path.cwd()
M = [
    # D2
    ("src/lib/lookBacks.ts", "if (m.kind !== 'tool' || !m.payload) continue;", "if (!m.payload) continue;", "src/lib/lookBacks.test.ts", "D2: only tool messages"),
    ("src/lib/lookBacks.ts", "m.attachments?.find(isMediaRef)", "m.attachments?.[0]", "src/lib/lookBacks.test.ts", "D2: files and bad refs skipped"),
    ("src/lib/lookBacks.ts", "s.replace(/[_-]+/g, ' ')", "s", "src/lib/lookBacks.test.ts", "D2: alt text in words"),
    ("src/components/LookBacks.tsx", "block h-24 w-32 shrink-0", "block max-h-24 shrink-0", "src/components/LookBacks.test.tsx", "D2: fixed box, no layout shift"),
    ("src/components/LookBacks.tsx", "mt-1.5 flex flex-wrap gap-2", "mt-1.5 flex gap-2", "src/components/LookBacks.test.tsx", "D2: wraps in a narrow chat"),
    # D3
    ("src/lib/projectTemplates.ts", "if (!s.blenderMcp.ok) return", "if (false) return", "src/lib/projectTemplates.test.ts", "D3: Blender tools missing blocks"),
    ("src/lib/projectTemplates.ts", "if (!s.blender.ok) return", "if (false) return", "src/lib/projectTemplates.test.ts", "D3: Blender missing blocks"),
    ("src/lib/projectTemplates.ts", "if (!s.supported) return", "if (false) return", "src/lib/projectTemplates.test.ts", "D3: off-Windows blocks"),
    ("src/lib/projectTemplates.ts", "if (choice !== 'game') return null;", "", "src/lib/projectTemplates.test.ts", "D3: None and Dev never blocked"),
    ("src/lib/projectTemplates.ts", "return game.error ? \"Couldn't check Blender. Open Settings › Game tools to see why.\" : 'Checking Blender…';", "return game.error ?? 'Checking Blender…';", "src/lib/projectTemplates.test.ts", "D3: hub error text not echoed"),
    ("src/lib/projectTemplates.ts", "{ name: name.trim(), template: choice }", "{ name: name.trim(), team: true }", "src/lib/projectTemplates.test.ts", "D3: template sent"),
    ("src/lib/projectTemplates.ts", "setup.studio === 'added' ?", "setup.studio !== 'failed' ?", "src/lib/projectTemplates.test.ts", "D3: studio words"),
    ("src/components/ui.tsx", "className=\"mt-1 pl-6 text-hint leading-relaxed text-fg\"", "className={cn('mt-1 pl-6 text-hint leading-relaxed text-fg', dim)}", "src/components/RadioCard.test.tsx", "D3: reason not dimmed (AA)"),
    ("src/components/ui.tsx", "note ? noteId : null", "null", "src/components/RadioCard.test.tsx", "D3: reason is described"),
    # (a)
    ("src/store.ts", "set({ gameToolsRev: s.gameToolsRev + 1 });", "", "src/lib/useGameTools.test.ts", "(a) event bumps the counter"),
    ("src/lib/useGameTools.ts", "deps.focus.addEventListener('focus', reload);", "", "src/lib/useGameTools.test.ts", "(a) focus re-reads"),
    ("src/lib/useGameTools.ts", "    off();\n", "", "src/lib/useGameTools.test.ts", "(a) unsubscribes"),
    # (b)
    ("src/components/settings/parts.tsx", "[^\\\\/\\s\"']+/gi, '~')", "[^\\\\/\\s\"']+/g, '~')", "src/components/settings/McpServerTarget.test.tsx", "(b) case-insensitive"),
    ("src/components/settings/McpServersSection.tsx", "const shown = maskHome(line);", "const shown = line;", "src/components/settings/McpServerTarget.test.tsx", "(b) row masks"),
    ("src/components/settings/parts.tsx", "/(?:[A-Za-z]:[\\\\/]Users", "/^(?:[A-Za-z]:[\\\\/]Users", "src/components/settings/McpServerTarget.test.tsx", "(b) anywhere in the line"),
    # (c)
    ("src/lib/approvalWords.ts", ".map((l) => l.trim()).find(Boolean)", ".map((l) => l.trim())[0]", "src/lib/approvalSummary.test.ts", "(c) first non-blank line"),
    ("src/lib/approvalWords.ts", "if (typeof v !== 'string') return null;", "return null;", "src/lib/approvalSummary.test.ts", "(c) JSON-string input"),
    ("src/lib/approvalWords.ts", "s.replace(/\\s+/g, ' ').trim().slice(0, 160)", "s.replace(/\\s+/g, ' ').trim()", "src/lib/approvalSummary.test.ts", "(c) one short line"),
    ("src/lib/inbox.ts", "...(p.codeField ? { codeField: p.codeField } : {})", "", "src/lib/approvalSummary.test.ts", "(c) rows carry codeField"),
]

caught = 0
for path, old, new, test, label in M:
    f = ROOT / path
    src = f.read_bytes()
    text = src.decode("utf-8")
    if text.count(old) != 1:
        print(f"SETUP  {label}: pattern found {text.count(old)} times in {path}")
        sys.exit(2)
    try:
        f.write_bytes(text.replace(old, new).encode("utf-8"))
        r = subprocess.run(["npx", "vitest", "run", test], capture_output=True, text=True, encoding="utf-8", errors="replace", shell=(sys.platform == "win32"))
        ok = r.returncode != 0
        caught += ok
        print(("CAUGHT " if ok else "SURVIVED ") + f"{label}  ({path} -> {test})")
    finally:
        f.write_bytes(src)
print(f"\n{caught} of {len(M)} caught")
