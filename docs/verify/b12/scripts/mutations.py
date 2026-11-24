# B12 fail-then-pass check: break one guarded line of BlenderHost.ts at a time, run its tests, restore.
# Run from packages/hub:  python -I ../../docs/verify/b12/scripts/mutations.py
import re
import subprocess

SRC = "src/services/BlenderHost.ts"
TESTS = ["src/services/BlenderHost.test.ts", "src/agent/blenderTurn.test.ts"]
MUTATIONS = [
    ("no -b on the command line", "'-b', '--factory-startup', ...(", "'--factory-startup', ...("),
    ("no other-Blender check", "if (other) return", "if (false && other) return"),
    ("no busy check (two projects at once)", "if (!cur.stopping && this.now() - cur.lastUse < BUSY_MS)", "if (false)"),
    ("no idle stop", "setTimeout(() => void this.stop('idle')", "setTimeout(() => undefined"),
    ("idle clock from spawn, not READY", "    child.on('error', (e) => onGone(null, e));\n    return ready;", "    child.on('error', (e) => onGone(null, e));\n    this.touch();\n    return ready;"),
    ("no crash cap", "this.recentCrashes() > MAX_CRASHES", "this.recentCrashes() > 1000"),
    ("Blender on another port than the mount", "'--port', String(port)", "'--port', String(port + 1)"),
    ("mount may use 9876", "this.port === null || this.port === GUI_BLENDER_PORT", "this.port === null"),
    ("MCP server reads the owner's APPDATA", "APPDATA: home, ", ""),
]

orig = open(SRC, encoding="utf8").read()
try:
    for name, old, new in MUTATIONS:
        assert orig.count(old) == 1, name
        open(SRC, "w", encoding="utf8", newline="").write(orig.replace(old, new))
        r = subprocess.run("npx vitest run " + " ".join(TESTS), shell=True, capture_output=True, text=True, encoding="utf8", errors="replace")
        out = r.stdout + r.stderr
        failed = sorted(set(re.findall(r"FAIL\s+\S+ > (.+)", out)))
        summary = re.search(r"Tests\s+(.+)", out)
        print("## mutation: " + name)
        print("   " + (summary.group(1).strip() if summary else "no summary"))
        for f in failed:
            print("   FAIL " + f)
finally:
    open(SRC, "w", encoding="utf8", newline="").write(orig)
r = subprocess.run("npx vitest run " + " ".join(TESTS), shell=True, capture_output=True, text=True, encoding="utf8", errors="replace")
print("## restored: " + (re.search(r"Tests\s+(.+)", r.stdout + r.stderr) or [None, "?"])[1].strip())
