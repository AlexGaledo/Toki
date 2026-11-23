# DMs

Every bot has a one-to-one chat. The user opens it, drafts in the composer, attaches files, picks the model for the chat, and reads the bot's replies streamed into the transcript.

## Sub-features

- `dm-open` opens a bot's DM from the sidebar or the bot page's `Chat` button.
- `dm-compose` drafts text; `Send` enables when the draft is non-empty.
- `dm-send` sends and streams the bot's reply **(turn)**.
- `dm-header` header actions: `Open <Bot>'s page`, `Files`, `Screen`.
- `dm-model` `Model for this chat: <model>` menu.
- `dm-empty` empty state `Nothing here yet` / `Say hi whenever you're ready.`

## How to get to it (user POV)

- Click a bot in the sidebar list.
- On a bot page, `Chat` (accessible name `Open chat with <Bot>`).
- From the Overview's `Bots` region, a bot row.

## Driving it with control-toki

Preconditions:

- Baseline run. The launch page is already the Toki Support DM.

- **Open via bot page.** Run `$C click --role button --name "Open Data Engineer's page"` (from a chat that shows that avatar) then `$C click --role button --name "Open chat with Data Engineer"`. `main` shows `button "Data Engineer"` and `textbox "Message Data Engineer"`.
- **Empty state.** `$C wait --text "Nothing here yet"` passes on a fresh run.
- **Draft.** Run `$C fill --role textbox --name "Message Data Engineer" --value "draft only"`. `button "Send"` is no longer `[disabled]` in `$C snapshot`.
- **Second view.** `$C api GET /api/rooms` lists a room with `"kind": "dm"` and `"name": "Data Engineer"`.
- **Send (turn).** Only with the owner's OK: `$C press --key Enter`, then `$C wait --text "<expected words>" --timeout 120000`. Proof is the transcript snapshot plus `$C api GET /api/rooms/<id>/messages`.
- **Proof.** `$C snapshot --path dms/draft.aria.yml`, `$C screenshot dms/draft.png`.

## Gotchas

- A draft is not a message. Never call a DM "verified" from a filled composer if the change is about sending or replies; that needs a **(turn)**.
- Drafts persist per chat in the browser; a later run in the same profile would see them, but `stop` deletes the profile.
- Bot replies are streamed; wait on the final text, not a fixed sleep.
- The model button reads `Auto` on a fresh run; the list depends on the local Claude login.
