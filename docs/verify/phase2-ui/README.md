# Phase 2 UI evidence: D2, D3, and follow-ups (a), (b), (c)

This covers tasks D2 and D3 from `docs/specs/toki-local-first-gamedev.md`, plus three follow-ups from Phase 1:
- (a) the room strip re-reads on `game-tools.changed` and on window focus, with no timer;
- (b) Settings › Tools masks the user folder in command lines;
- (c) Needs you and the Overview preview outside-tool cards in words.

Everything ran on 2026-11-24 on the owner's PC, which has Blender 5.2.2, uv on PATH, and Roblox Studio installed but closed.

| Commit | Task |
|---|---|
| c98e388, 222a003, 9970651 | D2: look-back thumbnails, plus two tests added after the first mutation pass |
| b04029c | D3: the template picker |
| 6f668ee | (a) the strip re-reads on the event and on focus, with no 30 s timer |
| e9d7020 | (b) the user folder is masked in Settings › Tools |
| a26094d | (c) the Needs you and Overview previews |
| d2c4bda | ts-strict: no new unchecked index access |

## Live runs (verify-toki)

The driver was `node scripts/control-toki.mjs` with the root `%TEMP%\toki-verify-p2ui`. Each run used a throwaway hub with its own data dir, Vite and headless Chromium on free ports, and `doctor` passed before any evidence was taken.

Safety notes for both runs:
- Nothing touched ports 7788 or 7789, the desktop app or its data, or the VPS.
- No Blender or Studio process ran. The only Blender call was the hub's own `blender -b --factory-startup --version` (B1).
- No bot turn ran, so no Claude quota was spent.
- `stop` closed the hub, Vite and Chromium and deleted each run's data.

**Run 1** (`actions-run1.jsonl`) produced the blocked picker in light and dark, wide and narrow, and the keyboard walk. Pressing **Install Blender tools** in that run failed with `requirements-missing`; see "Found on the way" below.

**Run 2** (`actions-run2.jsonl`) went like this:
1. **Install Blender tools** went through the real UI and the in-app confirm. It installed into the temp data dir and wrote the audit row `game_tools.blender_mcp_installed 2.3.1 b363e5b4…`.
2. The picker turned ready.
3. **Obby Run** was created through the picker with **Game team** selected.
4. **Tower Climb**, a second project, was created the same way, so the result card could be shot in dark.
5. The look-back and the approval card were seeded (see below).
6. The UI was read.

| File | What it shows |
|---|---|
| `d3/picker-blocked-{light,dark}.png`, `.aria.yml` | `radiogroup "Team"`: None, Dev team, and `radio "Game team" [disabled]`. Game team's description ends with "Install the Blender tools in Settings › Game tools first.", and Create is disabled until a name is typed. The reason line is not dimmed |
| `d3/picker-blocked-{light,dark}-narrow.*` | The same at 390×844, scrolled so that Game team is on screen |
| `d3/keyboard-arrow-to-game.aria.yml` | From None, ArrowDown checks Dev team. The next ArrowDown moves focus to Game team, which stays unchecked, and its reason is read out. One more ArrowDown wraps to None (in `actions-run1.jsonl`) |
| `d3/game-tools-after-install.aria.yml` | Blender MCP tools now reads "Installed 2.3.1" |
| `d3/picker-ready-{light,dark}.*`, `picker-ready-dark-narrow.*` | Game team is enabled, with no reason line |
| `d3/created-setup-light.*` | After **Create project**, the card reads "Obby Run is set up". Git: "now keeps a history, starting with a first commit". Roblox Studio: "its tools are on in the game chat". Blender: "starts headless". A toast says "created with a team of 3" |
| `d3/created-setup-dark.*`, `created-setup-dark-narrow.*` | The same for Tower Climb, in dark, at wide and at 390 px |
| `d3/api-projects-after-create.json`, `d3/git-log.txt` | A read-only second view: `kind: "game"`, a room, 3 members, and the first commit `Start Obby Run from the game team template` |
| `d2/lookback-{dark,light}.*` | Under Blender Artist, "Worked · 2 steps" (folded), followed by `button "Look-back from blender: look"`. It holds the spike's real headless EEVEE render in a fixed 128×96 box, followed by the bot's reply |
| `d2/lookback-dark-narrow.*` | The same at 390 px |
| `d2/lightbox.*` | A click opens `dialog "Look-back from blender: look"`, the same viewer attached pictures use. Escape closes it |
| `b/tools-masked-dark.*` | The Studio recipe in Settings › Tools reads `C:\WINDOWS\System32\cmd.exe /d /c ~\AppData\Local\Roblox\mcp.bat`, with "Show the full roblox-studio command" and "Copy …" buttons. The Windows user name appears 0 times in the snapshot |
| `c/needs-you-light.*`, `c/needs-you-light-narrow.*` | The Needs you row and the Overview card both read `roblox-studio · execute_luau: -- Add a finish pad at the end of the obby`, not escaped JSON. `d2/lookback-dark.png` shows the Overview in dark |
| `seed.txt` | The seeder's output: the media ref, the tool message id, and the card's `codeField code` |

### What was seeded, and how

These steps did not go through the UI:
- **API setup:** `POST /api/bots` (@lead-engineer) and `POST /api/skills` (safe-shipping). A fresh hub lacks both, and the game template needs them, as in phase2-backend.
- **The look-back:** `scripts/seed_phase2_ui.ts` writes it the way `BotRunner.onToolResult` does. It inserts a running `mcp__blender__look` tool message, then patches it done with `attachments: [ref]`. The `ref` comes from the hub's own `storeLookBack` on `docs/verify/game-tools-spike/f2-look-camera-rendered.png`.
  - A separate process cannot send the hub's WS events, so the page loaded the message from history.
  - The live `message.update` path is proven by `packages/web/src/store.lookBack.test.ts`, which applies BotRunner's exact patch to the store.
- **The approval card:** it came from the hub's own `PermissionBroker.askOutsideMcp`, as in phase1-ui. Nothing answered it.

## Logic proofs

- **`fail-then-pass.txt`:** for each task commit, the source files go back to the parent commit and that commit's tests fail. With the source restored, they pass.
  - Run it with `bash docs/verify/phase2-ui/scripts/fail_then_pass.sh <commits>`.
  - Some of these failures are only "module missing", which is why the mutation pass below exists.
- **`mutations.txt`:** 24 guarded lines were broken in turn, and the tests caught all 24.
  - The first pass caught 23. The survivor was the look-back's tool-kind check; 222a003 tightened its test, and the rerun catches it.
  - Run it with `python -I ../../docs/verify/phase2-ui/scripts/mutations.py` from `packages/web`.
- **`checks.txt`:**
  - `pnpm lint` (clean) and `pnpm ts-strict` (1493 frozen, none new).
  - The contrast and token-parity tests (8 of 8).
  - The bundle budget: the entry chunk is 923,815 bytes against a budget of 1,320,000.
  - `tsc --noEmit` for web, the whole web vitest suite (49 files, 382 tests), and `repo-guards`.
  - No full `pnpm test` and no `pnpm -r build`, because of the RAM rule.

## Found on the way (for pr-backend)

- **The dev hub can't find its Blender resources while `packages/hub/src/node_modules` exists.**
  - `resolveHubDir` (`config.ts:12`) picks the first folder that has a `node_modules`. A vitest cache at `packages/hub/src/node_modules/.vite/vitest/` (made at 17:35 by a hub test run with `src` as cwd) made `HUB_DIR` resolve to `packages/hub/src`.
  - So `blenderServerScript()` looked in `src/resources/blender/`, and **Install Blender tools** answered `requirements-missing` (run 1, audit `game_tools.fix_failed requirements-missing`).
  - For run 2 the cache folder was moved out of the repo, not deleted.
  - Suggested fix: resolve `HUB_DIR` by `package.json` rather than by `node_modules`, or ignore a `node_modules` that only holds `.vite`.

## Not verified here

- **Open folder.** This was not built. The desktop shell has no way for the page to open a project folder:
  - `open_data_folder` is a tray action for the whole data dir;
  - `localcopy` copies one file into Documents.

  This needs pr-infra, for example a `?openfolder=<slug>` handled like `?launch=studio`, with the path resolved by the shell.
- **A live look-back from a real `look` turn.** That needs a Blender plus a Claude turn, so the message was seeded (see above).
- **The disabled states this PC can't show live:** Blender not installed, a non-Windows hub, an add-on mismatch, and a failed status read. The tests in `lib/projectTemplates.test.ts` cover them.
- **The `setup` words other than `created`/`added`.** Covered by unit tests only.
- **(a) live.** No Blender started, so no `game-tools.changed` event fired in the UI during the runs. The re-read is proven by `lib/useGameTools.test.ts` on the real store.
  - Without the timer, the strip's "idle N min" only updates on an event or on focus.
- **The classic layout and reduced motion.** No motion was added.
- **A pre-existing narrow quirk.** At 390 px, the Settings dialog shows a faint horizontal scrollbar under the project cards (`d3/created-setup-dark-narrow.png`). It comes from the existing project header row, not from this change.
