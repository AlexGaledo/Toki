# Triggers and automations

Automations run bots without a message: schedules (cron or once), triggers fired by outside events from a connected app, and workflows that chain bot steps with the user's approval between them.

## Sub-features

- `auto-page` the Automations page across all bots (`Schedules`, `Triggers`, `Workflows`).
- `auto-schedule` schedules: enable switch, `Run <name> now` **(turn)**, `Run history for <name>`, `Delete <name>`.
- `auto-trigger` triggers: `New` (needs a connected app), form fields `Trigger name`, `Source`, `Bot`, `Chat`, `Prompt`, `Insert an event field`.
- `auto-workflow` `New workflow`; empty `No workflows. Chain bot steps with your approval in between.`
- `auto-bot` a bot page's `Automations` tab shows the same sections for that bot.

## How to get to it (user POV)

- Profile menu (`Menu for <user>. Online`) › `Automations`.
- Bot page › `Automations` tab.

## Driving it with control-toki

Preconditions:

- Baseline run (the seeded schedule exists and is paused by launch).

- **Open.** `$C click --role button --name "Menu for Verifier. Online"`, `$C click --role menuitem --name Automations`. `heading "Automations"` level 1, `Schedules, triggers, all bots`.
- **Schedule row.** The list has `checkbox "Schedule Nightly workspace check enabled"` (unchecked after launch) and its `Run ... now`, `Run history for ...`, `Delete ...` buttons.
- **Toggle (no turn).** `$C click --role checkbox --name "Schedule Nightly workspace check enabled"` then again to turn it back off. Second view: `$C api GET /api/routines` shows `"enabled"` flipping. Leave it disabled.
- **Triggers gated.** With no connection, the Triggers `New` is `[disabled]` and the page says `Connect an app in Connections first.`
- **Workflows empty.** `list "Workflows"` reads `No workflows. Chain bot steps with your approval in between.`
- **Proof.** `$C snapshot --path automations/page.aria.yml`, `$C screenshot automations/page.png`.

## Gotchas

- `Run <name> now` starts a real turn **(turn)**. Leaving a schedule enabled overnight does too: launch pauses them; do not re-enable and walk away.
- Triggers need a GitHub/Google connection (real OAuth). In a throwaway run, `auto-trigger` beyond the gated state is BLOCKED.
- `New` on this page is ambiguous with the sidebar `New`; scope or use `--nth`.
- Times show in the settings time zone (`Schedules times in <zone>`).
