# S2: Roblox Studio, live

These are items 1 to 5 of "S2: Roblox Studio" in `../APPROVAL.md`. They ran on 2026-11-24, from 20:55 to 21:04 (+08:00),
on the owner's PC, with his approval to launch Studio. Studio was version-8d7a1009c17e4ff8. Item 6 (**Open Studio** in an
installed build) is left to the separate installed-app run.

Both drivers start a throwaway in-process hub on a random loopback port, with a fresh `%TEMP%\toki-s2-*` data dir and
no Vite or browser. They follow `../e2e/live_e2e.ts`. `GameTools` gets no `env` override, so it reads
`process.env.LOCALAPPDATA` (`services/gameTools.ts`, `robloxDir`), which here is the owner's real `%LOCALAPPDATA%\Roblox`.
Nothing touched ports 7788 or 7789, the desktop app or its data, the PC runner, the VPS, or RobloxPlayerBeta.
One Haiku turn was used, out of a budget of 3.

| # | Item | Result | Evidence |
|---|---|---|---|
| 1 | A setting flip made with Studio closed takes effect on the next Studio start | **pass** | `flip.txt`, `flip-files.txt`, `turn.txt` |
| 2 | `execute_luau` card shows the code; "Always allow" works under Ask | **pass** for `execute_luau`. **Not exercised** for `multi_edit` | `turn.txt`, `cards.json` |
| 3 | `screen_capture` returns an image, and it becomes a look-back | **pass** | `turn.txt`, `screen.png` |
| 4 | `save_place` from a bot | **pass** | `turn.txt` |
| 5 | Detection with Studio open, and the fix refusing while Studio runs | **pass** (API). The room strip itself was not driven in a browser | `turn.txt` |
| 5b | `?launch=studio`'s resolver finds this PC's Studio exe (read, not launched) | **pass** | `resolver.txt` |
| — | Cleanup | done | `cleanup.txt` |

No bugs found, so no product code changed.

## 1. The setting flip, on the real file
- **Backup.** With Studio closed, the real `AssistantSettings\1742184827.json` was copied to `1742184827.json.orig`
  (sha256 `2fef6889…9867`).
- **Turned off by hand.** Only `mcp-server.enabled` changed, from `true` to `false`. That file is saved as
  `1742184827.json.off`.
- **Before the fix.** `GET /api/game-tools` reported
  `studio: {reason: "setting-off", setting: "off", running: false, fix: "studio-mcp-setting"}`.
- **The fix.** `POST /api/game-tools/fix/studio-mcp-setting` returned **200**,
  `{ok: true, result: "enabled", changed: ["…\\AssistantSettings\\1742184827.json"]}`. Status moved to
  `reason: "not-running", setting: "on"`, and the audit log got one row, `game_tools.studio_mcp_enabled 1742184827.json`.
- **The files afterwards** (`flip-files.txt`):
  - The fixed file is byte-identical to the original backup: same 4-space indent, LF line endings, no final newline.
  - `.toki-bak` is byte-identical to the hand-flipped `off` file.
  - `diff .toki-bak file` shows only line 10, `false` to `true`.
  - Key by key, `mcp-prompt-sharing`, `AssistantSkillsCloudMigrated` and `integrations` are unchanged.
- **It takes effect.** Studio was then started (`RobloxStudioBeta.exe -task EditFile -localPlaceFile
  %TEMP%\toki-s2-place-0d31a2\TokiS2.rbxl`, a copy of `Roblox\server.rbxl`, pid 37340). It opened the place with no login
  screen or dialog (`studio-open.png`). Its MCP then served the bot's calls: `list_roblox_studios` returned
  `TokiS2.rbxl`, mode Edit, and every later Studio call worked (`turn.txt`).
- **Not shown:** that Studio refuses MCP while the setting is *off*. Studio was never started with the setting off.

## 2 to 4. One real turn under Ask, Haiku builder, cards answered as the web answers them
- **Settings.** `approvals: "ask"`, model `claude-haiku-4-5-20251001`, `@lead-engineer` and the `safe-shipping` skill
  added. A Game team project was created: `setup: {git: "created", studio: "added"}`. The recipe uses
  `approve: "mode"` with the 13 `STUDIO_READ_TOOLS`.
- **How the cards were answered.** Through the web's own path, the `/ws` socket with `{type: "approval.decide"}`
  (`web/src/store.ts` `decide`, `hub/src/api/ws.ts`). The first `execute_luau` card got `always`, and everything else
  got `allow`.
- **One owner message** to `@studio-test-builder`: list studios, create a red Part `TokiTest` at 0,5,0 with
  `execute_luau`, print it with a second `execute_luau`, `inspect_instance`, `screen_capture`, `save_place`. The turn
  took 28 s.
- **Tool calls, in order:** list_roblox_studios, execute_luau, execute_luau, inspect_instance, screen_capture, save_place.
- **Cards: exactly 2** (`cards.json`, plus the `approvals` rows and the `approval.always` / `approval.allow` audit rows).
  - `execute_luau`: the payload has `codeField: "code"` and `once: false`. The code came through as real multi-line
    Luau (`Instance.new("Part")` …).
  - `save_place`: `codeField` is absent.
- **"Always allow" works.** The second `execute_luau` (`print(workspace.TokiTest.Position …)`) ran with **no card**:
  2 execute_luau calls, 1 execute_luau card.
- **Read tools ran with no card under Ask:** `list_roblox_studios`, `inspect_instance` and `screen_capture` (B3 `mode`).
- **`screen_capture` became a look-back.**
  - The tool message has attachment `img:ab2e323e…e2ad`. That is a 413 612 B PNG in the hub's media store, copied here as
    `screen.png` and viewed. It shows Studio's viewport on the opened place.
  - The tool output text is `[image]`, and 0 messages contain the CLI's `[Image: source:` path.
- **`save_place` saved.** The output was `Saved: Saved to the local place file. {"status":"Saved","filePath":"C:/Users/alex/AppData/Local/Temp/toki-s2-place-0d31a2/TokiS2.rbxl","location":"LocalFile"}`.
  The place file grew from 787 325 to 788 893 B, with mtime 21:02:53.
- **TokiTest exists in Studio.** `inspect_instance` on `Workspace.TokiTest` returned `className: "Part"` and
  `CFrame.Position: "0, 5, 0"`. The bot replied: "Created red Part "TokiTest" at (0, 5, 0) … Inspection confirms
  Position: 0, 5, 0 and BrickColor: Bright red. Place saved to TokiS2.rbxl."
- **Not exercised: `multi_edit`.** The bot had no script to edit, so it never called it. Its card is also not
  code-formatted by design: `outsideCodeField` only knows `execute_luau` and `execute_blender_code`
  (`services/outsideMcp.ts`), and no real `multi_edit` input has been seen yet (S1 found none). This stays open.

## 5. Studio open
- **Detection with Studio open.** `GET /api/game-tools` gave
  `studio: {ok: true, reason: "ready", setting: "on", running: true, fix: null}`, both before and after the turn.
- **The fix refuses while Studio runs.** `POST /api/game-tools/fix/studio-mcp-setting` with Studio open returned
  **409**, `{ok: false, step: "studio-mcp-setting", result: "studio-running", changed: []}`.
  - `enableStudioMcp` checks the process list before it reads any file, so this is the same refusal the "Close Roblox
    Studio first" state uses.
  - The setting was *on* at this point. The exact combination of setting off with Studio open was not staged, because
    Studio rewrites this file on exit (see cleanup) and the owner's file had to end as it started.
  - The room strip and Settings text were not driven in a browser. They are unit-tested in phase1-ui.

## 5b. The desktop resolver (`resolver.txt`)
- `launch.rs` `find_installed(App::Studio)` first takes the parent of the HKCU `ContentFolder` value,
  `…\Versions\version-8d7a1009c17e4ff8\content\`, and gets `…\version-8d7a1009c17e4ff8\RobloxStudioBeta.exe`. That path
  is under `Roblox\Versions` and is a file, so it is returned.
- The fallback, the newest `version-*` folder holding a Studio exe, gives the same file. The other version folder holds
  only the Player.
- It was not launched through the resolver: launching is item 6.

## Cleanup (`cleanup.txt`)
- **Studio.** pid 37340 was closed with `CloseMainWindow` and exited in about 6 s, with no force-kill.
- **The settings file.** Studio rewrote it on exit (mtime 21:03), and the content is **byte-identical** to
  `1742184827.json.orig` (`mcp-server.enabled: true`).
- **The `.toki-bak`.** It held only the hand-made `off` copy, so it was removed and the folder is as it was found.
- **Hubs.** Both throwaway hubs shut down, and the temp place and data dirs were removed.
- **Other processes.** No `blender.exe` was running. The pre-existing `StudioMCP.exe` (2188, 36852), `blender-mcp.exe`
  and RobloxPlayerBeta (27388) were left alone.
- **Exit noise.** Node 26 printed a libuv `UV_HANDLE_CLOSING` assertion after `process.exit` in `s2_flip.ts`. All output
  had already been written by then, and the step had finished.

## Rerun
From `packages/hub`, with Studio closed for `s2_flip.ts` and open on a place for `s2_turn.ts`:
`POCKETROCKET_DATA=<new %TEMP% folder> npx tsx ../../docs/verify/s2/<script>.ts`
