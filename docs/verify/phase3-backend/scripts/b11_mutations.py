"""B11 (shared-subscription note) mutation run: the hub lines mutants 21-23 of mutations.py did not cover, plus the web.

From the repo root:  python -I docs/verify/phase3-backend/scripts/b11_mutations.py
Each guarded line is broken in turn, the listed tests run in that package, and the file is restored byte for byte.
A mutant is "caught" when vitest exits non-zero. After each mutant `git diff --stat -- <mutated file>` must be empty, or the run stops.
Mutants 21-23 of mutations.py (UsageTracker gate, route field, hub wiring of known('server')) were caught there.
"""
import pathlib
import subprocess
import sys

ROOT = pathlib.Path.cwd()
assert (ROOT / "packages" / "hub" / "src" / "hub.ts").exists(), "run from the repo root"
HUB, WEB = ROOT / "packages" / "hub", ROOT / "packages" / "web"
NOTE = ["src/services/UsageTracker.test.ts", "src/api/usageNote.test.ts"]
WEB_NOTE = ["src/components/FleetPages.usageNote.test.tsx"]

# (name, package dir, file, old, new, tests)
MUTANTS = [
    ("hub: known() says yes for a host never told", HUB, "src/services/RemoteProjects.ts",
     "    return this.state(host) !== null;", "    return this.state(host) !== null || true;", NOTE),
    ("hub: known() only while connected", HUB, "src/services/RemoteProjects.ts",
     "    return this.state(host) !== null;", "    return this.state(host)?.connected === true;", NOTE),
    ("hub: the route is not given the tracker", HUB, "src/hub.ts",
     "    media, usage, routineInUse:", "    media, routineInUse:", NOTE),
    ("hub: the route never asks for the note", HUB, "src/api/rest.ts",
     "    const note = deps.usage?.subscriptionNote() ?? null;", "    const note = null as string | null;", NOTE),
    ("web: the note is never shown", WEB, "src/components/FleetPages.tsx",
     "  return text ? <p className=\"rounded-lg bg-card2/60 p-3 text-fg\">{text}</p> : null;", "  return text ? null : null;", WEB_NOTE),
    ("web: any value from the hub is shown (no string check)", WEB, "src/components/FleetPages.tsx",
     "  const text = typeof note === 'string' && note.trim() ? note : null;", "  const text = note ? String(note) : null;", WEB_NOTE),
    ("web: the note is rendered as HTML", WEB, "src/components/FleetPages.tsx",
     "  return text ? <p className=\"rounded-lg bg-card2/60 p-3 text-fg\">{text}</p> : null;",
     "  return text ? <p className=\"rounded-lg bg-card2/60 p-3 text-fg\" dangerouslySetInnerHTML={{ __html: text }} /> : null;", WEB_NOTE),
    ("web: the Usage page drops the note", WEB, "src/components/FleetPages.tsx",
     "      <SubscriptionNote note={note} />\n", "", WEB_NOTE),
    ("web: the reply's note is not kept", WEB, "src/components/FleetPages.tsx",
     "      setNote(u.subscriptionNote);", "      setNote(undefined);", WEB_NOTE),
]

caught = 0
for n, (name, pkg, rel, old, new, tests) in enumerate(MUTANTS, 1):
    f = pkg / rel
    raw = f.read_bytes()
    src = raw.decode("utf8")
    if src.count(old) != 1:
        print(f"{n:>2} SKIP  {name}: pattern found {src.count(old)} times", flush=True)
        continue
    f.write_bytes(src.replace(old, new).encode("utf8"))
    try:
        r = subprocess.run(["npx.cmd" if sys.platform == "win32" else "npx", "vitest", "run", *tests], cwd=pkg, capture_output=True,
                           text=True, encoding="utf8", errors="replace", timeout=600)
    finally:
        f.write_bytes(raw)
    ok = r.returncode != 0
    caught += ok
    summary = [l.strip() for l in (r.stdout + r.stderr).splitlines() if l.strip().startswith("Tests ")]
    print(f"{n:>2} {'CAUGHT' if ok else 'SURVIVED'}  {name}  ({pkg.name}/{rel})  {summary[-1] if summary else '(no test summary)'}", flush=True)
    # Scoped to the mutated file: another agent may be editing other files in this worktree at the same time.
    dirty = subprocess.run(["git", "diff", "--stat", "--", str(f)], cwd=ROOT, capture_output=True, text=True).stdout.strip()
    if dirty:
        sys.exit(f"tree not clean after mutant {n}: {dirty}")
print(f"\n{caught} of {len(MUTANTS)} mutants caught; the mutated file was clean after each")
