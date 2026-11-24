# Local-first Toki with Blender and Roblox Studio

Status: draft spec, 2026-11-24. Asked for by the owner. Nothing here is built yet. Code facts were checked on
`origin/main` (5fcf8a6), and PC facts were checked on the owner's machine on 2026-11-24.

Clean-room note: this spec describes OpenBot's *model* (`docs/specs/openbot-gaps/00-openbot-recon.md`) as a reference
point. Nothing in it, or in the tasks it creates, may copy OpenBot code, identifiers, strings or assets
(`docs/specs/openbot-gaps/05-owner-decisions.md`, Cross-cutting).

## Problem / user story

The owner's words: "i want this all automatic or no setup needed especially in the blender and roblox studio, the goal
is for me to iteratively develop games inside toki while it being connected to roblox studio and blender", and "should
be mainly connected to local computer then optional vps."

Today his bots run on the VPS hub. The desktop app only reaches that hub through an `ssh -L` tunnel
(`packages/desktop/src-tauri/src/lib.rs:213-226`). Blender and Studio run on his PC. The only bridge is the PC runner
(`scripts/pc-runner/README.md`). It runs a whole `claude -p` job per request, needs two approvals per job, and is
switched on and off with desktop shortcuts. Today he hand-built a `blender` runner folder with blender-mcp. That works
as a stopgap, but it is not a loop he can iterate in, and every new tool means hand edits.

> As the owner, I open Toki on my PC, make a game project, and it finds Blender and Roblox Studio, connects them, and
> gives me a team that builds in Studio and models in Blender while I watch and steer in chat. It asks me before it runs
> code in either app. My VPS keeps running my other bots, and I can still reach it from my phone, but game work does
> not depend on it.

## Scope

**In**
- The PC hub as the primary host (local mode already exists; this makes it the owner's daily setup). The VPS becomes an
  optional always-on second host.
- Detecting Blender and Roblox Studio, installing and enabling the Blender add-on, registering both MCP servers scoped
  to a game room, showing status, and offering one-click fixes.
- A game team template, skills for the Studio and Blender loop, screenshots ("look-backs") in chat, and checkpoints of
  game files.
- Windows only, because that is the only installer (`docs/GUIDE.md:103-112`).

**Out**
- Syncing two hubs, or merging their histories. This is a deliberate choice, explained below.
- VPS bots reaching Blender or Studio directly, through a reverse tunnel or anything else. They keep `run_on_pc`.
- Publishing to Roblox. Bots never publish; `save_place` never publishes (its own description says so).
- Rojo or another file-sync plugin for Studio scripts (see Phase 4 note), Git LFS, macOS and Linux.
- A "full access" mode. See "Where Toki deliberately differs".

## Design

### The host model (matching OpenBot's shape)

OpenBot is a desktop app whose agents live on the user's own computer. An optional server (Docker, a curl install, or
hosted plans) can act as the host instead, and its mobile and web clients connect to whichever host the user picked.
Toki already has the same three pieces:

| OpenBot shape | Toki today | Toki after this spec |
|---|---|---|
| Desktop app hosts the agents | **This PC** mode: the app spawns the hub as its own child, with data in the app's data dir (`lib.rs:2-6`, `lib.rs:459-519`, `docs/SERVER.md:14`). It is already the default for new installs (`lib.rs:59-60`). | The owner's primary host. Game tools exist only here. |
| Optional server host | **Server** mode over an SSH tunnel (`lib.rs:213-226`, `docs/SERVER.md`). | Optional always-on host for routines, triggers, Telegram, and the phone when the PC is off. |
| Phone and web clients connect to a host | PWA plus phone pairing (`docs/GUIDE.md:414`), with Tailscale Serve to reach a loopback hub (`docs/GUIDE.md:345`). | Unchanged. The phone pairs with whichever host it should reach: the PC for game work, the VPS when the PC is off. |

#### Where Toki deliberately differs

- **No "Full access" default.** OpenBot runs agents with full access after a consent screen at first launch
  (`00-openbot-recon.md:52-53`). Toki keeps `approvals: 'ask'` as the default
  (`packages/shared/src/providers.ts:136`), as principle 2 requires.
- **Code execution in Blender and Studio asks on every call, even under bypass.** Outside MCP tools that are not on
  the server's `readTools` list raise a card on every call, and no "always" answer or rule skips it
  (`packages/hub/src/permissions/PermissionBroker.ts:528-555`; tested in `permissions/outsideMcpApproval.test.ts:44-52`).
  The card is enforced with a PreToolUse hook, so bypass mode cannot skip it (`providers/claude.ts:462-485`).
  `execute_blender_code`, `execute_luau` and `multi_edit` stay off `readTools`.
- **No sync and no hosted relay.** Each host owns its own data. Nothing goes through a cloud (principle 1).
- **No pooled or hosted plans.** This is unchanged from `06-direction.md` ("Not doing").

### 1. Local-first hub

**What exists.** Local mode spawns `resources/hub/hub.mjs` on system Node 22.13 or later, otherwise on the bundled Node
24 sidecar (`lib.rs:405-426`). The hub gets `POCKETROCKET_DATA`, a fresh random token on every launch, and port 7788
(`lib.rs:484-490`). It runs inside a Job Object that kills it when Toki quits (`proc.rs:164-188`). Closing the window
sends it to the tray by default in local mode (`lib.rs:66-71`). Remote and local mode share port 7788, so local mode
refuses to start while the VPS tunnel holds that port (`lib.rs:697-707`).

**Data location.** All hub state stays in `%APPDATA%\com.pocketrocket.app\data\` (`docs/SERVER.md:14`), with
`mcp-servers.json` beside it (`packages/hub/src/services/outsideMcp.ts:8`). Game files are the exception: see open
question 1.

**No sync, on purpose.** The two hubs are two separate fleets. Two-way sync of SQLite, memories and approvals would be
a large new failure surface. It would also blur which machine a bot can touch, and that distinction is the whole point
of the PC/VPS split (see the security section below). What moves between hosts:
- **Bots**: the existing export and import (`packages/hub/src/api/rest.ts:331-344`, UI calls at
  `packages/web/src/lib/api.ts:221-222`). An import always creates a new bot, without secrets, scrubbed of machine paths
  (`services/botTransfer.ts:15-45`), and its skills arrive pending. Memory is optional.
- **Rooms and history**: these do not move. The game room is created fresh on the PC by the template. Old VPS history
  stays readable on the VPS.
- **Work in progress**: the existing PC runner `move` and `pull` jobs cover sessions (`scripts/pc-runner/README.md`,
  "Move a session to the VPS and pull it back").

**When the PC is off.** The PC hub and the game room are off too, and the PC hub runs no routines. The VPS hub keeps
running its own bots, routines and triggers, and the phone switches to the VPS. Nothing queues for the PC. Telegram
notifications come from whichever hub raised them.

**Both hosts at once.** Today, switching modes kills the current connection (`lib.rs:663-668`). Phase 3 gives the VPS
tunnel its own local port, so the PC hub keeps running while the owner looks at the VPS, and the window switches
between them. Each hub keeps its own token. Both hubs share one Claude subscription and its limits, so the usage meter
must say that the VPS spends from the same plan.

**Auth.** Local mode: the desktop app hands the hub its token (`lib.rs:697-713`), and the hub binds to 127.0.0.1 only.
The existing rule stays in place: adding or changing a *user-supplied* stdio server needs a password-signed-in browser
(`packages/hub/src/api/mcpServers.ts:20-21`, `:112`, `:124`). The game-tools setup route (below) writes only fixed
recipes compiled into the hub, never a caller-supplied command. It needs the hub token, refuses paired devices and bots,
and writes an audit row. Open question 3 asks whether it should also require the password.

### 2. Zero-setup game tools

**Facts verified on the owner's PC (2026-11-24).**

*Blender*
- Blender 5.2 is installed at `C:\Program Files\Blender Foundation\Blender 5.2`.
- The PyPI package resolved by `uvx blender-mcp` (cached as `blender_mcp`, with a `mcp-for-blender` 2.3.1 dist-info)
  ships its own add-on (`blender_mcp/bundled/addon.py`). It also has a CLI in `blender_mcp/addon_manager.py:587-660`:
  - `install` copies the bundled add-on into Blender's user add-ons folder, or into `BLENDERMCP_ADDONS_DIR`.
  - `setup` also rewrites the config of *other* MCP clients, so Toki must never call it.
  - `update` upgrades the server and the add-on.
  - The server and the add-on must agree on a protocol version (`EXPECTED_ADDON_PROTOCOL_VERSION = 16`, `:23`).
- The add-on already starts its socket server by itself. It has a scene property "Auto-Start Server", default `True`,
  started by a persistent `load_post` handler and a timer, on `localhost:9876`. That was true in both installed copies,
  v1.8 and v2.0 (`blender_mcp_addon.py:170`, `:210-228`, `:7531-7535`). So the "Connect to Claude" click should not be
  needed. Phase 0 confirms this on a cold start.
- **Two copies are installed today.** `scripts/addons/blender_mcp.py` (v1.8) and `blender_mcp_addon.py` (v2.0) both
  declare "MCP for Blender". Both register the same properties and both try to start on 9876. The detector must flag
  this, and the fix keeps only the copy that matches the server's protocol version.
- MCP tools in the cached `server.py`: `get_addon_status`, `disable_telemetry`, `get_scene_info`,
  `execute_blender_code`, `record_trajectory_feedback`, `look`, `generate_3d`, `generate_gaussian_world`,
  `search_assets`, `import_asset`, plus viewport app resources.
- Telemetry is off when `DISABLE_TELEMETRY` (or `BLENDER_MCP_DISABLE_TELEMETRY`) is set (`telemetry.py:117-119`).
- `BLENDER_MCP_SAFE_MODE=1` runs an AST allowlist over `execute_blender_code` scripts before they reach Blender
  (`safe_mode.py:1-20`). By its own account, it guards only the MCP path: **the socket on 9876 accepts raw code from any
  local process, with no authentication.**

*Roblox Studio*
- `%LOCALAPPDATA%\Roblox\mcp.bat` runs `Versions\<version>\StudioMCP.exe`. If that is missing, it falls back to the
  `ContentFolder` value under `HKCU\Software\Roblox\RobloxStudio`.
- `StudioMCP.exe` is an MCP server over stdio. The first instance binds a local WebSocket host that Studio connects to,
  and later instances detect that the port is taken and attach as non-hosts (strings in the binary). It keeps
  `%LOCALAPPDATA%\Roblox\StudioMCP\auth.token` and a `tools-cache.json` (38 tools).
- Studio must be open. Its Assistant setting `mcp-server` must be enabled. In
  `%LOCALAPPDATA%\Roblox\AssistantSettings\<userId>.json` it is `{"enabled":true}` on this PC, and
  `mcp-prompt-sharing` is `{"enabled":false}`.
- Every call needs a `studio_id` taken from `list_roblox_studios`.
- Tools that matter here:
  - Read only (`readOnlyHint`): `search_game_tree`, `script_search`, `script_read`, `script_grep`, `inspect_instance`,
    `get_console_output`, `get_studio_state`, `screen_capture`, `list_roblox_studios`, `list_skills`, `skill`,
    `wait_job_finished`, `search_asset`, `http_get`.
  - Write: `execute_luau`, `multi_edit`, `save_place`, `start_stop_play`, `insert_asset`, `user_mouse_input`,
    `user_keyboard_input`, `character_navigation`, and the AI generators `generate_scene`, `generate_mesh`,
    `generate_material`, `generate_texture`, `generate_animation`, `generate_avatar`, `generate_procedural_model`,
    `segment_mesh` and `auto_setup_avatar`.
  - Reaching outside the machine: `open_cloud_invoke` (an authenticated Open Cloud request as the owner, marked
    destructive), `upload_image`, `submit_feedback`, `create_skill` and `edit_skill`.

**Why the hub can mount them as they are.**
- A stdio command must be `npx`, `node` or an absolute path (`outsideMcp.ts:50-54`). The recipes therefore use the
  absolute path of `uvx.exe`, found on the PATH (on this PC it is
  `C:\Users\alex\AppData\Local\Programs\Python\Python313\Scripts\uvx.exe`), and
  `C:\Windows\System32\cmd.exe /d /c <abs>\mcp.bat`.
- Servers are mounted per bot handle or room (`outsideMcp.ts:67-124`, used at `agent/BotRunner.ts:481`) and passed to
  the Claude SDK (`providers/claude.ts:397-401`).

**Recipes** (fixed in hub code, written into `mcp-servers.json` scoped to the game room's id):

| Name | Command and args | Env | approve | readTools | denyTools (new, task B3) |
|---|---|---|---|---|---|
| `blender` | `<abs uvx.exe>` `blender-mcp==<pinned>` | `DISABLE_TELEMETRY=true`, `BLENDER_MCP_SAFE_MODE=<open question 4>` | `writes` | `get_addon_status`, `get_scene_info`, `look`, `search_assets` | `generate_3d`, `generate_gaussian_world`, `record_trajectory_feedback`, `disable_telemetry` (open question 4) |
| `roblox-studio` | `C:\Windows\System32\cmd.exe` `/d /c <abs>\mcp.bat` | none | `writes` | the read-only list above, without `http_get` | `open_cloud_invoke`, `upload_image`, `submit_feedback`, `create_skill`, `edit_skill` (open question 4) |

`http_get` stays card-gated even though it only reads, because a GET to any URL can carry data out in its query string.

**Detection** (new hub service, win32 only; other platforms report "not supported"):
- Blender: the newest `C:\Program Files\Blender Foundation\Blender *\blender.exe`, plus its version folder under
  `%APPDATA%\Blender Foundation\Blender\<ver>\scripts\addons`. Add-on files are found by the "MCP for Blender" marker the
  package itself uses (`addon_manager.py:25`), and their protocol version by `ADDON_PROTOCOL_VERSION`. The detector also
  probes TCP 127.0.0.1:9876.
- uv: `uvx.exe` on the fresh user PATH. The desktop app already re-reads the PATH (`lib.rs:491-495`, `envpath.rs`).
- Studio: `mcp.bat` exists, a `StudioMCP.exe` resolves, the `mcp-server` setting is enabled, and `RobloxStudioBeta.exe`
  is running. The detector also warns if `mcp-prompt-sharing` is on.

**One-click fixes** (each a fixed step, owner only, audited):

| Missing | Fix |
|---|---|
| Blender not installed | Link to blender.org. Toki does not install Blender. |
| uv not installed | Link to the official uv install page. Toki does not run an installer for the owner (open question 5). |
| Add-on missing or outdated | Run `<uvx> blender-mcp==<pinned> install` with `BLENDERMCP_ADDONS_DIR` set to the detected folder. |
| Add-on not enabled | With Blender closed, run `blender.exe --background --python-expr "import addon_utils, bpy; addon_utils.enable('<module>', default_set=True, persistent=True); bpy.ops.wm.save_userpref()"`. This was proven by hand on 2026-11-24. |
| Duplicate add-on | Move the non-matching copy to `scripts/addons/.toki-backup/` after an in-app confirm. |
| Blender or Studio not running | "Open Blender" or "Open Studio", launched by the desktop shell (task I2) so the app outlives a Toki quit. |
| Studio MCP setting off | Show the exact Studio menu path and a "Check again" button. Toki does not edit Studio's settings file while Studio may be running (open question 5). |
| Socket 9876 not listening while Blender is open | "Restart Blender", with a note that Auto-Start may have been turned off in this .blend. |

**UI.**
- A **Game tools** section in Settings lists Blender and Studio, each with a status dot, a version and one fix button.
- The game room header gets a compact status strip ("Blender ready · Studio not open [Open Studio]").
- Both reuse the `ui.tsx` primitives and the in-app confirm, not `confirm()`. They use the one accent colour, and status
  is shown in text as well as colour.

### 3. The iterative loop in a game room

**Template.** The project service already clones a team from a template and builds a room and a project folder
(`services/ProjectService.ts:107-153`, `services/devTeamTemplate.ts:1-16`). Today the API only has `team: boolean`
(`api/projects.ts:11`). Phase 2 adds a named template, `game`:
- **lead** (the coordinator), cloned from @lead-engineer.
- **builder**, cloned from a new seed bot @roblox-builder. It works in Studio and writes Luau.
- **artist**, cloned from a new seed bot @blender-artist. It models, textures and exports from Blender.
- Skills: `project-map`, `prove-it`, plus two new built-ins, `studio-loop` and `blender-loop` (see `services/builtinSkills.ts`).
- When the project is created, the hub runs the game-tools setup for the new room, if the tools were detected.
- Room size is fine: `MAX_ROOM_BOTS` is 20 (`packages/shared/src/models.ts:1`; the planner brief's "10" is out of date).

**Loop** (taught by the two skills, checked in Phase 0):
1. The owner asks in the room ("make a lobby with a spawn pad and a door that opens").
2. The lead splits the work: the artist makes the door mesh, and the builder lays out parts and scripts.
3. The artist: `get_scene_info`, then `execute_blender_code` (card), then `look` (a look-back in chat), then saves the
   `.blend` and exports `.fbx`/`.glb` into the game folder.
4. The builder: `list_roblox_studios`, `search_game_tree` and `script_read`, then `multi_edit` or `execute_luau` (card),
   then `start_stop_play` (card) and `get_console_output`, then `screen_capture` (a look-back), then `save_place` (card).
5. The lead posts what changed with the screenshots, and asks the owner for the next step.

**Look-backs in chat.** Today a bot can attach an image only from a file in its folders, up to 512 KB
(`agent/botTools.ts:139-153`, `:205-206`). Studio's `screen_capture` and Blender's `look` return image blocks inside the
tool result, which the owner never sees. Phase 2 stores image blocks from outside-MCP tool results of the game recipes
in the media store, and shows them as thumbnails on the tool message. The cap is one image per tool call, with the
existing media size limits. Images cost tokens, so the skills tell bots to capture after a change, not on every step
(principle 4).

**Checkpoints and versioning.**
- The game folder is a git repo, made when the project is created (`services/git.ts`).
- Blender files are committed as binaries, with a warning above 50 MB.
- Studio scripts are mirrored to text: before each checkpoint, the builder writes every changed script to
  `studio/<path>.luau` using `script_read`, so the history shows real diffs. Then `save_place`.
- The place itself keeps Studio's own version history.
- A checkpoint is a commit, made through `git` in Bash, which asks under `ask`. Bots never push to a default branch,
  because `safe-shipping` stays on (`permissions/shipGuard.ts`).
- `FileRevisions` only records writes by hub file tools in room roots (`agent/BotRunner.ts:566-572`). Files that
  Blender writes are covered by git, not by that log.

### Security against the principles

- **The boundary moves, and the spec must say so plainly.** On the VPS, a prompt-injected bot runs as a non-admin
  service user on another machine. It reaches the PC only through `run_on_pc`, with two approvals per job. On the PC
  hub, every bot runs **as the owner on the owner's PC**: Bash, file tools, and anything Blender's Python or Studio's
  Luau can do. So:
  1. **Approvals must stay `ask` on the PC hub.** Under bypass, a bot's own Bash could already open the unauthenticated
     socket on 9876, or do anything else the owner can, so cards on `execute_blender_code` would protect nothing. The
     game-tools setup refuses to run, and the room strip shows a warning, while `approvals` is `bypass` on the PC hub.
     The VPS hub may stay in bypass. It never mounts game tools, because there is no Blender or Studio on it and no
     recipe there.
  2. **Every code-executing call is approved one at a time** (`PermissionBroker.ts:528-555`). The card shows the full
     code. An input above `OUTSIDE_INPUT_CAP` (8000 chars, `PermissionBroker.ts:114`) is refused instead of shown
     truncated (`:540-543`). That is safe, but it may block real Luau edits, so Phase 0 measures it and task B4 handles it.
  3. **Untrusted text enters the loop.** Asset names and descriptions from Poly Haven, Sketchfab and the Creator Store
     are third-party text, and `http_get` fetches pages. That is why `http_get` and every write ask, and why the
     outward-reaching Studio tools are denied (`open_cloud_invoke` can change the owner's live Roblox resources).
- **VPS-optional mode: what it can and cannot reach.**
  - VPS bots cannot reach Blender, Studio, port 9876 or Studio's WebSocket. No tunnel forwards them, and Phase 1 adds
    none.
  - VPS bots can use `run_on_pc` exactly as today: one job, two approvals (owner card plus PC dialog), whitelisted
    folders, and an auto-refuse after 10 minutes. The `blender-work` runner folder stays as the fallback, but it is no
    longer the main path.
  - The game room lives on the PC hub only.
- **Principle 1.** The hub stays on loopback, and the MCP servers are local stdio. Telemetry is off by environment
  variable, and Studio prompt sharing stays off. Studio's `generate_*` tools and Blender's asset search send prompts to
  Roblox and to asset sites by design. The Game tools card states this.
- **Principle 2.** Bots cannot change `mcp-servers.json` (`outsideMcp.ts:7`) or run the setup route (it accepts the hub
  token only). Fleet changes from the template still go through the owner's own project creation.
- **Principle 4.** Per-turn budgets apply as usual. Look-backs are capped, and the usage meter notes the shared
  subscription.

## Tasks

| # | Owner | Files | Change | Acceptance criteria | Verify |
|---|---|---|---|---|---|
| **Phase 0: spike (no product code)** |||||
| S1 | pr-infra | `docs/verify/game-tools-spike.md` (new) | On the owner's PC, start **This PC** mode from a fresh data dir. Hand-write the two recipes into `mcp-servers.json`, scoped to one test room. Run the loop from §3 once. | The note records: (a) cold-start Blender serves 9876 with no click; (b) `uvx.exe` and `cmd.exe /c mcp.bat` start from a hub-spawned Claude turn; (c) cards appear under `ask` and under bypass; (d) the input length of 10 real `execute_luau` and `multi_edit` calls against the 8000 cap; (e) whether the owner sees images from `screen_capture` and `look`; (f) whether a paired phone can answer an outside-MCP card. | The note, with screenshots under `docs/verify/` |
| **Phase 1: zero-setup tools** |||||
| B1 | pr-backend | `packages/hub/src/services/gameTools.ts` (new), test | Detection as in §2 (Blender, add-on copies and protocol, 9876, uvx, Studio, setting, process). Pure functions over an injected fs, registry and process list. | Reports each fact with a fixed reason code. Duplicate add-ons are detected. Non-win32 reports `unsupported`. | Unit tests with fixture trees copied from the facts above |
| B2 | pr-backend | `packages/hub/src/api/gameTools.ts` (new), `hub.ts`, `services/outsideMcpStore.ts`, tests | `GET /api/game-tools` and `POST /api/game-tools/:tool/setup` (writes the fixed recipe for one room through `McpServerStore`), plus `POST /api/game-tools/:tool/fix/:step` for the add-on install, enable and dedupe steps. Hub token only. | Paired device and bot MCP bearer get 403. No request field can change the command, args or env. Every write is audited. Setup refuses while `approvals` is `bypass`. Enable refuses while Blender is running. | Route tests; a manual run on the owner's PC |
| B3 | pr-backend | `services/outsideMcp.ts`, `services/outsideMcpStore.ts`, `providers/claude.ts`, tests | New `denyTools` field: those tools are put in `disallowedTools` and also refused by the outside-MCP hook. | A denied tool is refused under `ask` and under bypass, with a clear message. The existing schema stays valid. | Unit tests next to `outsideMcp.test.ts` |
| B4 | pr-backend | `permissions/PermissionBroker.ts`, tests | Only if S1(d) shows calls over 8000 chars: a per-server input cap up to 32 000 chars for the game recipes. The full input is still shown, never truncated. | Calls above the cap are still refused. Other servers keep 8000. | `messages.test.ts`-style tests |
| B5 | pr-backend | `api/mcpServers.ts` | `check` for recipe servers also probes 9876 (Blender) or the Studio process and setting, instead of only "command found" (`:53-55`). | `lastCheck` says `blender-not-running`, `addon-not-listening`, `studio-not-open` and so on. | Tests with a fake probe |
| I1 | pr-infra | `packages/desktop/src-tauri/src/lib.rs`, new `launch.rs` | "Open Blender" and "Open Studio" through the `window.open` pattern already used for local copies (`lib.rs:1013-1036`): fixed app ids only. The shell resolves the path itself and starts the app with `CREATE_BREAKAWAY_FROM_JOB` (the job allows it, `proc.rs:167`, `:188`). | The page cannot pass a path. Blender and Studio stay open after Toki quits. | Rust unit test for id validation; manual quit test |
| D1 | pr-design-system | `packages/web/src/components/settings/GameToolsSection.tsx` (new), the room header, `lib/api.ts` | The Game tools section and room strip from §2, with fix buttons, in-app confirm for the dedupe step, the bypass warning, and the "prompts go to Roblox" note. | AA contrast; keyboard reachable; status in text as well as colour; reduced motion respected; no native `confirm()`. | Manual check in light and dark at narrow width; screenshot in `docs/verify/` |
| **Phase 2: the game room** |||||
| B6 | pr-backend | `services/devTeamTemplate.ts` (becomes a template registry), `services/ProjectService.ts`, `api/projects.ts`, DB migration, `services/SeedBots.ts`, tests | `template: 'dev' \| 'game'` (`team: true` still means `dev`), a `template_kind` column, the game roles and seed bots, a git repo in the game folder, and game-tools setup run for the new room. | Creating a game project yields 3 bots, a room, a game folder with git, and both recipes scoped to the room when they were detected. `TEMPLATE.md` names the template. | `ProjectService` tests; a manual create |
| B7 | pr-backend | `services/builtinSkills.ts` | The `studio-loop` and `blender-loop` skills: `studio_id` first, read before writing, small code calls under the cap, look-back after each change, `save_place` after a verified change, never publish, mirror scripts to `studio/`, save `.blend` and exports to the game folder. | The skills are added to the pool at startup when missing, like `project-map`. | Template test method in `docs/project-folders.md`: 3 runs with and without, on a trap task (for example "publish it") |
| B8 | pr-backend | `providers/claude.ts`, `agent/BotRunner.ts`, `services/MediaStore.ts`, tests | Store the first image block of a game-recipe tool result as media, and attach it to that tool's message. | One image per call, within existing media limits. Nothing is stored for other servers. | Unit test with a fake tool result; manual look-back |
| D2 | pr-design-system | chat tool message component, lightbox | Show look-back thumbnails on tool messages, opening in the existing image viewer. | Images have alt text from the tool name. Layout does not shift. Works in the narrow drawer. | Manual check; screenshot |
| D3 | pr-design-system | `components/settings/ProjectsSection.tsx` | A template picker (None, Dev team, Game team) with one line on what each adds. Game team is disabled, with the reason, when the tools are missing. | Keyboard and AA. | Manual |
| **Phase 3: PC first, VPS optional** |||||
| I2 | pr-infra | `lib.rs` (Config, `run_connection`, `spawn_tunnel`), `ssh.rs` | An optional server connection alongside local: the tunnel uses its own local port (default 7790), the local hub keeps running, and the window and tray switch between "This PC" and "Server". | Switching never kills the local hub. Each hub keeps its own token. Old configs still load (see `lib.rs:1685`). | Rust tests for config migration; manual switch with a live turn on the PC |
| B9 | pr-backend | `services/UsageTracker.ts`, the usage API | Usage notes that both hubs spend from one subscription (a text note only; no cross-hub data). | The note shows when a server connection is configured. | Unit test |
| D4 | pr-design-system | Settings: Connection and Bots | Copy that explains the two hosts. A multi-select "Export bots" that runs the existing per-bot export in a loop. | No new endpoint. Copy is clear about what does not move (rooms, history, secrets). | Manual |
| P1 | pr-planner | `docs/GUIDE.md`, `CHANGELOG.md` [Unreleased] | Guide: "Make games with Blender and Studio", "This PC and your server", and moving bots. | Matches the shipped behaviour. | Review |

## Order and dependencies

1. **S1 first.** Its answers decide B4 (needed or not), whether B8 is needed (if the owner already sees the images),
   and whether the add-on needs a click after all.
2. **Phase 1:** B1, then B2 (needs B3 for `denyTools`) and B5; D1 needs B2; I1 is independent. When Phase 1 ships, the
   owner switches the desktop to **This PC**, creates a room, presses Set up, and has a working loop. This is the
   smallest useful cut.
3. **Phase 2:** B6 needs B2. B7 is independent. B8, then D2. D3 needs B6.
4. **Phase 3** can run alongside Phase 2: I2, then D4; B9 is independent.
5. **Phase 4 (not tasked):** Rojo-style two-way script sync, more tools (for example Godot, Unity or Aseprite through
   the same recipe mechanism), and Linux or macOS detection.

Each phase leaves the app shippable. Owners never share a task: backend routes come before the UI that calls them.

## Risks / open questions (for the user)

**Questions**
1. **Where do game files live?** (a) Inside Toki's project folder (`%APPDATA%\com.pocketrocket.app\data\projects\<slug>\game`).
   This keeps everything in one place, but the folder is hidden from Blender's and Studio's file dialogs.
   (b) `Documents\Toki Games\<slug>`, linked to the project. This is visible and easy to back up, but it is a second
   root that the bots' folder guard must allow. *Recommended: (b).*
2. **Approval rhythm for code calls.** Phase 1 asks on every `execute_blender_code`, `execute_luau` and `multi_edit`.
   That is safe, but it means many clicks per feature. Do you accept this for now? The alternative is a later feature
   such as "allow this bot's code calls in this room for 15 minutes". It would be new and would weaken principle 2, so
   it is not planned unless you ask.
3. **Setup without a password.** Should the one-click setup work with the hub token alone (fixed recipes only, audited),
   or also require the password sign-in that custom command servers need? *Recommended: hub token alone.* Otherwise
   "no setup" starts with "set a password".
4. **Paid and outward tools.** Deny or card-gate each of these:
   - Blender `generate_3d` and `generate_gaussian_world`, which use paid third-party keys.
   - Studio `generate_*`, which uses Roblox quota and sends prompts to Roblox.
   - Studio `open_cloud_invoke`, which makes authenticated changes to your live Roblox resources.
   - Blender safe mode (`BLENDER_MCP_SAFE_MODE=1`), on or off.

   *Recommended:* deny the Blender generators and `open_cloud_invoke`, card-gate the Studio generators, and turn safe
   mode on, accepting that it may block some scripts.
5. **How far "automatic" goes outside Toki.** May Toki install uv for you (it runs the official installer script) and
   flip Studio's `mcp-server` setting by editing its settings file while Studio is closed? Both are undocumented or
   third-party steps. *Recommended:* links and a "Check again" button for both. The owner's PC already has both today.
6. **Which bots move to the PC?** The game team is new. Should any existing VPS bots be exported to the PC hub, or does
   the PC hub start with only the game team?

**Risks**
- The Blender socket on 9876 has no authentication. Any local process can run Python in Blender. This is unchanged by
  Toki, but it is why approvals must stay `ask` on the PC hub.
- Studio's MCP surface changes with Studio updates (`tools-cache.json` is refreshed by version). Recipe tool names are
  checked at setup, and an unknown write tool is card-gated by default, because `approve: 'writes'` asks for anything
  not on `readTools`.
- Both blender-mcp packages update often (protocol 16 today). The recipe pins a version, and "Update" is a manual fix
  step.
- Pending approvals are still lost on a hub crash (a known bug). A crash during a long build loses the open card, not
  the files.
