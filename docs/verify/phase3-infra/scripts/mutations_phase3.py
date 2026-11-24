"""Phase 3 infra (I2, I3, Open folder) fail-then-pass run.

Each mutant puts back the behaviour from before the change ("without"), or breaks one security rule ("rule"), and the
named tests must FAIL on it. At the end every new test must have failed on at least one mutant: that is the proof that
each test fails without its change. The unmutated tree must pass first.

From packages/desktop/src-tauri:  python -I ../../../docs/verify/phase3-infra/scripts/mutations_phase3.py [first [last] | --only 5,21,26] [--targeted]
Restores every file after each mutant, also on failure or Ctrl+C. One cargo build at a time, -j 2 (low RAM PC).
--targeted runs only each mutant's named tests (`--exact`), or its module for an informational mutant; the target dir
is reused, so each mutant is one incremental build. After each mutant `git diff --stat -- <mutated file>` must be empty, or the run stops.
"""
import pathlib, re, subprocess, sys, time

L, S, H, F = "src/lib.rs", "src/server.rs", "src/hosts.rs", "src/folder.rs"

# (kind, what, file, old, new, tests that must fail)
MUTANTS = [
    # ---- I2: config ----
    ("without", "old configs load as they are (no migration)", L,
     "fn migrate_config(mut c: Config) -> Config {\n",
     "fn migrate_config(mut c: Config) -> Config {\n    if c.port > 0 { return c; }\n",
     ["tests::an_old_server_mode_config_loads_as_this_pc_plus_that_server", "tests::config_migration_is_idempotent_and_round_trips",
      "tests::a_leftover_host_on_a_local_config_is_not_a_server"]),
    ("without", "the tunnel may take the PC hub's port (migration)", L,
     "        if s.local_port == c.port {\n            s.local_port",
     "        if false && s.local_port == c.port {\n            s.local_port",
     ["tests::the_tunnel_never_takes_the_pc_hubs_port"]),
    ("rule", "validation lets the tunnel share the PC hub's port", L,
     "if s.local_port < 1024 || s.local_port == c.port {",
     "if s.local_port < 1024 {",
     ["tests::the_tunnel_never_takes_the_pc_hubs_port"]),
    ("without", "the settings page's 'remote' saved like an old file (moves the PC hub's port)", L,
     "fn from_settings_page(mut c: Config, current: Option<ServerEntry>) -> Config {\n",
     "fn from_settings_page(mut c: Config, current: Option<ServerEntry>) -> Config {\n    if c.mode != \"attach\" { if c.mode != \"remote\" { c.server = None; } let _ = &current; return migrate_config(c); }\n",
     ["tests::the_settings_page_adds_and_drops_the_server_without_moving_the_pc_hub"]),
    # ---- I2: webview, tunnel, tokens ----
    ("without", "the webview allows only the PC hub's port", L,
     "let hub = on_loopback_port(url, HUB_PORT.load(Ordering::Relaxed)) || on_loopback_port(url, SERVER_PORT.load(Ordering::Relaxed));",
     "let hub = on_loopback_port(url, HUB_PORT.load(Ordering::Relaxed));",
     ["tests::both_hubs_stay_in_the_webview_and_nothing_else_does"]),
    ("rule", "https (or any scheme) on a hub port counts as the hub", L,
     "    port != 0\n        && url.scheme() == \"http\"\n",
     "    port != 0\n",
     ["tests::both_hubs_stay_in_the_webview_and_nothing_else_does", "hosts::tests::other_origins_and_other_asks_are_not_host_asks",
      "folder::tests::only_the_pc_hubs_page_may_ask"]),
    ("without", "the tunnel's local end not bound to 127.0.0.1", L,
     'let fwd = format!("127.0.0.1:{local_port}:127.0.0.1:{hub_port}");',
     'let fwd = format!("{local_port}:127.0.0.1:{hub_port}");',
     ["tests::the_server_tunnel_listens_on_loopback_only_and_never_relaxes_host_keys"]),
    ("rule", "BatchMode dropped from the tunnel", L,
     '        "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=30",',
     '        "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=30",',
     ["tests::the_server_tunnel_listens_on_loopback_only_and_never_relaxes_host_keys"]),
    ("rule", "any hex string is taken as the server token", L,
     "let ok = token.len() == 32 && token.chars().all(|c| c.is_ascii_hexdigit());",
     "let ok = !token.is_empty() && token.chars().all(|c| c.is_ascii_hexdigit());",
     ["tests::only_a_32_hex_token_is_taken_from_the_server"]),
    ("without", "dropping the server clears the one shared token (the PC hub's)", S,
     "    inner.server.token.clear();\n",
     "    inner.server.token.clear();\n    inner.token.clear();\n",
     ["tests::dropping_the_server_never_touches_the_pc_hub_or_its_token"]),
    ("rule", "the server port stays allowed after the tunnel is dropped", S,
     "    inner.remote_claude = None;\n    SERVER_PORT.store(0, Ordering::Relaxed);\n",
     "    inner.remote_claude = None;\n",
     ["tests::dropping_the_server_never_touches_the_pc_hub_or_its_token"]),
    ("rule", "the server token rides in the query", S,
     '        url.push_str("#token=");',
     '        url.push_str("&token=");',
     ["server::tests::the_server_page_gets_its_own_token_only_in_the_fragment"]),
    # ---- I3: caps ----
    ("without", "the page is not told about host asks (no `hosts` cap)", L,
     'const CAPS: &str = if cfg!(windows) { "localcopy,studio,openfolder,hosts" } else { "localcopy,openfolder,hosts" };',
     'const CAPS: &str = if cfg!(windows) { "localcopy,studio,openfolder" } else { "localcopy,openfolder" };',
     ["tests::hub_url_always_says_desktop"]),
    ("without", "no `server` cap when a server is set up", L,
     'if has_server { format!("{CAPS},server") } else { CAPS.to_string() }',
     'let _ = has_server; CAPS.to_string()',
     ["tests::hub_url_always_says_desktop"]),
    # ---- I3: stubs on the wire ----
    ("without", "the server's reply is passed on unfiltered", S,
     "            Some((200, reply)) => match hosts::stubs_body(&reply) {",
     "            Some((200, reply)) => match Ok::<(String, usize), String>((reply, 0)) {",
     ["server::tests::a_refresh_reads_the_server_and_writes_only_to_this_pc"]),
    ("rule", "the PC hub is sent the server's token", S,
     "    let headers = bearer(&token, true);",
     "    let headers = bearer(&state.0.lock().unwrap().server.token.clone(), true); let _ = &token;",
     ["server::tests::a_refresh_reads_the_server_and_writes_only_to_this_pc"]),
    ("rule", "a failed read wipes the last stubs", S,
     'tell_pc_hub(state, body.as_deref().unwrap_or(r#"{"connected":true}"#));',
     'tell_pc_hub(state, body.as_deref().unwrap_or(r#"{"connected":true,"projects":[]}"#));',
     ["server::tests::a_failed_read_keeps_the_stubs_and_a_loss_marks_the_server_disconnected"]),
    ("without", "a loss is not told to the PC hub", H,
     'pub const DISCONNECTED: &str = r#"{"connected":false}"#;',
     'pub const DISCONNECTED: &str = r#"{"connected":true}"#;',
     ["server::tests::a_failed_read_keeps_the_stubs_and_a_loss_marks_the_server_disconnected"]),
    ("rule", "stubs are written to a hub that is not ours (attach: no token)", S,
     "(inner.status.connected && !inner.token.is_empty())",
     "(inner.status.connected)",
     ["server::tests::nothing_is_told_to_a_pc_hub_that_is_not_ours_or_not_up"]),
    # ---- I3: the stub filter ----
    ("rule", "slugs with a double dash pass", H,
     "        && !s.contains(\"--\")\n",
     "\n",
     ["hosts::tests::slugs_follow_the_hub_rule"]),
    ("rule", "the server's own stubs of other hosts are passed on", H,
     '            Some(h) => h.as_str() == Some("pc"),',
     '            Some(_) => true,',
     ["hosts::tests::stubs_are_the_servers_own_projects_with_slug_and_name_only"]),
    ("rule", "control and bidi characters pass", H,
     "|| name.chars().any(unsafe_char) ",
     "",
     ["hosts::tests::invalid_stubs_are_dropped_not_sent"]),
    ("rule", "names are not trimmed", H,
     'let name = o.get("name").and_then(|n| n.as_str()).map(js_trim);',
     'let name = o.get("name").and_then(|n| n.as_str()); let _ = js_trim;',
     ["hosts::tests::invalid_stubs_are_dropped_not_sent"]),
    ("rule", "name length counted in chars, not UTF-16 units as zod does", H,
     "let units = name.encode_utf16().count();",
     "let units = name.chars().count();",
     ["hosts::tests::invalid_stubs_are_dropped_not_sent"]),
    ("rule", "a slug may appear twice", H,
     "|| !seen.insert(slug.to_string()) {",
     "|| seen.insert(String::new()) && false {",
     ["hosts::tests::invalid_stubs_are_dropped_not_sent"]),
    ("rule", "no 500 cap", H,
     "        if out.len() == MAX_STUBS {\n            break;\n        }\n",
     "",
     ["hosts::tests::at_most_500_stubs_are_sent"]),
    ("rule", "a hub with no server is taught one (any project counts as 'connected')", H,
     ' && p.get("connected").and_then(|c| c.as_bool()) == Some(true)',
     '',
     ["hosts::tests::a_stale_connected_server_is_noticed_on_the_pc_hub"]),
    # ---- I3: the page's asks ----
    ("without", "no host asks at all", H,
     "    if !ours || !url.query_pairs().any(|(k, _)| KEYS.contains(&k.as_ref())) {",
     "    if true || !ours || !url.query_pairs().any(|(k, _)| KEYS.contains(&k.as_ref())) {",
     ["hosts::tests::the_page_can_ask_for_the_server_by_id_and_a_slug", "hosts::tests::the_page_can_never_pass_an_address_a_path_or_a_token"]),
    ("rule", "openproject takes any host before the colon", H,
     '("openproject", v) => v.strip_prefix("server:")',
     '("openproject", v) => v.split_once(\':\').map(|(_, s)| s)',
     ["hosts::tests::the_page_can_never_pass_an_address_a_path_or_a_token"]),
    ("rule", "extra parameters (a token) ride along", H,
     "    let ask = match pairs.as_slice() {",
     "    let ask = match &pairs[..1.min(pairs.len())] {",
     ["hosts::tests::the_page_can_never_pass_an_address_a_path_or_a_token"]),
    ("rule", "a fragment (a token) rides along", H,
     '[(k, v)] if url.path() == "/" && url.fragment().is_none() => match',
     '[(k, v)] if url.path() == "/" => match',
     ["hosts::tests::the_page_can_never_pass_an_address_a_path_or_a_token"]),
    ("rule", "any loopback port may ask", H,
     "let ours = crate::on_loopback_port(url, pc_port) || crate::on_loopback_port(url, server_port);",
     'let ours = matches!(url.host_str(), Some("127.0.0.1" | "localhost")) && url.scheme() == "http"; let _ = (pc_port, server_port);',
     ["hosts::tests::other_origins_and_other_asks_are_not_host_asks"]),
    # ---- I3: the loss clock ----
    ("without", "only ssh exiting counts (a quiet hub waits for ServerAlive, about 90 s)", H,
     "        self.strikes += 1;\n        self.strikes >= STRIKES || now.saturating_duration_since(self.last_ok) >= QUIET_FOR\n",
     "        self.strikes += 1;\n        let _ = now; false\n",
     ["hosts::tests::a_lost_tunnel_shows_within_30_seconds", "hosts::tests::one_or_two_missed_checks_are_not_a_loss",
      "hosts::tests::a_long_silence_is_a_loss_at_the_first_missed_check"]),
    ("rule", "five strikes", H,
     "pub const STRIKES: u32 = 3;", "pub const STRIKES: u32 = 5;",
     ["hosts::tests::one_or_two_missed_checks_are_not_a_loss"]),
    ("rule", "one missed check is a loss", H,
     "pub const STRIKES: u32 = 3;", "pub const STRIKES: u32 = 1;",
     ["hosts::tests::one_or_two_missed_checks_are_not_a_loss"]),
    ("rule", "no quiet deadline", H,
     " || now.saturating_duration_since(self.last_ok) >= QUIET_FOR\n",
     "\n",
     ["hosts::tests::a_long_silence_is_a_loss_at_the_first_missed_check"]),
    ("rule", "telling the PC hub may take 12 s (over the 30 s budget)", H,
     "pub const TELL_TIMEOUT: Duration = Duration::from_secs(2);",
     "pub const TELL_TIMEOUT: Duration = Duration::from_secs(12);",
     ["hosts::tests::a_lost_tunnel_shows_within_30_seconds"]),
    ("rule", "health checks may take 8 s", H,
     "pub const CHECK_TIMEOUT: Duration = Duration::from_secs(3);",
     "pub const CHECK_TIMEOUT: Duration = Duration::from_secs(8);",
     []),  # informational: the 20 s quiet deadline still keeps it inside 30 s (see the README)
    # ---- Open folder ----
    ("without", "no folder asks at all", F,
     '    if !url.query_pairs().any(|(k, _)| k == "openfolder") {',
     '    if true || !url.query_pairs().any(|(k, _)| k == "openfolder") {',
     ["folder::tests::the_page_can_ask_for_a_project_folder_by_slug", "folder::tests::paths_traversal_and_extra_parameters_are_refused",
      "folder::tests::only_the_pc_hubs_page_may_ask"]),
    ("without", "openfolder not advertised", L,
     'const CAPS: &str = if cfg!(windows) { "localcopy,studio,openfolder,hosts" } else { "localcopy,openfolder,hosts" };',
     'const CAPS: &str = if cfg!(windows) { "localcopy,studio,hosts" } else { "localcopy,hosts" };',
     ["tests::hub_url_always_says_desktop"]),
    ("rule", "any non-empty name is a folder name (paths, '..')", F,
     "    valid_slug(slug)\n        && !slug.contains(\"..\")",
     "    !slug.is_empty() || valid_slug(slug)\n        && !slug.contains(\"..\")",
     ["folder::tests::paths_traversal_and_extra_parameters_are_refused", "folder::tests::the_shell_resolves_an_existing_folder_under_projects_only"]),
    ("rule", "the server hub's page may ask (opens a same-named PC folder)", F,
     "    if crate::on_loopback_port(url, server_port) {\n        return Some(Err(ON_SERVER));\n    }\n",
     "",
     ["folder::tests::only_the_pc_hubs_page_may_ask"]),
    ("rule", "extra parameters (a path) ride along", F,
     "    let slug = match pairs.as_slice() {",
     "    let slug = match &pairs[..1.min(pairs.len())] {",
     ["folder::tests::paths_traversal_and_extra_parameters_are_refused"]),
    ("rule", "the folder isn't checked on disk (missing or a file)", F,
     '    let root = std::fs::canonicalize(data.join("projects")).map_err(|_| NOT_HERE)?;\n',
     '    if !slug.is_empty() { return Ok(data.join("projects").join(slug)); }\n    let root = std::fs::canonicalize(data.join("projects")).map_err(|_| NOT_HERE)?;\n',
     ["folder::tests::the_shell_resolves_an_existing_folder_under_projects_only", "folder::tests::it_opens_the_resolved_folder_once_per_cooldown"]),
    ("rule", "a junction out of projects/ is followed", F,
     "if !dir.is_dir() || dir.parent() != Some(root.as_path()) {",
     "if !dir.is_dir() {",
     ["folder::tests::a_junction_out_of_the_projects_folder_is_refused"]),
    ("rule", "no cooldown", F,
     "if l.as_ref().is_some_and(|(s, t)| s == slug && now.saturating_duration_since(*t) < COOLDOWN) {",
     "if false {",
     ["folder::tests::it_opens_the_resolved_folder_once_per_cooldown"]),
]

# Every test added in this phase; each must fail on at least one mutant above.
NEW_TESTS = sorted({t for m in MUTANTS for t in m[5]})


TARGETED = "--targeted" in sys.argv
if TARGETED:
    sys.argv.remove("--targeted")


def run_tests(filters=()):
    # Full test names run with --exact; a module prefix (ending in "::") runs as a substring filter.
    exact = ["--exact"] if filters and not filters[0].endswith("::") else []
    extra = ["--", *exact, *filters] if filters else []
    r = subprocess.run(["cargo", "test", "-j", "2", "--lib", *extra], capture_output=True, text=True, encoding="utf-8", errors="replace")
    out = r.stdout + r.stderr
    failed = set(re.findall(r"^test (\S+) \.\.\. FAILED", out, re.M))
    summary = (re.findall(r"^test result: .*$", out, re.M) or ["(no test result: build failed)"])[0]
    errors = [l for l in out.splitlines() if l.startswith("error")]
    return r.returncode, failed, summary, errors


def main() -> int:
    only = None
    if len(sys.argv) > 2 and sys.argv[1] == "--only":
        only = {int(x) for x in sys.argv[2].split(",")}
        first, last = 1, len(MUTANTS)
    else:
        first = int(sys.argv[1]) if len(sys.argv) > 1 else 1
        last = int(sys.argv[2]) if len(sys.argv) > 2 else len(MUTANTS)
    t0 = time.time()
    if first == 1:
        code, failed, summary, _ = run_tests()
        print(f"## 0. unmutated tree: {summary}", flush=True)
        if code != 0:
            print("   the tree must pass before mutating: " + ", ".join(sorted(failed)))
            return 1
    caught_tests, bad = set(), 0
    for i, (kind, what, rel, old, new, expect) in enumerate(MUTANTS, 1):
        if i < first or i > last or (only is not None and i not in only):
            continue
        p = pathlib.Path(rel)
        src = p.read_bytes()
        text = src.decode("utf-8")
        assert text.count(old) == 1, f"{i} {what}: anchor found {text.count(old)} times"
        try:
            p.write_bytes(text.replace(old, new).encode("utf-8"))
            module = {H: "hosts::tests::", S: "server::tests::", F: "folder::tests::", L: "tests::"}[rel]
            code, failed, summary, errors = run_tests((tuple(expect) or (module,)) if TARGETED else ())
        finally:
            p.write_bytes(src)
        # Scoped to the mutated file: another agent may be editing other files in this worktree at the same time.
        dirty = subprocess.run(["git", "diff", "--stat", "--", rel], capture_output=True, text=True).stdout.strip()
        if dirty:
            print(f"## tree not clean after mutant {i}: {dirty}")
            return 1
        missing = [t for t in expect if t not in failed]
        compiled = not (code != 0 and not failed)
        verdict = "CAUGHT" if (failed and not missing) else ("INFO" if not expect else "NOT CAUGHT")
        if expect and (missing or not compiled):
            bad += 1
        caught_tests |= set(expect) & failed
        print(f"## {i}. [{kind}] {what}  ({rel})", flush=True)
        print(f"   - {old.strip()[:160]}")
        print(f"   + {new.strip()[:160]}")
        print(f"   {verdict}: failed {', '.join(sorted(failed)) or '(none)'}")
        if missing:
            print(f"   expected to fail but passed: {', '.join(missing)}")
        if not compiled:
            print("   BUILD FAILED: " + " | ".join(errors)[:600])
        print(f"   {summary}", flush=True)
    print(f"\n{bad} mutant(s) not caught as expected; {len(MUTANTS)} mutants, {time.time() - t0:.0f} s")
    if first == 1 and last == len(MUTANTS) and only is None:
        never = [t for t in NEW_TESTS if t not in caught_tests]
        print(f"{len(NEW_TESTS) - len(never)} of {len(NEW_TESTS)} new tests failed on at least one mutant")
        for t in never:
            print(f"   never failed: {t}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
