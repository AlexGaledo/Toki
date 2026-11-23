# Rooms and chat

A group chat holds up to 20 bots. The user names it, picks members and a coordinator (who answers messages with no @mention), then chats with the room and @mentions bots.

## Sub-features

- `room-create` creates a group chat from `New group chat`.
- `room-members` adds and removes bots; the counter reads `<n>/20`.
- `room-coordinator` picks the coordinator or `Automatic (a lead, else the first bot)`.
- `room-details` edits or deletes the room from `Group details`.
- `room-composer` composes to the room (`Message #<room>`), with `@` mentions.
- `room-send` sends to the room; the coordinator or the mentioned bot replies **(turn)**.

## How to get to it (user POV)

- Sidebar `New` › `New group chat`.
- In a group chat's header, `Group details`.
- The sidebar `Rooms` section lists each group; each has `<room> settings`.

## Driving it with control-toki

Preconditions:

- Baseline run; no room named `verify-run`.

- **Open the dialog.** Run `$C click --role button --name New --exact` and `$C click --role menuitem --name "New group chat"`. `dialog "New group chat"`; `list "Bots in this chat"` says `Add at least one bot.`
- **Name and members.** Run `$C fill --role textbox --name "Group chat name" --value verify-run`, `$C click --role button --name "Add Toki Support"`, `$C click --role button --name "Add Data Engineer"`. The counter reads `2/20` and each member row has `Remove <Bot>`.
- **Coordinator.** `combobox "Coordinator"` offers `Automatic (a lead, else the first bot)` and each member.
- **Create.** Run `$C click --role button --name Create --exact`. The dialog closes; `main` shows `button "verify-run"`, a `coordinator @<handle>` badge and `textbox "Message #verify-run"`.
- **Second view.** `$C api GET /api/rooms` has `"kind": "group"`, `"name": "verify-run"` with both bot ids in `memberIds`.
- **Persistence.** `$C goto /` then click `verify-run` in the sidebar `Rooms` section; same header.
- **Proof.** `$C snapshot --path rooms/created.aria.yml`, `$C screenshot rooms/created.png`.

## Gotchas

- **Known bug (2026-11-24):** after `Create`, `body` keeps `pointer-events: none`; the next `click` fails with "`<html>` intercepts pointer events". `goto /` recovers. Report it in a group-flow proof; do not hide it.
- `Create` matches more than one button on some screens; always pass `--exact`.
- A one-bot room is allowed; the dialog notes it.
- Sending to the room is a **(turn)** for the coordinator, and for every @mentioned bot.
