//! I1 (spec toki-local-first-gamedev): "Open Studio" from the hub page.
//!
//! Like the bot pop-outs and "Open on my PC", the page asks with `window.open("<hub>/?launch=studio")`, which
//! arrives in on_new_window: no IPC command and no capability. What keeps it from being a way to run things:
//!  - the page names an app id, never a path. The only id is `studio`; `blender` is not one (decision 7: Toki's
//!    Blender is headless and the hub starts it), and anything else, any extra parameter included, is refused;
//!  - the shell finds the exe itself, and only a `RobloxStudioBeta.exe` inside `%LOCALAPPDATA%\Roblox\Versions\`;
//!  - Studio gets no arguments, and one start per 10 s at most.
//!
//! Studio is started with CREATE_BREAKAWAY_FROM_JOB, so it leaves the kill-on-close Job Object (proc.rs, which sets
//! BREAKAWAY_OK) and stays open when Toki quits or crashes.

use std::io;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};
use tauri::Url;

/// The apps the page may ask the shell to open. One, on purpose.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum App {
    Studio,
}

const IDS: &[(&str, App)] = &[("studio", App::Studio)];

pub const STUDIO_EXE: &str = "RobloxStudioBeta.exe";
/// winbase.h; the Job Object allows it (JOB_OBJECT_LIMIT_BREAKAWAY_OK in proc.rs).
pub const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
pub const COOLDOWN: Duration = Duration::from_secs(10);
pub const REFUSED: &str = "Toki can only open Roblox Studio from here.";

/// The app for an exact id, or None. Case and whitespace count: `Studio` is not `studio`.
pub fn app_id(raw: &str) -> Option<App> {
    IDS.iter().find(|(id, _)| *id == raw).map(|(_, app)| *app)
}

/// None when the URL is not a launch ask (another handler, or the browser, takes it). Some(Err) when it is one
/// that is refused: an unknown id, a path, or anything besides the single `launch` parameter on the hub's `/`.
pub fn request(url: &Url, hub_port: u16) -> Option<Result<App, &'static str>> {
    let hub = url.scheme() == "http"
        && matches!(url.host_str(), Some("127.0.0.1" | "localhost"))
        && url.port_or_known_default() == Some(hub_port);
    if !hub || !url.query_pairs().any(|(k, _)| k == "launch") {
        return None;
    }
    let pairs: Vec<(String, String)> = url.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
    let app = match pairs.as_slice() {
        [(_, id)] if url.path() == "/" && url.fragment().is_none() => app_id(id),
        _ => None,
    };
    Some(app.ok_or(REFUSED))
}

/// `p` is `dir` or below it, compared the way Windows does (case-insensitive), with no `..` anywhere in `p`.
fn under(p: &Path, dir: &Path) -> bool {
    if !p.is_absolute() || p.components().any(|c| matches!(c, Component::ParentDir)) {
        return false;
    }
    let low = |c: Component| c.as_os_str().to_string_lossy().to_lowercase();
    let (mut a, mut b) = (p.components(), dir.components());
    loop {
        match (a.next(), b.next()) {
            (_, None) => return true,
            (Some(x), Some(y)) if low(x) == low(y) => continue,
            _ => return false,
        }
    }
}

/// Where Studio is: beside Roblox's own `ContentFolder` registry value (`...\Versions\version-<hash>\content\`),
/// else the most recently written `Versions\version-*\RobloxStudioBeta.exe`. Only ever a file inside
/// `<local app data>\Roblox\Versions`; a value pointing anywhere else is ignored.
pub fn studio_exe(content_folder: Option<&Path>, local_app_data: &Path) -> Option<PathBuf> {
    let versions = local_app_data.join("Roblox").join("Versions");
    let ok = |exe: &Path| under(exe, &versions) && exe.is_file();
    if let Some(exe) = content_folder.and_then(Path::parent).map(|d| d.join(STUDIO_EXE)) {
        if ok(&exe) {
            return Some(exe);
        }
    }
    std::fs::read_dir(&versions)
        .ok()?
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with("version-"))
        .map(|e| e.path().join(STUDIO_EXE))
        .filter(|exe| ok(exe))
        .max_by_key(|exe| std::fs::metadata(exe).and_then(|m| m.modified()).unwrap_or(SystemTime::UNIX_EPOCH))
}

/// The installed exe for `app`, found by the shell. Read-only: one registry value and one folder listing.
pub fn find_installed(app: App) -> Option<PathBuf> {
    match app {
        App::Studio => {
            let local = PathBuf::from(std::env::var_os("LOCALAPPDATA")?);
            let content = crate::envpath::user_registry_value(r"Software\Roblox\RobloxStudio", "ContentFolder").map(PathBuf::from);
            studio_exe(content.as_deref(), &local)
        }
    }
}

/// Start `exe` with no arguments, outside the Job Object, never waited on or killed. Windows only.
pub fn spawn_detached(exe: &Path, flags: u32) -> io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        use std::process::{Command, Stdio};
        let mut cmd = Command::new(exe);
        if let Some(dir) = exe.parent() {
            cmd.current_dir(dir);
        }
        // The token only ever goes to the hub's own environment; make sure it can't reach Studio either.
        cmd.env_remove("POCKETROCKET_TOKEN").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).creation_flags(flags);
        // Dropping the Child closes its handle and nothing else: it is not assigned to the job (proc::job::assign).
        cmd.spawn().map(drop)
    }
    #[cfg(not(windows))]
    {
        let _ = (exe, flags);
        Err(io::Error::new(io::ErrorKind::Unsupported, "Windows only"))
    }
}

/// Find and start `app`. `find` and `spawn` are injected so tests never start a real program.
pub fn open(app: App, find: &dyn Fn(App) -> Option<PathBuf>, spawn: &dyn Fn(&Path, u32) -> io::Result<()>) -> Result<PathBuf, String> {
    let exe = find(app).ok_or_else(|| match app {
        App::Studio => "Roblox Studio wasn't found on this PC. Install it from create.roblox.com, then try again.".to_string(),
    })?;
    spawn(&exe, CREATE_BREAKAWAY_FROM_JOB).map_err(|e| format!("Roblox Studio didn't start: {e}"))?;
    Ok(exe)
}

/// At most one start per COOLDOWN, so a page that asks in a loop can't pile up Studio windows.
pub struct Gate(Mutex<Option<Instant>>);

impl Gate {
    pub const fn new() -> Self {
        Gate(Mutex::new(None))
    }

    pub fn pass(&self, now: Instant) -> bool {
        let mut last = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if last.is_some_and(|t| now.saturating_duration_since(t) < COOLDOWN) {
            return false;
        }
        *last = Some(now);
        true
    }
}

pub static GATE: Gate = Gate::new();

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::fs;

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn only_the_exact_studio_id_is_an_app() {
        assert_eq!(app_id("studio"), Some(App::Studio));
        for bad in [
            "blender", "Blender", "blender.exe", "Studio", "STUDIO", " studio", "studio ", "studio\0", "", "notepad",
            "RobloxStudioBeta.exe", r"C:\Windows\System32\calc.exe", "C:/Windows/System32/calc.exe", r"..\studio",
            "../studio", r"\\server\share\studio.exe", "studio;calc", "studio&calc",
        ] {
            assert_eq!(app_id(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn the_page_can_ask_for_studio_and_nothing_else() {
        assert_eq!(request(&u("http://127.0.0.1:7788/?launch=studio"), 7788), Some(Ok(App::Studio)));
        assert_eq!(request(&u("http://localhost:7788/?launch=studio"), 7788), Some(Ok(App::Studio)));
        for bad in [
            "?launch=blender",
            "?launch=notepad",
            "?launch=Studio",
            "?launch=",
            "?launch=C%3A%5CWindows%5CSystem32%5Ccalc.exe",
            "?launch=..%2F..%2Fcalc.exe",
            "?launch=studio&path=C%3A%5Cevil.exe",
            "?launch=studio&exe=calc",
            "?launch=studio&args=-script",
            "?path=C%3A%5Cevil.exe&launch=studio",
            "?launch=studio&launch=blender",
            "?launch=studio&launch=studio",
        ] {
            assert_eq!(request(&u(&format!("http://127.0.0.1:7788/{bad}")), 7788), Some(Err(REFUSED)), "{bad}");
        }
        assert_eq!(request(&u("http://127.0.0.1:7788/api/x?launch=studio"), 7788), Some(Err(REFUSED)));
        assert_eq!(request(&u("http://127.0.0.1:7788/?launch=studio#C:/evil.exe"), 7788), Some(Err(REFUSED)));
    }

    #[test]
    fn other_origins_and_other_asks_are_not_launches() {
        assert_eq!(request(&u("http://127.0.0.1:7789/?launch=studio"), 7788), None);
        assert_eq!(request(&u("https://127.0.0.1:7788/?launch=studio"), 7788), None);
        assert_eq!(request(&u("http://evil.example:7788/?launch=studio"), 7788), None);
        assert_eq!(request(&u("http://127.0.0.1.evil.example:7788/?launch=studio"), 7788), None);
        assert_eq!(request(&u("http://127.0.0.1:7788/?popout=b"), 7788), None);
        assert_eq!(request(&u("http://127.0.0.1:7788/?localcopy=r&path=a.md"), 7788), None);
    }

    /// A spawner that records what it was asked to start and starts nothing.
    fn recording() -> (RefCell<Vec<(PathBuf, u32)>>, impl Fn(&RefCell<Vec<(PathBuf, u32)>>, &Path, u32) -> io::Result<()>) {
        (RefCell::new(Vec::new()), |log: &RefCell<Vec<(PathBuf, u32)>>, exe: &Path, flags: u32| {
            log.borrow_mut().push((exe.to_path_buf(), flags));
            Ok(())
        })
    }

    #[test]
    fn studio_starts_from_the_found_path_and_breaks_away_from_the_job() {
        let found = PathBuf::from(r"C:\Users\x\AppData\Local\Roblox\Versions\version-1\RobloxStudioBeta.exe");
        let (log, rec) = recording();
        let got = open(App::Studio, &|app| (app == App::Studio).then(|| found.clone()), &|exe, flags| rec(&log, exe, flags));
        assert_eq!(got, Ok(found.clone()));
        let calls = log.into_inner();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, found);
        assert_ne!(calls[0].1 & CREATE_BREAKAWAY_FROM_JOB, 0, "Studio must leave the kill-on-close job");
        assert_eq!(CREATE_BREAKAWAY_FROM_JOB, 0x0100_0000);
    }

    #[test]
    fn nothing_starts_when_studio_is_not_found_or_fails() {
        let (log, rec) = recording();
        let err = open(App::Studio, &|_| None, &|exe, flags| rec(&log, exe, flags)).unwrap_err();
        assert!(err.contains("wasn't found"), "{err}");
        assert!(log.borrow().is_empty());

        let err = open(App::Studio, &|_| Some(PathBuf::from(r"C:\x\RobloxStudioBeta.exe")), &|_, _| Err(io::Error::other("denied"))).unwrap_err();
        assert!(err.contains("didn't start") && err.contains("denied"), "{err}");
    }

    struct Tree(PathBuf);
    impl Drop for Tree {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn tree(name: &str) -> Tree {
        let root = std::env::temp_dir().join(format!("toki-launch-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        Tree(root)
    }

    fn exe_at(dir: &Path, age_secs: u64) -> PathBuf {
        fs::create_dir_all(dir).unwrap();
        let exe = dir.join(STUDIO_EXE);
        let f = fs::File::create(&exe).unwrap();
        f.set_modified(SystemTime::now() - Duration::from_secs(age_secs)).unwrap();
        exe
    }

    #[test]
    fn studio_is_found_beside_roblox_content_folder_or_as_the_newest_version() {
        let t = tree("find");
        let local = t.0.join("Local");
        let versions = local.join("Roblox").join("Versions");
        let old = exe_at(&versions.join("version-aaa"), 3600);
        let new = exe_at(&versions.join("version-bbb"), 60);
        // Roblox's own value wins, trailing separator and all.
        let content = versions.join("version-aaa").join("content").join("");
        assert_eq!(studio_exe(Some(&content), &local), Some(old.clone()));
        // No value: the newest install.
        assert_eq!(studio_exe(None, &local), Some(new.clone()));
        // Folders that aren't `version-*`, and a "exe" that is a folder, are not Studio.
        exe_at(&versions.join("other"), 0);
        fs::create_dir_all(versions.join("version-ccc").join(STUDIO_EXE)).unwrap();
        assert_eq!(studio_exe(None, &local), Some(new));
        // Case doesn't matter on Windows paths.
        let shouty = PathBuf::from(content.to_string_lossy().replace("Roblox", "ROBLOX"));
        if cfg!(windows) {
            assert_eq!(studio_exe(Some(&shouty), &local), Some(PathBuf::from(shouty.parent().unwrap()).join(STUDIO_EXE)));
        }
    }

    #[test]
    fn a_registry_value_pointing_outside_roblox_versions_is_ignored() {
        let t = tree("outside");
        let local = t.0.join("Local");
        let versions = local.join("Roblox").join("Versions");
        let real = exe_at(&versions.join("version-aaa"), 60);
        let evil = t.0.join("evil");
        exe_at(&evil, 0);
        assert_eq!(studio_exe(Some(&evil.join("content")), &local), Some(real.clone()));
        // `..` climbing out of Versions is refused even though the file exists.
        let climb = versions.join("version-aaa").join("..").join("..").join("..").join("..").join("evil").join("content");
        assert_eq!(studio_exe(Some(&climb), &local), Some(real));
        // A relative value is never trusted.
        assert_eq!(studio_exe(Some(Path::new(r"evil\content")), &t.0.join("nowhere")), None);
        // Nothing installed: nothing found.
        assert_eq!(studio_exe(None, &t.0.join("nowhere")), None);
    }

    #[test]
    fn one_start_per_cooldown() {
        let g = Gate::new();
        let t0 = Instant::now();
        assert!(g.pass(t0));
        assert!(!g.pass(t0 + Duration::from_secs(5)));
        assert!(g.pass(t0 + COOLDOWN + Duration::from_millis(1)));
    }
}
