//! I2 (spec toki-local-first-gamedev, Phase 3: one app, two hosts). The hub on this PC always runs and is the
//! primary host (owner decision 6). A configured server is a second host, reached through its own tunnel:
//!  - `ssh -N -L 127.0.0.1:<local>:127.0.0.1:<hub>` on its own local port (default 7790), never the PC hub's;
//!  - opened only when asked ([`connect`]), never at launch, and never in place of the PC hub: nothing here
//!    touches `Inner::child`, `Inner::token` or `Inner::generation`, so the tunnel can't stop the local hub;
//!  - with the server hub's own token, read over SSH from `<dir>/data/hub-token` (32 hex characters or nothing).
//!
//! A port already in use is refused rather than reused: whatever listens there would be handed the server token.

use crate::hosts;
use crate::proc::{kill_tree, Tail};
use crate::{AppState, Inner, ServerEntry, SERVER_PORT};
use std::process::Child;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

/// The server tunnel's state, inside `Inner` (so under the same lock as everything else).
#[derive(Default)]
pub struct Link {
    /// Bumped by every connect and stop; a worker whose generation is old gives up.
    pub gen: u64,
    pub child: Option<Child>,
    /// The server hub's token. Never the PC hub's, never logged.
    pub token: String,
    pub connected: bool,
    pub connecting: bool,
    pub error: Option<String>,
    /// What to show once a connect in progress is up (a later ask replaces an earlier one).
    pub then: Open,
}

/// What the main window shows once the tunnel is up.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum Open {
    /// Stay where it is (Connect only refreshes the server's projects).
    #[default]
    Nothing,
    /// The server hub's own page.
    Home,
    /// A project on the server, by slug (already validated by the caller).
    Project(String),
}

/// How long the tunnel gets to show a hub behind it.
const UP_WITHIN: Duration = Duration::from_secs(60);

/// Close the tunnel, if any, and forget its token. Callers hold the lock (nothing here waits).
pub fn stop(inner: &mut Inner) {
    inner.server.gen += 1;
    if let Some(mut c) = inner.server.child.take() {
        kill_tree(&mut c);
    }
    inner.server.token.clear();
    inner.server.connected = false;
    inner.server.connecting = false;
    inner.server.then = Open::Nothing;
    inner.remote_claude = None;
    SERVER_PORT.store(0, Ordering::Relaxed);
}

fn stale(state: &AppState, gen: u64) -> bool {
    let inner = state.0.lock().unwrap_or_else(|e| e.into_inner());
    inner.quitting || inner.server.gen != gen
}

/// Open the tunnel if it isn't, then show `then`. Returns at once; the work runs on its own thread.
pub fn connect(app: AppHandle, state: AppState, then: Open) {
    let (entry, gen) = {
        let mut inner = state.0.lock().unwrap_or_else(|e| e.into_inner());
        if inner.quitting {
            return;
        }
        let Some(entry) = inner.config.server.clone() else {
            drop(inner);
            crate::tell(&app, "No server is set up", "Add your server in Connection settings, then try again.");
            return;
        };
        if inner.server.connected {
            let token = inner.server.token.clone();
            drop(inner);
            show(&app, entry.local_port, &token, &then);
            return;
        }
        if inner.server.connecting {
            if then != Open::Nothing {
                inner.server.then = then;
            }
            return;
        }
        inner.server.gen += 1;
        inner.server.connecting = true;
        inner.server.error = None;
        inner.server.then = then;
        (entry, inner.server.gen)
    };
    std::thread::spawn(move || run(app, state, entry, gen));
}

fn run(app: AppHandle, state: AppState, entry: ServerEntry, gen: u64) {
    let started = start(&entry, &|| stale(&state, gen));
    let (child, token, tail) = match started {
        Ok(up) => up,
        Err(why) => {
            {
                let mut inner = state.0.lock().unwrap_or_else(|e| e.into_inner());
                if inner.quitting || inner.server.gen != gen {
                    return;
                }
                inner.server.connecting = false;
                inner.server.then = Open::Nothing;
                inner.server.error = Some(why.clone());
            }
            // I3: the page that asked waits for `hosts.changed`; this ends its working state.
            tell_pc_hub(&state, hosts::DISCONNECTED);
            crate::tell(&app, "Couldn't connect to your server", &why);
            return;
        }
    };
    let then = {
        let mut inner = state.0.lock().unwrap_or_else(|e| e.into_inner());
        if inner.quitting || inner.server.gen != gen {
            drop(inner);
            let mut c = child;
            kill_tree(&mut c);
            return;
        }
        inner.server.child = Some(child);
        inner.server.token = token.clone();
        inner.server.connected = true;
        inner.server.connecting = false;
        SERVER_PORT.store(entry.local_port, Ordering::Relaxed);
        std::mem::take(&mut inner.server.then)
    };
    // I3: the stubs first, so the PC hub's list is fresh by the time the page shows the project.
    refresh(&state, &entry);
    show(&app, entry.local_port, &token, &then);
    watch(&app, &state, &entry, gen, &tail);
}

/// Tunnel, token, then a hub answering through it. Cancelled (and the ssh killed) as soon as `cancel` says so.
fn start(e: &ServerEntry, cancel: &dyn Fn() -> bool) -> Result<(Child, String, Tail), String> {
    crate::ssh::validate_host(&e.ssh_host)?;
    if crate::port_open(e.local_port) {
        return Err(format!(
            "Port {} on this PC is already in use, so the tunnel to {} can't listen there. Close what uses it, or give the server another port.",
            e.local_port, e.ssh_host
        ));
    }
    let tail = Tail::default();
    let mut child = crate::spawn_tunnel(&e.ssh_host, e.local_port, e.hub_port, &tail)?;
    // Same SSH access the tunnel uses. Without it the server page asks for its token, which still works.
    let token = crate::fetch_remote_token(&e.ssh_host, cancel).unwrap_or_default();
    let began = Instant::now();
    loop {
        if cancel() {
            kill_tree(&mut child);
            return Err("Cancelled.".into());
        }
        if let Ok(Some(_)) = child.try_wait() {
            return Err(crate::ssh::explain(&tail.text(), &e.ssh_host, e.local_port));
        }
        if crate::hub_responding(e.local_port, Duration::from_millis(1500)) {
            return Ok((child, token, tail));
        }
        if began.elapsed() > UP_WITHIN {
            kill_tree(&mut child);
            return Err(format!(
                "No answer from the hub on {} through the tunnel after 60 s. On the server: systemctl status pocketrocket",
                e.ssh_host
            ));
        }
        std::thread::sleep(Duration::from_millis(500));
    }
}

/// What the shell does for the server hub's page: only the host asks (`openhost=pc` is its way back). Not
/// `openfolder`, `localcopy` or `studio`: those act on this PC, for the PC hub's page.
pub const SERVER_CAPS: &str = "hosts";

/// The server hub's page. The token rides only in the fragment, as for the PC hub.
pub fn server_url(port: u16, token: &str, then: &Open) -> String {
    let mut url = format!("http://127.0.0.1:{port}/?desktop=1&caps={SERVER_CAPS}&host=server");
    if let Open::Project(slug) = then {
        url.push_str("&project=");
        url.push_str(slug);
    }
    if !token.is_empty() {
        url.push_str("#token=");
        url.push_str(token);
    }
    url
}

fn show(app: &AppHandle, port: u16, token: &str, then: &Open) {
    if *then == Open::Nothing {
        return;
    }
    crate::show_main_window(app);
    crate::navigate(app, &server_url(port, token, then));
}

/// While the tunnel is up: the loss clock ([`hosts::Watch`]) every CHECK_EVERY, and the stubs every REFRESH_EVERY.
fn watch(app: &AppHandle, state: &AppState, e: &ServerEntry, gen: u64, tail: &Tail) {
    let mut clock = hosts::Watch::new(Instant::now());
    let mut next_refresh = Instant::now() + hosts::REFRESH_EVERY;
    loop {
        std::thread::sleep(hosts::CHECK_EVERY);
        let running = {
            let mut inner = state.0.lock().unwrap_or_else(|e| e.into_inner());
            if inner.quitting || inner.server.gen != gen {
                return;
            }
            inner.server.child.as_mut().is_some_and(|c| matches!(c.try_wait(), Ok(None)))
        };
        let answered = running && crate::hub_responding(e.local_port, hosts::CHECK_TIMEOUT);
        if clock.tick(Instant::now(), running, answered) {
            let why = if running {
                format!("The hub on {} stopped answering through the tunnel.", e.ssh_host)
            } else {
                crate::ssh::explain(&tail.text(), &e.ssh_host, e.local_port)
            };
            return lose(app, state, e, gen, why);
        }
        if Instant::now() >= next_refresh {
            refresh(state, e);
            next_refresh = Instant::now() + hosts::REFRESH_EVERY;
        }
    }
}

/// The tunnel is gone: close it, tell the PC hub (its stubs stay, marked disconnected), and if the main window shows
/// the server, bring back this PC's hub. The local hub itself is untouched throughout.
fn lose(app: &AppHandle, state: &AppState, e: &ServerEntry, gen: u64, why: String) {
    {
        let mut inner = state.0.lock().unwrap_or_else(|e| e.into_inner());
        if inner.quitting || inner.server.gen != gen {
            return;
        }
        stop(&mut inner);
        inner.server.error = Some(why.clone());
    }
    tell_pc_hub(state, hosts::DISCONNECTED);
    let on_server = app
        .get_webview_window("main")
        .and_then(|w| w.url().ok())
        .is_some_and(|u| u.port_or_known_default() == Some(e.local_port));
    if on_server {
        crate::show_pc_hub(app, state);
    }
    crate::tell(app, &format!("Lost the connection to {}", e.ssh_host), &why);
}

/// The PC hub's port and token, when it is up and ours (attach mode has no token).
fn pc_hub(state: &AppState) -> Option<(u16, String)> {
    let inner = state.0.lock().unwrap_or_else(|e| e.into_inner());
    (inner.status.connected && !inner.token.is_empty()).then(|| (inner.config.port, inner.token.clone()))
}

/// Request headers for a hub, with its token. Built here only; never logged.
fn bearer(token: &str, json: bool) -> String {
    let mut h = format!("Authorization: Bearer {token}\r\n");
    if json {
        h.push_str("Content-Type: application/json\r\n");
    }
    h
}

/// `PUT /api/hosts/server/projects` on the PC hub. The only write this module makes, and only to this PC.
fn tell_pc_hub(state: &AppState, body: &str) -> bool {
    let Some((port, token)) = pc_hub(state) else { return false };
    let headers = bearer(&token, true);
    match crate::local_http(port, "PUT", "/api/hosts/server/projects", &headers, body, hosts::TELL_TIMEOUT) {
        Some((200, _)) => true,
        Some((code, _)) => {
            eprintln!("the hub on this PC refused the server's project list ({code})");
            false
        }
        None => false,
    }
}

/// Read the server hub's projects through the tunnel and hand the PC hub their names. A failed read leaves the last
/// stubs as they are; the tunnel is still up, so the host is still marked connected.
fn refresh(state: &AppState, e: &ServerEntry) {
    let token = state.0.lock().unwrap_or_else(|e| e.into_inner()).server.token.clone();
    let body = if token.is_empty() {
        None
    } else {
        let headers = bearer(&token, false);
        match crate::local_http_max(e.local_port, "GET", "/api/projects", &headers, "", Duration::from_secs(10), 2 * 1024 * 1024) {
            Some((200, reply)) => match hosts::stubs_body(&reply) {
                Ok((body, _)) => Some(body),
                Err(why) => {
                    eprintln!("server projects not refreshed: {why}");
                    None
                }
            },
            Some((code, _)) => {
                eprintln!("server projects not refreshed: the server hub answered {code}");
                None
            }
            None => None,
        }
    };
    tell_pc_hub(state, body.as_deref().unwrap_or(r#"{"connected":true}"#));
}

/// Once the PC hub is up (first start, restart, new token): bring its stubs up to date. With the tunnel up that is a
/// refresh; without it, a stale "connected" from an earlier run (a crash, a removed server) is cleared.
pub fn on_pc_hub_up(state: AppState) {
    std::thread::spawn(move || {
        let (connected, entry) = {
            let inner = state.0.lock().unwrap_or_else(|e| e.into_inner());
            (inner.server.connected, inner.config.server.clone())
        };
        if let (true, Some(e)) = (connected, entry.as_ref()) {
            return refresh(&state, e);
        }
        let Some((port, token)) = pc_hub(&state) else { return };
        let headers = bearer(&token, false);
        let listed = crate::local_http_max(port, "GET", "/api/projects", &headers, "", Duration::from_secs(5), 2 * 1024 * 1024);
        if let Some((200, reply)) = listed {
            if hosts::shows_server_connected(&reply) {
                tell_pc_hub(&state, hosts::DISCONNECTED);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_server_page_gets_its_own_token_only_in_the_fragment() {
        let t = "0123456789abcdef0123456789abcdef";
        assert_eq!(server_url(7790, t, &Open::Home), format!("http://127.0.0.1:7790/?desktop=1&caps=hosts&host=server#token={t}"));
        assert_eq!(
            server_url(7790, t, &Open::Project("my-game".into())),
            format!("http://127.0.0.1:7790/?desktop=1&caps=hosts&host=server&project=my-game#token={t}")
        );
        // Without a token the page asks for one (the old fallback); nothing else carries it.
        assert_eq!(server_url(7790, "", &Open::Home), "http://127.0.0.1:7790/?desktop=1&caps=hosts&host=server");
        let u = tauri::Url::parse(&server_url(7790, t, &Open::Home)).unwrap();
        assert!(!u.query().unwrap_or("").contains(t), "the token never goes in the query");
    }

    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    /// A fake hub on 127.0.0.1: answers every request with `status` and `body`, and keeps each request's text.
    fn fake_hub(status: u16, body: &'static str) -> (u16, Arc<Mutex<Vec<String>>>) {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        std::thread::spawn(move || {
            for s in l.incoming() {
                let Ok(mut s) = s else { return };
                let _ = s.set_read_timeout(Some(Duration::from_secs(2)));
                let mut buf = Vec::new();
                let mut chunk = [0u8; 4096];
                // Headers, then Content-Length bytes of body.
                loop {
                    let n = s.read(&mut chunk).unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                    let text = String::from_utf8_lossy(&buf).to_string();
                    if let Some((head, rest)) = text.split_once("\r\n\r\n") {
                        let len = head.lines().find_map(|l| l.strip_prefix("Content-Length: ")).and_then(|v| v.trim().parse().ok()).unwrap_or(0);
                        if rest.len() >= len {
                            break;
                        }
                    }
                }
                log.lock().unwrap().push(String::from_utf8_lossy(&buf).to_string());
                let _ = write!(s, "HTTP/1.0 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", body.len());
            }
        });
        (port, seen)
    }

    const PC_TOKEN: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const SERVER_TOKEN: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    fn state_for(pc_port: u16, server_token: &str) -> AppState {
        let mut config = crate::Config { port: pc_port, ..Default::default() };
        config.server = Some(ServerEntry { ssh_host: "crm".into(), local_port: 1, hub_port: 7788 });
        let mut status = crate::Status::default();
        status.connected = true;
        let server = Link { token: server_token.into(), connected: true, ..Default::default() };
        AppState(Arc::new(Mutex::new(Inner {
            config, status, child: None, child_kind: "hub", generation: 1, quitting: false, token: PC_TOKEN.into(),
            connect_started: Instant::now(), first_run: false, remote_claude: None, server,
        })))
    }

    fn body_of(req: &str) -> serde_json::Value {
        serde_json::from_str(req.split_once("\r\n\r\n").unwrap().1).unwrap()
    }

    #[test]
    fn a_refresh_reads_the_server_and_writes_only_to_this_pc() {
        let (server_port, server_seen) = fake_hub(
            200,
            r#"[{"slug":"tower","name":"Tower","host":"pc","roomId":"r1","path":"/home/pocketrocket/p"},{"slug":"x","name":"stub","host":"server"},{"slug":"../x","name":"bad"}]"#,
        );
        let (pc_port, pc_seen) = fake_hub(200, "{}");
        let state = state_for(pc_port, SERVER_TOKEN);
        let entry = ServerEntry { ssh_host: "crm".into(), local_port: server_port, hub_port: 7788 };
        refresh(&state, &entry);

        let to_server = server_seen.lock().unwrap().clone();
        assert_eq!(to_server.len(), 1, "one request to the server");
        assert!(to_server[0].starts_with("GET /api/projects HTTP/1.0\r\n"), "{}", to_server[0]);
        assert!(to_server[0].contains(&format!("Authorization: Bearer {SERVER_TOKEN}\r\n")));
        assert!(!to_server[0].contains(PC_TOKEN), "the PC hub's token never goes to the server");

        let to_pc = pc_seen.lock().unwrap().clone();
        assert_eq!(to_pc.len(), 1);
        assert!(to_pc[0].starts_with("PUT /api/hosts/server/projects HTTP/1.0\r\n"), "{}", to_pc[0]);
        assert!(to_pc[0].contains(&format!("Authorization: Bearer {PC_TOKEN}\r\n")));
        assert!(to_pc[0].contains("Content-Type: application/json\r\n"));
        assert!(!to_pc[0].contains(SERVER_TOKEN), "the server's token never goes to the PC hub");
        assert_eq!(body_of(&to_pc[0]), serde_json::json!({"connected":true,"projects":[{"slug":"tower","name":"Tower"}]}));
    }

    #[test]
    fn a_failed_read_keeps_the_stubs_and_a_loss_marks_the_server_disconnected() {
        // The server refuses (a rotated token): the PC hub keeps its last stubs, and the tunnel is still up.
        let (server_port, _) = fake_hub(401, r#"{"error":"Unauthorized"}"#);
        let (pc_port, pc_seen) = fake_hub(200, "{}");
        let state = state_for(pc_port, SERVER_TOKEN);
        refresh(&state, &ServerEntry { ssh_host: "crm".into(), local_port: server_port, hub_port: 7788 });
        // No token at all: nothing is asked of the server.
        let (quiet_port, quiet_seen) = fake_hub(200, "[]");
        refresh(&state_for(pc_port, ""), &ServerEntry { ssh_host: "crm".into(), local_port: quiet_port, hub_port: 7788 });
        assert!(quiet_seen.lock().unwrap().is_empty());
        // The tunnel drops.
        assert!(tell_pc_hub(&state, hosts::DISCONNECTED));

        let to_pc = pc_seen.lock().unwrap().clone();
        let bodies: Vec<_> = to_pc.iter().map(|r| body_of(r)).collect();
        assert_eq!(
            bodies,
            [serde_json::json!({"connected":true}), serde_json::json!({"connected":true}), serde_json::json!({"connected":false})],
            "no `projects` key, so the hub keeps the stubs"
        );
    }

    #[test]
    fn nothing_is_told_to_a_pc_hub_that_is_not_ours_or_not_up() {
        let (pc_port, pc_seen) = fake_hub(200, "{}");
        let state = state_for(pc_port, SERVER_TOKEN);
        state.0.lock().unwrap().token.clear(); // attach mode: someone else's hub
        assert!(!tell_pc_hub(&state, hosts::DISCONNECTED));
        state.0.lock().unwrap().token = PC_TOKEN.into();
        state.0.lock().unwrap().status.connected = false;
        assert!(!tell_pc_hub(&state, hosts::DISCONNECTED));
        assert!(pc_seen.lock().unwrap().is_empty());
    }
}
