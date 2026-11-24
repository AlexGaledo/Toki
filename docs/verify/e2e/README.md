# Live end-to-end: a real bot turn drives Toki's headless Blender

Run 2026-11-24 on the owner's PC by the coordinating session. Script: `live_e2e.ts`. Full log: `live-e2e.txt`.

Setup:
- A throwaway hub with a temp data dir. It ran on its own, with no Vite and no browser, because free RAM was 1.3 GB.
- Approvals set to **bypass** (owner decision 2). Bots ran on Haiku 4.5.
- Blender MCP tools installed through `POST /api/game-tools/fix/install-blender-mcp`.
- A **Game team** project created through `POST /api/projects`.
- **One** owner message to `@cube-test-artist`: add a red cube, take a look-back, save.

| Check | Result |
|---|---|
| Blender started from the bot's first `blender` call, headless | `[blender] ready for cube-test after 11.0 s`, on a loopback port other than 9876 |
| Tools the bot called through the built-in `blender` mount | get_addon_status, get_scene_info, execute_blender_code, look, execute_blender_code x2 |
| No approval cards under bypass | none were raised (B3 `mode`) |
| Look-back stored as media and attached to the tool message (B9) | `mcp__blender__look -> img:cbff047c…`, 207 714 B PNG, saved here as `lookback.png` (shows the red cube) |
| No CLI tool-result file path in the chat | 0 messages contain `[Image: source:` |
| Saved without wm operators (`toki_save`) | `art/cube-test.blend` is 76 005 B; `git status` shows `?? art/cube-test.blend` (`project-state.txt`) |
| Blender stopped when the hub quit | `stopped … after 32 s; peak working set 586 MB`; no `blender.exe` running afterwards |
| Turn time | 48 s, with a single message |

Not covered here: the room strip updating live in a browser (no browser ran), the skills' A/B trap test, and Studio (S2).
