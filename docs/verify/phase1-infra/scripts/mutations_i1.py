"""I1 mutation run: break each guard in launch.rs / lib.rs in turn and show `cargo test` catches it.

From packages/desktop/src-tauri:  python -I ../../../docs/verify/phase1-infra/scripts/mutations_i1.py
Restores every file after each mutation, also on failure.
"""
import pathlib, re, subprocess, sys

MUTATIONS = [
    ("blender becomes an app id", "src/launch.rs",
     'const IDS: &[(&str, App)] = &[("studio", App::Studio)];',
     'const IDS: &[(&str, App)] = &[("studio", App::Studio), ("blender", App::Studio)];'),
    ("ids compared case-insensitively", "src/launch.rs",
     "IDS.iter().find(|(id, _)| *id == raw)",
     "IDS.iter().find(|(id, _)| id.eq_ignore_ascii_case(raw.trim()))"),
    ("extra query parameters (a path) allowed", "src/launch.rs",
     '[(_, id)] if url.path() == "/" && url.fragment().is_none() => app_id(id),',
     '[(_, id), ..] if url.path() == "/" => app_id(id),'),
    ("any origin may ask", "src/launch.rs",
     '    if !hub || !url.query_pairs().any(|(k, _)| k == "launch") {',
     '    let _ = hub;\n    if !url.query_pairs().any(|(k, _)| k == "launch") {'),
    ("no breakaway flag", "src/launch.rs",
     "pub const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;",
     "pub const CREATE_BREAKAWAY_FROM_JOB: u32 = 0;"),
    ("spawn ignores the flags it is given (calls spawn with 0)", "src/launch.rs",
     "spawn(&exe, CREATE_BREAKAWAY_FROM_JOB)",
     "spawn(&exe, 0)"),
    (r"registry path not confined to Roblox\Versions", "src/launch.rs",
     "    let ok = |exe: &Path| under(exe, &versions) && exe.is_file();",
     "    let ok = |exe: &Path| exe.is_file();"),
    ("'..' allowed in the registry path", "src/launch.rs",
     "    if !p.is_absolute() || p.components().any(|c| matches!(c, Component::ParentDir)) {",
     "    if !p.is_absolute() {"),
    ("no cooldown", "src/launch.rs",
     "        if last.is_some_and(|t| now.saturating_duration_since(t) < COOLDOWN) {",
     "        if false {"),
    ("studio cap not advertised to the page", "src/lib.rs",
     'const CAPS: &str = if cfg!(windows) { "localcopy,studio" } else { "localcopy" };',
     'const CAPS: &str = "localcopy";'),
]

def main() -> int:
    caught = 0
    for name, rel, old, new in MUTATIONS:
        p = pathlib.Path(rel)
        src = p.read_bytes()
        text = src.decode("utf-8")
        assert text.count(old) == 1, f"{name}: anchor not found once"
        try:
            p.write_bytes(text.replace(old, new).encode("utf-8"))
            r = subprocess.run(["cargo", "test", "-j", "2", "--lib", "--", "launch::", "tests::hub_url"],
                               capture_output=True, text=True, encoding="utf-8", errors="replace")
        finally:
            p.write_bytes(src)
        out = r.stdout + r.stderr
        failed = sorted(set(re.findall(r"^test (\S+) \.\.\. FAILED", out, re.M)))
        summary = re.findall(r"^test result: .*$", out, re.M)
        ok = r.returncode != 0
        caught += ok
        print(f"## {name}  ({rel})")
        print(f"   - {old.strip()}")
        print(f"   + {new.strip()}")
        print(f"   {'CAUGHT' if ok else 'SURVIVED'}: {', '.join(failed) or 'build failed'}")
        if summary:
            print(f"   {summary[0]}")
        if ok and not failed:
            print("   " + "\n   ".join(l for l in out.splitlines() if l.startswith("error"))[:600])
    print(f"\n{caught} of {len(MUTATIONS)} mutations caught")
    return 0 if caught == len(MUTATIONS) else 1

if __name__ == "__main__":
    sys.exit(main())
