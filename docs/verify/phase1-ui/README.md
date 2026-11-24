# Phase 1 UI evidence: D1 and D5

These are tasks D1 (8118dfc) and D5 (7b239e6) from `docs/specs/toki-local-first-gamedev.md`. They were run on 2026-11-24 on
the owner's PC, which has Blender 5.2.2, uv 0.11.15 on PATH, and Roblox Studio installed but closed.

The live run used `verify-toki` (`node scripts/control-toki.mjs`) with the root `%TEMP%\toki-verify-d1d5`: a throwaway hub
on port 38984 with its own data dir, Vite on 38986 and headless Chromium. `doctor` passed before any evidence was taken.
Nothing touched ports 7788 or 7789, the desktop app or its data, or the VPS. Roblox Studio was not launched. The only
Blender started was the hub's own `blender -b --factory-startup --version` (B1). No bot turn ran, so no Claude quota was
spent. `stop` closed the hub, Vite and Chromium and deleted the run's data.

| File | What it shows |
|---|---|
| `d1/settings-light.png`, `.aria.yml` | Settings › Game tools on this PC, light: four items with status in words, versions, masked paths, the two plain lines, one button (Install Blender tools) |
| `d1/settings-dark.png`, `.aria.yml` | The same, dark |
| `d1/settings-light-narrow.*`, `d1/settings-dark-narrow.*` | 390×844, both themes |
| `d1/confirm-install.png`, `.aria.yml` | Install Blender tools opens the in-app `alertdialog`, not a native confirm. Cancel was pressed: no `game_tools` audit row and no `tools/` folder afterwards (`actions.jsonl`) |
| `d1/strip-and-d5-card.aria.yml` | The game room: `group "Game tools"` reading "Blender tools missing" and "Studio not open (unverified)", plus Fix in Settings. Below it the D5 card: `term studio_id`, then `region "code for execute_luau"` holding the full script up to its tail marker `TAIL_LUAU_3K_OK`, then Allow once and Deny in their usual order |
| `d5/card-luau-light.png`, `d5/card-luau-dark.png` | The card at 1382 px: monospace Luau with real line breaks and indentation, in the 60vh area |
| `d5/card-luau-dark-narrow.png`, `.aria.yml` | The card and strip at 390 px |
| `b3/tools-mode-label.png`, `.aria.yml` | Settings › Tools: the Studio recipe's `approve: "mode"` selected as "Follow approval setting" |
| `mutations.txt` | 12 guarded lines broken in turn; the tests catch 12 of 12 |
| `fail-then-pass.txt` | The new tests fail with the new modules moved aside, and pass with them |
| `checks.txt` | `pnpm lint`, `pnpm ts-strict`, the contrast and token-parity tests, the bundle budget, and the touched existing web tests |
| `actions.jsonl` | Every driver command in the run |
| `scripts/seed_game_room.ts` | The seeder (see below) |
| `scripts/narrow.mjs` | Narrow screenshots: the driver has no viewport command, so this sets 390×844, saves PNG and ARIA, and restores the size in one CDP session |
| `scripts/mutations.py` | From `packages/web`: `python -I ../../docs/verify/phase1-ui/scripts/mutations.py` |

## What was seeded, and how

Every UI step above went through the UI. These setup steps did not, because no UI path reaches them yet:

- **API:** a project (`POST /api/projects`), a group room (`POST /api/rooms`), the link (`PUT /api/projects/obby-run/room`), and
  the Studio recipe (`POST /api/game-tools/studio/setup`), which wrote only the temp data dir's `mcp-servers.json`.
- **`kind = 'game'`:** no route sets it until B7's template, so `seed_game_room.ts` sets it in the throwaway DB.
- **The approval card.** `features/approvals.md` says not to fake a card through the API, and a real one needs a bot turn
  (quota). The seeder instead calls the hub's own `PermissionBroker.askOutsideMcp` against the throwaway DB, with a 2842-char
  `execute_luau` input. The payload is the one B4's code emits (`toolName mcp__roblox-studio__execute_luau`, `codeField code`,
  `toolInput.input` with `code` and `studio_id`), but no model asked for it. Nothing answered it, so it stayed pending.

## Not verified here

- **Open Studio, live.** The button shows only when `desktopCan('studio')`, which a plain browser never has. Its mapping is
  unit-tested, and the click is the exact `window.open(location.origin + '/?launch=studio', '_blank')` from I1, but no desktop
  shell ran, and Studio must not be launched here (S2).
- **A fix pressed for real from the UI.** Install was cancelled on purpose. The routes' live installs are in
  `docs/verify/phase1-backend/live-install.txt`, and the 409 → `result` word → text path is covered only by `fixResultText`.
- **States this PC doesn't have:** crashing Blender with Open log, another Blender running, Studio open with the setting
  off (the disabled "Close Roblox Studio first" state), and a VPS hub (`supported: false`). They are unit-tested in
  `lib/gameTools.test.ts`, not seen live.
- **Keyboard traversal, live.** The code region has `tabIndex=0` and a focus ring (a test checks this), and focus returned
  to "Fix in Settings" when Settings closed (`d5/card-luau-dark.png`), but no Tab-by-Tab walk was recorded.
- **The classic layout.** The run used the Toki layout (project header). The strip mounts in ChatPane under either header,
  but only the Toki layout was shot.
- **Reduced motion.** No new motion was added, so there was nothing to turn off.
