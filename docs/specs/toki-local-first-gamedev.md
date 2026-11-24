# Local-first Toki with Blender and Roblox Studio

Status: built on feat/gamedev-tools; see docs/verify/APPROVAL.md.

Clean-room note: this spec describes OpenBot's *model* (`docs/specs/openbot-gaps/00-openbot-recon.md`) as a reference
point. Nothing in it, or in the tasks it creates, may copy OpenBot code, identifiers, strings or assets
(`docs/specs/openbot-gaps/05-owner-decisions.md`, Cross-cutting).

## Problem / user story

The owner's words: "i want this all automatic or no setup needed especially in the blender and roblox studio, the goal
is for me to iteratively develop games inside toki while it being connected to roblox studio and blender", and "should
be mainly connected to local computer then optional vps."

Today his bots run on the VPS hub. The desktop app only reaches that hub through an `ssh -L` tunnel
(`packages/desktop/src-tauri/src/lib.rs:213-226`). Blender and Studio run on his PC. The only bridge is the PC runner
(`scripts/pc-runner/README.md`), which runs a whole `claude -p` job per request, needs two approvals per job, and is
switched on and off with desktop shortcuts.

> As the owner, I open Toki on my PC, make a game project, and Toki sets up Blender (headless, never on my screen) and
> Roblox Studio for it. A team builds in Studio and models in Blender while I watch the previews and steer in chat. My
> VPS projects still show in the same app. When I open one while the VPS isn't connected, Toki asks me to connect it
> first.

## Owner decisions (2026-11-24)

These answer the open questions from the first draft (commit 0617b63) and add the headless rule. Where another section
of this spec seems to disagree with them, these decisions win.

1. **Game files live in Toki's data folder**, in the project folder `<data>/projects/<game-slug>/`. They do not go in a
   Roblox folder, because Roblox has no single local project folder: places mostly live in the cloud, and `.rbxl` files
   go wherever the user saves them.
2. **Game tools follow the hub's approval mode**, including full allow (bypass). Nothing refuses setup or blocks a call
   because of bypass. The risk is stated in the safety section but does not gate anything. A new game room starts on
   the default, `ask`.
3. **One-click setup does not need a password sign-in.** It writes only fixed settings, and every write is logged.
4. **No game tool is blocked.** Blender safe mode is not forced on. `open_cloud_invoke` and the generators are allowed
   under the bot's approval mode. Claude builds the models through the MCP tools. Blender's `generate_3d` and
   `generate_gaussian_world` call paid third-party services and do nothing unless their keys are set in the add-on.
5. **Toki may install uv and turn on Studio's MCP setting itself**, logged ("One-click fixes" in §2).
6. **Nothing is migrated.** Projects stay on their host. One app lists projects from both hosts, each tagged with its
   host. PC projects open with no VPS. A VPS project opened while the VPS is offline shows a connect prompt (§1,
   Phase 3).
7. **Blender runs headless only.**
   - Toki never opens the Blender window.
   - It never launches `blender.exe` without `-b --factory-startup`.
   - Neither Toki nor its bots use `bpy.ops.wm.*` UI operators.
   - Only one Blender runs at a time on this PC, because of RAM (same rule as `reel3d/HEADLESS.md`).

## Scope

**In**
- The PC hub as the primary host. The VPS becomes an optional always-on second host, with its projects listed in the
  same app.
- A **hub-owned headless Blender** per game project: started on demand, at most one at a time, stopped when idle, and
  restarted after a crash.
- Roblox Studio through its own MCP server (`mcp.bat`).
- Detection, installs (uv, the pinned Blender MCP tools, Studio's MCP setting), status in the UI, and one-click fixes.
- A game team template, skills for the Studio and Blender loop, image previews ("look-backs") in chat, readable code on
  approval cards, and checkpoints of game files.
- Windows only, because that is the only installer (`docs/GUIDE.md:103-112`).

**Out**
- The owner's own Blender: its window, preferences and user add-ons. Toki neither reads nor changes them.
- Syncing or migrating anything between hubs.
- VPS bots reaching Blender or Studio directly. They keep `run_on_pc`.
- Rojo-style script sync, Git LFS, macOS and Linux, installing Blender or Studio themselves.

## Design

### The host model (matching OpenBot's shape)

OpenBot is a desktop app whose agents live on the user's own computer. An optional server (Docker, a curl install, or
hosted plans) can act as the host instead, and its mobile and web clients connect to whichever host the user picked.
Toki has the same three pieces:

| OpenBot shape | Toki today | Toki after this spec |
|---|---|---|
| Desktop app hosts the agents | **This PC** mode: the app spawns the hub as its own child, with data in the app's data dir (`lib.rs:2-6`, `lib.rs:459-519`, `docs/SERVER.md:14`). It is the default for new installs (`lib.rs:59-60`). | The primary host. Game tools exist only here. |
| Optional server host | **Server** mode over an SSH tunnel (`lib.rs:213-226`). | An optional always-on host alongside the PC hub, with its projects listed in the same app, tagged "Server". |
| Phone and web clients connect to a host | PWA plus phone pairing (`docs/GUIDE.md:414`), with Tailscale Serve to a loopback hub (`docs/GUIDE.md:345`). | Unchanged. The phone pairs with one host directly. |

#### Where Toki deliberately differs

- **No "Full access" default.** OpenBot runs agents with full access after a consent screen at first launch
  (`00-openbot-recon.md:52-53`). Toki keeps `approvals: 'ask'` as the default
  (`packages/shared/src/providers.ts:136`). Full allow stays the owner's explicit choice, and game tools follow it
  (decision 2).
- **No sync and no hosted relay.** The only thing that crosses between hosts is a list of project names (Phase 3),
  carried by the desktop app on the owner's machine (principle 1).
- **No pooled or hosted plans.** This is unchanged from `06-direction.md` ("Not doing").

### 1. Local-first hub

**What exists.**
- Local mode spawns `resources/hub/hub.mjs` on system Node 22.13 or later, otherwise on the bundled Node 24 sidecar
  (`lib.rs:405-426`).
- The hub gets `POCKETROCKET_DATA`, a fresh random token on every launch, and port 7788 (`lib.rs:484-490`).
- It runs inside a Job Object that kills it when Toki quits (`proc.rs:164-188`).
- Closing the window sends it to the tray by default (`lib.rs:66-71`).
- Remote and local mode share port 7788 today (`lib.rs:697-707`), and switching modes kills the current connection
  (`lib.rs:663-668`).

**Data location.**
- All PC hub state is in `%APPDATA%\com.pocketrocket.app\data\` (`docs/SERVER.md:14`).
- Game files are in `<data>/projects/<game-slug>/` (decision 1). Bots in the project's room already get that folder as a
  working root (`docs/project-folders.md`, "Access").
- Toki's own tools go in `<data>/tools/`: uv, and the pinned Blender MCP environment (§2).

**No migration, two hosts in one app** (decision 6).
- Projects, bots, rooms and history stay where they were made. The per-bot export and import
  (`packages/hub/src/api/rest.ts:331-344`) still exist but are not part of this plan.
- The desktop app keeps the PC hub running. When a server is configured, it also holds an SSH tunnel to the VPS hub on
  its own local port (default 7790), and reads that hub's token over SSH as server mode already does (`lib.rs:243-271`).
- The desktop app reads `GET /api/projects` from the VPS through the tunnel and passes it to the PC hub as **project
  stubs**: host, slug, name and when it was last seen. These are names only. The PC hub stores them, so they still show
  while the VPS is offline.
- The project list shows PC projects tagged "This PC" and stubs tagged "Server".
- A PC project opens with no VPS.
- A Server project opens on the VPS hub when the tunnel is up. When it is down, the app shows "This project is on your
  server. Connect to open it." with **Connect** and **Cancel**. If the connection fails, it shows the reason
  (`lib.rs:803-813` sorts SSH failures by kind).
- Bots never see stubs, so the project folder guard (`permissions/projectGuard.ts`) is unchanged.
- **When the PC is off,** the PC hub, its projects and its headless Blender are off. The VPS hub keeps running its own
  bots, routines and triggers.
- Both hubs share one Claude subscription, and the usage view says so.

**Auth.**
- Each hub keeps its own token, and both bind to 127.0.0.1 only.
- The stub route and the game-tools routes accept the hub token only. They refuse paired devices and bot bearers.
- The game-tools routes need no password sign-in (decision 3). Custom stdio servers still do
  (`packages/hub/src/api/mcpServers.ts:20-21`, `:112`, `:124`).
- The game-tools routes run only fixed steps compiled into the hub. Nothing in a request becomes a command, argument or
  environment variable.

### 2. Zero-setup game tools

#### Facts (verified 2026-11-24; corrected by the spike)

*Blender*
- Blender 5.2.2 LTS is at `C:\Program Files\Blender Foundation\Blender 5.2`. The PC has 16 GB RAM and an RTX 3050
  Laptop GPU.
- **Package and pin.** The server is the PyPI package `mcp-for-blender` (console script `mcp-for-blender`).
  `blender-mcp` 2.0.0 is only a shim that requires `mcp-for-blender>=2.0.0` with no upper bound, so pinning it pins
  nothing (spike item 1). Toki pins **`mcp-for-blender==2.3.1`**.
- **The add-on.** `mcp-for-blender` 2.3.1 ships its add-on in the package (`blender_mcp/bundled/addon.py`). Server and
  add-on must agree on a protocol version (`addon_manager.py:23`, protocol 16), so taking both from one pinned package
  keeps them matched.
- **Connection settings.** The server finds Blender through `BLENDER_HOST` and `BLENDER_PORT`, with defaults
  `localhost:9876` (`server.py:78-92`). Telemetry is off with `DISABLE_TELEMETRY` (`telemetry.py:117-119`).
- **The add-on does not serve in `-b` on its own** (spike item 4 and f2):
  - `start()` prints "cannot start server in background mode", because a `bpy.app.timers` callback drains its command
    queue, and timers never fire in `-b`.
  - The spike's ~30-line `docs/verify/game-tools-spike/scripts/f2_server.py` binds the socket itself and pumps the
    queue on the main thread.
  - With that pump, `get_scene_info`, `execute_blender_code` and `look` all worked from a hub turn.
  - The pump depends on private internals (`BlenderMCPServer.command_queue`, `_server_loop`, `_drain_command_queue`).
    This is why the add-on version is pinned with the server, and the pump is retested on every bump.
- **Timings, warm, from the spike's "Latency" table:**
  - Blender start: about 5 s, plus a 0.2 s socket bind.
  - MCP connect: 2.9 s (22 s on uvx's first resolve of the pin).
  - `execute_blender_code` and `get_scene_info`: 0.02 s each.
  - Rendered `look`: 0.5 s (5.4 s for the first render). A solid `look`: 0.06 s.
  - For comparison, a one-shot `-b` job with an EEVEE 512² preview takes about 7 s warm and 31 s the first time
    (shader compile).
  - The EEVEE engine id in 5.2 is `BLENDER_EEVEE`. There is no `_NEXT`.
- **The "read" tools run code** (spike item 6): `get_scene_info` and `look` reach the add-on as `execute_code` scripts
  that the server writes. They are read-only by intent, not by mechanism.
- **Update check** (spike item 7): in GUI mode the add-on fetches `https://raw.githubusercontent.com/ahujasid/blender-mcp/main/addon.py`
  unless it runs in `-b` or `BLENDERMCP_NO_UPDATE_CHECK` is set (`bundled/addon.py:7354`). Toki sets the variable anyway.
- **The socket has no authentication.** Any local process that finds the port can send it Python.
- MCP tools: `get_addon_status`, `disable_telemetry`, `get_scene_info`, `execute_blender_code`,
  `record_trajectory_feedback`, `look`, `generate_3d`, `generate_gaussian_world`, `search_assets`, `import_asset`.
- The owner's own add-on folder has two old copies (v1.8 and v2.0). Toki does not use or touch them, because its
  Blender starts with `--factory-startup` and loads the add-on from Toki's own pinned environment.

*Roblox Studio* (none of the live Studio steps were verified, because Studio was not open during the spike; they are
marked "verify when Studio is open")
- `%LOCALAPPDATA%\Roblox\mcp.bat` runs `Versions\<version>\StudioMCP.exe`, or falls back to the `ContentFolder` value
  under `HKCU\Software\Roblox\RobloxStudio`.
- `StudioMCP.exe` is a stdio MCP server. Its first instance hosts a local WebSocket that Studio connects to. It keeps
  `%LOCALAPPDATA%\Roblox\StudioMCP\auth.token` and a `tools-cache.json` (38 tools).
- From a hub turn, `list_roblox_studios` returned `{"studios":[]}` with Studio closed (spike b).
- Studio must be open, with the Assistant setting `mcp-server` enabled. In
  `%LOCALAPPDATA%\Roblox\AssistantSettings\<userId>.json` the setting is `{"enabled":true}` today, and
  `mcp-prompt-sharing` is `{"enabled":false}`.
- Every call needs a `studio_id` from `list_roblox_studios`.
- Read-only tools (`readOnlyHint`): `search_game_tree`, `script_search`, `script_read`, `script_grep`,
  `inspect_instance`, `get_console_output`, `get_studio_state`, `screen_capture`, `list_roblox_studios`, `list_skills`,
  `skill`, `wait_job_finished`, `search_asset`, `http_get`.
  Toki leaves `http_get` off the recipe's `readTools` anyway: a GET to any URL can carry data out in its query string,
  so under `ask` it gets the normal card. Under bypass it runs, as every tool does (decision 4).
- Write tools: `execute_luau`, `multi_edit`, `save_place`, `start_stop_play`, `insert_asset`, input and navigation
  tools, and the `generate_*` tools.
- Tools that reach outside the PC: `open_cloud_invoke`, `upload_image`, `submit_feedback`, `create_skill`,
  `edit_skill`.
- All tools stay mounted (decision 4).

*Approval cards today* (spike c', item 2, item 3)
- Under `ask`, every outside call asks, even for tools on `readTools`. The hub's normal card fires for any tool the
  bot's `allowedTools` does not list. `readTools` only skip the extra once-only hook card
  (`providers/claude.ts:462-485`).
- Writes get only the once-only card ("Asked every time.", with no "Always allow"). The hook's `allow` then skips the
  normal card.
- Inputs over `OUTSIDE_INPUT_CAP` (8000 chars, `PermissionBroker.ts:114`) are **refused**, never cut off (`:540-543`).
  Every real input measured was under that: `execute_luau` max 2244 chars, `execute_blender_code` max 1607.
- The card shows code as a double-escaped JSON string (`\\n`) in a 160 px box. Nothing is cut off, but it is hard to
  read.
- Images in tool results never reach the owner. `providers/claude.ts:799-803` turns every non-text block into
  `[image]`. The Claude CLI writes the PNG to `~/.claude/projects/<cwd-slug>/<session>/tool-results/`, outside Toki's
  data dir, and that path shows in chat (spike d, item 5).

#### The hub-owned headless Blender (new: `BlenderHost`)

One process manager in the hub owns every Blender that Toki starts.

- **Command.**
  `"<blender.exe>" -b --factory-startup "<data>/projects/<slug>/art/<slug>.blend" -P "<hub resources>/blender/toki_blender_server.py" -- <port> <idle-seconds>`
  - The `.blend` path is left out when the file does not exist yet. Blender then starts with the factory scene.
  - Passing the file on the command line is how it opens without `bpy.ops.wm.open_mainfile` (decision 7).
- **Environment.**
  - `BLENDERMCP_NO_UPDATE_CHECK=1` and `DISABLE_TELEMETRY=true`.
  - `PYTHONPATH` is not inherited, so the owner's Python setup cannot leak in.
  - Windows flags: `CREATE_NO_WINDOW`, so nothing appears on screen.
  - The process runs inside the hub's job, so it dies with Toki.
- **`toki_blender_server.py`** (hub resource, owned by pr-backend, shipped by pr-infra). It follows the spike's
  `f2_server.py` pattern. It:
  1. loads the add-on **from Toki's pinned environment**
     (`<data>/tools/blender-mcp/2.3.1/Lib/site-packages/blender_mcp/bundled/addon.py`) with
     `importlib.util.spec_from_file_location`, and calls its `register()`. It does not use `addon_utils` or the owner's
     add-on folder, and it does not depend on his preferences;
  2. sets `scene.render.engine = 'BLENDER_EEVEE'`, so `look` renders with EEVEE;
  3. binds `127.0.0.1:<port>` itself and pumps the command queue on the main thread;
  4. adds `toki_save()` to `builtins`, so code run through the add-on's `exec(code, {"bpy": bpy})`
     (`bundled/addon.py:2445-2455`) can call it. `toki_save()` writes the open project's data with
     `bpy.data.libraries.write(<tmp>, set(bpy.data.scenes), fake_user=True, compress=True)` and then `os.replace` onto
     `art/<slug>.blend`. That is the spike's suggested way to save without `bpy.ops.wm.*`, and it never writes outside
     `art/`;
  5. saves when it stops and every 5 minutes while `bpy.data.is_dirty`. It stops when the hub creates a stop file in
     its run folder, or when the idle seconds run out.
- **Port.** The hub picks a free loopback port at every start: it binds 127.0.0.1:0 and reads the number. It never uses
  9876, so it cannot collide with a GUI Blender the owner opens himself.
- **MCP mount.**
  - Blender is not a line in `mcp-servers.json`. `BotRunner` appends a built-in `blender` entry to the turn's
    `outsideMcp` list (`agent/BotRunner.ts:481`) for rooms linked to a game project.
  - The entry runs `<data>/tools/blender-mcp/2.3.1/Scripts/mcp-for-blender.exe`, an absolute path that needs no uvx
    resolve per turn, with `BLENDER_HOST=127.0.0.1`, `BLENDER_PORT=<live port>` and `DISABLE_TELEMETRY=true`.
  - It has `approve: 'mode'` (B3) and `readTools: ['get_addon_status', 'get_scene_info', 'look', 'search_assets']`.
- **On demand.**
  - A turn in a game room calls `BlenderHost.ensure(project)` before it starts.
  - The PreToolUse hook for `mcp__blender__.*` awaits `ensure` again, which covers a crash in mid-turn.
  - Whether `mcp-for-blender` starts cleanly before Blender listens is checked in B12. If it does not, the turn waits
    for the socket to answer before it starts.
- **One at a time.**
  - The hub keeps at most one Blender. Before it starts one, it also checks for any other `blender.exe` on the PC, such
    as a reel3d render or the owner's own Blender.
  - If another Blender is running, the call is refused with "Another Blender is running on this PC (<exe>, pid N). Try
    again when it finishes." Toki never kills a process it did not start.
  - If the hub's own Blender belongs to another project, it saves and stops that Blender only if it has been idle for
    at least 60 s. Otherwise the call is refused with "Blender is busy with <project>".
- **Idle and crash.**
  - Blender stops after 10 minutes with no Blender tool call (a hub setting) and when the hub quits. It saves first.
  - An unexpected exit is logged with Blender's last 50 lines of output, and the next call restarts it. More than 3
    crashes in 10 minutes stop the restarts and put a fix in the status ("Blender keeps crashing: open log").
- **RAM** was not measured in the spike. B12 logs the process's peak working set, so the 10-minute default can be
  tuned.
- **No `bpy.ops.wm.*` from bots.** The `blender-loop` skill says so. The `mcp__blender__execute_blender_code` hook also
  refuses code containing `bpy.ops.wm.` with "Use toki_save(); the file is opened for you." This is a text check that
  stops ordinary use, not a wall.

#### Studio recipe

Studio is a fixed recipe written into `mcp-servers.json`, scoped to the game room:
`C:\Windows\System32\cmd.exe /d /c <abs>\mcp.bat`, with `approve: 'mode'` and `readTools` set to the read-only list
above, minus `http_get`. A stdio command must be an absolute path (`outsideMcp.ts:50-54`), and `cmd.exe` is one. It is mounted per room
(`outsideMcp.ts:67-124`).

#### Approval behaviour (decision 2, spike item 2): `approve: 'mode'`

- **Bypass** (`bypassedFor(ctx)` is true, `PermissionBroker.ts:151-156`): no card for any tool of the server.
- **`ask` and strict turns** (routines, triggers, failover, `rooms/RoomRouter.ts:526-527`):
  - Tools on `readTools` **skip the card**. The hook returns `allow` for them, which also skips the normal card that
    fires today because the bot's `allowedTools` doesn't list them. This is the decided meaning of `readTools` under
    `ask`.
  - Every other tool gets the **normal** tool card, with "Always allow" and the owner's approval rules, the same as
    built-in tools.
- The 8000-character refusal stays for every outside server.
- The values `every-call`, `writes` and `none` keep today's behaviour for all other outside servers.
- Approvals are hub-wide, so a new game room starts on `ask`.

#### Detection (win32 only; other platforms report "not supported")

- **Blender:** the newest `C:\Program Files\Blender Foundation\Blender *\blender.exe`, and its version from
  `blender.exe -b --factory-startup --version`.
- **uv:** `uv.exe` on the fresh user PATH (`lib.rs:491-495`, `envpath.rs`), otherwise
  `<data>/tools/uv/<version>/uv.exe`.
- **Blender MCP tools:** `<data>/tools/blender-mcp/2.3.1/` exists with `mcp-for-blender.exe` and `bundled/addon.py`,
  and the add-on's sha256 matches the value recorded at install.
- **Blender process:** none running, Toki's own (which project, idle time, port), or another one (exe and pid).
- **Studio** (verify when Studio is open): `mcp.bat` exists, a `StudioMCP.exe` resolves, the `mcp-server` setting is
  enabled, and `RobloxStudioBeta.exe` is running.

#### One-click fixes

Each fix is a fixed step. It accepts the hub token only, needs no password (decision 3), and writes one audit row
(`services/AuditLog.ts`, `recordAudit`) naming the step and the files it changed.

| Missing | Fix | What it touches | Audit action |
|---|---|---|---|
| Blender not installed | Link to blender.org. | nothing | none |
| uv not installed | Download the pinned `uv-x86_64-pc-windows-msvc.zip` from the uv GitHub releases, check its sha256 against a value compiled into the hub, and unpack it into `<data>/tools/uv/<version>/`. PATH and the registry are not changed. On first use, uv adds its cache under `%LOCALAPPDATA%\uv\` and, if no Python is found, a managed Python under `%APPDATA%\uv\python\`. | `<data>/tools/uv/`; uv's cache and Python folders | `game_tools.uv_installed` |
| Blender MCP tools missing | `uv venv <data>/tools/blender-mcp/2.3.1`, then `uv pip install --require-hashes -r <hub resource requirements file>`. The file pins `mcp-for-blender==2.3.1` and its dependencies, with hashes. | `<data>/tools/blender-mcp/` | `game_tools.blender_mcp_installed` (version, add-on sha256) |
| Another Blender running | Text only: which exe and pid, and "try again when it finishes". | nothing | none |
| Toki's Blender crashing | "Open log" for the last start, and "Try again", which resets the crash counter. | nothing | `game_tools.blender_reset` |
| Studio MCP setting off (verify when Studio is open) | Only while Studio is closed: for each `%LOCALAPPDATA%\Roblox\AssistantSettings\<userId>.json`, back it up to `<file>.toki-bak`, set only `mcp-server` to `{"enabled":true}`, keep every other key, and write it back atomically. `mcp-prompt-sharing` is never touched. If the file does not parse or has no such key, nothing changes and the menu path is shown instead. | those files and their backups | `game_tools.studio_mcp_enabled` |
| Studio not running | "Open Studio", launched by the desktop shell (I1). | nothing | none |

#### UI

- A **Game tools** section in Settings lists Blender, uv, Blender MCP tools and Studio. Each has a status dot, a version
  and one fix button. Blender also shows its state: stopped, running for <project> (idle N min), or "another Blender is
  running".
- The game room header gets a compact strip ("Blender idle · Studio not open [Open Studio]").
- Both reuse the `ui.tsx` primitives and the in-app confirm. Status is shown in text as well as colour.
- One plain line says that game tools run code as you on this PC and follow your approval setting.
- There is no "Open Blender" button anywhere (decision 7).

### 3. The iterative loop in a game room

**Template.** The project service already clones teams from a template (`services/ProjectService.ts:107-153`,
`services/devTeamTemplate.ts:1-16`). The API only has `team: boolean` (`api/projects.ts:11`). Phase 2 adds `game`:
- the lead, cloned from @lead-engineer;
- a builder, cloned from a new seed bot @roblox-builder;
- an artist, cloned from a new seed bot @blender-artist;
- skills `project-map`, `prove-it`, `studio-loop` and `blender-loop`.

`MAX_ROOM_BOTS` is 20 (`packages/shared/src/models.ts:1`).

**Folder layout** in `<data>/projects/<game-slug>/`, next to `current.md`, `archive/` and `features/`:
- `art/<slug>.blend` is the one scene file Toki's Blender opens and saves.
- `exports/` holds `.fbx` and `.glb` files for Studio.
- `studio/` holds text mirrors of the place's scripts.
- `places/` holds any `.rbxl` the owner saves there by hand.
- Settings › Projects gets an "Open folder" button.

**Loop:**
1. The owner asks in the room.
2. The lead splits the work.
3. The artist: `get_scene_info`, then `execute_blender_code` (ending with `toki_save()`), then `look` (rendered with
   EEVEE, about 0.5 s warm), then an export to `exports/` with `bpy.ops.export_scene.*`, which is not a `wm` operator.
4. The builder (verify when Studio is open): `list_roblox_studios`, `search_game_tree`, `script_read`, then
   `multi_edit` or `execute_luau`, then `start_stop_play`, `get_console_output`, `screen_capture` and `save_place`.
5. The lead posts the result with the look-backs.

Under `ask`, read tools run straight away and writes raise one card each. Under bypass, nothing asks.

**Look-backs** (B9, needed per spike d).
- The hub takes the image block **from the SDK message**, the `tool_result` content in `providers/claude.ts:796-803`,
  where it is replaced by `[image]` today. It does not read the CLI's `tool-results` file path.
- It stores the image in the media store, attaches it to the tool's message, and removes the CLI file path from the
  text shown in chat.
- There is one image per call, within existing media limits.

**Readable code on cards** (B4 and D5, per spike c').
- The card's `code` field (`execute_blender_code`, `execute_luau`; `multi_edit` edits as a list) is shown as
  preformatted code: real line breaks, monospace, a taller scroll area (up to 60 % of the viewport), and no `\\n`.
- The other fields show as a short key-value list.
- The 8000-character limit is unchanged.

**Checkpoints.**
- The project folder is a git repo, created with the template (`services/git.ts`).
- A checkpoint commits `art/<slug>.blend` (a binary; warn above 50 MB), `exports/` and the `studio/` script mirrors.
  The place itself keeps Studio's own version history.
- Bots keep `safe-shipping` (`permissions/shipGuard.ts`).

### Security against the principles

- **Where the boundary is.** On the PC hub every bot runs as the owner. Python in Toki's Blender and Luau in Studio run
  as the owner, and the Blender socket has no authentication.
  - The socket uses a random loopback port per start and lives only while the project is in use. That narrows exposure,
    but it is not a lock.
  - The "read" Blender tools also execute server-written scripts.
  - Under `ask`, writes raise cards. Under bypass, nothing asks, as for Bash. The owner chose this (decision 2), and it
    gates nothing.
- **The owner's own Blender is untouched.** Toki uses `--factory-startup`, its own pinned add-on, and its own port. It
  never opens a window and never uses `wm` operators (decision 7). It also never kills a Blender it did not start.
- **Untrusted text.** Asset names and descriptions, and pages fetched with `http_get`, are third-party text. Under
  `ask`, the owner sees every write. Under bypass, he has accepted that.
- **Outward tools.** `open_cloud_invoke` and the generators follow the approval mode (decision 4).
- **What the VPS can reach.** VPS bots cannot reach Blender or Studio. No tunnel forwards either. `run_on_pc` stays as
  it is today: double approval, whitelisted folders. The VPS hub learns nothing about PC projects.
- **Principle 1.**
  - Both hubs stay on loopback, and the MCP servers are local.
  - Blender telemetry and the add-on's update check are off.
  - Studio prompt sharing is left as the owner set it.
  - The generators and asset search send prompts to third parties by design, and the Game tools section says so.
- **Principle 2.** Bots cannot change `mcp-servers.json`, run the setup or fix routes, write stubs, or start or stop
  Blender outside a turn in their own game room.
- **Principle 4.** Per-turn budgets apply as usual. Look-backs are capped at one image per call. Blender stops when
  idle, and only one runs at a time.

## Tasks

| # | Owner | Files | Change | Acceptance criteria | Verify |
|---|---|---|---|---|---|
| **Phase 0: spike** |||||
| S1 | pr-infra | `docs/verify/game-tools-spike.md` | **Done** (0840b6f). | - | - |
| S2 | pr-infra | `docs/verify/game-tools-spike.md` (append) | **Verify when Studio is open:** (e) a `mcp-server` flip with Studio closed takes effect on the next start; `execute_luau` and `multi_edit` cards; `screen_capture` image block; `save_place`. | Each item answered with evidence. | Notes and screenshots |
| **Phase 1: Blender headless and Studio, set up in one click** |||||
| B12 | pr-backend | `packages/hub/src/services/BlenderHost.ts` (new), `packages/hub/resources/blender/toki_blender_server.py` (new), `agent/BotRunner.ts`, tests | `BlenderHost` as in §2: start with `-b --factory-startup [<blend>] -P`, free loopback port, `CREATE_NO_WINDOW`, the env above, at most one, the other-Blender check, idle stop with a stop file and save, crash restart with a limit, peak working set logged. The server script: load the add-on from the pinned environment, set EEVEE, pump, `toki_save()` with `bpy.data.libraries.write` and `os.replace`, save every 5 minutes while dirty. `BotRunner` mounts the built-in `blender` entry with the live port. Also check whether `mcp-for-blender` starts before Blender listens. | The command line always holds `-b --factory-startup`, and no window ever appears. A second start while one runs is refused, as is a start while a non-Toki `blender.exe` runs. After an idle stop, `art/<slug>.blend` reopens in a fresh `-b` process with the same scene, object, mesh and material counts. A killed process is restarted on the next call, and the fourth crash in 10 minutes stops restarts. Nothing binds 9876. | Unit tests with a fake spawner and process list; a manual run on the owner's PC with Task Manager open, recording peak RAM in the PR |
| B1 | pr-backend | `services/gameTools.ts` (new), test | Detection as in §2: Blender exe and version; uv (system or Toki's); the Blender MCP environment and add-on hash; Blender process state; Studio files, setting and process (Studio items: verify when Studio is open). | Each fact has a fixed reason code. Non-win32 reports `unsupported`. Toki never reads or writes the owner's Blender config or add-on folders. | Unit tests with fixture trees |
| B2 | pr-backend | `api/gameTools.ts` (new), `hub.ts`, tests | `GET /api/game-tools`; `POST /api/game-tools/studio/setup` (writes the Studio recipe for one room); `POST /api/game-tools/fix/:step` for `install-uv`, `install-blender-mcp`, `blender-reset` and `studio-mcp-setting`. Hub token only, no password, every write audited. | Paired device and bot bearer get 403. No request field reaches a command, args or env. Works under `ask` and under bypass. | Route tests |
| B6 | pr-backend | `services/gameTools.ts`, `packages/hub/resources/blender/requirements.txt` (new, hashed), tests | The install steps: uv (pinned zip plus sha256 into `<data>/tools/uv/`); the Blender MCP environment (`uv venv` plus `uv pip install --require-hashes`); the Studio setting edit (verify when Studio is open). | A wrong hash leaves nothing behind. PATH and the registry are unchanged. The Studio step refuses while Studio runs, keeps every other key, writes a `.toki-bak`, and changes nothing when the file won't parse. | Unit tests with a fake fetch and a fixture settings file; manual on the owner's PC |
| B3 | pr-backend | `services/outsideMcp.ts`, `services/outsideMcpStore.ts`, `providers/claude.ts`, `agent/BotRunner.ts`, `permissions/PermissionBroker.ts`, tests | `approve: 'mode'` as in §2. Bypass: no card. `ask` and strict turns: `readTools` are allowed by the hook with no card at all, and other tools get the normal card with rules and "Always allow". Plus the `bpy.ops.wm.` refusal hook for `mcp__blender__execute_blender_code`. | Under `ask`, `mcp__blender__get_scene_info` raises no card (the spike's `t1-readtool-card` case), and `execute_blender_code` raises one normal card with "Always allow". Under bypass, neither asks. A routine turn asks for writes. `every-call` servers are unchanged. Code containing `bpy.ops.wm.` is refused in every mode. | Tests next to `outsideMcpApproval.test.ts` |
| B5 | pr-backend | `api/mcpServers.ts`, `api/gameTools.ts` | Status checks: the Blender state comes from `BlenderHost`; `check` for the Studio recipe also reports `studio-not-open` and `setting-off` (verify when Studio is open). | Fixed result words, never remote text. | Tests with fakes |
| I1 | pr-infra | `packages/desktop/src-tauri/src/lib.rs`, new `launch.rs` | **"Open Studio" only**, through the `window.open` pattern used for local copies (`lib.rs:1013-1036`): one fixed app id, path resolved by the shell, started with `CREATE_BREAKAWAY_FROM_JOB` (`proc.rs:167`, `:188`). No Blender launcher. | The page cannot pass a path or another app id. Studio stays open after Toki quits. | Rust unit test; manual (verify when Studio is open) |
| I4 | pr-infra | `pnpm hub:bundle` config, `tauri.conf.json` resources | Ship `packages/hub/resources/blender/` (server script and hashed requirements) inside `resources/hub/`, and pass its path to the hub. | The installed app has both files, and `BlenderHost` finds them in bundled and dev runs. | Manual install check; `cargo check` |
| D1 | pr-design-system | `components/settings/GameToolsSection.tsx` (new), room header, `lib/api.ts` | The Game tools section and room strip from §2, including Blender's state line, crash "Open log" and "Try again", Install uv, Install Blender tools, and Turn on Studio MCP. | AA contrast; keyboard reachable; status in text as well as colour; reduced motion respected; no native `confirm()`; no "Open Blender". | Manual in light and dark at narrow width; screenshot |
| B4 | pr-backend | `permissions/PermissionBroker.ts`, the card payload type in `packages/shared`, tests | The outside-tool card carries the redacted input as an object, not a JSON string, plus a `codeField` name for known code tools (`code` for `execute_blender_code` and `execute_luau`). This applies to both the once-only and the normal card path. The cap stays at 8000. | The spike's 3044-char input reaches the card with real newlines in `code`. Over 8000 is still refused. | Unit tests |
| D5 | pr-design-system | approval card component | Render `codeField` as preformatted monospace code with real line breaks, in a taller scroll area (up to 60vh), and the other fields as a key-value list. | Readable at narrow width; keyboard scrollable; AA; focus order unchanged. | Manual with the spike's 3 KB input; screenshot |
| **Phase 2: the game room** |||||
| B7 | pr-backend | `services/devTeamTemplate.ts` (template registry), `services/ProjectService.ts`, `api/projects.ts`, migration, `services/SeedBots.ts`, tests | The `game` template: roles, seed bots, the folder layout from §3, `git init`, the Studio recipe for the new room, and Blender mounting through `BlenderHost`. `team: true` still means `dev`. | A game project has 3 bots, a room, `art/ exports/ studio/ places/`, and git. Blender mounts for that room only. | `ProjectService` tests; a manual create |
| B8 | pr-backend | `services/builtinSkills.ts` | The `blender-loop` skill (no `bpy.ops.wm.*`, end each change with `toki_save()`, export to `exports/`, `look` after a change) and the `studio-loop` skill (`studio_id` first, read before writing, `save_place` after a verified change, mirror scripts to `studio/`). | Added to the pool at startup when missing. | Template test method in `docs/project-folders.md`: 3 runs with and without, on a trap task ("save with wm.save_mainfile") |
| B9 | pr-backend | `providers/claude.ts` (tool_result handling at `:796-803`), `agent/BotRunner.ts`, `services/MediaStore.ts`, tests | Take image blocks from the SDK `tool_result` content of game tools, store the first one as media, attach it to the tool message, and remove the CLI's `tool-results` file path from the shown text. | Never reads `~/.claude/.../tool-results`. One image per call. No image is stored for other servers. | Unit test with a fake SDK message; manual `look` |
| D2 | pr-design-system | chat tool message component, lightbox | Look-back thumbnails on tool messages, opening in the existing image viewer. | Alt text from the tool name; no layout shift; works in the narrow drawer. | Manual; screenshot |
| D3 | pr-design-system | `components/settings/ProjectsSection.tsx` | A template picker (None, Dev team, Game team) and an "Open folder" button. Game team is disabled, with the reason, until Blender and the Blender MCP tools are ready. | Keyboard and AA. | Manual |
| **Phase 3: one app, two hosts** |||||
| I2 | pr-infra | `lib.rs` (Config, `run_connection`, `spawn_tunnel`, `stays_in_webview` at `:551-561`), `ssh.rs`, tests | The local hub always runs. An optional server tunnel uses its own port (default 7790), started on demand, with its token read over SSH. Both ports stay in the webview. Old `mode: "remote"` configs load as local plus that server. | The tunnel never stops the local hub. Each hub keeps its own token. Old configs load (`lib.rs:1685`). | Rust tests; manual with a live PC turn |
| B10 | pr-backend | `services/RemoteProjects.ts` (new), `api/projects.ts`, migration, tests | `PUT /api/hosts/:host/projects` (stubs plus a `connected` flag); `GET /api/projects` adds `host`; a `hosts.changed` event. | Hub token only. Stubs never reach a bot. At most 500 per host, names validated. | Route tests |
| I3 | pr-infra | `lib.rs` (`new_window_elsewhere`), new `hosts.rs` | Refresh stubs on connect and every 5 minutes; mark the host disconnected within 30 s of losing the tunnel; handle `?openproject=server:<slug>` and `?connecthost=server`. | The page never passes an address or token. Nothing is pushed to the VPS. | Rust tests; manual |
| D4 | pr-design-system | project lists, connect prompt (`ui.tsx` dialog) | Host tags; the offline Server project prompt with Connect, a working state, then the project or the error; outside the desktop app, a note to open it there. | Text tags; focus returns on Cancel; AA; no `confirm()`. | Manual: PC project offline opens; Server project offline prompts; Connect opens it |
| B11 | pr-backend | `services/UsageTracker.ts`, usage API | A note that both hubs spend from one subscription. | Shown when a server host is known. | Unit test |
| P1 | pr-planner | `docs/GUIDE.md`, `CHANGELOG.md` [Unreleased] | Guide sections: "Make games with Blender and Studio" (headless, one Blender at a time), "This PC and your server", and what is not migrated. | Matches the shipped behaviour. | Review |

## Order and dependencies

**Phase 1** (the smallest working loop: Blender headless, plus Studio once verified)
1. B3 and B12 have no dependencies and can start together. B12 needs B6's environment to run for real, but its unit
   tests use fakes.
2. B1, then B6, then B2. I4 runs alongside B12.
3. B5 needs B12 and B2. D1 needs B2, B5 and B6.
4. B4, then D5. These two have no other dependencies.
5. I1 has no dependencies.
6. **Cut:** with B12, B3, B1, B6, B2, I4 and D1, the owner presses Install Blender tools, links a room to a game
   project, and the artist works in a headless Blender with cards under `ask`. Studio joins when S2 passes.

**Phase 2**
- B7 needs B12 and B2.
- B8 has no dependencies.
- B9, then D2.
- D3 needs B7.

**Phase 3**
- I2, then I3.
- B10 runs alongside I2.
- D4 needs B10 and I3.
- B11 has no dependencies.
- Phase 3 can run alongside Phase 2.

**S2** blocks marking any Studio item done, but does not block Blender work.

**Final task list per owner:**
- **pr-backend:** B12, B3, B1, B6, B2, B5, B4 (Phase 1); B7, B8, B9 (Phase 2); B10, B11 (Phase 3).
- **pr-infra:** S2 (whenever Studio can be opened), I4, I1 (Phase 1); I2, I3 (Phase 3).
- **pr-design-system:** D1, D5 (Phase 1); D2, D3 (Phase 2); D4 (Phase 3).
- **pr-planner:** P1, after each phase ships.

**Phase 4 (not tasked):** Rojo-style script sync, more tools through the same recipe or host mechanism, macOS and
Linux.

## Risks / open questions (for the user)

No open questions remain; see "Owner decisions (2026-11-24)".

**Risks**
- The pump in `toki_blender_server.py` depends on the add-on's private internals. Any bump of `mcp-for-blender`
  must rerun B12's manual check before the pin changes.
- `bpy.data.libraries.write` of all scenes is the only save path that avoids `wm` operators. B12 checks that the counts
  match when the file is reopened, but some data that is not linked from a scene could be dropped. If that happens, it
  comes back to the owner as a decision.
- RAM for a persistent Blender was not measured. Until B12 measures it, the 10-minute idle stop and the one-at-a-time
  rule are the guard.
- Under full allow, any bot in a game room can run code in Blender and Studio as the owner. The owner accepted this
  (decision 2).
- The Blender socket has no authentication. A random port per start and a short lifetime narrow the exposure, but do
  not close it.
- Roblox does not document the Studio settings file. B6 falls back to showing the menu path. Every live Studio behaviour
  in this spec is unverified until S2.
- Pending approvals are still lost on a hub crash (a known bug).
- Stubs can be up to 5 minutes stale.
