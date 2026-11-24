# Real-setup run: the installed app and the real server

This run covers the "Still to verify live" items in `../APPROVAL.md` that needed the owner's real setup:
- the installed desktop app over his Toki 0.5.4;
- his old `{"mode":"remote"}` config;
- the real VPS (`crm-agency`, 54 bots);
- Roblox Studio on this PC.

It ran on 2026-11-24, from 21:10 to 22:45 (+08:00). The owner approved the install and the deploy for this run only.
Nothing was pushed, merged or tagged.

| What | Value |
|---|---|
| Branch | `feat/gamedev-tools`, with origin/main (dee0210) merged in as `a2c0e3b` |
| VPS | `a2c0e3b`, deployed at 13:36:51 UTC (`SKIP_SCREEN=1 DEPLOY_ANY_TREE=1`, run from a fresh detached worktree, `Desktop\toki-deploy-gamedev-20261124-213505`). The server's git was left as it was |
| Installed | The NSIS build of `a2c0e3b` (`PocketRocket_0.5.4_x64-setup.exe`, sha256 `8550d4e0…4d87`). The version string is still 0.5.4. Node sidecar v24.22.3 |
| Rollback | `ROLLBACK.md` |

**Captures kept off the repo.** The repo is public, and the screenshots and ARIA snapshots show the owner's real rooms, messages,
name and email. So they stay on his PC in `C:\Users\alex\pr-rollback-gamedev-20261124\evidence-private\`: the `01`–`12`
`.png` and `.aria.yml` files named below, plus unredacted copies of the text files. The text files here use placeholders:
- his server projects are Project A to H (`project-a` …);
- his bots are `@lead-bot` and `@worker-bot`.

## Results

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | Old `mode: remote` config: the PC hub on 7788, no tunnel at start, **Open your server** uses 7790 with no token prompt, and 7790 listens on loopback only | **pass** | `pre-install.txt`, `check1-old-config.txt`, `01-pc-hub-start.png`, `02-open-your-server.*` |
| 2 | The PC hub's `GET /api/projects` lists the server's projects, tagged `server`, `connected: true` | **pass** (8 of the server's 8) | `check2-pc-projects.json`, `check2-server-own-projects.txt`, `03-pc-with-server-stubs.*` |
| 3 | Loss: kill the tunnel ssh (not the VPS hub). Within 30 s the stubs read false, a notification shows, and the window returns to the PC hub | **pass**: back in 5.8 s, toast after 1 s, `connected: false` by 8.9 s. The PC bot turn was skipped (optional; the PC hub has no bots) | `check3-loss.txt`, `check3-reconnect-repro.txt` |
| 4 | Port 7790 in use: Connect refuses with the port message | **pass** | `check4-port-busy.txt`, `09-port-busy-failed.*` |
| 5a | Restart the PC hub while connected: the stubs come back | **pass** (`seenAt` refreshed when the new hub came up). **Bug found and fixed**, see below | `check5a-restart-while-connected.txt`, `04-hub-stopped-splash.*`, `fix-hub-stopped-hint.txt` |
| 5b | Quit while connected, then start: a stale `connected: true` is cleared | **pass** | `check5b-quit-and-start.txt` |
| 6 | Open folder opens Explorer on `projects\<slug>`, and a missing folder gives a notification | **pass** | `check6-open-folder.txt`, `11-settings-projects.*` |
| 7 | D4 in the real shell: a PC project offline, the prompt for an offline Server project, Connect loads `project=<slug>`, and the failed-connect reason in a notification | **pass** | `check7-d4.txt`, `06`–`10` shots |
| S2-6 | **Open Studio** from the installed app: no arguments, not in Toki's job, still open after Toki quits, and no second Studio within 10 s | **pass** | `s2-open-studio.txt` |
| I4 | The installer carries `hub/resources/blender/` | **pass** (sha256 of the installed files equals the source's) | below |
| — | VPS after the deploy: health, the new route, the schema, bots answering | **pass** | below, `vps-after.txt` |

## How it was driven

- **The installed app.** It was started with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9339 --remote-debugging-address=127.0.0.1` for the test session only.
  - A small CDP driver (the repo's playwright-core, `connectOverCDP`) read URLs with the fragment cut, took screenshots and ARIA snapshots, and clicked by role and name.
  - It called the hub with the page's own token from `sessionStorage`. The token was never printed.
  - At the end the app was quit and started normally, so no debug port is left open.
- **Desktop calls.** `window.open('/?openhost=server')` is the same call as the tray's **Open your server**: both reach `server::connect(Open::Home)` (`lib.rs` 1114 and 1582). The tray menu itself was not clicked.
- **Notifications** were read from a read-only copy of `%LOCALAPPDATA%\Microsoft\Windows\Notifications\wpndatabase.db`, filtered to the `com.pocketrocket.app` handler. A full-screen capture showed the owner's own game in front, so it was deleted.
- **The job check** (S2). Every process on this Windows 11 PC is in some job, so a plain `IsProcessInJob(NULL)` proves nothing. Instead, Toki's own job handle was duplicated (query access only), and each process was tested against it, with the PC hub node and the tunnel ssh as controls.
- **"Restart hub" (5a) is the splash's Retry.** The tray has no Restart hub item, and the phase3-infra README's "(tray, Restart hub)" is wrong. The PC hub's node was stopped (it had no bots or projects), the window fell back to the splash, and Retry was pressed.

## I4: the installer

- `pnpm desktop:build` from `a2c0e3b`: the hub bundle, then fetch-node (v24.22.3, sha256 checked), then `cargo tauri build` (release, 17 min).
- The installer was not opened, because there is no 7z on this PC and the payload is LZMA.
- After a silent install (`/S`, exit 0), `%LOCALAPPDATA%\PocketRocket\hub\resources\blender\` holds:
  - `toki_blender_server.py`, sha256 `87bfd17e…78de3`;
  - `requirements.txt`, sha256 `feb0091e…e6260`.

  Both match `packages/hub/resources/blender/` byte for byte. `node.exe` matches the fetched sidecar.
- This was an install over 0.5.4, not a clean machine.

## VPS

- **Before the deploy:**
  - `df -h /`: 13G free (87%).
  - The DB backup was taken first (`ROLLBACK.md`).
  - No bot process and no hub log lines in the 5 minutes before.
- **deploy.sh:** the chown took about 2 minutes with no hang, the build was clean, and the service is `active` and runs `dist/hub.mjs`.
- **After the deploy:**
  - `/api/health` ok.
  - `PUT /api/hosts/server/projects`: 401 without a token, and 400 (a schema error) with it, while an unknown route is 404. So the route exists.
  - The `remote_hosts` and `project_stubs` tables exist.
  - The tracked files on the server equal `a2c0e3b` (hash check of `server.rs` and `migrations.ts`).
- **Bots answer.** Three owner messages after the deploy each got bot replies (`vps-after.txt`). NRestarts is 0, and the journal has no errors.
- **One stray write, undone.** A throwaway project was created on the server by mistake, because the window had been put back on the server (see below). It was deleted at once through `DELETE /api/projects/toki-verify-tmp`, and its scaffold folder (`current.md`, `features/README.md`) was removed. The server is back to its 8 projects.

## Findings

1. **Bug, fixed:** the hub-stopped message named a button that wasn't on screen.
   - The message read "...; Restart hub starts it again." The splash's button reads **Retry** whenever the hub is down, and "Restart hub" only while it runs.
   - Fix: one constant, `HUB_STOPPED_HINT`, for both messages, plus a test that reads `splash.js`'s disconnected label.
   - Fail-then-pass is in `fix-hub-stopped-hint.txt`; `cargo test --lib` passes 97.
   - It is not rebuilt into the installed app, because no check needed that.
2. **The reconnect at 22:24:50 was the owner, not the app.** 12 s after the loss test, a new tunnel opened.
   - It didn't reproduce with no input, and the web never sends `openhost=server`.
   - The owner's message reached the server hub 36 s later, so he reopened his server from the tray.
   - This is also why the first throwaway project landed on the server. Every later write first checked that the window was on 7788.
3. **Follow-up (pr-infra, not fixed): the window title stays "Toki · this PC" while it shows the server.** `window_title` (`lib.rs`) depends only on the mode.
4. **UX note (owner's call): a migrated server user now opens onto the PC hub.**
   - This PC's old local data from September opened on the onboarding's "Pick your first helper" step on first start.
   - The server is one click away (Open your server, or a Server project), but it is no longer what opens by default.
5. **Test note, pre-existing:** `providers/gemini.test.ts` "picks the .cmd shim" fails on this PC, because the owner has a real `%LOCALAPPDATA%\agy\bin\agy.exe`, which the test finds first. The branch does not touch gemini.

## Left on the PC

- Toki is running normally, with no debug port. The PC hub is on 7788.
- The tunnel is connected (ssh on 127.0.0.1:7790), and the window shows the server hub (project G). This is the old setup's server, now reached through Open your server.
- `config.json` is unchanged (sha256 equal to the backup).
- The PC runner (7789) was not touched.
- No Studio or Blender started by this run is still open. The owner's RobloxPlayerBeta and the StudioMCP helpers were left alone.

## Merge and tests (step 0)

- **The merge:** origin/main (2 commits, #250) merged with no conflict.
  - The CHANGELOG gained only main's one line.
  - `changelog-guard.mjs` reports the released sections intact, and they are byte-equal to main from `[0.5.4]` down.
- **Hub:** 2561 passed and 3 failed under load (`--maxWorkers=2`).
  - Rerun alone, `sessionMove` and `fileAttachments` pass.
  - The gemini failure is the environment one above.
- **Web:** 416 passed. `PcSessionViews.test.tsx` hit a hook timeout under load and passes alone (5 of 5).
- **Scripts** (`node --test scripts/*.test.mjs`): 62 passed, 0 failed.
- **Rust:** `cargo check` is clean.
