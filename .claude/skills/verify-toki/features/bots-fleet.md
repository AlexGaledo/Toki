# Bots and fleet

A user creates bots from the sidebar, opens a bot's page to see and edit it, and sees every bot at a glance in the sidebar list, the podium and the Overview's Bots region.

## Sub-features

- `bot-create` creates a bot from the `New bot` dialog (presets or by hand).
- `bot-open` opens a bot's page (Memory, Skills, Automations, Computer tabs).
- `bot-edit` changes a bot's name, title, model or tools from its settings.
- `bot-delete` deletes a bot after a confirm.
- `bot-list` shows every bot in the sidebar list, the podium (`Add bot` slots) and the Overview's `Bots` region with status.
- `bot-import` imports a bot file (`Import a bot...`).

## How to get to it (user POV)

- Sidebar `New` › `New bot`; sidebar `New` › `Import a bot...`.
- A podium slot `Add bot` in the sidebar.
- A bot's avatar in a chat header (`Open <Bot>'s page`), or a bot row in the Overview's `Bots` region.
- On a bot page, `<Bot> settings` opens the edit dialog.

## Driving it with control-toki

Preconditions:

- Baseline run; no bot named `Verify Bot`.

- **Open the dialog.** Choose `New` › `New bot`. Run `$C click --role button --name New --exact` then `$C click --role menuitem --name "New bot"`. A dialog `New bot` opens with a `Name` field focused.
- **Fill it.** Run `$C fill --role textbox --name Name --exact --in "dialog:New bot" --value "Verify Bot"`. The handle fills itself (`verify-bot`); `Create bot` becomes enabled.
- **Create.** Run `$C click --role button --name "Create bot"`. The dialog closes and the new bot's DM opens: `main` shows `button "Verify Bot"` and `textbox "Message Verify Bot"`; the sidebar list has `Verify Bot · Idle Verify Bot @verify-bot`.
- **Second view.** Run `$C api GET /api/bots`. The array has an entry with `"handle": "verify-bot"`.
- **Open its page.** Run `$C goto /` (clears the pointer lock below), `$C click --role button --name "Verify Bot · Idle Verify Bot @verify-bot"`, `$C click --role button --name "Open Verify Bot's page"`. A `heading "Verify Bot"` level 1 and a `tablist` with `Memory`, `Skills`, `Automations`, `Computer`.
- **Seeded fleet.** On a fresh run, `$C snapshot` lists `Toki Support` and `Data Engineer` in the sidebar and `region "Bots"` in the Overview.
- **Proof.** `$C snapshot --path bots/created.aria.yml` and `$C screenshot bots/created.png`.

## Gotchas

- **Known bug (2026-11-24):** after `Create bot`, `body` keeps `pointer-events: none` and every later click times out ("`<html>` intercepts pointer events"). Same bug as `New group chat` (both dialogs open from the sidebar `New` menu). `goto /` recovers; report it in any proof of this flow.
- The `Name` label also matches other fields in some dialogs; scope with `--in "dialog:New bot"`.
- Bot pages cover the chat. Use `Back to chat` before typing in the composer.
- The Overview's `Bots` region counts bots that have a chat with activity, not every bot; on a fresh run it shows fewer than the sidebar.
- Creating a bot does not start a turn. Sending it a message does **(turn)**.
- `Edit podium` and the podium `Add bot` slots are a layout feature; an empty podium is the normal fresh state.
