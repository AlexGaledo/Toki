# Toki guide

What Toki does once it's installed, how it works, and what the bots may and may not do.
Setup itself is in the [README](../README.md).

## Contents

- [Features](#features)
- [How it works](#how-it-works)
- [Concepts](#concepts)
- [Make games with Blender and Studio](#make-games-with-blender-and-studio)
- [This PC and your server](#this-pc-and-your-server)
- [Permissions & safety](#permissions--safety)
- [Configuration](#configuration)
- [Roadmap](#roadmap)

## Features

- **Persistent bots** — identity, private memory and skills that survive restarts.
- **DMs and group chats** — @mention and hand off work between bots in a shared room.
- **Approval cards** — bots ask before shell commands, edits outside the workspace, or fleet/room
  changes; on by default.
- **Skills** — import from your provider's skill directory, author in the UI, or let a bot draft
  one for review.
- **Routines** — wake a bot on a cron schedule to check in or do recurring work.
- **Cost tracking** — spend per bot and per room, with a budget cap per turn.
- **Shared screen** (server mode) — a persistent virtual desktop and browser bots and you both use.
- **Optional account** — sign in for paid plans later; everything works fully signed out.

## How it works

The hub is a Node process (SQLite, REST, WebSocket) bound to `127.0.0.1`; the React UI is served
from the same process. Each bot turn spawns your own `claude` CLI through the Claude Agent SDK and
resumes that bot's session; bot tools (`send_message`, memory, room management, and the rest) are
exposed to the model over an in-process MCP server. The desktop app is a thin Tauri/WebView2 shell
around that same hub. Server mode runs the identical hub on a Linux box, reachable over an SSH
tunnel — see [SERVER.md](SERVER.md).

## Concepts

| Thing | Where it lives | Notes |
|---|---|---|
| Bot | `data/pocketrocket.db` + `data/bots/<id>/` | `CLAUDE.md`-style identity file, `memory.md` = private memory (injected every turn), `plugin/` = assigned skills |
| Workspace | `data/workspace/` | Shared cwd for every bot. The folder button in the sidebar opens it on whichever computer the hub runs on: Explorer or Finder locally, the file manager on the virtual desktop for a server hub |
| DM | room kind `dm` | Bot always replies |
| Group chat | room kind `group`, 1–6 bots | Only @mentioned bots reply. No mention → coordinator bot (if set). Bots can @mention each other; max 5 hops per thread, $5 cost cap per thread |
| Session | one Claude Agent SDK session per (bot, room) | Resumed each turn; reset from the Bot page, under Memory |
| Skill pool | `data/skills/<name>/SKILL.md` | Import from Claude Code's skill directory, author in the UI, or let a bot `save_skill` (goes to review first) |
| Routine | cron in DB | Wakes a bot with a prompt in a room while the hub runs |

Custom tools every bot gets: `send_message`, `handoff`, `update_memory`, `read_memory`, `save_skill`,
`list_bots`, `read_room`, and full team CRUD: `create_bot`, `update_bot`, `delete_bot` (any bot,
including itself, `confirm: true` required), `create_room`, `list_rooms`, `delete_room`,
`add_to_room`, `remove_from_room` (all room tools take an optional `room` so a bot can manage any
room, not just the one it's replying in; reading or posting in a chat the bot isn't in shows an approval card). A coordinator can recruit its own specialists, put them
in a group chat of its own making, retune them, and retire them ("create a researcher and a
writer, start a room with them, then draft the post"). Limits: 50 bots per account, 6 per room.
The system prompt tells bots not to delete or rewrite a bot unless you asked.

**Auto-memory.** Bots don't have to remember to call `update_memory`: every 10 completed turns of a
bot in a room (per bot, 3–100, or off — Settings → Bots), a background pass on Haiku 4.5 reads the
messages since the last pass and appends new lasting facts (your preferences, decisions, ongoing
work, names/IDs) to `memory.md` under an `## Auto-saved <date>` heading. It is append-only, runs
separately from the bot's session without holding up the room, skips secrets, posts "*Bot* saved N
notes to memory" when it saved anything, and its cost shows up in usage. Claude provider only.

Models: **Sonnet 5** (default), **Opus 5**, **Fable 5.1**, **Haiku 4.5** — picked per bot in the
bot dialog.

### Messaging a busy bot (steering)

You don't have to wait for a bot to finish before you correct it.

- **Enter** sends. If the bot is busy in that chat and can take messages mid-task, your message
  **joins its running turn**: the bot reads it at its next step and can change course. The
  placeholder says "*Ada* is working. Your message joins in." when that will happen.
- **Ctrl+Enter** (Cmd+Enter on a Mac) **queues** the message instead, so the bot reads it once its
  current reply ends. On a phone, or with a mouse, use the small arrow beside Send: **Join the
  running turn** or **Queue for after**. The arrow only shows while a bot that can join is busy.
  (Alt+Enter is not a send shortcut: in the desktop app it toggles full screen.)
- **The default** is in Settings → Bots → *When a bot is busy*. Set it to *Queue for after* and Enter
  queues too; the arrow beside Send can still join.
- **Under your message** a short line says what happened, for each busy bot: "Joined Ada's reply",
  "Queued for after Ada's reply", "Queued: Gemini can't take messages mid-task", or "Queued: Ada was
  between steps" (the bot was starting or retrying a step right then). Nothing is shown when the bot
  was idle. The bot's work after your message is labelled **continued**: it is the same turn, not a
  new one.
- **Stop** stops every running bot in the chat, not only the one you steered. A message that had
  joined a turn but was not answered yet is **not lost**: it is queued and the bot answers it right
  after Stop. The chat says so ("Stopped. Ada will answer your new message next."), and the line
  under your message changes to "Queued: Ada answers this next".
- **Which bots can join:** Claude bots, once the installed Claude CLI is recent enough to report which
  messages it still has queued (the hub checks on the bot's first turn; until then messages queue).
  Codex, OpenCode, Grok and Gemini bots always queue, with the reason shown under your message.
  Messages between bots (hand-offs) always queue. A routine or trigger turn you join keeps its own
  approvals and budget.

### Telegram notifications

Toki can ping your phone through your own Telegram bot when something needs you. It is
**content-free**: Telegram only ever sees a fixed sentence and a link back to your hub, never a
bot, room or tool name and never any message text. Telegram is a cloud service, so assume it can
see that "something happened".

1. **Make a bot.** In Telegram, message **@BotFather**, send `/newbot`, pick a name, and copy the
   token it gives you.
2. **Connect it.** Settings → Notifications → Telegram: paste the token. Toki checks it and
   shows `@yourbot`. The token goes into the encrypted token store and is not shown again.
3. **Link your chat.** Press **Link**, open the bot from the button or the QR code, and send it the
   code shown (valid 10 minutes). Five wrong codes lock linking for a while. It then shows
   "Linked to <your name>".
4. **Turn it on** with **Notify me here** and press **Send a test**. Read the cloud note above the
   switch first.

What the messages say: one fixed line per kind, for example "A bot needs your approval" or "A
workflow needs you", plus a link to your hub. Nothing else.

Good to know: one hub per bot token (two hubs polling one bot fight over its updates). Only the
owner can set this up; bots and paired phones cannot. Phones get their own pings under Devices →
Notifications on this device.

**Revoke.** **Unlink** stops messages to that chat. **Remove token** forgets the bot on this hub.
To kill the token itself, message **@BotFather**, send `/revoke` and pick the bot; the old token
stops working at once. `deploy/keys.sh inventory` lists Telegram among the keys it can disable,
with the same revoke step.

## Make games with Blender and Studio

A game project gives you a team that models in Blender and builds in Roblox Studio while you
watch and steer in chat. This works on a Windows PC hub only. On a server hub, Settings › Game tools
says "Game tools work on the hub that runs on your Windows PC. This hub can't use them.", each item
reads "Not supported here", and **Game team** is disabled.

### Set up: Settings › Game tools

Settings › Game tools lists four things, each with its status in words, its version, and the
button for its next step, if there is one (a crashing Blender has two: **Open log** and **Try again**):

| Item | What it needs | The button |
|---|---|---|
| **Blender** | Blender installed in `C:\Program Files\Blender Foundation\` | **Get Blender** (a link; Toki never installs Blender) |
| **uv** | uv on your PATH, or Toki's own copy | **Install uv**: downloads the pinned uv 0.11.15 for Windows, checks it against a hash built into Toki, and unpacks it into `<data>/tools/uv/0.11.15/`. Your PATH and the registry are not changed. |
| **Blender MCP tools** | `mcp-for-blender` 2.3.1 in `<data>/tools/blender-mcp/2.3.1/` | **Install Blender tools**: installs the pinned package and its pinned dependencies, with hashes, using uv. If the add-on file later differs from what Toki installed, the item says so, and the same button reinstalls it. |
| **Roblox Studio** | Studio installed, its MCP setting on, and Studio open | **Turn on Studio MCP**, only while Studio is closed. It backs up each `%LOCALAPPDATA%\Roblox\AssistantSettings\<id>.json` to `.toki-bak`, turns on only `mcp-server`, and leaves every other setting alone (prompt sharing included). **Open Studio** appears in the desktop app. |

- Downloads and settings changes ask first, in the app.
- No password sign-in is needed. Only you can press these buttons: bots and paired phones cannot.
- Every change writes an audit row naming what it changed (`game_tools.uv_installed`,
  `game_tools.blender_mcp_installed`, `game_tools.studio_mcp_enabled`, `game_tools.blender_reset`).
- Studio items say **Unverified** for now, because Toki's live Studio steps haven't been checked
  with Studio open yet.

### Make a game project

Settings › Projects › new project, **Team: Game team**. Game team stays disabled, and says why, until
Blender and the Blender MCP tools are ready. The template also uses the bot @lead-engineer and the
skill safe-shipping; if either is missing, **Create project** says which. It makes:

- A group chat with a lead (cloned from @lead-engineer), a builder (from @roblox-builder) and an
  artist (from @blender-artist). The two new bots are created with your first game project.
- The project folder `<data>/projects/<slug>/` with `art/`, `exports/`, `studio/` and `places/`, as
  a git repo with a first commit. The files live in Toki's data folder, not in a Roblox folder,
  because Roblox has no single local project folder: places live in the cloud, and `.rbxl` files go
  wherever you save them. In the desktop app, **Open folder** opens the project folder in Explorer.
- Roblox Studio's tools for that chat, when Studio's launcher is on the PC, and Toki's headless
  Blender for that chat.
- The skills blender-loop and studio-loop. Bots look before changing anything, save after each
  change, keep text copies of changed Studio scripts in `studio/`, and play-test before
  `save_place`.

The game chat shows a one-line strip, for example "Blender stopped · Studio not open (unverified)",
with a button for the next step: **Fix in Settings** when something needs fixing, and **Open Studio**
in the desktop app.

### Toki's Blender runs headless

- **It never opens a window.** Toki starts its own Blender with `-b --factory-startup`. It never
  reads or changes your own Blender settings or add-ons.
- **It starts on the first Blender call** in a game chat, and opens the project's
  `art/<slug>.blend`.
- **It stops after 10 minutes with no Blender call,** saving first. It also saves every 5 minutes
  while there are changes.
- **One at a time.** If another Blender is open on the PC (yours, or a render), Toki doesn't start
  one and the item says which.
- **Crashes.** After a crash it starts again on the next call. After more than 3 crashes in 10
  minutes it stops restarting, and Settings › Game tools shows **Open log** and **Try again**.
- **Saving.** Bots save with `toki_save()`, which writes only `art/<slug>.blend`. Blender code that
  uses `bpy.ops.wm.` is refused in every approval mode.

### Look-backs

When a bot calls Blender's `look` or Studio's `screen_capture`, the picture is kept with that tool
step: a thumbnail under the bot's work line, opening full size in the picture viewer. You get one
picture per call, within the usual size limit. Toki takes it from the tool result itself, never from
the Claude CLI's copy in your home folder.

### Approvals follow your setting

Game tools use the approval mode the bot already runs under:

- **Ask (the default):** read tools (for example `get_scene_info`, `look`, `script_read`,
  `screen_capture`) run without a card. Everything else shows the normal approval card, where your
  rules and "Always allow" work. On the card, the script in `execute_blender_code` or `execute_luau`
  reads as code, and an input over 8000 characters is refused.
- **Bypass:** nothing asks, except on routine, trigger and failover turns.
- **Read-only:** writes are refused.

No game tool is blocked. That includes Roblox's `open_cloud_invoke` and generators, and Blender's
`generate_3d` and `generate_gaussian_world`. The last two call paid third-party services and do
nothing unless their keys are set in the add-on.

### What runs as you

Code a bot sends to Blender (Python) or Studio (Luau) runs as you, on this PC. Toki's Blender
listens on a loopback port with no password, so any program on the PC that finds the port can send
it code while it runs. The port changes every start, and Blender stops when idle. Under Ask you see
each write before it runs. Under bypass you don't. Bots on your server can't reach Blender or Studio
at all. Asset searches and Roblox's generators send prompts to those services.

## This PC and your server

The desktop app always runs the hub on this PC, and that is your main host. A server (a VPS with
Toki on it) is optional. It is a second host next to the PC, not a separate mode.

- **Connecting.** The tray's **Open your server** opens an SSH tunnel to it on `127.0.0.1:7790`.
  The PC hub keeps 7788. The app reads the server hub's own token over SSH, so you get no token
  prompt. Losing the tunnel never stops the hub on this PC.
- **Old setups.** A saved "Server over SSH" setup loads as this PC plus that server. The tray's
  **Connection settings** page shows it as "This PC and a server over SSH".
- **One project list.** When the server connects, and every 5 minutes after, the app copies the
  names of its projects to the PC hub. These are names only, at most 500, and nothing is sent to the
  server. Once a server is known, every project shows a tag in words: **This PC** or **Server**.
  Bots never see the server's list.
- **Opening a Server project.** While the server is connected, the window switches to it, and
  **Back to this PC** returns. While it is offline, a prompt says "This project is on your server.
  Connect to open it." with **Connect** and **Cancel**. If connecting fails, the prompt says so, and
  the desktop notification gives the reason. Outside the desktop app (a phone or a browser), the
  prompt says to open it from the desktop app.
- **When the server drops,** the PC hub marks it offline within 30 seconds, keeps the last list,
  and the window comes back to this PC.
- **PC projects never need the server.** When the PC is off, the server keeps running its own bots,
  routines and triggers.
- **Nothing is migrated.** Projects, bots, chats and history stay on the host where they were made.
  Nothing is synced between hosts. Game tools exist only on the PC hub.
- **One subscription.** Both hosts spend from the same Claude subscription. The Usage page says so
  once a server is known.

## Permissions & safety

See [SECURITY.md](../SECURITY.md) for the token model and the full threat model — treat every bot
like a contractor with a shell on your machine, not a sandboxed toy.

**Approvals ask by default.** Bots ask before shell commands, edits outside the workspace, and any
fleet or room change (creating/editing a bot, changing its tool grants, creating/deleting a room).
Approval cards appear inline in chat:

- `Read/Glob/Grep` inside `data/workspace/` or the bot's home: silent. Outside: an approval card.
- `Write/Edit` inside the workspace: auto-accepted. Outside: approval card.
- `Bash`: an allowlist of read-only/build commands runs silently; anything else asks, and
  destructive patterns (`rm -rf`, `git push`, `curl | sh`, …) are flagged red. Absolute paths
  outside the workspace always ask.
- `WebSearch/WebFetch`: silent when enabled for the bot.
- "Allow for this session" adds a permission rule for the rest of that session; unanswered
  approvals time out as a deny after 10 minutes.

Settings → Bots → **Approvals** can switch a bot to **bypass mode** — run every tool call with no
approval cards — a clearly-labelled opt-in with no undo. Server operators can pin the whole hub to
bypass mode with `POCKETROCKET_BYPASS_PERMISSIONS` (see [CONFIGURATION.md](CONFIGURATION.md)).

The hub always requires a bearer token — every run mode, no exceptions. It's minted on first
start, stored in `<data>/hub-token`, and reused on later starts (so restarting the hub doesn't
lock an open window out). It is never written to the hub's logs. The desktop app handles it for you;
anywhere else, paste the file's contents into the prompt the web UI shows, or open
`http://127.0.0.1:7788/#token=<token>`, which the web UI consumes automatically.

Toki has had two internal security reviews; what they changed is under **Security** in
[CHANGELOG.md](../CHANGELOG.md), and [SECURITY.md](../SECURITY.md) has the summary.

## Configuration

Every environment variable, setting, secret, and server-mode env var — with defaults and
precedence — is documented in [CONFIGURATION.md](CONFIGURATION.md).

## Roadmap

Short and honest:

- **More providers.** OpenAI Codex, OpenCode and Grok adapters exist in the codebase behind a
  dev-only flag but aren't offered as a user-facing option in v1 — Claude only, for now.
- **Paid plans**, behind the optional Toki account. Signing in does nothing else yet.
- **Code signing** is still deferred. The desktop app now updates itself (checked at launch and daily, installed
  only when you say so and, on this PC, only once the bots are idle); see Updating in the README.
- **macOS / Linux installers.** Both run from source today; no packaged installer yet.
