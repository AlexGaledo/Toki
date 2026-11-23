# Toki verification map

The maintained list of what a Toki user can do in the web UI, and how to prove each one with `scripts/control-toki.mjs`. Read this index before driving the app; use the matching feature file as the recipe. Names below are the accessible names the UI renders (what `snapshot` prints), so "the thing in the left sidebar" has one shared name.

## Baseline preconditions

- A run started by this checkout: `node scripts/control-toki.mjs launch`, and `doctor` passes. Never drive the dev hub on 7788 or a VPS.
- Fresh data dir: two seeded bots, **Toki Support** (`@pocketrocket-support`) and **Data Engineer** (`@data-engineer`), a DM with each, the seeded "Nightly workspace check" routine **paused** by launch, the user name **Verifier**, approvals mode **Approval**.
- The page starts on the Toki Support DM with the sidebar (`complementary`), the chat (`main`) and the Overview (`complementary "Overview"`) inline.

## Driving conventions

- `C="node scripts/control-toki.mjs"` in every recipe.
- Role + accessible name only. Use `--exact`, `--in <role>:<name>` or `--nth` when a name repeats.
- Start each recipe from the baseline (`goto /`). Close covering pages with `Back to chat` and dialogs with `Escape` or `Close`.
- A step marked **(turn)** starts a real bot turn on the machine's Claude login. Skip it and report BLOCKED unless the owner approved spending quota for this run.

## Proof and skip reporting

- Per claim: the action, the resulting UI state (`snapshot --path <feature>/<step>.aria.yml` + `screenshot <feature>/<step>.png`), and a read-only second view (`api GET ...` or a `goto /` round trip).
- Record the feature file and entry point used with each artifact (`actions.jsonl` does this for commands).
- Report an unreachable path as BLOCKED with the attempted command and the unmet precondition. Do not report it verified through a different path.
- Report PASS / ISSUES / BLOCKED per feature. A gap is not a pass.

## Feature entry contract

Each feature file: an H1, one paragraph of user-visible behavior, then exactly four H2s in this order: `Sub-features`, `How to get to it (user POV)`, `Driving it with control-toki` (starts with `Preconditions:`, then labeled bullets pairing a user action, the exact command and the observable result), `Gotchas`. Keep implementation details out; name user paths, stable handles, required state, commands, proof.

## Features (regression order)

Walk top to bottom for a sweep. Earlier features create what later ones use.

1. [Bots and fleet](./bots-fleet.md): create, open, edit bots; the Bots list, podium and Overview.
2. [DMs](./dms.md): one-to-one chat with a bot, composer, header actions.
3. [Rooms and chat](./rooms-chat.md): group chats, members, coordinator, room settings.
4. [Files panel](./files.md): a chat's folder, new folder, upload, views.
5. [Skills](./skills.md): a bot's Skills tab, create, assign, import.
6. [Approval cards](./approvals.md): permission level, approval cards, Needs you.
7. [Triggers and automations](./triggers.md): schedules, triggers, workflows.
8. [Settings › Connections](./connections.md): GitHub, Google, other apps.
9. [Devices and pairing](./devices.md): pair a phone, paired devices, revoke.
