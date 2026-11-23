# Approval cards

When approvals are on, a bot that wants to run a risky tool (shell, writes outside its folder, outside MCP tools, a PC job) pauses and posts an approval card in the chat. The user answers on the card, in Needs you, or in the Overview; answers can become rules.

## Sub-features

- `approval-level` `Permission level for all bots: <level>` menu in the composer: `Read only`, `Approval`, `Full permission`.
- `approval-card` card titled `Needs your OK` or `Risky action needs your OK`, with the tool name, reason and input **(turn)**.
- `approval-answer` `Allow once`, `Always allow…`, `Deny`; outcome label `Allowed once`, `Allowed for that session`, `Denied`, `Timed out, denied`, `Expired after restart. Ask the bot to retry.` **(turn)**.
- `approval-handoff` hand-off cards `Pass this to another bot?` with `Send it` / `Keep it here` **(turn)**.
- `approval-inbox` Needs you page and the Overview `Needs you` region list pending cards; empty state `All caught up`.
- `approval-rules` saved rules are listed and revoked in Settings › Bots.

## How to get to it (user POV)

- The chat where the bot asked.
- Sidebar `Needs you`; the Overview's `Needs you` region.
- Composer `Permission level for all bots: ...`.

## Driving it with control-toki

Preconditions:

- Baseline run (approvals mode `Approval`).
- For card steps: the owner approved spending one small turn.

- **Empty inbox.** `$C click --role button --name "Needs you" --exact`. `heading "Needs you"` level 1 and `heading "All caught up"`. `Back to chat` after.
- **Level menu.** `$C click --role button --name "Permission level for all bots: Approval"`. `menu "Permission level for all bots: Approval"` says `Applies to all bots and chats` and has `menuitemradio` `Read only Bots look around. Every write is refused.`, `Approval Risky actions show a card first.` `[checked]`, `Full permission No cards. Bots run everything.` `Escape` closes without changing.
- **Second view.** `$C api GET /api/settings` shows `"approvals": "ask"` (or the current mode).
- **Raise a card (turn).** In a Data Engineer DM: `$C fill --role textbox --name "Message Data Engineer" --value "Use Bash to run: echo verify > verify.txt"`, `$C press --key Enter`, `$C wait --text "Needs your OK" --timeout 120000`.
- **Answer (turn).** `$C click --role button --name "Allow once"`. The card's outcome reads `Allowed once`; the Overview's `Needs you` empties.
- **Second view (turn).** `$C api GET /api/rooms/<roomId>/files` lists `verify.txt`.
- **Proof.** `$C snapshot --path approvals/<step>.aria.yml`, `$C screenshot approvals/<step>.png` at the pending card and after the answer.

## Gotchas

- No turn, no card: without the owner's OK, report `approval-card`, `approval-answer`, `approval-handoff` as BLOCKED (needs a live turn). Do not fake a card through the API.
- Cards left open when the hub restarts become `Expired after restart`.
- The permission button sits under covering pages (bot page, Needs you): click `Back to chat` first or the click times out.
- A paired phone cannot use `Always allow…` (`Always allow is desktop only.`).
- Changing the level writes the real setting for every bot in this run; set it back or restart the run.
