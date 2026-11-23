# Skills

Skills are shared instructions bots can load. On a bot's Skills tab the user creates a skill, assigns it to that bot, imports skills from this computer or a git repo, deletes one for all bots, and opts in to suggested fixes.

## Sub-features

- `skill-create` creates a skill (name, description, instructions).
- `skill-assign` assigns or unassigns a skill for this bot (`Assign <skill> to this bot`).
- `skill-import` imports from this computer (`Import (N)`) or `From git`.
- `skill-delete` `Delete for all bots`.
- `skill-suggest` `Suggest skill fixes after runs` switch with an `Every` N runs picker **(turn when it fires)**.
- `skill-pending` an imported or suggested skill waits for approval and shows in Needs you.

## How to get to it (user POV)

- Bot page › `Skills` tab.
- Needs you lists skills that wait for approval.

## Driving it with control-toki

Preconditions:

- Baseline run; on Data Engineer's page (`$C click --role button --name "Open Data Engineer's page"` from its DM).

- **Open tab.** `$C click --role tab --name Skills`. `tabpanel "Skills"` reads `Skills 0 assigned to this bot` and lists `project-map`.
- **New form.** `$C click --role button --name New --exact --in tabpanel:Skills`. Textboxes `name-like-this`, `description: when to use it`, `Instructions (markdown)` and a disabled `Create`.
- **Fill.** `$C fill --role textbox --name name-like-this --value verify-evidence`, `$C fill --role textbox --name "description: when to use it" --value "Use when proving a change"`, `$C fill --role textbox --name "Instructions (markdown)" --value "Capture ARIA and a screenshot."`.
- **Create.** `$C click --role button --name Create --exact --in tabpanel:Skills`. The list gains `checkbox "Assign verify-evidence to this bot"`.
- **Assign.** `$C click --role checkbox --name "Assign verify-evidence to this bot"`; the header reads `1 assigned to this bot`.
- **Second view.** `$C api GET /api/skills` contains `verify-evidence`; `$C api GET /api/bots/<botId>/skills` lists it after assigning.
- **Proof.** `$C snapshot --path skills/created.aria.yml`, `$C screenshot skills/created.png`.

## Gotchas

- `New` also matches the sidebar button: always `--exact --in tabpanel:Skills`.
- `Import (N)` counts skills in this machine's `~/.claude/skills`; N differs per machine. Importing copies into the throwaway data dir only.
- Skill names must look like `name-like-this`; `Create` stays disabled otherwise.
- Turning on `Suggest skill fixes after runs` spends quota after runs; leave it off.
