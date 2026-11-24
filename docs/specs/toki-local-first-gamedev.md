# Local-first Toki with Blender and Roblox Studio

Status: draft spec, 2026-11-24, revised the same day with the owner's decisions (see "Owner decisions"). Asked for by
the owner. Nothing here is built yet. Code facts were checked on `origin/main` (5fcf8a6), and PC facts were checked on
the owner's machine on 2026-11-24.

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

> As the owner, I open Toki on my PC, make a game project, and it finds Blender and Roblox Studio, sets them up, and
> gives me a team that builds in Studio and models in Blender while I watch and steer in chat. My VPS projects still
> show in the same app. When I open one while the VPS isn't connected, Toki asks me to connect it first.

## Owner decisions (2026-11-24)

These answer the open questions from the first draft (commit 0617b63). Where another section of this spec seems to
disagree with them, these decisions win.

1. **Game files live in Toki's data folder**, in the project folder `<data>/projects/<game-slug>/`. They do not go in
   Documents or a Roblox folder, because Roblox has no single local project folder: places mostly live in the cloud,
   and `.rbxl` files go wherever the user saves them.
2. **Game tools follow the approval mode the hub already uses**, including full allow (bypass). Nothing refuses setup
   or blocks a call because of bypass. The risk is stated in the safety section but does not gate anything. A new game
   room starts under the default, `ask`.
3. **One-click setup does not need a password sign-in.** It writes only fixed settings, and every write is logged.
4. **No game tool is blocked.** Blender safe mode is not forced on. `open_cloud_invoke` and every generator are allowed
   under the bot's approval mode. Claude builds the models through the MCP tools. Note: Blender's `generate_3d` and
   `generate_gaussian_world` call paid third-party services, and they do nothing unless their keys are set in the
   add-on.
5. **Toki may install uv and turn on Studio's MCP setting itself.** "One-click fixes" in §2 says how, which files it
   touches, and how each change is logged.
6. **Nothing is migrated.** Projects stay on the host where they are. One app lists the projects of both hosts, each
   tagged with its host. PC projects open with no VPS. Opening a VPS project while the VPS is not connected shows a
   prompt to connect first (§1 and Phase 3).

## Scope

**In**
- The PC hub as the primary host (local mode already exists; this makes it the owner's daily setup). The VPS becomes an
  optional always-on second host, and its projects are listed in the same app.
- Detecting Blender, uv and Roblox Studio; installing uv, the Blender add-on and Studio's MCP setting when they are
  missing; registering both MCP servers for a game room; status in the UI; one-click fixes.
- A game team template, skills for the Studio and Blender loop, screenshots ("look-backs") in chat, and checkpoints of
  game files.
- Windows only, because that is the only installer (`docs/GUIDE.md:103-112`).

**Out**
- Syncing or migrating anything between the two hubs: bots, rooms, projects or history.
- VPS bots reaching Blender or Studio directly, through a reverse tunnel or anything else. They keep `run_on_pc`.
- Rojo or another file-sync plugin for Studio scripts (see Phase 4), Git LFS, macOS and Linux.
- Installing Blender or Roblox Studio themselves.

## Design

### The host model (matching OpenBot's shape)

OpenBot is a desktop app whose agents live on the user's own computer. An optional server (Docker, a curl install, or
hosted plans) can act as the host instead, and its mobile and web clients connect to whichever host the user picked.
Toki already has the same three pieces:

| OpenBot shape | Toki today | Toki after this spec |
|---|---|---|
| Desktop app hosts the agents | **This PC** mode: the app spawns the hub as its own child, with data in the app's data dir (`lib.rs:2-6`, `lib.rs:459-519`, `docs/SERVER.md:14`). It is already the default for new installs (`lib.rs:59-60`). | The primary host. Game tools exist only here. |
| Optional server host | **Server** mode over an SSH tunnel (`lib.rs:213-226`, `docs/SERVER.md`). | An optional always-on host that runs alongside the PC hub. Its projects are listed in the same app, tagged "Server". |
| Phone and web clients connect to a host | PWA plus phone pairing (`docs/GUIDE.md:414`), with Tailscale Serve to reach a loopback hub (`docs/GUIDE.md:345`). | Unchanged. The phone pairs with one host directly. |

#### Where Toki deliberately differs

- **No "Full access" default.** OpenBot runs agents with full access after a consent screen at first launch
  (`00-openbot-recon.md:52-53`). Toki keeps `approvals: 'ask'` as the default
  (`packages/shared/src/providers.ts:136`). Full allow stays something the owner turns on; game tools follow it when
  he does (decision 2).
- **No sync and no hosted relay.** Each host owns its own data. The only thing that crosses between them is a list of
  project names (Phase 3), carried by the desktop app on the owner's own machine (principle 1).
- **No pooled or hosted plans.** This is unchanged from `06-direction.md` ("Not doing").

### 1. Local-first hub

**What exists.** Local mode spawns `resources/hub/hub.mjs` on system Node 22.13 or later, otherwise on the bundled Node
24 sidecar (`lib.rs:405-426`). The hub gets `POCKETROCKET_DATA`, a fresh random token on every launch, and port 7788
(`lib.rs:484-490`). It runs inside a Job Object that kills it when Toki quits (`proc.rs:164-188`). Closing the window
sends it to the tray by default in local mode (`lib.rs:66-71`). Remote and local mode share port 7788 today, so local
mode refuses to start while the VPS tunnel holds that port (`lib.rs:697-707`). Switching modes kills the current
connection (`lib.rs:663-668`).

**Data location.** All PC hub state stays in `%APPDATA%\com.pocketrocket.app\data\` (`docs/SERVER.md:14`), with
`mcp-servers.json` beside it (`packages/hub/src/services/outsideMcp.ts:8`). Game files go in the project folder
`<data>/projects/<game-slug>/` (decision 1). Bots in the project's room already get that folder as a working root
(`docs/project-folders.md`, "Access"), so no new folder rule is needed. A Toki-installed uv lives in
`<data>/tools/uv/` (§2).

**No migration, two hosts in one app** (decision 6).
- Projects, bots, rooms and history stay on the host where they were made. Nothing is copied. The existing per-bot
  export and import (`packages/hub/src/api/rest.ts:331-344`) stay available, but they are not part of this plan.
- The desktop app keeps the PC hub running and, when a server is configured, also holds an SSH tunnel to the VPS hub on
  its own local port (default 7790). It reads the VPS hub's token over SSH, the way server mode already does
  (`lib.rs:243-271`, `fetch_remote_token`).
- The desktop app reads the VPS project list through the tunnel (`GET /api/projects`) and passes it to the PC hub as
  **project stubs**: host, slug, name and when it was last seen. These are names only, with no files or messages. The
  PC hub stores them so they still show while the VPS is offline.
- The project list on the PC hub shows its own projects tagged "This PC" and the stubs tagged "Server".
- Opening a PC project needs no VPS. Opening a Server project while the tunnel is up switches the window to the VPS hub
  at that project. While the tunnel is down, a prompt says "This project is on your server. Connect to open it." with
  **Connect** and **Cancel**. Connect starts the tunnel, then opens the project. If connecting fails, the prompt shows
  the reason (`lib.rs:803-813` already sorts SSH failures by kind).
- Bots never see stubs. No bot tool or prompt lists them, so the project folder guard (`permissions/projectGuard.ts`)
  is unchanged.
- **When the PC is off,** the PC hub and its projects are off. The VPS hub keeps running its own bots, routines and
  triggers, and the phone (paired with the VPS) still reaches it.
- Both hubs share one Claude subscription and its limits. The usage view says so.

**Auth.**
- The PC hub token comes from the desktop app (`lib.rs:697-713`). The VPS token is read over SSH. Each hub keeps its
  own token, and both hubs bind to 127.0.0.1 only.
- The stub route on the PC hub accepts only the hub token, and refuses paired devices and bot bearers.
- The game-tools setup route needs no password sign-in (decision 3), unlike user-supplied stdio servers, which still
  need one (`packages/hub/src/api/mcpServers.ts:20-21`, `:112`, `:124`). It writes only fixed recipes compiled into the
  hub, never a command or arguments from the request. It accepts the hub token only and logs every write.

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
  declare "MCP for Blender". Both register the same properties and both try to start on 9876. The detector flags this,
  and the fix keeps only the copy that matches the server's protocol version.
- MCP tools in the cached `server.py`: `get_addon_status`, `disable_telemetry`, `get_scene_info`,
  `execute_blender_code`, `record_trajectory_feedback`, `look`, `generate_3d`, `generate_gaussian_world`,
  `search_assets`, `import_asset`, plus viewport app resources.
- `generate_3d` and `generate_gaussian_world` call paid third-party services, and they do nothing unless their keys are
  set in the add-on.
- Telemetry is off when `DISABLE_TELEMETRY` (or `BLENDER_MCP_DISABLE_TELEMETRY`) is set (`telemetry.py:117-119`).
- An optional safe mode (`BLENDER_MCP_SAFE_MODE=1`, `safe_mode.py:1-20`) checks scripts against an allowlist. Toki does
  not set it (decision 4).
- **The socket on 9876 accepts raw code from any local process, with no authentication.**

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
  - Reaching outside the machine: `open_cloud_invoke` (an authenticated Open Cloud request as the owner),
    `upload_image`, `submit_feedback`, `create_skill` and `edit_skill`.
  - All of these stay mounted (decision 4).

**How approvals work for these tools today, and what changes** (decision 2).
- Today every outside MCP server asks on each call that is not on its `readTools` list, even under bypass. That comes
  from a once-only card with no "always" answer (`permissions/PermissionBroker.ts:528-555`), enforced by a hook
  (`providers/claude.ts:462-485`).
- For game tools to follow the hub's mode, task B3 adds a new `approve` value, `mode`.
- A `mode` server is not gated when the turn is bypassed (`PermissionBroker.ts:151-156`, `bypassedFor`), so it runs
  under full allow like built-in tools. Strict turns stay strict: routines, triggers and failover still ask
  (`rooms/RoomRouter.ts:526-527`).
- Under `ask`, its non-read tools raise the normal tool card, so the owner's approval rules and "always" answers apply,
  as they do for built-in tools.
- The existing `every-call`, `writes` and `none` values are unchanged for every other outside server.
- Approvals are a hub-wide setting with no per-room value, so a new game room starts under the hub default, `ask`.

**Why the hub can mount them as they are.**
- A stdio command must be `npx`, `node` or an absolute path (`outsideMcp.ts:50-54`). The recipes therefore use the
  absolute path of `uvx.exe` (the system one if present; on this PC it is
  `C:\Users\alex\AppData\Local\Programs\Python\Python313\Scripts\uvx.exe`, otherwise Toki's own in `<data>/tools/uv/`)
  and `C:\Windows\System32\cmd.exe /d /c <abs>\mcp.bat`.
- Servers are mounted per bot handle or room (`outsideMcp.ts:67-124`, used at `agent/BotRunner.ts:481`) and passed to
  the Claude SDK (`providers/claude.ts:397-401`).

**Recipes** (fixed in hub code, written into `mcp-servers.json` scoped to the game room's id):

| Name | Command and args | Env | approve | readTools |
|---|---|---|---|---|
| `blender` | `<abs uvx.exe>` `blender-mcp==<pinned>` | `DISABLE_TELEMETRY=true` | `mode` | `get_addon_status`, `get_scene_info`, `look`, `search_assets` |
| `roblox-studio` | `C:\Windows\System32\cmd.exe` `/d /c <abs>\mcp.bat` | none | `mode` | the read-only list above |

No tool is denied.

**Detection** (new hub service, win32 only; other platforms report "not supported"):
- Blender: the newest `C:\Program Files\Blender Foundation\Blender *\blender.exe`, plus its version folder under
  `%APPDATA%\Blender Foundation\Blender\<ver>\scripts\addons`. Add-on files are found by the "MCP for Blender" marker the
  package itself uses (`addon_manager.py:25`), and their protocol version by `ADDON_PROTOCOL_VERSION`. The detector also
  probes TCP 127.0.0.1:9876.
- uv: `uvx.exe` on the fresh user PATH (the desktop app already re-reads it, `lib.rs:491-495`, `envpath.rs`), then
  `<data>/tools/uv/<version>/uvx.exe`.
- Studio: `mcp.bat` exists, a `StudioMCP.exe` resolves, the `mcp-server` setting is enabled, and `RobloxStudioBeta.exe`
  is running.

**One-click fixes.** Each fix is a fixed step that accepts the hub token only, needs no password (decision 3), and
writes one audit row (`services/AuditLog.ts`, `recordAudit`) naming the step and the files it changed.

| Missing | Fix | What it touches | Audit action |
|---|---|---|---|
| Blender not installed | Link to blender.org. | nothing | none |
| uv not installed | Download the pinned uv release for Windows x64 (`uv-x86_64-pc-windows-msvc.zip` from the uv GitHub releases). Check its sha256 against the value compiled into the hub, then unpack `uv.exe` and `uvx.exe` into `<data>/tools/uv/<version>/`. The PATH and the registry are not changed. On first use, uv adds its cache under `%LOCALAPPDATA%\uv\` and, if no Python is found, a managed Python under `%APPDATA%\uv\python\`. | `<data>/tools/uv/`; uv's own cache and Python folders | `game_tools.uv_installed` (version, sha256) |
| Add-on missing or outdated | Run `<uvx> blender-mcp==<pinned> install` with `BLENDERMCP_ADDONS_DIR` set to the detected folder. | `scripts/addons/` of that Blender version | `game_tools.addon_installed` |
| Add-on not enabled | With Blender closed, run `blender.exe --background --python-expr "import addon_utils, bpy; addon_utils.enable('<module>', default_set=True, persistent=True); bpy.ops.wm.save_userpref()"`. Proven by hand on 2026-11-24. | `%APPDATA%\Blender Foundation\Blender\<ver>\config\userpref.blend` | `game_tools.addon_enabled` |
| Duplicate add-on | After an in-app confirm, move the copy that does not match into `scripts/addons/.toki-backup/`. | that folder | `game_tools.addon_deduped` (file names) |
| Studio MCP setting off | With Studio closed (otherwise the step asks you to close it and press again): for each `%LOCALAPPDATA%\Roblox\AssistantSettings\<userId>.json`, copy it to `<file>.toki-bak`, set only the `mcp-server` key to `{"enabled":true}`, keep every other key as it was, and write it back atomically. `mcp-prompt-sharing` is never touched. | those JSON files and their `.toki-bak` copies | `game_tools.studio_mcp_enabled` (files changed) |
| Blender or Studio not running | "Open Blender" or "Open Studio", launched by the desktop shell (task I1) so the app outlives a Toki quit. | nothing | none |
| Socket 9876 not listening while Blender is open | "Restart Blender", with a note that Auto-Start may have been turned off in this .blend. | nothing | none |

The Studio settings file format is not documented by Roblox. If the file does not parse, or has no `mcp-server` key,
the step changes nothing and shows the menu path instead.

**UI.**
- A **Game tools** section in Settings lists Blender, uv and Studio, each with a status dot, a version and one fix
  button.
- The game room header gets a compact status strip ("Blender ready · Studio not open [Open Studio]").
- Both reuse the `ui.tsx` primitives and the in-app confirm, not `confirm()`. They use the one accent colour, and status
  is shown in text as well as colour.
- The card says once, in plain words, that game tools run code as you on this PC and follow your approval setting.

### 3. The iterative loop in a game room

**Template.** The project service already clones a team from a template and builds a room and a project folder
(`services/ProjectService.ts:107-153`, `services/devTeamTemplate.ts:1-16`). Today the API only has `team: boolean`
(`api/projects.ts:11`). Phase 2 adds a named template, `game`:
- **lead** (the coordinator), cloned from @lead-engineer.
- **builder**, cloned from a new seed bot @roblox-builder. It works in Studio and writes Luau.
- **artist**, cloned from a new seed bot @blender-artist. It models, textures and exports from Blender.
- Skills: `project-map`, `prove-it`, plus two new built-ins, `studio-loop` and `blender-loop` (see `services/builtinSkills.ts`).
- When the project is created, the hub runs the game-tools setup for the new room.
- Room size is fine: `MAX_ROOM_BOTS` is 20 (`packages/shared/src/models.ts:1`; the planner brief's "10" is out of date).

**Game folder layout** (inside `<data>/projects/<game-slug>/`, next to `current.md`, `archive/` and `features/`):
- `art/` holds `.blend` files.
- `exports/` holds `.fbx` and `.glb` files for Studio.
- `studio/` holds text mirrors of the place's scripts.
- `places/` holds any `.rbxl` the owner chooses to save there by hand.

The Settings › Projects row gets an "Open folder" button, because `%APPDATA%` is hidden in file dialogs.

**Loop** (taught by the two skills, checked in Phase 0):
1. The owner asks in the room ("make a lobby with a spawn pad and a door that opens").
2. The lead splits the work: the artist makes the door mesh, and the builder lays out parts and scripts.
3. The artist: `get_scene_info`, then `execute_blender_code`, then `look` (a look-back in chat), then saves the `.blend`
   to `art/` and exports to `exports/`. Under `ask`, `execute_blender_code` raises a card. Under bypass it runs
   straight away.
4. The builder: `list_roblox_studios`, `search_game_tree` and `script_read`, then `multi_edit` or `execute_luau`, then
   `start_stop_play` and `get_console_output`, then `screen_capture` (a look-back), then `save_place`.
5. The lead posts what changed with the screenshots, and asks the owner for the next step.

**Look-backs in chat.** Today a bot can attach an image only from a file in its folders, up to 512 KB
(`agent/botTools.ts:139-153`, `:205-206`). Studio's `screen_capture` and Blender's `look` return image blocks inside the
tool result, which the owner never sees. Phase 2 stores image blocks from game-recipe tool results in the media store,
and shows them as thumbnails on the tool message. The cap is one image per tool call, with the existing media size
limits. Images cost tokens, so the skills tell bots to capture after a change, not on every step (principle 4).

**Checkpoints and versioning.**
- The project folder becomes a git repo when a game project is created (`services/git.ts`).
- `.blend` files are committed as binaries, with a warning above 50 MB.
- Studio scripts are mirrored to text: before each checkpoint, the builder writes every changed script to
  `studio/<path>.luau` using `script_read`, so the history shows real diffs. Then `save_place`.
- The place itself lives in Roblox's cloud with Studio's own version history.
- A checkpoint is a git commit. Bots keep `safe-shipping` (`permissions/shipGuard.ts`), so they never push a default
  branch.
- `FileRevisions` only records writes by hub file tools in room roots (`agent/BotRunner.ts:566-572`). Files that
  Blender writes are covered by git, not by that log.

### Security against the principles

- **The boundary moves, and the spec says so plainly.** On the VPS, a prompt-injected bot runs as a non-admin service
  user on another machine and reaches the PC only through `run_on_pc`, with two approvals per job. On the PC hub,
  every bot runs **as the owner on the owner's PC**. Python in Blender and Luau in Studio run as the owner, and port
  9876 accepts code from any local process with no authentication. Under `ask`, code calls raise cards. Under full
  allow (bypass), they run without asking, as Bash already does. The owner chose this (decision 2), and nothing in this
  spec blocks it. The Game tools card states it once.
- **Card size.** Under `ask`, the normal tool card shows the call's input. Phase 0 checks that long `execute_luau` and
  `multi_edit` inputs show in full and are not cut off. Task B4 fixes that if they are cut off.
- **Untrusted text.** Asset names and descriptions from Poly Haven, Sketchfab and the Creator Store, and pages fetched
  by `http_get`, are third-party text in the bots' context. Under `ask`, the owner sees every write. Under bypass, the
  owner has accepted that risk.
- **Outward-reaching tools.** `open_cloud_invoke` can change the owner's live Roblox resources, and the generators spend
  Roblox quota or paid third-party credit. They follow the approval mode (decision 4). Under `ask`, each one raises a
  card.
- **VPS: what it can and cannot reach.**
  - VPS bots cannot reach Blender, Studio, port 9876 or Studio's WebSocket. No tunnel forwards them.
  - VPS bots can use `run_on_pc` exactly as today: one job, two approvals, whitelisted folders, and an auto-refuse after
    10 minutes. The `blender-work` runner folder stays as the fallback.
  - The VPS hub learns nothing about PC projects. Only the PC hub stores stubs, and they hold VPS project names only.
- **Principle 1.**
  - Both hubs stay on loopback, and the MCP servers are local stdio.
  - Blender telemetry is off by environment variable, and Studio prompt sharing is left as the owner set it (off today).
  - Studio's `generate_*` tools and Blender's asset search and generators send prompts to Roblox and third parties by
    design. The Game tools card states this.
- **Principle 2.**
  - Bots cannot change `mcp-servers.json` (`outsideMcp.ts:7`), run the setup or fix routes, or write project stubs.
    All of those accept the hub token only.
  - The default stays `ask`. Full allow is the owner's explicit choice, as before.
- **Principle 4.** Per-turn budgets apply as usual. Look-backs are capped, and the usage view notes the shared
  subscription.

## Tasks

| # | Owner | Files | Change | Acceptance criteria | Verify |
|---|---|---|---|---|---|
| **Phase 0: spike (no product code)** |||||
| S1 | pr-infra | `docs/verify/game-tools-spike.md` (new) | On the owner's PC, start **This PC** mode from a fresh data dir. Hand-write the two recipes (with `approve: 'writes'` until B3 exists) into `mcp-servers.json`, scoped to one test room. Run the loop from §3 once. | The note records: (a) cold-start Blender serves 9876 with no click; (b) `uvx.exe` and `cmd.exe /c mcp.bat` start from a hub-spawned Claude turn; (c) the length of 10 real `execute_luau` and `multi_edit` inputs; (d) whether the owner sees images from `screen_capture` and `look`; (e) whether flipping `mcp-server` in the settings JSON with Studio closed takes effect on the next start. | The note, with screenshots under `docs/verify/` |
| **Phase 1: zero-setup tools** |||||
| B1 | pr-backend | `packages/hub/src/services/gameTools.ts` (new), test | Detection as in §2: Blender, add-on copies and protocol, 9876, uv (system or Toki's), Studio, its setting, and its process. Pure functions over an injected fs, registry and process list. | Reports each fact with a fixed reason code. Duplicate add-ons are detected. Non-win32 reports `unsupported`. | Unit tests with fixture trees copied from the facts above |
| B2 | pr-backend | `packages/hub/src/api/gameTools.ts` (new), `hub.ts`, tests | `GET /api/game-tools` and `POST /api/game-tools/:tool/setup` (writes the fixed recipe for one room through `McpServerStore`), plus `POST /api/game-tools/:tool/fix/:step` for the add-on install, enable and dedupe steps. Hub token only; no password needed. | Paired device and bot MCP bearer get 403. No request field can change the command, args or env. Every write is audited with its action name. Works under `ask` and under bypass. Enable refuses while Blender is running. | Route tests; a manual run on the owner's PC |
| B3 | pr-backend | `services/outsideMcp.ts`, `services/outsideMcpStore.ts`, `providers/claude.ts`, `agent/BotRunner.ts`, `permissions/PermissionBroker.ts`, tests | New `approve: 'mode'`. Its non-read tools go through the normal tool permission path: no gate when `bypassedFor(ctx)` is true, and the normal card (with rules and "always") under `ask` and on strict turns. Other `approve` values are unchanged. | Under bypass, a `mode` server's write tool runs with no card. Under `ask`, it raises a card, and "always" is remembered. A routine turn under bypass still asks. `every-call` servers still ask under bypass. | Tests next to `outsideMcpApproval.test.ts` |
| B4 | pr-backend | `permissions/PermissionBroker.ts`, tests | Only if S1(c) shows long inputs cut off on the normal card: make the card carry the full input for `mode` servers, up to 32 000 chars. Above that, refuse with a message rather than show a cut-off card. | No card ever shows a cut-off input. | `messages.test.ts`-style tests |
| B5 | pr-backend | `api/mcpServers.ts` | `check` for recipe servers also probes 9876 (Blender) or the Studio process and setting, instead of only "command found" (`:53-55`). | `lastCheck` says `blender-not-running`, `addon-not-listening`, `studio-not-open` and so on. | Tests with a fake probe |
| B6 | pr-backend | `services/gameTools.ts`, `api/gameTools.ts`, tests | The two install fixes from §2: (1) uv: download the pinned zip, check its compiled-in sha256, unpack into `<data>/tools/uv/<version>/`; (2) Studio: with Studio not running, back up each `AssistantSettings/<userId>.json` and set only `mcp-server` to enabled. | A wrong hash leaves nothing on disk. The PATH and registry are unchanged. The Studio step refuses while `RobloxStudioBeta.exe` runs, keeps every other key, writes a `.toki-bak`, and makes no change when the file won't parse. Both write one audit row naming the files. | Unit tests with a fake fetch and a fixture settings file; manual run on the owner's PC |
| I1 | pr-infra | `packages/desktop/src-tauri/src/lib.rs`, new `launch.rs` | "Open Blender" and "Open Studio" through the `window.open` pattern already used for local copies (`lib.rs:1013-1036`): fixed app ids only. The shell resolves the path itself and starts the app with `CREATE_BREAKAWAY_FROM_JOB` (the job allows it, `proc.rs:167`, `:188`). | The page cannot pass a path. Blender and Studio stay open after Toki quits. | Rust unit test for id validation; manual quit test |
| D1 | pr-design-system | `packages/web/src/components/settings/GameToolsSection.tsx` (new), the room header, `lib/api.ts` | The Game tools section and room strip from §2: fix buttons (including Install uv and Turn on Studio MCP), an in-app confirm for the dedupe step, the one-line "runs as you, follows your approval setting" statement, and the "prompts go to Roblox and third parties" note. | AA contrast; keyboard reachable; status in text as well as colour; reduced motion respected; no native `confirm()`. | Manual check in light and dark at narrow width; screenshot in `docs/verify/` |
| **Phase 2: the game room** |||||
| B7 | pr-backend | `services/devTeamTemplate.ts` (becomes a template registry), `services/ProjectService.ts`, `api/projects.ts`, DB migration, `services/SeedBots.ts`, tests | `template: 'dev' \| 'game'` (`team: true` still means `dev`), a `template_kind` column, the game roles and seed bots, the folder layout from §3, `git init` in the project folder, and game-tools setup run for the new room. | Creating a game project yields 3 bots, a room, `art/`, `exports/`, `studio/` and `places/` under `<data>/projects/<slug>/`, a git repo there, and both recipes scoped to the room. `TEMPLATE.md` names the template. | `ProjectService` tests; a manual create |
| B8 | pr-backend | `services/builtinSkills.ts` | The `studio-loop` and `blender-loop` skills: `studio_id` first, read before writing, look-back after each change, `save_place` after a verified change, mirror scripts to `studio/`, save `.blend` to `art/` and exports to `exports/`. | The skills are added to the pool at startup when missing, like `project-map`. | Template test method in `docs/project-folders.md`: 3 runs with and without the skills, on a trap task (for example, skipping the script mirror before a checkpoint) |
| B9 | pr-backend | `providers/claude.ts`, `agent/BotRunner.ts`, `services/MediaStore.ts`, tests | Only if S1(d) shows the owner cannot see the images: store the first image block of a game-recipe tool result as media, and attach it to that tool's message. | One image per call, within existing media limits. Nothing is stored for other servers. | Unit test with a fake tool result; manual look-back |
| D2 | pr-design-system | chat tool message component, lightbox | Show look-back thumbnails on tool messages, opening in the existing image viewer. | Images have alt text from the tool name. Layout does not shift. Works in the narrow drawer. | Manual check; screenshot |
| D3 | pr-design-system | `components/settings/ProjectsSection.tsx` | A template picker (None, Dev team, Game team) with one line on what each adds, and an "Open folder" button per project. Game team is disabled, with the reason, when the tools are missing. | Keyboard and AA. | Manual |
| **Phase 3: one app, two hosts** |||||
| I2 | pr-infra | `lib.rs` (Config, `run_connection`, `spawn_tunnel`, `stays_in_webview`), `ssh.rs`, tests | The local hub always runs. An optional server entry keeps its own tunnel on its own local port (default 7790), started on demand, with its token read over SSH. `stays_in_webview` (`lib.rs:551-561`) allows both hub ports. Old configs with `mode: "remote"` load as local plus that server. | Starting or stopping the tunnel never stops the local hub. Each hub keeps its own token. Old configs still load (see `lib.rs:1685`). | Rust tests for config migration and the webview rule; manual run with a live turn on the PC while the tunnel starts |
| B10 | pr-backend | `services/ProjectService.ts` or new `services/RemoteProjects.ts`, `api/projects.ts`, DB migration, tests | Stub storage: `PUT /api/hosts/:host/projects` replaces one host's stubs (host, slug, name, seen_at) and its `connected` flag; `GET /api/projects` returns local projects with `host: 'pc'` plus stubs with `host: 'server'`; a `hosts.changed` event. | Hub token only: paired device and bot bearer get 403. Stubs never reach a bot prompt or tool. At most 500 stubs per host, with names validated like project names. | Route tests |
| I3 | pr-infra | `lib.rs` (`new_window_elsewhere`), new `hosts.rs` | (1) After the tunnel connects, and every 5 minutes while it is up, read `GET /api/projects` from the VPS hub and `PUT` the stubs to the PC hub. Mark the host disconnected when the tunnel drops. (2) Handle `?openproject=server:<slug>`: navigate to the VPS hub at that project if the tunnel is up. (3) Handle `?connecthost=server`: start the tunnel, then report success or the error kind to the page. | The page never passes a host address or token. A tunnel loss shows within 30 s. Nothing is pushed to the VPS. | Rust tests for request parsing; manual connect, open, and offline prompt |
| D4 | pr-design-system | project list (sidebar and Settings › Projects), new connect prompt using `ui.tsx` dialog primitives | A host tag on every project ("This PC" / "Server"). Opening an offline Server project shows "This project is on your server. Connect to open it." with Connect and Cancel, then a working state, then the opened project or the error. Outside the desktop app (phone or browser), the prompt says to open it from the desktop app. | Tags have text, not colour alone. The dialog is keyboard and AA compliant and returns focus on Cancel. No native `confirm()`. | Manual: PC project offline opens; Server project offline prompts; Connect opens it |
| B11 | pr-backend | `services/UsageTracker.ts`, the usage API | Usage notes that both hubs spend from one subscription (a text note; no cross-hub usage data). | The note shows when a server host is known. | Unit test |
| P1 | pr-planner | `docs/GUIDE.md`, `CHANGELOG.md` [Unreleased] | Guide: "Make games with Blender and Studio", "This PC and your server", and what is not migrated. | Matches the shipped behaviour. | Review |

## Order and dependencies

1. **S1 first.** Its answers decide B4 and B9 (needed or not), whether the add-on needs a click after all, and whether
   the Studio settings edit in B6 works.
2. **Phase 1:**
   - B1, then B2 and B6. B3 can run alongside them, but the recipes need it before they ship.
   - B5 is independent. D1 needs B2 and B6. I1 is independent.
   - When Phase 1 ships, the owner switches the desktop to **This PC**, creates a room and presses Set up. That is a
     working loop, and the smallest useful cut.
3. **Phase 2:** B7 needs B2 and B3. B8 is independent. B9, then D2. D3 needs B7.
4. **Phase 3:** I2, then I3. B10 runs alongside I2. D4 needs B10 and I3. B11 is independent. Phase 3 can run alongside
   Phase 2.
5. **Phase 4 (not tasked):** Rojo-style two-way script sync, more tools (for example Godot, Unity or Aseprite through
   the same recipe mechanism), and Linux or macOS detection.

Each phase leaves the app shippable. Owners never share a task: backend routes come before the UI and the desktop code
that call them.

## Risks / open questions (for the user)

No open questions remain from the first draft; see "Owner decisions (2026-11-24)".

**Risks**
- Under full allow, any bot in a game room can run code in Blender and Studio as the owner. Prompt injection through
  asset text or `http_get` could steer it. The owner accepted this (decision 2), and it is stated once in the UI.
- The Blender socket on 9876 has no authentication. Any local process can run Python in Blender. This is unchanged by
  Toki.
- Roblox does not document the Studio settings file. A Studio update could rename the key or the file. B6 then changes
  nothing and falls back to showing the menu path.
- Studio's MCP surface changes with Studio updates (`tools-cache.json` is refreshed by version). `approve: 'mode'` asks
  under `ask` for any tool not on `readTools`, so a new write tool is gated by default.
- Both blender-mcp packages update often (protocol 16 today). The recipe pins a version, and "Update" is a manual fix
  step. The uv hash must be bumped with each pinned uv version.
- Pending approvals are still lost on a hub crash (a known bug). A crash during a long build loses the open card, not
  the files.
- Stubs can be up to 5 minutes stale. A project deleted on the VPS shows until the next refresh, and opening it then
  lands on the VPS hub's "not found".
