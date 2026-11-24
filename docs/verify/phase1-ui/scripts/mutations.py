"""D1/D5 mutation run: break each guarded line in turn and expect the targeted tests to fail.
From packages/web:  python -I ../../docs/verify/phase1-ui/scripts/mutations.py
Each file is restored byte for byte after its run."""
import io, subprocess, sys

TESTS = ['src/lib/gameTools.test.ts', 'src/lib/approvalCode.test.ts', 'src/components/ApprovalCode.test.tsx']
M = [
    ('canRunFix ignores studio.running', 'src/lib/gameTools.ts',
     "case 'studio-mcp-setting': return s.studio.fix === step && !s.studio.running;", "case 'studio-mcp-setting': return s.studio.fix === step;"),
    ('runFix skips the fresh status check', 'src/lib/gameTools.ts',
     'if (!canRunFix(fresh, step)) return', 'if (false) return'),
    ('Studio fix offered while Studio runs', 'src/lib/gameTools.ts',
     ": st.running ? { kind: 'wait', label: FIX_LABEL[st.fix], why: CLOSE_STUDIO } :", ':'),
    ('Studio never marked unverified', 'src/lib/gameTools.ts',
     'const unverified = !st.verified;', 'const unverified = false;'),
    ('strip drops "(unverified)"', 'src/lib/gameTools.ts',
     "(st.verified ? '' : ' (unverified)')", "''"),
    ('uv fix button dropped', 'src/lib/gameTools.ts',
     "action: s.uv.fix ? { kind: 'fix', step: s.uv.fix, label: FIX_LABEL[s.uv.fix] } : null,", 'action: null,'),
    ('Blender tools offered before uv', 'src/lib/gameTools.ts',
     "!s.uv.ok ? { kind: 'wait', label: FIX_LABEL[m.fix], why: 'Install uv first.' } : ", ''),
    ('Open Studio shown without the desktop capability', 'src/lib/gameTools.ts',
     "action: opts.studioLauncher ? { kind: 'open-studio', label: 'Open Studio' } : null", "action: { kind: 'open-studio', label: 'Open Studio' }"),
    ('codeField read from toolInput, not toolInput.input', 'src/lib/approvalCode.ts',
     'isObj(t.input) ? t.input : t;', 'isObj(t.input) ? t : t;'),
    ('code shown as an escaped JSON string', 'src/components/ApprovalCode.tsx',
     '<code>{c.code}</code>', '<code>{JSON.stringify(c.code)}</code>'),
    ('code area back to the short 160 px box', 'src/components/ApprovalCode.tsx',
     'max-h-[60vh]', 'max-h-40'),
    ('code area not keyboard focusable', 'src/components/ApprovalCode.tsx',
     'tabIndex={0}\n', ''),
]

caught = 0
for name, path, old, new in M:
    src = io.open(path, encoding='utf-8', newline='').read()
    if src.count(old) != 1:
        print('SKIP (pattern not unique):', name); continue
    io.open(path, 'w', encoding='utf-8', newline='').write(src.replace(old, new))
    try:
        r = subprocess.run('npx vitest run ' + ' '.join(TESTS), shell=True, capture_output=True, text=True, encoding='utf-8', errors='replace')
    finally:
        io.open(path, 'w', encoding='utf-8', newline='').write(src)
    failed = r.returncode != 0
    caught += failed
    summary = [l.strip() for l in r.stdout.splitlines() if l.strip().startswith('Tests')]
    print(('CAUGHT  ' if failed else 'SURVIVED') + '  ' + name + '  | ' + (summary[-1] if summary else 'exit ' + str(r.returncode)))
print('caught %d of %d' % (caught, len(M)))
sys.exit(0 if caught == len(M) else 1)
