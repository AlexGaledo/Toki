# Final live gaps: S2 multi_edit, I3, the tray click, I4 on a clean folder, D1 on the server

Run on 2026-11-24, from 23:40 to 00:10 (+08:00), on the owner's PC. Approved for this session: launching Roblox Studio and
testing on his real setup. That setup is the installed NSIS build of `a2c0e3b`, the PC hub on 7788, the server tunnel on
127.0.0.1:7790, and the VPS on the branch. The budget was at most 3 short Haiku turns, because his Claude weekly limit is
at about 93%.

**Haiku turns used: 1** (I3).

| # | Item | Result | Evidence |
|---|---|---|---|
| 1 | S2: the `multi_edit` card | **Fixed from Studio's own schema; live card blocked** (RAM) | `multi-edit-schema.txt`, `multi-edit-fail-then-pass.txt`, `multi-edit-mutations.txt` |
| 2 | I3: a PC bot turn through a loss of the server link | **pass** | `i3-pc-turn-through-loss.txt`, `i3-attempt1-econnreset.txt` |
| 3 | The tray's **Open your server**, clicked through UIA | **blocked** | `tray-click.txt` |
| 4 | I4: the NSIS installer into a new, empty folder | **pass** | `i4-clean-folder.txt` |
| 5 | D1: Settings › Game tools on the real server's page | **blocked** (not run) | below |

## Memory

The rule was to keep about 4 GB of RAM free.
- **At the start:** 2.27 GB was available before anything was started. The owner's RobloxPlayerBeta held about 5.2 GB
  private (5.6 GB later), and it was off-limits.
- **During the run:** available memory went from 2.5 GB to 0.9 GB. The drop came from the owner's own apps (Edge grew
  to 18 processes), not from this run.

So nothing heavy was started:
- no Studio;
- no Blender;
- no extra browser.

## 1. S2: the `multi_edit` card

**Not launched: Studio.** A throwaway hub plus Studio plus a claude CLI needs roughly 1.5 to 2 GB, with 2.5 GB available.
So the real card payload was not captured.

**The input shape, from Studio itself** (`multi-edit-schema.txt`):
- `scripts/studio_tools_list.mjs` started this PC's `StudioMCP.exe` (version-8d7a1009c17e4ff8) over stdio, with Studio
  closed.
- It sent only `initialize` and `tools/list`, and called no tool. 41 tools were listed.
- `multi_edit` takes `file_path`, `className`, `datamodel_type`, `studio_id` and
  `edits: [{old_string, new_string, replace_all?}]`. The edits are applied in order, and an empty `old_string` sets a new
  script's content.

So the input holds code, and plain JSON on its card was wrong.

**The fix** follows how B4 and D5 did it:
- **Hub** (`services/outsideMcp.ts`): `outsideCodeField` now returns `'edits'` for `multi_edit`, but only when `edits` is
  a non-empty list in which every edit has a string `old_string` and `new_string`. Otherwise it returns nothing, and the
  card stays plain JSON.
- **Web** (`lib/approvalCode.ts`): `approvalCode` turns an edits list into one code text, which the existing
  `ApprovalCodeView` renders:
  - each edit gets a header, `edit 1 of 2` (with `, every match` for `replace_all`);
  - then its old lines with `- ` and its new lines with `+ `;
  - a new script (an empty `old_string`) shows only `+ ` lines.

  `file_path`, `studio_id` and the other fields stay in the short list.

**Proof:**
- **Fail-then-pass** (`multi-edit-fail-then-pass.txt`): the new hub test and the 2 new web tests fail on the unchanged
  source, and pass after the change. `tsc` is clean in hub and web, and ESLint is clean on the 4 files.
- **Mutation** (`multi-edit-mutations.txt`, `scripts/multi_edit_mutations.mjs`): 11 of 11 caught.
  - The first run caught 9 of 11. `every` to `some` survived, because the bad list held only one non-text edit; the hub
    test now mixes a good and a bad edit.
  - Mutant 10 had an escaping bug in the script itself.

**Still open:** a `multi_edit` card from a real Studio turn, and a look at the rendered card in a browser. It is the same
`ApprovalCodeView` as D5, with new text in it.

## 2. I3: a PC bot turn kept running through a loss

**How it was driven:**
- The owner's installed Toki was quit through its window. `closeToTray` is false, so closing quits.
- It was restarted through `Win32_Process.Create` with the WebView2 debug port 9339. Its environment was this shell's
  minus every `CLAUDE*` variable, so the bots' CLIs would not think they run inside Claude Code.
- `scripts/i3_driver.mjs`:
  - reads the PC token from the `127.0.0.1:7788` origin's `sessionStorage` only, and never prints it;
  - makes every hub call through Node `http` with the port fixed to 7788 and checked, never a page-relative fetch. A
    page-relative fetch is what wrote to the server last time;
  - logs every write.

**The run** (`i3-pc-turn-through-loss.txt`):
- **Setup.** A temporary `@i3-temp-counter` on `claude-haiku-4-5-20251001` (auto memory off, $0.50 cap), with a DM.
  `approvals` is `ask`, so its Bash card was answered over `/ws` on 7788, the way the web does.
- **The server opened.** The window went to the server through `window.open('/?openhost=server')`, which is the same
  `server::connect(Open::Home)` as the tray. Tunnel ssh pid 19504.
- **The turn.** The DM got "Count slowly from 1 to 20 …". Bash ran
  `for i in $(seq 1 20); do echo $i; sleep 2; done`.
- **The loss.** 6 s into that command, with `running: 1`, only the tunnel ssh was killed. The VPS hub kept MainPID 3829701.
- **What happened next:**
  - The window was back on `127.0.0.1:7788` **0.8 s** after the kill, and 7790 had no listener.
  - `busy` still showed `running: 1`.
  - The Bash output is the full `1` to `20`.
  - The bot replied "20" **36.9 s after the kill**, 48.4 s after the message.

**Clean-up:**
- The DM and the bot were deleted, so the PC hub is back to 1 bot and 1 room, and no temp bot folder is left.
- **Every write was to 127.0.0.1:7788:** 6 writes (3 POST, 1 ws `approval.decide`, 2 DELETE), and 0 elsewhere.
- **Checked on the server itself** (over ssh, with its own token, not printed): no `i3-temp-counter` bot and no
  "I3 Temp Counter" room.

**Attempt 1** (`i3-attempt1-econnreset.txt`) used no turn. Node 26's keep-alive agent reused a socket the hub had closed
(its keep-alive timeout is 5 s), so the message POST got ECONNRESET. The run's cleanup removed the bot and DM. The driver
now opens a new connection per call (`agent: false`).

## 3. The tray menu click: blocked (`tray-click.txt`)

**What was reached:**
- `System.Windows.Automation` can't see into the Windows 11 taskbar's XAML island.
- The native IUIAutomation (`scripts/tray_uia.py`, comtypes) can, when it starts from the island's own HWND
  (`DesktopWindowContentBridge`).
- It found **Toki** in the overflow flyout behind **Show Hidden Icons**, and opened that flyout through `InvokePattern`.

**Why the menu never opened:**
- The menu needs a right click (`show_menu_on_left_click(false)`).
- Four tries at a synthesized right click never opened Toki's `#32768` menu, for three reasons:
  - the flyout was closed, so the box was empty;
  - DPI scaling at 125%;
  - the flyout was still animating open, and it closes by itself within about 1 s.
- I stopped there, because each try moves the owner's real mouse, and a miss lands on the Claude or Roblox icon.

**Never invoked by mistake:** the window URL watched over CDP stayed on 7788 the whole time.

**What is shown without the click:** the tray item and `/?openhost=server` call the same
`server::connect(Open::Home)` (`lib.rs` `on_menu_event` "open_server"). That call was used live in I3.

## 4. I4 on a clean folder (`i4-clean-folder.txt`, `scripts/i4_clean_folder.ps1`)

**The installer:** `target/release/bundle/nsis/PocketRocket_0.5.4_x64-setup.exe`, sha256 `8550d4e0…4d87`, the same
build as the owner's install.

**Read before running it** (`target/release/nsis/x64/installer.nsi`):
- `/D=` is honoured: with INSTDIR set, `RestorePreviousInstallLocation` is skipped.
- Silent install and uninstall both kill `PocketRocket.exe` by name, so Toki was quit first.
- Install rewrites the HKCU `Uninstall\PocketRocket` key and `HKCU\Software\Alex Galedo\PocketRocket` to the new folder.
- Uninstall deletes the uninstall key. Without `/UPDATE` it also deletes the `Run` value and the jump list. Shortcuts are
  removed only when they point into its own folder.

**Backups first:** `reg export` of both keys to `C:\Users\alex\pr-rollback-gamedev-20261124\i4-registry-backup\`.

**The run:**
- **Install.** `setup.exe /S /NS /D=%TEMP%\toki-i4-clean-0d74b9c3\app` into a folder that did not exist: exit 0, 7235
  files, 170.9 MB, and no shortcuts.
- **`hub\resources\blender\` is present.** `toki_blender_server.py` (8533 B) and `requirements.txt` (56 552 B) match
  `packages/hub/resources/blender/` by sha256. `hub\package.json` sits next to `hub.mjs`, so `resolveHubDir` makes
  `HUB_DIR` this folder.
- **The hub starts from that folder.** The folder's own `node.exe hub\hub.mjs` ran on 127.0.0.1:7821, with a temp
  `POCKETROCKET_DATA`, `APPDATA` and `LOCALAPPDATA`, and no `CLAUDE*` or inherited `POCKETROCKET_*` variables. The
  listener belongs to that `node.exe` (node 24.22.3, the sidecar).
  - `/api/health` 200, v0.5.4.
  - `GET /api/game-tools`: `blender.reason=found`, `uv=system`, `studio=no-mcp-bat` (the temp `LOCALAPPDATA` has no
    Roblox).
  - `/` serves the bundled web.
- **Removed.** `uninstall.exe /S /UPDATE _?=<folder>`: exit 0. The folder was deleted.
- **Restored.** The owner's two keys were imported back.
  - Their `reg export` is byte-identical to the backups.
  - There is one PocketRocket uninstall entry, pointing at `%LOCALAPPDATA%\PocketRocket`.
  - The owner's `PocketRocket.exe` hash is unchanged, and `uninstall.exe` is present.
  - The Start menu and Desktop shortcuts still point at his install.

**A script bug, caught and fixed:** `reg.exe` writes its success line to stderr, and with `ErrorActionPreference=Stop`
the first run ended after the first import. The manufacturer key was then imported by hand and checked. The script now
continues past `reg.exe`'s stderr.

**Not covered:** a second, clean PC. WebView2 and a system Node 24 are already on this one. The hub was started directly,
not by the desktop launcher from that folder.

**Seen in passing (pre-existing, not fixed):** the hub also tries to serve the workspace on 127.0.0.1:7789. On this PC
that is the PC runner's tunnel, so it logs `EADDRINUSE` and carries on. The PC runner was not affected.

## 5. D1 on the real server's page: blocked, not run

`scripts/d1_server_page.mjs` is ready:
- It drives the app's own webview over CDP: profile menu › **Settings** › **Game tools** on the 7790 page, then Escape.
- It saves the full screenshot and ARIA snapshot only to `C:\Users\alex\pr-rollback-gamedev-20261124\evidence-private\`
  (`13-d1-server-game-tools.*`).
- It writes only the Game tools tabpanel's ARIA lines to the repo, and refuses them if they hold an `@` or the owner's
  name.

It did not run because, after I4, **the owner started Toki himself** (Explorer, 00:05:37), 52 s after the test install
was removed. He was using the PC. Running it needed one of two things:
- **A debug-port Toki:** that means quitting his app a third time.
- **A separate headless Chromium plus its own tunnel:** with 0.9 to 1.25 GB available.

Neither was done. To run it later: start Toki with the debug port, as in I3, then
`node docs/verify/final-gaps/scripts/d1_server_page.mjs C:\Users\alex\pr-rollback-gamedev-20261124\evidence-private docs/verify/final-gaps/d1-server-game-tools.aria.yml`.

## Left on the PC

- **Toki** is running: the owner's own start, at 00:05:37. It has no debug port, and the PC hub on 7788 answers
  `/api/health`.
- **Not connected to the server: no tunnel on 7790.** The run's last reconnect would have needed the tray (blocked) or
  steering the window he was using. One click puts it back: tray › Open your server, or a Server project › Connect.
- **Files and registry:**
  - `config.json` is unchanged (its sha256 equals the backup).
  - The uninstall and manufacturer keys equal their backups.
- **Processes:**
  - No Studio or Blender was started.
  - The two pre-existing `StudioMCP.exe` (2188, 36852), RobloxPlayerBeta and the PC runner (7789) were left alone.
  - The `tools/list` probe's StudioMCP exited.
- **Pip:** comtypes 1.4.11 is installed only in this session's scratchpad folder (`pip --target`).

## Files

- `README.md`: this file.
- `multi-edit-schema.txt`, `multi-edit-fail-then-pass.txt`, `multi-edit-mutations.txt`: item 1.
- `i3-pc-turn-through-loss.txt`, `i3-attempt1-econnreset.txt`: item 2.
- `tray-click.txt`: item 3.
- `i4-clean-folder.txt`: item 4.
- `scripts/`:
  - `studio_tools_list.mjs`, `multi_edit_mutations.mjs` (item 1);
  - `i3_driver.mjs` (item 2);
  - `tray_uia.ps1`, `tray_uia.py` (item 3);
  - `i4_clean_folder.ps1` (item 4);
  - `d1_server_page.mjs` (item 5).
