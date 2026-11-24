//! I3 (spec toki-local-first-gamedev, Phase 3): what crosses between the two hosts, and what the page may ask.
//!
//! Only names cross, and only one way: the shell reads the server hub's `GET /api/projects` through the tunnel and
//! hands the PC hub project stubs (`PUT /api/hosts/server/projects`, slug and name only). Nothing is ever sent to the
//! server. The page asks with `window.open("<hub>/?openproject=server:<slug>")`, `?connecthost=server` or
//! `?openhost=pc|server`, which arrive in on_new_window like `?launch=studio`: it names a host id and a slug, never an
//! address, port or token. The shell has the server's address in its own config and the tokens in its own memory.

use std::time::{Duration, Instant};
use tauri::Url;

/// The rule `slugify()` in the hub produces and the stub route accepts (`PROJECT_SLUG_RE` in shared/src/hosts.ts):
/// lowercase letters, digits and single dashes, at most 40.
pub fn valid_slug(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 40
        && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !s.starts_with('-')
        && !s.ends_with('-')
        && !s.contains("--")
}

/// What the page may ask for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Ask {
    /// Open a project that lives on the server (connecting first if needed).
    ServerProject(String),
    /// Connect to the server and refresh its projects, staying on this page.
    ConnectServer,
    /// The server hub's own page.
    ServerHome,
    /// Back to this PC's hub.
    PcHome,
}

pub const REFUSED: &str = "Toki can only open your server or one of its projects from here.";
const KEYS: &[&str] = &["openproject", "connecthost", "openhost"];

/// None when the URL is not a host ask. Some(Err) for one that is refused: anything but exactly one of the three
/// parameters on `/` of either hub's own origin, with a value naming a host id (and a slug), and no fragment.
pub fn request(url: &Url, pc_port: u16, server_port: u16) -> Option<Result<Ask, &'static str>> {
    let ours = crate::on_loopback_port(url, pc_port) || crate::on_loopback_port(url, server_port);
    if !ours || !url.query_pairs().any(|(k, _)| KEYS.contains(&k.as_ref())) {
        return None;
    }
    let pairs: Vec<(String, String)> = url.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
    let ask = match pairs.as_slice() {
        [(k, v)] if url.path() == "/" && url.fragment().is_none() => match (k.as_str(), v.as_str()) {
            ("openproject", v) => v.strip_prefix("server:").filter(|s| valid_slug(s)).map(|s| Ask::ServerProject(s.to_string())),
            ("connecthost", "server") => Some(Ask::ConnectServer),
            ("openhost", "server") => Some(Ask::ServerHome),
            ("openhost", "pc") => Some(Ask::PcHome),
            _ => None,
        },
        _ => None,
    };
    Some(ask.ok_or(REFUSED))
}

/// `MAX_STUBS_PER_HOST` in shared/src/hosts.ts.
pub const MAX_STUBS: usize = 500;
/// `ProjectNameSchema`: at most 60 (UTF-16 units, as zod counts) after trimming.
const MAX_NAME_UNITS: usize = 60;

/// JS `String.prototype.trim` (what zod's `.trim()` runs): Unicode white space plus U+FEFF.
fn js_trim(s: &str) -> &str {
    s.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

/// The hub's `UNSAFE_TEXT`: C0/C1 controls and the bidi marks, embeddings, overrides and isolates.
fn unsafe_char(c: char) -> bool {
    matches!(c, '\u{0}'..='\u{1f}' | '\u{7f}'..='\u{9f}' | '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
}

/// The PUT body for the PC hub, from the server hub's `GET /api/projects` reply: `{"connected":true,"projects":[…]}`
/// with the server's own projects only (`host` "pc" on that hub, or no host from a hub older than B10; never its own
/// stubs of other hosts), slug and name only, invalid ones dropped, each slug once, at most 500. Err when the reply
/// isn't a list, so a broken answer never replaces the last good stubs.
pub fn stubs_body(server_projects: &str) -> Result<(String, usize), String> {
    let v: serde_json::Value = serde_json::from_str(server_projects.trim()).map_err(|_| "The server sent an unreadable project list.".to_string())?;
    let list = v.as_array().ok_or("The server's project list isn't a list.")?;
    let mut out: Vec<serde_json::Value> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for p in list {
        if out.len() == MAX_STUBS {
            break;
        }
        let Some(o) = p.as_object() else { continue };
        let own = match o.get("host") {
            None => true,
            Some(h) => h.as_str() == Some("pc"),
        };
        let slug = o.get("slug").and_then(|s| s.as_str()).filter(|s| valid_slug(s));
        let name = o.get("name").and_then(|n| n.as_str()).map(js_trim);
        let (Some(slug), Some(name)) = (slug, name) else { continue };
        let units = name.encode_utf16().count();
        if !own || units == 0 || units > MAX_NAME_UNITS || name.chars().any(unsafe_char) || !seen.insert(slug.to_string()) {
            continue;
        }
        out.push(serde_json::json!({ "slug": slug, "name": name }));
    }
    let n = out.len();
    Ok((serde_json::json!({ "connected": true, "projects": out }).to_string(), n))
}

/// The PUT body that marks the server disconnected. It keeps the last stubs (no `projects`).
pub const DISCONNECTED: &str = r#"{"connected":false}"#;

/// Whether the PC hub's `GET /api/projects` still shows the server as connected (stale after a crash or a removed
/// server). Checked instead of always sending DISCONNECTED, which would make a hub that never had a server know one.
pub fn shows_server_connected(pc_projects: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(pc_projects.trim())
        .ok()
        .and_then(|v| v.as_array().cloned())
        .is_some_and(|l| l.iter().any(|p| p.get("host").and_then(|h| h.as_str()) == Some("server") && p.get("connected").and_then(|c| c.as_bool()) == Some(true)))
}

/// How often the stubs are read again while the tunnel is up.
pub const REFRESH_EVERY: Duration = Duration::from_secs(5 * 60);
/// The tunnel watch's pause between checks.
pub const CHECK_EVERY: Duration = Duration::from_secs(3);
/// The read timeout of one health check through the tunnel (local_http adds a 500 ms connect timeout).
pub const CHECK_TIMEOUT: Duration = Duration::from_secs(3);
/// The read timeout of the PUT that tells the PC hub.
pub const TELL_TIMEOUT: Duration = Duration::from_secs(2);
/// Failed checks in a row that make the tunnel lost.
pub const STRIKES: u32 = 3;
/// A hub silent this long after its last answer is lost, however few checks ran (a sleeping laptop, slow checks).
pub const QUIET_FOR: Duration = Duration::from_secs(20);

/// The loss clock. Fed by the watch loop with the time, whether ssh still runs and whether the hub answered.
#[derive(Debug)]
pub struct Watch {
    last_ok: Instant,
    strikes: u32,
}

impl Watch {
    pub fn new(now: Instant) -> Self {
        Watch { last_ok: now, strikes: 0 }
    }

    /// True once the tunnel counts as lost: ssh exited, or STRIKES missed checks in a row, or QUIET_FOR without an
    /// answer.
    pub fn tick(&mut self, now: Instant, tunnel_running: bool, answered: bool) -> bool {
        if !tunnel_running {
            return true;
        }
        if answered {
            self.last_ok = now;
            self.strikes = 0;
            return false;
        }
        self.strikes += 1;
        self.strikes >= STRIKES || now.saturating_duration_since(self.last_ok) >= QUIET_FOR
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn slugs_follow_the_hub_rule() {
        for ok in ["a", "my-game", "game2", "a-b-c", &"x".repeat(40)] {
            assert!(valid_slug(ok), "{ok}");
        }
        for bad in [
            "", "-a", "a-", "a--b", "A", "My-Game", "a_b", "a.b", "..", "../x", "a/b", r"a\b", "C:", "C:\\x", "/abs", "a b", "é",
            "%2e%2e", &"x".repeat(41),
        ] {
            assert!(!valid_slug(bad), "{bad:?}");
        }
    }

    #[test]
    fn the_page_can_ask_for_the_server_by_id_and_a_slug() {
        for port in [7788, 7790] {
            let at = |q: &str| request(&u(&format!("http://127.0.0.1:{port}/{q}")), 7788, 7790);
            assert_eq!(at("?openproject=server:my-game"), Some(Ok(Ask::ServerProject("my-game".into()))));
            assert_eq!(at("?openproject=server%3Amy-game"), Some(Ok(Ask::ServerProject("my-game".into()))));
            assert_eq!(at("?connecthost=server"), Some(Ok(Ask::ConnectServer)));
            assert_eq!(at("?openhost=server"), Some(Ok(Ask::ServerHome)));
            assert_eq!(at("?openhost=pc"), Some(Ok(Ask::PcHome)));
        }
        assert_eq!(request(&u("http://localhost:7788/?connecthost=server"), 7788, 0), Some(Ok(Ask::ConnectServer)));
    }

    #[test]
    fn the_page_can_never_pass_an_address_a_path_or_a_token() {
        for bad in [
            // other hosts, by name or address
            "?connecthost=crm", "?connecthost=crm-agency", "?connecthost=root@1.2.3.4", "?connecthost=1.2.3.4", "?connecthost=-oProxyCommand=calc",
            "?connecthost=Server", "?connecthost=server%20", "?connecthost=", "?connecthost=pc", "?openhost=crm", "?openhost=127.0.0.1:7790",
            "?openproject=crm:my-game", "?openproject=pc:my-game", "?openproject=127.0.0.1:7790:my-game", "?openproject=ssh://crm/my-game",
            "?openproject=http://evil.example/x", "?openproject=my-game", "?openproject=server:", "?openproject=server",
            // paths and traversal
            "?openproject=server:..", "?openproject=server:../x", "?openproject=server:..%2F..%2Fdata", "?openproject=server:a/b",
            "?openproject=server:a%5Cb", "?openproject=server:C:%5CWindows", "?openproject=server:%2Fetc%2Fpasswd", "?openproject=server:My-Game",
            // tokens and anything else riding along
            "?openproject=server:my-game&token=0123456789abcdef0123456789abcdef", "?connecthost=server&token=abc",
            "?token=abc&connecthost=server", "?connecthost=server&host=evil.example", "?connecthost=server&port=22",
            "?openhost=server&openproject=server:x", "?connecthost=server&connecthost=server",
            "?openproject=server:my-game#token=0123456789abcdef0123456789abcdef", "?connecthost=server#x",
        ] {
            assert_eq!(request(&u(&format!("http://127.0.0.1:7788/{bad}")), 7788, 7790), Some(Err(REFUSED)), "{bad}");
        }
        assert_eq!(request(&u("http://127.0.0.1:7788/api/x?connecthost=server"), 7788, 7790), Some(Err(REFUSED)));
    }

    #[test]
    fn other_origins_and_other_asks_are_not_host_asks() {
        assert_eq!(request(&u("http://127.0.0.1:7789/?connecthost=server"), 7788, 7790), None);
        assert_eq!(request(&u("http://127.0.0.1:7790/?connecthost=server"), 7788, 0), None, "no tunnel up: 7790 is not ours");
        assert_eq!(request(&u("https://127.0.0.1:7788/?connecthost=server"), 7788, 7790), None);
        assert_eq!(request(&u("http://evil.example:7788/?connecthost=server"), 7788, 7790), None);
        assert_eq!(request(&u("http://127.0.0.1:7788/?launch=studio"), 7788, 7790), None);
        assert_eq!(request(&u("http://127.0.0.1:7788/?popout=b"), 7788, 7790), None);
    }

    fn body(json: &str) -> serde_json::Value {
        serde_json::from_str(&stubs_body(json).unwrap().0).unwrap()
    }

    #[test]
    fn stubs_are_the_servers_own_projects_with_slug_and_name_only() {
        let reply = r#"[
            {"slug":"tower-defense","name":"Tower Defense","host":"pc","members":["b1"],"roomId":"r1","path":"/home/x/p","createdAt":1},
            {"slug":"old-hub","name":"From a hub before B10"},
            {"slug":"pc-thing","name":"The PC's own stub, held on the server","host":"server","seenAt":1,"connected":true},
            {"slug":"other","name":"A third host","host":"laptop"},
            {"slug":"weird","name":"host is not a string","host":1}
        ]"#;
        assert_eq!(
            body(reply),
            serde_json::json!({"connected":true,"projects":[{"slug":"tower-defense","name":"Tower Defense"},{"slug":"old-hub","name":"From a hub before B10"}]})
        );
        assert_eq!(body("[]"), serde_json::json!({"connected":true,"projects":[]}));
    }

    #[test]
    fn invalid_stubs_are_dropped_not_sent() {
        let long = "n".repeat(61);
        let sixty_wide = "😀".repeat(30); // 60 UTF-16 units: the most zod takes
        let too_wide = "😀".repeat(31);
        let reply = serde_json::json!([
            {"slug":"ok","name":"  Trimmed  "},
            {"slug":"Bad-Slug","name":"x"}, {"slug":"../up","name":"x"}, {"slug":"a/b","name":"x"}, {"slug":"","name":"x"},
            {"slug":"no-name"}, {"slug":"blank","name":"   "}, {"slug":"bom","name":"\u{feff}"}, {"slug":"long","name":long},
            {"slug":"wide","name":sixty_wide}, {"slug":"too-wide","name":too_wide},
            {"slug":"ctl","name":"a\u{7}b"}, {"slug":"nl","name":"a\nb"}, {"slug":"bidi","name":"evil\u{202e}gpj.exe"},
            {"slug":"iso","name":"a\u{2066}b"}, {"slug":"num","name":5}, "not an object", null,
            {"slug":"ok","name":"Duplicate slug"}
        ])
        .to_string();
        let got = body(&reply);
        let slugs: Vec<&str> = got["projects"].as_array().unwrap().iter().map(|p| p["slug"].as_str().unwrap()).collect();
        assert_eq!(slugs, ["ok", "wide"]);
        assert_eq!(got["projects"][0]["name"], "Trimmed");
        for p in got["projects"].as_array().unwrap() {
            assert_eq!(p.as_object().unwrap().len(), 2, "slug and name only: {p}");
        }
        assert!(stubs_body("{\"error\":\"Unauthorized\"}").is_err(), "a refusal never replaces the stubs");
        assert!(stubs_body("<html>").is_err());
        assert!(stubs_body("[{\"slug\":\"trunc").is_err(), "a cut-off reply never replaces the stubs");
    }

    #[test]
    fn at_most_500_stubs_are_sent() {
        let many: Vec<_> = (0..600).map(|i| serde_json::json!({"slug": format!("p{i}"), "name": format!("Project {i}")})).collect();
        let (json, n) = stubs_body(&serde_json::Value::Array(many).to_string()).unwrap();
        assert_eq!(n, 500);
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(v["projects"].as_array().unwrap().len(), MAX_STUBS);
        assert_eq!(v["projects"][499]["slug"], "p499");
        // The cap counts what is sent: dropped ones don't use it up.
        let mut mixed: Vec<_> = (0..300).map(|i| serde_json::json!({"slug": format!("bad_{i}"), "name": "x"})).collect();
        mixed.extend((0..520).map(|i| serde_json::json!({"slug": format!("g{i}"), "name": "x"})));
        assert_eq!(stubs_body(&serde_json::Value::Array(mixed).to_string()).unwrap().1, 500);
    }

    /// Writes what the filter makes of every fixture above to `target/stub-bodies/`, where
    /// `docs/verify/phase3-infra/scripts/stub_bodies_vs_schema.ts` checks each against the hub's own zod schema.
    #[test]
    fn stub_bodies_are_written_for_the_hub_schema_check() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target").join("stub-bodies");
        std::fs::create_dir_all(&dir).unwrap();
        let mixed = serde_json::json!([
            {"slug":"ok","name":"  Trimmed  "}, {"slug":"Bad-Slug","name":"x"}, {"slug":"blank","name":"   "},
            {"slug":"bom","name":"\u{feff}"}, {"slug":"wide","name":"😀".repeat(30)}, {"slug":"too-wide","name":"😀".repeat(31)},
            {"slug":"long","name":"n".repeat(61)}, {"slug":"sixty","name":"n".repeat(60)}, {"slug":"nbsp","name":"\u{a0}Spaced\u{3000}"},
            {"slug":"ctl","name":"a\u{7}b"}, {"slug":"bidi","name":"evil\u{202e}gpj.exe"}, {"slug":"ok","name":"dupe"},
            {"slug":"stub","name":"x","host":"server"}, {"slug":"emoji-ok","name":"Café ☕ 世界"}
        ]);
        let many: Vec<_> = (0..600).map(|i| serde_json::json!({"slug": format!("p{i}"), "name": format!("Project {i}")})).collect();
        for (name, reply) in [("mixed", mixed.to_string()), ("many", serde_json::Value::Array(many).to_string()), ("empty", "[]".into())] {
            std::fs::write(dir.join(format!("{name}.json")), stubs_body(&reply).unwrap().0).unwrap();
        }
        std::fs::write(dir.join("disconnected.json"), DISCONNECTED).unwrap();
    }

    #[test]
    fn a_stale_connected_server_is_noticed_on_the_pc_hub() {
        assert!(shows_server_connected(r#"[{"slug":"a","host":"pc"},{"slug":"b","host":"server","connected":true}]"#));
        assert!(!shows_server_connected(r#"[{"slug":"b","host":"server","connected":false}]"#));
        assert!(!shows_server_connected(r#"[{"slug":"a","host":"pc"}]"#), "a hub with no server is never told about one");
        assert!(!shows_server_connected("not json"));
    }

    /// Runs the watch with a fake clock: checks `gap` apart, the hub answering until `dies` and ssh running until
    /// `ssh_exits`. Returns when the watch called it lost.
    fn lost_at(gap: Duration, dies: Duration, ssh_exits: Option<Duration>) -> Duration {
        let t0 = Instant::now();
        let mut w = Watch::new(t0);
        let mut t = Duration::ZERO;
        loop {
            t += gap;
            let running = ssh_exits.is_none_or(|e| t < e);
            if w.tick(t0 + t, running, running && t < dies) {
                return t;
            }
            assert!(t < Duration::from_secs(600), "never lost");
        }
    }

    /// The spec's promise: a lost tunnel shows as disconnected within this.
    const SHOWN_WITHIN: Duration = Duration::from_secs(30);
    /// local_http's connect timeout, on top of each read timeout.
    const CONNECT: Duration = Duration::from_millis(500);

    #[test]
    fn a_lost_tunnel_shows_within_30_seconds() {
        // The slowest loop: the pause plus a check that times out every time. Then the PUT, at its slowest.
        let slowest = CHECK_EVERY + CONNECT + CHECK_TIMEOUT;
        const TELL_TAKES_AT_MOST: Duration = Duration::from_millis(500 + TELL_TIMEOUT.as_millis() as u64);
        for gap in [Duration::from_secs(1), CHECK_EVERY, slowest] {
            for dies_ms in [0u64, 1, 2900, 3000, 6400, 6600, 13_000, 60_000] {
                let dies = Duration::from_millis(dies_ms);
                let lost = lost_at(gap, dies, None);
                assert!(lost >= dies, "never before it happened (gap {gap:?}, dies {dies:?})");
                let shown = lost - dies + TELL_TAKES_AT_MOST;
                assert!(shown <= SHOWN_WITHIN, "gap {gap:?}, dies {dies:?}: shown after {shown:?}");
            }
        }
        // ssh exiting is lost at the next tick, answering or not.
        assert_eq!(lost_at(CHECK_EVERY, Duration::from_secs(999), Some(Duration::from_secs(7))), Duration::from_secs(9));
    }

    #[test]
    fn one_or_two_missed_checks_are_not_a_loss() {
        let t0 = Instant::now();
        let mut w = Watch::new(t0);
        let s = |n: u64| t0 + Duration::from_secs(n);
        assert!(!w.tick(s(3), true, false));
        assert!(!w.tick(s(6), true, false));
        assert!(!w.tick(s(9), true, true), "an answer clears the misses");
        assert!(!w.tick(s(12), true, false));
        assert!(!w.tick(s(15), true, false));
        assert!(w.tick(s(18), true, false));
    }

    #[test]
    fn a_long_silence_is_a_loss_at_the_first_missed_check() {
        // The PC slept: the next check comes a minute later and fails. No waiting for two more.
        let t0 = Instant::now();
        let mut w = Watch::new(t0);
        assert!(w.tick(t0 + Duration::from_secs(60), true, false));
    }
}
