"""Break each guarded line in turn and check that its test catches it (phase 3 UI: D4, Open folder).

From packages/web: python -I ../../docs/verify/phase3-ui/scripts/mutations.py
Every file is restored after each mutation, also on failure.
"""
import pathlib
import subprocess
import sys

ROOT = pathlib.Path.cwd()
H = "src/lib/hosts.ts"
HT = "src/lib/hosts.test.ts"
ST = "src/store.hosts.test.ts"
M = [
    # Host keying and the split
    (H, "if (item.host === undefined || item.host === 'pc') {", "if (true) {", ST, "split: a stub is never local (slug clash)"),
    (H, "} else if (isRemoteHost(item.host)) stubs.push(item as ProjectStub);", "} else stubs.push(item as ProjectStub);", HT, "split: unknown hosts dropped"),
    (H, "return (p.host ?? 'pc') + ':' + p.slug;", "return p.slug;", HT, "key is host plus slug"),
    ("src/store.ts", "const { local, stubs } = splitProjects(loose.projects); set({ projects: local, stubs });", "set({ projects: loose.projects as ProjectInfo[] });", ST, "projects.changed with a list is split"),
    # Tags
    (H, "return HOST_LABEL[p.host && p.host !== 'pc' ? p.host : pageHost];", "return HOST_LABEL[p.host ?? 'pc'];", HT, "server page calls its own projects Server"),
    (H, "return stubCount > 0 || pageHost !== 'pc';", "return stubCount > 0;", HT, "tags on the server page"),
    # Cap gating and the calls
    (H, "if (!can('hosts')) return { kind: 'prompt', phase: 'elsewhere' };", "", ST, "no hosts cap: open-it-there note"),
    (H, "if (stub.connected) return {", "if (true) return {", ST, "offline asks first"),
    (H, "'/?openproject=server:' + encodeURIComponent(slug)", "'/?openproject=server:' + slug", HT, "openproject slug encoded"),
    ("src/store.ts", "if (!cur || next === cur || !desktopCan('hosts')) return;", "if (!cur || next === cur) return;", ST, "Connect never calls outside the app / twice"),
    ("src/components/settings/ProjectsSection.tsx", "const folder = desktopCan('openfolder') ? (", "const folder = true ? (", "src/components/settings/ProjectsSection.test.tsx", "Open folder needs the cap"),
    # The prompt state machine
    (H, "if (sameHost.some((s) => s.connected)) return state;", "", ST, "connected keeps working"),
    (H, "state && (state.phase === 'ask' || state.phase === 'failed') ? { ...state, phase: 'working' } : state;", "state ? { ...state, phase: 'working' } : state;", HT, "no connect from elsewhere or working"),
    ("src/store.ts", "void get().loadProjects().then(() => set({ serverPrompt: promptStep(get().serverPrompt, { type: 'hosts', stubs: get().stubs }) }));", "void get().loadProjects();", ST, "hosts.changed ends working"),
    # Deep link
    (H, "return slug && slug.length <= 40 && PROJECT_SLUG_RE.test(slug) ? slug : null;", "return slug || null;", HT, "deep link takes only a slug"),
    (H, "  p.delete('project');\n", "", HT, "deep link stripped"),
    ("src/store.ts", "      set({ pendingProject: null });\n", "", ST, "deep link only once"),
    ("src/store.ts", "const project = local.find((p) => p.slug === slug);", "const project = local.find((p) => p.slug === slug) ?? (get().stubs.find((p) => p.slug === slug) as unknown as ProjectInfo | undefined);", ST, "deep link never a stub"),
    # Back to this PC
    ("src/lib/auth.ts", "return isDesktopMode() && getItem(DESKTOP_HOST_KEY, 'session') === 'server' ? 'server' : 'pc';", "return getItem(DESKTOP_HOST_KEY, 'session') === 'server' ? 'server' : 'pc';", "src/lib/auth.host.test.ts", "host only from the desktop app"),
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
