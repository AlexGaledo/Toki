//! "Open folder" (Settings › Projects, spec toki-local-first-gamedev §2): show a PC project's folder in Explorer.
//!
//! Like `?launch=studio`, the page asks with `window.open("<hub>/?openfolder=<slug>")`, which arrives in on_new_window:
//! no IPC command and no capability. The page names a project slug, never a path:
//!  - only from the PC hub's own origin (a server project's folder is on the server, not here);
//!  - the slug must follow the project slug rule, so no `..`, separator, drive or absolute path gets through;
//!  - the shell builds `<data>/projects/<slug>` itself, and opens it only if it already exists, is a directory, and
//!    resolves (junctions and links followed) to a direct child of the projects folder.
//!
//! It opens with the OS's "open" on a directory (ShellExecuteExW on Windows, so Explorer), never a command line.

use crate::hosts::valid_slug;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Url;

pub const REFUSED: &str = "Toki can only open a project's own folder from here.";
pub const NOT_HERE: &str = "That project's folder isn't on this PC.";
pub const ON_SERVER: &str = "That project is on your server, so its folder isn't on this PC.";

/// None when the URL is not a folder ask. Some(Err) when it is one that is refused. Only `openfolder=<slug>` on `/` of
/// the PC hub, alone and without a fragment; the same ask from the server hub's page is refused.
pub fn request(url: &Url, pc_port: u16, server_port: u16) -> Option<Result<String, &'static str>> {
    if !url.query_pairs().any(|(k, _)| k == "openfolder") {
        return None;
    }
    if crate::on_loopback_port(url, server_port) {
        return Some(Err(ON_SERVER));
    }
    if !crate::on_loopback_port(url, pc_port) {
        return None;
    }
    let pairs: Vec<(String, String)> = url.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
    let slug = match pairs.as_slice() {
        [(_, slug)] if url.path() == "/" && url.fragment().is_none() && safe_name(slug) => Some(slug.clone()),
        _ => None,
    };
    Some(slug.ok_or(REFUSED))
}

/// A slug that can only ever be one plain folder name: the project slug rule, and (said again, in case that rule
/// changes) no `..`, no separator, no drive and nothing absolute.
fn safe_name(slug: &str) -> bool {
    valid_slug(slug)
        && !slug.contains("..")
        && !slug.contains(['/', '\\', ':'])
        && !Path::new(slug).is_absolute()
        && matches!(Path::new(slug).components().collect::<Vec<_>>().as_slice(), [Component::Normal(_)])
}

/// `<data>/projects/<slug>`, only when it exists, is a directory, and is (after following links) directly inside the
/// projects folder. Returns the resolved path.
pub fn project_dir(data: &Path, slug: &str) -> Result<PathBuf, &'static str> {
    if !safe_name(slug) {
        return Err(REFUSED);
    }
    let root = std::fs::canonicalize(data.join("projects")).map_err(|_| NOT_HERE)?;
    let dir = std::fs::canonicalize(root.join(slug)).map_err(|_| NOT_HERE)?;
    if !dir.is_dir() || dir.parent() != Some(root.as_path()) {
        return Err(NOT_HERE);
    }
    Ok(dir)
}

/// The same folder asked for again this soon opens nothing new (a page asking in a loop can't pile up windows).
pub const COOLDOWN: Duration = Duration::from_secs(2);
static LAST: Mutex<Option<(String, Instant)>> = Mutex::new(None);

fn pass(slug: &str, now: Instant, last: &Mutex<Option<(String, Instant)>>) -> bool {
    let mut l = last.lock().unwrap_or_else(|e| e.into_inner());
    if l.as_ref().is_some_and(|(s, t)| s == slug && now.saturating_duration_since(*t) < COOLDOWN) {
        return false;
    }
    *l = Some((slug.to_string(), now));
    true
}

/// Resolve and open. `opener` is injected so tests never open a window.
pub fn open(data: &Path, slug: &str, now: Instant, opener: &dyn Fn(&Path) -> std::io::Result<()>) -> Result<(), String> {
    let dir = project_dir(data, slug).map_err(str::to_string)?;
    if !pass(slug, now, &LAST) {
        return Ok(());
    }
    opener(&dir).map_err(|e| format!("Explorer didn't open: {e}"))
}

/// The real opener: the OS's "open" on a directory, detached.
pub fn open_in_explorer(dir: &Path) -> std::io::Result<()> {
    open::that_detached(crate::strip_verbatim(dir))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::fs;

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn the_page_can_ask_for_a_project_folder_by_slug() {
        assert_eq!(request(&u("http://127.0.0.1:7788/?openfolder=my-game"), 7788, 7790), Some(Ok("my-game".into())));
        assert_eq!(request(&u("http://localhost:7788/?openfolder=g2"), 7788, 0), Some(Ok("g2".into())));
    }

    #[test]
    fn paths_traversal_and_extra_parameters_are_refused() {
        for bad in [
            "?openfolder=..", "?openfolder=..%2F..", "?openfolder=..%5C..%5CWindows", "?openfolder=a%2Fb", "?openfolder=a%5Cb",
            "?openfolder=C%3A%5CWindows", "?openfolder=C%3A", "?openfolder=%2Fetc", "?openfolder=%5C%5Cserver%5Cshare",
            "?openfolder=.", "?openfolder=", "?openfolder=My-Game", "?openfolder=my%20game", "?openfolder=my-game.exe",
            "?openfolder=-x", "?openfolder=%2e%2e", "?openfolder=my-game&path=C%3A%5C", "?openfolder=my-game&token=abc",
            "?openfolder=a&openfolder=b", "?openfolder=my-game#x", "?launch=studio&openfolder=x",
        ] {
            assert_eq!(request(&u(&format!("http://127.0.0.1:7788/{bad}")), 7788, 7790), Some(Err(REFUSED)), "{bad}");
        }
        assert_eq!(request(&u("http://127.0.0.1:7788/api/files?openfolder=x"), 7788, 7790), Some(Err(REFUSED)));
    }

    #[test]
    fn only_the_pc_hubs_page_may_ask() {
        assert_eq!(request(&u("http://127.0.0.1:7790/?openfolder=my-game"), 7788, 7790), Some(Err(ON_SERVER)));
        assert_eq!(request(&u("http://127.0.0.1:7789/?openfolder=my-game"), 7788, 7790), None);
        assert_eq!(request(&u("https://127.0.0.1:7788/?openfolder=my-game"), 7788, 7790), None);
        assert_eq!(request(&u("http://evil.example:7788/?openfolder=my-game"), 7788, 7790), None);
        assert_eq!(request(&u("http://127.0.0.1:7788/?launch=studio"), 7788, 7790), None);
    }

    struct Tree(PathBuf);
    impl Drop for Tree {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn data(name: &str) -> Tree {
        let root = std::env::temp_dir().join(format!("toki-folder-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("projects").join("my-game")).unwrap();
        Tree(root)
    }

    #[test]
    fn the_shell_resolves_an_existing_folder_under_projects_only() {
        let t = data("resolve");
        let got = project_dir(&t.0, "my-game").unwrap();
        assert_eq!(got, fs::canonicalize(t.0.join("projects").join("my-game")).unwrap());
        // Not there, or a file of that name: nothing is created and nothing opens.
        assert_eq!(project_dir(&t.0, "other"), Err(NOT_HERE));
        assert!(!t.0.join("projects").join("other").exists());
        fs::write(t.0.join("projects").join("notes"), "x").unwrap();
        assert_eq!(project_dir(&t.0, "notes"), Err(NOT_HERE));
        // No projects folder at all.
        assert_eq!(project_dir(&t.0.join("nowhere"), "my-game"), Err(NOT_HERE));
        // Called directly, bad names are refused before touching the disk.
        fs::create_dir_all(t.0.join("secret")).unwrap();
        for bad in ["..", "../secret", r"..\secret", "/", r"C:\Windows", "C:", "", "."] {
            assert_eq!(project_dir(&t.0, bad), Err(REFUSED), "{bad:?}");
        }
        let abs = t.0.join("secret").to_string_lossy().to_string();
        assert_eq!(project_dir(&t.0, &abs), Err(REFUSED));
    }

    #[cfg(windows)]
    #[test]
    fn a_junction_out_of_the_projects_folder_is_refused() {
        let t = data("junction");
        let outside = t.0.join("outside");
        fs::create_dir_all(&outside).unwrap();
        let link = t.0.join("projects").join("escape");
        // A directory junction needs no admin rights (unlike a symlink).
        let made = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(&link)
            .arg(&outside)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        assert!(made, "could not make the test junction");
        assert_eq!(project_dir(&t.0, "escape"), Err(NOT_HERE));
    }

    #[test]
    fn it_opens_the_resolved_folder_once_per_cooldown() {
        let t = data("open");
        let opened = RefCell::new(Vec::new());
        let rec = |p: &Path| {
            opened.borrow_mut().push(p.to_path_buf());
            Ok(())
        };
        let t0 = Instant::now();
        let last = Mutex::new(None);
        // `open` uses the shared gate; check the gate and the opener separately so tests never race on it.
        assert!(pass("my-game", t0, &last));
        assert!(!pass("my-game", t0 + Duration::from_secs(1), &last));
        assert!(pass("other", t0 + Duration::from_secs(1), &last));
        assert!(pass("my-game", t0 + COOLDOWN + Duration::from_secs(1), &last));

        open(&t.0, "my-game", Instant::now(), &rec).unwrap();
        assert_eq!(opened.borrow().as_slice(), [fs::canonicalize(t.0.join("projects").join("my-game")).unwrap()]);
        let err = open(&t.0, "../x", Instant::now(), &rec).unwrap_err();
        assert_eq!(err, REFUSED);
        let err = open(&t.0, "missing", Instant::now(), &rec).unwrap_err();
        assert_eq!(err, NOT_HERE);
        assert_eq!(opened.borrow().len(), 1, "nothing else was opened");
        let err = open(&t.0.clone(), "my-game", Instant::now() + COOLDOWN * 2, &|_| Err(std::io::Error::other("denied"))).unwrap_err();
        assert!(err.contains("denied"), "{err}");
    }
}
