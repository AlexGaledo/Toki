# Phase 3 infra evidence: I2, I3 and Open folder

These are tasks I2 and I3 from `docs/specs/toki-local-first-gamedev.md` (Phase 3: one app, two hosts), plus the
"Open folder" handler (§2, D3/D4). Owner decision 6 applies: nothing is migrated, the PC hub is primary, and the VPS is
an optional second host.

All runs were on 2026-11-24 on the owner's PC (Windows 11, rustc 1.96.0, `-j 2`, about 1.3 to 2.9 GB of RAM free).
- Nothing touched ports 7788 or 7789, the installed desktop app, `%APPDATA%\com.pocketrocket.app`, the PC runner or the VPS.
- No SSH connection was made. The "server" and the "PC hub" in the wire tests are fake hubs on random loopback ports.
- No Blender or Studio process started.
- The coordinator capped the first mutation run for time: 11 of 46 mutants ran. A third run (`--targeted`) ran the other 35, so all 46 have run.

| Commit | Task |
|---|---|
| 39afb96 | I2: the PC hub always runs; an optional `server` gets its own tunnel on 7790, started on demand, with its own token. Both hub ports stay in the webview. Old `mode: "remote"` configs load as local plus that server. |
| 0fe6cc0 | I3: stubs refreshed on connect, every 5 minutes and on PC hub start; a 30 s loss clock and `PUT {connected:false}`; `?openproject=server:<slug>`, `?connecthost=server` and `?openhost=pc\|server` |
| c6fe9b2 | Open folder: `?openfolder=<slug>` and the `openfolder` cap |
| (evidence commit) | This folder, and the connection modes table in `docs/SERVER.md` |

| File | What it shows |
|---|---|
| `mutations.txt` | The fail-then-pass run, described below. |
| `cargo.txt` | The baseline before any change (65 passed), `cargo check` (clean, no warnings), and the full `cargo test -j 2` after the change (96 passed). The full run was not filtered. |
| `stub-schema.txt` | The stub bodies the Rust filter makes from its fixtures, checked against the PC hub's own zod schema (`HostProjectsInputSchema`). All are accepted, and none is re-trimmed by the hub. |
| `checks.txt` | `node --test` for the repo guards that read the desktop sources (ssh-host-keys, repo-guards, token-parity): 13 of 13 pass. eslint was run on the splash script, but the repo's eslint config ignores `packages/desktop/ui`, so it checked nothing. |
| `scripts/mutations_phase3.py` | The mutation run. From `packages/desktop/src-tauri`: `python -I ../../../docs/verify/phase3-infra/scripts/mutations_phase3.py [--only 5,21]` |
| `scripts/stub_bodies_vs_schema.ts` | The schema check (see its header) |

What `mutations.txt` shows:
- **The method.** The unmutated tree passes (96 tests) first. Then each mutant is applied in turn, and the tests it names must fail. A mutant either restores the behaviour from before the change ("without") or breaks one security rule ("rule").
- **All 46 ran. The 45 with named tests were all caught; mutant 38 is informational and harmless.**
- **The first run** went in order through mutants 1 to 6, all I2:
  - migration;
  - the port clash, in migration and in validation;
  - the settings page's save;
  - the webview port allowlist;
  - http only on hub ports.
- **The stop.** The coordinator then stopped the run for time, during mutant 7's build. That file was restored from git and the tree checked clean.
- **The second run** took only the security guards:
  - the stub host filter (`host === 'pc'` only);
  - the 500 cap;
  - a token riding in the query;
  - openfolder refusing `..`, separators and absolute paths;
  - openfolder must-exist-under-projects.

  Its first attempt hit the build lock left by the killed run and stopped at the clean-tree check. The rerun is recorded.
- **The third run** took the other 35, each running only its named tests (`--targeted`: `cargo test -j 2 --lib -- --exact <tests>`, target dir reused). The unmutated tree passed in full first (97 tests). 34 of 34 were caught. Mutant 38 (health checks may take 8 s) fails no test, which is right: the 30 s test builds its slowest loop from the real `CHECK_TIMEOUT`, and the 20 s quiet deadline still shows a loss inside 30 s. `mutations.txt` has the arithmetic.

## What the new tests cover

There are 31 new Rust tests, plus `hub_url_always_says_desktop`, which was extended.

- **Config.**
  - Migration of an old `mode: "remote"`.
  - Idempotence and round trip.
  - A leftover host on a local config is not a server.
  - The tunnel's port is never the PC hub's port.
  - The settings page's save never moves the PC hub's port.
- **Webview.**
  - Both hub ports are allowed, but the server port only while its tunnel is up.
  - These are refused: 7789, 7791, https, `127.0.0.1.evil.com`, other hosts, `[::1]`, port 80 and `ws:`.
- **Tunnel.** `-L 127.0.0.1:7790:127.0.0.1:<hub>`, BatchMode, and never `StrictHostKeyChecking`.
- **Tokens.**
  - Only a 32-hex token is taken from the server.
  - Dropping the server never touches the PC hub's token, child or generation.
  - The server token goes only in the fragment.
- **Request parsing.**
  - `openproject`, `connecthost` and `openhost` are accepted from either hub.
  - Negatives: other host names and addresses (`crm`, `root@1.2.3.4`, `-oProxyCommand`), paths and traversal, extra parameters (`&token=`, `&host=`, `&port=`), fragments, other ports and https.
  - `openfolder` has the same negatives, and is refused from the server hub's page.
- **The stub filter.**
  - Only host `pc`, or no host, is taken, and only slug and name are sent.
  - Dropped: invalid slugs, names with control or bidi characters, blank or BOM-only names, names over 60 UTF-16 units (counted as zod counts) and repeated slugs.
  - The cap is 500, counting only what is sent.
  - A refusal or a cut-off reply is an error, so the last stubs stay.
- **Wire tests, against two fake hubs on loopback.**
  - One refresh sends exactly one `GET /api/projects` to the "server", with the server token.
  - It sends one `PUT /api/hosts/server/projects` to the "PC hub", with the PC token and the filtered body.
  - Neither token ever goes to the other hub.
  - A failed read sends `{"connected":true}` with no `projects` key, and a loss sends `{"connected":false}`.
  - Nothing is told to an attached hub (no token) or a hub that is down.
- **Loss timing, with a fake clock.**
  - Ticks are 1 s, 3 s, or the slowest real loop apart. The slowest loop is the 3 s pause, a 500 ms connect and a 3 s check timeout, followed by a 2.5 s PUT.
  - Across 8 death times, a loss always shows within 30 s, and never before it happened.
  - ssh exiting is a loss at the next tick.
  - One or two missed checks are not a loss.
  - A minute's silence (a sleeping PC) is a loss at the first missed check.
- **Open folder.**
  - The folder must exist and be a directory directly under `projects/`.
  - Refused: a missing folder, a file, `..`, an absolute path, and a real directory junction out of `projects/`.
  - Nothing is created.
  - The same folder opens at most once every 2 s.

## Exact web calls for D4 (pr-design-system)

The shell's caps on the PC hub's page are `caps=localcopy,studio,openfolder,hosts` on Windows (without `studio` elsewhere),
plus `,server` once a server is set up. The server hub's page gets `caps=hosts&host=server`.

| What | Show when | Call |
|---|---|---|
| Open folder (a `host: 'pc'` project) | `desktopCan('openfolder')` | `window.open(location.origin + '/?openfolder=' + encodeURIComponent(project.slug), '_blank')` |
| Open a Server project, and the prompt's **Connect** | `desktopCan('hosts')` and `project.host === 'server'` | `window.open(location.origin + '/?openproject=server:' + encodeURIComponent(stub.slug), '_blank')` |
| Connect without opening a project | `desktopCan('server')` | `window.open(location.origin + '/?connecthost=server', '_blank')` |
| On the server hub's page: back to this PC | `desktopCan('hosts')` and `host=server` in the URL | `window.open(location.origin + '/?openhost=pc', '_blank')` |

- **Nothing else goes in the URL.** Each call is the single parameter on `/`, with no fragment. Any extra parameter, such as a token, address or path, is refused with a notification.
- **What success looks like:**
  - For `openproject`, the main window navigates to `http://127.0.0.1:7790/?desktop=1&caps=hosts&host=server&project=<slug>#token=<server token>`. The page unloads, so there is no reply to wait for.
  - D4 needs the web app to open the project named by `project=<slug>` on load. The web has no project deep link today.
  - For `connecthost`, the PC hub gets a fresh stub list with `connected: true`, and `hosts.changed` fires.
- **What failure looks like:**
  - The shell sends `PUT {connected:false}`, so `hosts.changed` fires and the stubs stay `connected: false`. That is the signal to end the working state.
  - The reason itself arrives only as a desktop notification ("Couldn't connect to your server" plus the reason), because the page gets no result.
  - To show the reason in the dialog, the hub would need an `error` field on the PUT. That is a schema change for pr-backend. Until then the dialog can say "Couldn't connect. The notification says why."
- **Outside the desktop app,** `desktopCan()` is false: show the note to open it there.
- **The server port in the webview.** 7790 is allowed only while the tunnel is up. On a loss, the main window goes back to the PC hub if it was showing the server.

## Verify on the owner's machine (live, not done here)

No live SSH was made from this PC, by rule. These need the installed app and the real server:
1. **An old config.** In an installed build, keep the old config (`{"mode":"remote","sshHost":"<vps>","port":7788}`).
   - The app starts the PC hub on 7788 and opens no tunnel.
   - The tray's **Open your server** opens `ssh -N -L 127.0.0.1:7790:127.0.0.1:7788` and shows the server hub, with no token prompt.
   - `netstat -ano | findstr 7790` shows 127.0.0.1 only.
2. **Stubs.** After connecting, `GET http://127.0.0.1:7788/api/projects` with the PC token lists the server's projects, tagged `server` and `connected: true`.
3. **Loss.** Cut the network, or run `systemctl stop pocketrocket` on the server.
   - Within 30 s the stubs show `connected: false`, a notification appears, and the window comes back to the PC hub.
   - The PC hub keeps running a bot turn throughout. This is the spec's "manual with a live PC turn".
4. **Port in use.** Start something on 7790 first. Connect must refuse with the port message, not reuse the port.
5. **Restarts.**
   - Restart the PC hub while connected (tray, Restart hub). The stubs come back within a few seconds.
   - Quit while connected, then start again. A stale `connected: true` is cleared once the PC hub is up.
6. **Open folder.** In an installed build, Open folder opens Explorer on `%APPDATA%\com.pocketrocket.app\data\projects\<slug>`. A project with no folder shows a notification.
7. **D4's three manual checks,** once D4 lands: a PC project opens while offline, an offline Server project shows the prompt, and Connect opens it.

## Notes and follow-ups

- **The shell no longer has a "remote" mode.**
  - There is one tunnel path, in server.rs.
  - `run_connection` and `monitor` only run the local hub.
  - A migrated server user's close-to-tray default becomes the local default (on), because the PC hub and its bots now run here.
  - Updates use the local plan.
- **The server hub's page still lacks two things.** Its pop-outs and "Open on my PC" check only the PC hub's port, so they go to the browser without a token. That is unchanged from before and harmless, but a gap if the server page should get pop-outs. Follow-up for pr-infra.
- **Notes out of date.** "There is no tray" in the infra agent's notes is out of date: the shell has had a tray since P9, and the new item is in it.
- **For pr-backend.** An optional fixed-word `error` on `PUT /api/hosts/:host/projects` would let D4 show the reason in its dialog.
