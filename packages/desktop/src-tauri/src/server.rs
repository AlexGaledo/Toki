//! I2 (spec toki-local-first-gamedev, Phase 3: one app, two hosts). The hub on this PC always runs and is the
//! primary host (owner decision 6). A configured server is a second host, reached through its own tunnel:
//!  - `ssh -N -L 127.0.0.1:<local>:127.0.0.1:<hub>` on its own local port (default 7790), never the PC hub's;
//!  - opened only when asked ([`connect`]), never at launch, and never in place of the PC hub: nothing here
//!    touches `Inner::child`, `Inner::token` or `Inner::generation`, so the tunnel can't stop the local hub;
//!  - with the server hub's own token, read over SSH from `<dir>/data/hub-token` (32 hex characters or nothing).
//!
//! A port already in use is refused rather than reused: whatever listens there would be handed the server token.

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
    #[allow(dead_code)] // asked for by the page in I3
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

/// The server hub's page. The token rides only in the fragment, as for the PC hub.
pub fn server_url(port: u16, token: &str, then: &Open) -> String {
    let mut url = format!("http://127.0.0.1:{port}/?desktop=1&host=server");
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

/// Consecutive failed checks through the tunnel before it counts as lost (checks are 3 s apart).
const STRIKES: u32 = 3;

/// While the tunnel is up: notice ssh exiting or the hub behind it going quiet.
fn watch(app: &AppHandle, state: &AppState, e: &ServerEntry, gen: u64, tail: &Tail) {
    let mut strikes = 0;
    loop {
        std::thread::sleep(Duration::from_secs(3));
        let exited = {
            let mut inner = state.0.lock().unwrap_or_else(|e| e.into_inner());
            if inner.quitting || inner.server.gen != gen {
                return;
            }
            inner.server.child.as_mut().and_then(|c| c.try_wait().ok().flatten()).is_some()
        };
        if exited {
            return lose(app, state, e, gen, crate::ssh::explain(&tail.text(), &e.ssh_host, e.local_port));
        }
        if crate::hub_responding(e.local_port, Duration::from_secs(3)) {
            strikes = 0;
            continue;
        }
        strikes += 1;
        if strikes >= STRIKES {
            return lose(app, state, e, gen, format!("The hub on {} stopped answering through the tunnel.", e.ssh_host));
        }
    }
}

/// The tunnel is gone: close it, and if the main window shows the server, bring back this PC's hub. The local hub is
/// untouched throughout.
fn lose(app: &AppHandle, state: &AppState, e: &ServerEntry, gen: u64, why: String) {
    {
        let mut inner = state.0.lock().unwrap_or_else(|e| e.into_inner());
        if inner.quitting || inner.server.gen != gen {
            return;
        }
        stop(&mut inner);
        inner.server.error = Some(why.clone());
    }
    let on_server = app
        .get_webview_window("main")
        .and_then(|w| w.url().ok())
        .is_some_and(|u| u.port_or_known_default() == Some(e.local_port));
    if on_server {
        crate::show_pc_hub(app, state);
    }
    crate::tell(app, &format!("Lost the connection to {}", e.ssh_host), &why);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_server_page_gets_its_own_token_only_in_the_fragment() {
        let t = "0123456789abcdef0123456789abcdef";
        assert_eq!(server_url(7790, t, &Open::Home), format!("http://127.0.0.1:7790/?desktop=1&host=server#token={t}"));
        assert_eq!(
            server_url(7790, t, &Open::Project("my-game".into())),
            format!("http://127.0.0.1:7790/?desktop=1&host=server&project=my-game#token={t}")
        );
        // Without a token the page asks for one (the old fallback); nothing else carries it.
        assert_eq!(server_url(7790, "", &Open::Home), "http://127.0.0.1:7790/?desktop=1&host=server");
        let u = tauri::Url::parse(&server_url(7790, t, &Open::Home)).unwrap();
        assert!(!u.query().unwrap_or("").contains(t), "the token never goes in the query");
    }
}
