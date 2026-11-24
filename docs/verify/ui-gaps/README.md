# UI gaps: D1, B5, D2, P1, B11 and the keyboard walk

Run on 2026-11-24 (22:54 to 23:35) on the owner's PC. This closes the UI rows of `docs/verify/APPROVAL.md` that were
"unit-tested only" or "seeded", plus "Install and UI states" items 2 and 3.

## How it ran

There were three throwaway Toki runs with `node scripts/control-toki.mjs`. Each had its own root under `%TEMP%`
(`toki-verify-ui-gaps-run1/2/3`), a fresh data dir, free ports from the driver, Vite and one headless Chromium.
`doctor` passed before any evidence was taken. `stop` ended each run and deleted its data.

Safety:
- Nothing used ports 7788, 7789 or 7790. The driver now refuses 7790 too (see below).
- Nothing touched the installed app, `%APPDATA%\com.pocketrocket.app`, the PC runner or the VPS.
- Roblox Studio was never started.
- One Blender ran at a time, always `-b --factory-startup`, and nothing called `bpy.ops.wm.*`.
- Exactly one bot turn ran: one Haiku message, for D2.
- The user name was `Verifier`. Text evidence has the Windows user folder replaced with `%USERPROFILE%`, and the
  screenshots show only `~`.

### The seams used, and why

`createHub` already takes test seams for game tools (`gameTools.platform`, `.env`, `.processes`). The driver only ever
started `packages/hub/src/index.ts`, so two small changes were needed:

- **`--hub-entry <file.ts>`** in the driver. It must be a `.ts` file inside the repo, and it is unit-tested.
- **`scripts/hub_entry.ts`**, which is `index.ts` plus those seams, driven by `TOKI_VERIFY_*` variables. The driver
  drops every inherited `POCKETROCKET_*`, so a `.env` still can't aim a run at real data.

| Run | Entry | What it fakes |
|---|---|---|
| 1 | `hub_entry.ts`, `TOKI_VERIFY_FAKE_PC=%TEMP%\toki-ui-gaps-fakepc` | Program Files and `%LOCALAPPDATA%` for game tools point at that folder. A `RobloxStudioBeta.exe` row is added to the real process list while `studio-running` exists. `crash-now` asks the hub's own BlenderHost to start 4 times. |
| 2 | `index.ts`, as the driver always ran it | Nothing. The real Blender 5.2.2 and the real Roblox files were read, and nothing was written to them. |
| 3 | `hub_entry.ts`, `TOKI_VERIFY_PLATFORM=linux` | Detection answers as a non-Windows (server) hub. |

**The crash stub.** `scripts/crash_stub.cs` is built with the .NET Framework's `csc.exe` into
`<fake>\pf\Blender Foundation\Blender 9.9\blender.exe`. It is not Blender. `--version` prints "Blender 9.9.0 (crash stub
…)"; anything else prints three lines and exits 3.

**Why the crashes were triggered from the entry.** BlenderHost only starts Blender from a game room's Blender call. That
is a bot turn, and only one Haiku turn was allowed. So the entry calls `hub.runner.blender.ensure()` 4 times, the same
call the PreToolUse hook makes. Each call spawned the stub for real, BlenderHost counted a real exit 3, and wrote
`run/blender/last-crash.log` (`run1/hub-blender-lines.txt`). Everything after that went through the UI.

## Results

| Item | Result | Evidence |
|---|---|---|
| **Crashing Blender** | **pass** | `run1/d1/crashing-{light,dark}.*`, `crashing-dark-narrow.*`: "Keeps crashing 9.9.0" with **Open log** and **Try again**. The strip reads "Blender keeps crashing" with **Fix in Settings** (`strip-crashing.*`) |
| **Open log** | **pass** | `run1/d1/crash-log-dialog.*`: `dialog "Blender crash log"` holds "exit code 3 / Read prefs: (factory startup) / crash stub: args 520 chars / EXCEPTION_ACCESS_VIOLATION (simulated …)", the same as `GET /api/game-tools/blender/crash-log` |
| **Try again** | **pass** | Pressed from **Fix in Settings**. The toast reads "Blender will start again on the next Blender call.", and the row reads "Installed · Stopped …", keeping **Open log** for the last crash (`after-try-again.*`). Audit `game_tools.blender_reset` by `hub-token` (`run1/actions.jsonl`) |
| **Another Blender running** | **pass** | Run 2: a real `blender.exe -b --factory-startup --python-expr "time.sleep(300)"`, idle, pid 17056. Settings reads "Another Blender running … (blender.exe, pid 17056). Try again when it finishes." (`run2/d1/other-blender-light.*`). The strip reads "Another Blender running" (`strip-other-blender.*`). After `taskkill /PID 17056` the strip reads "Blender stopped" (`strip-after-kill.aria.yml`) |
| **Server hub: not supported** | **pass, through the platform seam** | `run3/d1/server-not-supported-*`: the banner reads "Game tools work on the hub that runs on your Windows PC. This hub can't use them.", and all four items read "Not supported here". The Game team radio is disabled with "Game tools need the hub on a Windows PC." (`run3/p1/server-picker.aria.yml`). This is a Windows hub answering as Linux, not a Linux server |
| **Blender not installed** | **pass** | Fake Program Files with no Blender: "Not installed", **Get Blender (opens in a new tab)** → blender.org (`run1/d1/not-installed-{light,dark}.*`). The strip reads "Blender not installed" (`strip-not-installed.*`) |
| **Studio closed** | **pass** | "Not open … Open Roblox Studio to use it." In run 1 this was the fake tree with the setting on (`not-installed-light.*`). In run 2 it was the real tree (`run2/p1/setup-before.aria.yml`) |
| **Studio open** | **pass, through the process seam** | "Open and ready" (`run1/d1/studio-open-light.*`). The seam adds only the process row: `mcp.bat`, `StudioMCP.exe` and the settings file are files in the fake tree that the hub read |
| **Close Roblox Studio first** | **pass, through the process seam** | Setting off and Studio "running": `button "Turn on Studio MCP" [disabled]`, with "Close Roblox Studio first. Toki changes this setting only while Studio is closed." (`studio-close-first-light.*`) |
| **Turn on Studio MCP** (bonus) | **pass** | Studio "closed": the in-app confirm (`studio-turn-on-confirm.aria.yml`), then **Turn on**. The toast reads "Studio MCP is on. It takes effect when Studio next opens." The fake `1.json` now has `"enabled": true`, plus a `1.json.toki-bak` |
| **D2: live look-back** | **pass** | One message from the composer: `@cube-test-artist add a red cube and look at it` (approvals bypass, all three bots on `claude-haiku-4-5-20251001`). Blender started headless (`ready for cube-test after 3.3 s`). The artist called get_addon_status, get_scene_info, execute_blender_code ×3, Skill and look. The look got `img:27ee2647…` (`run2/d2/messages.txt`, `lookback.png`), and no message has `[Image: source:`. The browser shows `button "Look-back from blender: look"` under "Worked for 25s · 7 steps · 1 retried" (`live-lookback.*`). Clicking it opens `dialog "Look-back from blender: look"` with the red cube (`live-lightbox.*`), and Escape closes it. The strip read "Blender working" **live** during the turn, from the hub's `game-tools.changed` (`live-lookback.aria.yml`) |
| **Keyboard walk, default layout** | **fail, then fixed** | See "Bugs fixed". `run1/a11y/walk-default-before-fix.txt` and `walk-default-after-fix.txt` (and `-stopped.txt`, after Try again). The final order (Blender crashing): Close → Game tools tab → Check again → Show/Copy Blender path → Open log → Try again → Show/Copy uv path → back to Close, the same in reverse with Shift+Tab. Every stop draws a focus ring (`tab_walk.mjs` checks the computed outline and box-shadow). Open log by Enter moves focus to the log dialog's Close. Tab reaches the log (`pre`, tabIndex 0). Escape returns to **Open log** |
| **Keyboard walk, classic layout** | **pass, after the same fix** | `run1/a11y/walk-classic-after-fix.txt`, `classic-crashing.*`. The strip in classic: from the composer, Shift+Tab reaches `[strip] Fix in Settings`. Enter opens Settings on Game tools with focus on Close, and Escape returns to Fix in Settings (`classic-strip-keyboard.txt`, `classic-strip-crashing.*`) |
| **Unreachable controls** | none | The disabled **Turn on Studio MCP** is skipped by Tab, as a disabled button is. Its reason is the next paragraph and its `aria-describedby` |
| **P1: the guide walk** | **pass, with 5 guide fixes**, and one backend gap found | See "P1" |
| **B11: the usage note** after 82e2afc | **pass** | A server made known with `PUT /api/hosts/server/projects {"connected":false}` (setup, as in phase3-ui). Then profile menu › **Usage**. `paragraph: Your PC and your server both spend from the same Claude subscription, so its usage limits cover the bots on both.`, the same line as `phase3-ui/d4/usage-note-light.aria.yml`, in the same place under Plan limits (`run2/b11/usage-note-light.*`, `-narrow.*`) |

## Bugs fixed

**1. Settings: Shift+Tab was stuck on the selected section** (both layouts, widths of 640 px and up).
- Radix gives the tablist container `tabIndex=0` and no tab a tab stop until one is focused, so the dialog's focus trap
  took the container as its first stop.
- Shift+Tab from the active tab left the dialog, and the trap pulled focus back to the same tab, every time:
  `walk-default-before-fix.txt`, 25 presses with no movement.
- Narrow widths worked only because the mobile Close button came before the tablist.
- Fix (`SettingsDialog.tsx`): one Close button, first in the DOM at every width, in the same place on screen. The narrow
  header keeps the button's height (`max-sm:min-h-8`, or 10 for a coarse pointer).
- Focus on opening moves from the section tab to Close at desktop widths, which is what the narrow layout already did.
- Test: `SettingsDialog.focus.test.tsx`. Web tests have no DOM, so it renders the real dialog's children in order and
  checks there is one Close button, before `role="tablist"`, and never hidden.
- Fail-then-pass is in `fail-then-pass.txt`, and the live walk after the fix is in `walk-*-after-fix*.txt`.

**2. Game tools: focus dropped to `<body>` after a fix button.**
- The pressed button is disabled while its step runs, and removed when the step is done.
- Fix: `keepFocusInRow` (`lib/gameTools.ts`) puts focus on that row's heading (`h4`, `tabIndex=-1`) only when focus was
  lost: `<body>`, a disconnected element, or a disabled one.
- Live: Enter on **Try again** leaves focus on `h4 "Blender"` at 100 ms and at 1500 ms. Tab then goes to the next
  control in the row (`a11y/focus-after-try-again.png`).
- Tests: 4 new cases in `lib/gameTools.test.ts`, failing first with the helper missing (`fail-then-pass.txt`).

**3. The driver could pick 7790,** the desktop's server tunnel port. `AVOID_PORTS` now has it. The test fails without
it (`checks.txt`).

## P1: the two GUIDE.md sections, step by step

**Make games with Blender and Studio**
1. **Set up.** Settings › Game tools showed the four items.
   - **Install Blender tools** asked first in the app ("Install the Blender tools?") and installed 2.3.1.
   - It wrote the audit row `game_tools.blender_mcp_installed tools/blender-mcp/2.3.1 b363e5b4…` (`run2/p1/setup-*`).
   - **Install uv** was not shown, because uv is on PATH here. Its route is live in `phase1-backend/live-install.txt`.
   - Turn on Studio MCP and Try again were done in run 1.
2. **Make a game project, on a fresh hub.** Game team could be picked, but **Create project** failed with "The game team
   template needs the skill safe-shipping, which does not exist" (`create-fresh-hub.aria.yml`).
   - The template also needs `@lead-engineer`, and a new install has neither (pr-backend, below). The guide now says so.
   - With both added through the API, the project was made (`created.*`, `project-state.txt`):
     - folders `art/ exports/ studio/ places/` and the first commit;
     - the bots `cube-test-lead`, `-builder` and `-artist`;
     - the skills blender-loop and studio-loop;
     - the Studio recipe for the room.
3. **The strip.** It reads "Blender stopped · Studio not open (unverified)". The guide's example now has "(unverified)"
   and names its buttons.
4. **Headless Blender.**
   - It started on the first call, with the `.blend` saved by `toki_save` (`art/cube-test.blend`, 76 016 B).
   - It stopped on idle: `stopped for cube-test (idle) after 618 s; peak working set 580 MB` (`run2/blender-lines.txt`).
   - "Another Blender" and "Crashes" are above, and both match the guide.
5. **Look-backs.** D2, above.
6. **Approvals follow your setting.** Under bypass, no card. Ask is live in `s2/turn.txt`.

**This PC and your server**
- **Tags.** These were checked in the browser (`run2/p1/server-tags.*`): with a server stub, the sidebar reads
  "Cube Test This PC" and "Tower Climb Server (offline)".
- **Opening a Server project offline.**
  - In a plain browser it reads "This project is on your server. Open it from the desktop app, which can connect to your
    server." with Close.
  - With the desktop caps it reads "This project is on your server. Connect to open it." with Cancel and Connect
    (`server-project-*`).
- **One subscription.** B11, above.
- **Game tools exist only on the PC hub.** Run 3, above.
- **Desktop only, cited from `docs/verify/real-setup/README.md`:**
  - Connecting through **Open your server** on 7790 with no token prompt, with the PC hub keeping 7788 (check 1).
  - The project list from the server (check 2).
  - The 30 s loss, and the window coming back (check 3).
  - Port 7790 busy (check 4).
  - Restarts (checks 5a, 5b).
  - **Open folder** (check 6).
  - The Connect prompt in the shell (check 7).
  - **Open Studio** (S2-6).
  - The tray menu item itself was not clicked there (its call was used), and is still not clicked here.
- **Fixed in the guide:**
  - "Settings › Connection" does not exist in the app; Settings has a "Connections" section, which is something else.
    The label is on the tray's **Connection settings** page (`packages/desktop/ui/index.html`, card `data-mode="remote"`).
  - The server hub's wording is now the real banner.
  - "At most one button" is now "the button for its next step" (a crashing Blender has two).

## Findings not fixed here

- **pr-backend:** a fresh install can't make a Game team (or Dev team) project. It needs `@lead-engineer` and the skill
  `safe-shipping`, and nothing seeds them. The picker doesn't disable the team for it either. This goes against the
  owner's "no setup" goal.
- **pr-design-system:** Settings' **Check again** refreshes only Settings. The strip under it keeps the old state until
  `game-tools.changed` or window focus. Run 1 used a window `focus` event for `strip-not-installed`.
- **pr-design-system:** the strip shows **Fix in Settings** for "Another Blender running", but Settings has no step for
  it, only the sentence.
- **pr-design-system:** on a server hub, Settings › Game tools still says "Game tools run code as you on this PC".
- The Usage page in run 2 showed the real Claude weekly limit at 93 % (`run2/b11/usage-note-light.png`).

## Files

- `run1/`: fake PC. `d1/` has the states. `a11y/` has the walks and the focus checks. Also `actions.jsonl` and
  `hub-blender-lines.txt`.
- `run2/`: the real PC. `d1/` (another Blender), `d2/` (the live look-back), `p1/` (the guide walk), `b11/` (the usage
  note), `actions.jsonl` and `blender-lines.txt`.
- `run3/`: the server hub.
- `scripts/`: `hub_entry.ts`, `crash_stub.cs`, `tab_walk.mjs`.
- `fail-then-pass.txt` and `checks.txt`.
