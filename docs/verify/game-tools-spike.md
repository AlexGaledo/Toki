# S1 spike: game tools on the owner's PC

Task S1 from `docs/specs/toki-local-first-gamedev.md`, run on 2026-11-24 (15:05 to 15:25, +08:00) on the owner's PC
(Windows 11, 16 GB RAM, RTX 3050 Laptop GPU, Blender 5.2.2 LTS, Roblox Studio version-8d7a1009c17e4ff8). No product code
changed. Raw evidence is in [`game-tools-spike/`](game-tools-spike/), and the scripts that produced it are in
[`game-tools-spike/scripts/`](game-tools-spike/scripts/).

## Answers

| # | Question | Answer | Evidence |
|---|---|---|---|
| a | Cold-start Blender serves 9876 with no click | **Replaced: headless is the default** (owner, mid-spike). Before that, one GUI run said **yes**: 10.1 s after `blender.exe` with no .blend, `ping` and `get_scene_info` answered on 127.0.0.1:9876. | `game-tools-spike/a-cold-start.txt` |
| b | `uvx.exe` and `cmd.exe /c mcp.bat` start from a hub-spawned Claude turn | **Yes**, both. `get_scene_info` and `look` came back from Blender, and `list_roblox_studios` returned `{"studios":[]}` (Studio closed). | `t1-look-result.aria.yml`, `t1-readtool-card.aria.yml`, `actions.jsonl` |
| c | Length of 10 real `execute_luau` / `multi_edit` inputs | 108 real `execute_luau` calls in 12 local Claude Code transcripts. The 10 newest had input JSON of 643, 748, 602, 776, 366, 844, 829, 561, 1580 and 1586 chars. Across all 108: median 715, p90 1307, **max 2244**, none over 8000. **No `multi_edit` call exists** in any transcript. `execute_blender_code` (20 calls): median 401, max 1607. | `c-execute-luau-lengths.txt`, `c-execute-blender-code-lengths.txt` |
| c' | Do long inputs show in full on the card (feeds B4) | **Yes, nothing is cut off**: a 3044-char input showed in full (the tail marker `TAIL_A_3K_OK` is in the card's ARIA text). A 9161-char input was **refused**, not truncated: "its input is too large to show for approval (9161 chars)". **But it is not readable**: the card shows the code as a double-escaped JSON string (`\\n` instead of line breaks) inside a 160 px scroll box. | `t2-card-A.png`, `t2-card-A.aria.yml`, `t2-after.aria.yml` |
| d | Owner sees images from `look` / `screen_capture` (feeds B9) | **No.** The tool output in chat is the text `[image]` plus a local file path, with no `img` element. `look`: seen live. `screen_capture`: **untested live** (Studio not open), but it takes the same code path (`providers/claude.ts:799-803` turns every non-text block into `[image]`). | `t1-look-result.png`, `t1-look-result.aria.yml` |
| e | Flipping `mcp-server` in the settings JSON with Studio closed takes effect on the next start | **Unknown.** Studio was not open, and the owner said not to launch it. Read-only today: `AssistantSettings/1742184827.json` has keys `mcp-prompt-sharing`, `AssistantSkillsCloudMigrated`, `integrations` and `mcp-server`; `mcp-server` is `{"enabled":true}` and `mcp-prompt-sharing` is `{"enabled":false}`. | this note |
| f1 | Headless job per run (`-b`, a .blend on disk, EEVEE preview) | **Yes.** The engine id is `BLENDER_EEVEE` (there is no `_NEXT` in 5.2). EEVEE renders in `-b` on the RTX 3050 (OpenGL). A 512x512 frame took 27.3 s on the first EEVEE run (shader compile), then **3.5 s warm**. Job wall clock: 31.4 s cold, **7.1 s warm**; a no-op Blender start alone is 4.75 s. | `f-headless-runs.txt`, `f1-headless-eevee-warm.png` |
| f2 | Persistent headless MCP server | **Yes, with a pump.** The add-on refuses on its own: `start()` prints "cannot start server in background mode (blender -b)", because its command queue is drained by a `bpy.app.timers` callback that never fires in `-b`. `scripts/f2_server.py` (about 30 lines) binds 127.0.0.1:9877 itself and drains the queue on the main thread. The real MCP server (`uvx mcp-for-blender==2.3.1` with `BLENDER_PORT=9877`) then worked for `get_scene_info`, `execute_blender_code` and `look` in camera, solid and default modes. The hub turn in (b) and (d) ran against this headless server. | `f-headless-runs.txt`, `f2-server.log`, `f2-look-*.png` |

### Latency (warm, this PC)

| Path | One-time cost | Per call |
|---|---|---|
| Headless job per run | about 4.75 s Blender start, every job | `execute` work plus a 3.5 s EEVEE 512² preview: about **7 s per job** (31 s the first time EEVEE compiles shaders) |
| Persistent headless MCP | Blender start (about 5 s) plus a 0.2 s bind, then MCP connect 2.9 s (22 s on uvx's first resolve of the pin) | `execute_blender_code` **0.02 s**, `get_scene_info` 0.02 s, rendered `look` **0.5 s** (5.4 s on the first render), solid `look` 0.06 s |

### Viable?
- **Headless only (a run per job with a .blend on disk): viable.** It needs no add-on and no socket, and nothing has to stay running. The cost is about 7 s per job, and the scene state lives only in the saved .blend.
- **Persistent headless MCP server: viable, and much faster per step** (milliseconds per code call, 0.5 s per preview). But it depends on the add-on's private internals (`BlenderMCPServer.command_queue`, `_server_loop`, `_drain_command_queue`), so the add-on version must be pinned with the server, and the pump has to be retested on each bump. It also keeps one Blender (RAM) alive while a room works. The socket is still unauthenticated, so any local process can send it code.

## Do B4 and B9 need to happen?

- **B4: not as written.** Nothing is ever cut off. The hub already refuses inputs over 8000 chars (`OUTSIDE_INPUT_CAP`, `PermissionBroker.ts:114`, `:541-543`), and every real input measured is under 2300. Raising the cap to 32 000 is not needed. **A readability fix is needed instead**: the outside-tool card nests the input as a JSON string inside JSON (`{server, tool, input: "<json>"}`), so code shows as one escaped line with `\\n`. Suggested reframe for the owner: show the `code` field (`execute_luau`, `execute_blender_code`) as preformatted code on the card. That is a pr-design-system plus pr-backend change.
- **B9: needed.** `look` images never reach the owner (see d).

## Spec facts that turned out wrong or incomplete

1. **The recipe pin does not pin the server.** `blender-mcp` 2.0.0 is a shim with `Requires-Dist: mcp-for-blender>=2.0.0`, with no upper bound, and the server is in `mcp-for-blender`. Pin `uvx mcp-for-blender==2.3.1` (console script `mcp-for-blender`), as this spike did.
2. **`readTools` do not stop cards under `ask`.** Under `ask`, `get_scene_info`, `look` and `list_roblox_studios` each raised the hub's normal card ("... requires approval"), because the bot's `allowedTools` did not list them. `readTools` only skip the extra once-only hook card. Writes got only the once-only card, since the hook's `allow` skips the normal card. So today, under `ask`, every outside call asks. B3 should state what `readTools` mean under `ask`. (`t1-readtool-card.aria.yml`)
3. **The card cap is 8000 chars, and over it the call is refused, not truncated** (see B4). Also, the once-only card has no "Always allow…" button ("Asked every time.").
4. **The add-on never auto-starts in `-b`** (`bpy.app.background` returns early in `_blendermcp_ensure_server_running`, and `start()` refuses). The spec's 9876 detection, the "Restart Blender" fix and I1's "Open Blender" all assume a GUI Blender, which the owner no longer wants. A Toki-owned headless server on its own port (9877 here, through `BLENDER_PORT`) fits the owner's preference. It also avoids clashing with a GUI Blender he opens himself, because the add-on skips auto-start when the port is taken (`_blendermcp_port_has_listener`).
5. **Images from tool results land in the owner's home folder**: the Claude CLI wrote the `look` PNG to `~/.claude/projects/<cwd-slug>/<session>/tool-results/mcp-blender-blob-*.png`, outside Toki's data dir, and that path is shown in chat. B9 should take the image block from the SDK message, not that file.
6. **The "read" Blender tools run code**: mcp-for-blender 2.3.1 sends `get_scene_info` and `look` to the add-on as `execute_code` scripts (`f2-server.log`). They are read-only by intent, not by mechanism.
7. **The add-on phones home in GUI mode**: on start it GETs `https://raw.githubusercontent.com/ahujasid/blender-mcp/main/addon.py`, unless Blender runs `-b` or `BLENDERMCP_NO_UPDATE_CHECK` is set. Add that host to the outbound list, or set the variable in the recipe.
8. At spike start, Blender was **not** open (only two `blender-mcp.exe` servers left over from earlier sessions), contrary to the brief.

## How it was run

- **Throwaway Toki:** `node scripts/control-toki.mjs launch --root %TEMP%\toki-spike`. The data dir was `%TEMP%\toki-spike\run\data`; `doctor` passed every check. The driver has no port flag, so the hub ran on a free loopback port (17835), not 7795. Nothing touched 7788, 7789, the desktop app, `%APPDATA%\com.pocketrocket.app`, the PC runner or the VPS.
- **Setup through the API** (not a UI proof): one bot `@spike` pinned to Haiku 4.5 (`allowedTools: ["Read"]`, $0.50 budget) and one group room `game-spike`. Both recipes were written by hand into the throwaway `mcp-servers.json`, scoped to that room with `approve: "writes"`, as S1 says (`blender`: `uvx.exe mcp-for-blender==2.3.1`, env `DISABLE_TELEMETRY`, `BLENDER_HOST`, `BLENDER_PORT=9877`; `roblox-studio`: `cmd.exe /d /c ...\Roblox\mcp.bat`). Approvals stayed at the default `ask`.
- **Bot turns: 2** (Haiku), both sent and approved through the UI. Turn 1: `get_scene_info`, `look`, `list_roblox_studios`. Turn 2: `execute_blender_code` with a 3 KB and a 9 KB input.
- **Blender:** one GUI instance (pid 1424) was started for (a) and closed when the owner asked. After that, only `-b --factory-startup`, one Blender at a time. `f1_job.py` used `bpy.ops.wm.save_as_mainfile` before the "no `bpy.ops.wm.*`" rule arrived; future jobs should save with `bpy.data.libraries.write`.
- **Studio:** never launched. The two `StudioMCP.exe` and the `RobloxPlayerBeta.exe` already running were left alone.
- **Cleanup:** `control-toki.mjs stop` (hub, Vite, Chromium, run dir), and the headless Blender stopped by its `f2_server.py` command line. Afterwards, nothing listened on 9876, 9877 or the run's ports, and no `blender.exe` was left.

## Not verified

- (e) and every live Studio step: `execute_luau` and `multi_edit` cards, `screen_capture`, `save_place`. They need Studio open.
- Whether `look` in viewport mode in a GUI Blender returns the same kind of block: very likely, since it is the same MCP content type, but only the headless server was driven by the hub.
- RAM used by a persistent headless Blender (not measured).
