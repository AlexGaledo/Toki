---
name: verify-toki
description: "Launch a throwaway local Toki (hub + web UI + headless Chromium), drive the web UI the way a user does with scripts/control-toki.mjs, and capture evidence (ARIA snapshot + screenshot + read-only API view). Use to prove a UI or hub change works before calling it done, to reproduce a UI bug, or for a regression sweep of the feature map."
---

# Verify Toki

Review is evidence. This skill starts a private copy of Toki on free loopback ports with an empty data dir under the OS temp folder, drives it through the real UI, and keeps proof that outlives the run.

Pattern adapted from Lauren Tan's pstack `create-verification-skill` (MIT © Lauren Tan, https://github.com/cursor/plugins/tree/main/pstack). The driver and wording are written for this repo.

Driver: `node scripts/control-toki.mjs --help` (canonical command list). Every command below runs from the repo root.

## Launch

```bash
pnpm install                                   # once per checkout
node scripts/control-toki.mjs launch           # ~60 s: hub (tsx), vite dev server, headless Chromium
```

What `launch` does, so you never have to:

- Run root `<os.tmpdir()>/toki-verify-<hash of this checkout>/`, with `run/data` (POCKETROCKET_DATA), `run/profile` (browser), `logs/`, `evidence/<launch timestamp>/`. It refuses a root outside the temp folder or overlapping `<repo>/data`.
- Strips inherited `POCKETROCKET_*`, `PORT`, `HUB_URL`, `SCREEN_URL` and `DOTENV_*`, and points dotenv at a missing file, so neither a shell export nor a `.env` can aim the run at real data or a VPS.
- Picks 4 free ports (hub, workspace-web, vite, CDP), never 7788/7789/5173/9222. Generates the hub token; it lives only in `state.json` and the tab's sessionStorage. It is never printed.
- Marks first-run setup done (`PUT /api/settings {onboarded:true, userName:"Verifier"}`) and **pauses the seeded "Nightly workspace check" routine**, so the throwaway hub never spends Claude quota by itself. `--onboarding` keeps the setup wizard (to test onboarding). `--keep-routines` keeps routines on.
- Opens the app with `#token=` once (lib/auth.ts moves it to sessionStorage and strips the hash).

**Ready means usable**, not "a port answers": launch returns only after `/api/health` is 200, vite serves `<div id="root">`, the tab has no sign-in dialog and no "Connecting to the hub" card, and the sidebar's `New` button is visible. It prints `ready url=... title="Toki"`.

Options: `--web dist` serves the built UI from the hub instead of vite (run `pnpm --filter @pocketrocket/web build` first); `--headed` shows the window; `--browser <exe>` picks a Chromium.

Browser: the driver uses the repo's own playwright-core (hub → `@playwright/mcp` → `playwright-core`) only to connect over CDP. It runs, in order: `--browser`, `TOKI_VERIFY_BROWSER`, playwright's pinned Chromium, the newest `ms-playwright/chromium-*`, then system Chrome or Edge. If none: `node scripts/control-toki.mjs install-browser`.

## Doctor

```bash
node scripts/control-toki.mjs doctor     # read-only, exit 1 on any FAIL
```

Checks: run root is throwaway; hub/web/browser pids alive; `/api/health` 200 (version, provider, claude exe); `GET /api/settings` without the token is 401; `hub.log`'s start line shows **our data dir on our port** (proves the port is ours, not a dev hub); vite serves the app and proxies `/api` to our hub; CDP answers; the tab is on the app and signed in. Run it first whenever anything looks off, and before any evidence you intend to hand in.

`status` prints the state file (token shown as `<set>`).

## Drive

Stable handles only: ARIA role + accessible name, exactly as `snapshot` prints them. No CSS selectors, no coordinates.

```bash
C="node scripts/control-toki.mjs"
$C snapshot                                            # ARIA tree of the page, saved to evidence and printed
$C click --role button --name "New" --exact            # sidebar "New" menu
$C click --role menuitem --name "New group chat"
$C fill  --role textbox --name "Group chat name" --value "verify-run"
$C click --role button --name "Add Data Engineer"
$C click --role button --name "Create" --exact
$C click --role button --name "New" --exact --in tabpanel:Skills   # --in role:name scopes a lookup
$C click --role tab --name "Skills" --nth 0             # --nth picks among several matches
$C click --text "Other apps" --exact                   # only for controls with no role (a <details> summary)
$C press --key Escape
$C wait  --role dialog --name "Settings" [--gone] [--timeout 15000]
$C wait  --text "All caught up"
$C goto  /                                             # same origin; the token stays in the tab
$C api   GET /api/rooms                                # authenticated, secrets in output redacted
$C api   PATCH /api/routines/<id> '{"enabled":false}'
```

Every `click`/`press`/`goto` prints the resulting state (url, title, open dialogs). Every command, including a failed one, appends to `evidence/<ts>/actions.jsonl`.

An example run (2026-11-24) is in `docs/verify/`: bot created → its page, group chat created, phone paired.

Shell: from Git Bash a leading-slash argument (`/api/rooms`, `/`) gets rewritten by MSYS; the driver undoes that. Quote names with spaces.

The per-feature recipes are in [`features/`](features/README.md). Read the feature file before driving it; walk `features/README.md` top to bottom for a regression sweep.

## Evidence

A proof a skeptical reviewer accepts has three parts, per claim:

1. **The action**, through the real user path (UI clicks/typing, not `api` writes or internal setters). `actions.jsonl` records it.
2. **The resulting state** in the UI: `snapshot --path <feature>/<step>.aria.yml` **and** `screenshot <feature>/<step>.png`. The ARIA file is the assertion; the PNG is for humans.
3. **A read-only second view** of the side effect: `api GET ...` (the row exists, the file is on disk, the device is listed), or a reload/switch-away round trip (`goto /`, reopen) that shows it persisted.

Rules:

- Relative `--path`/screenshot paths land in `<root>/evidence/<launch timestamp>/`. Name them by feature and step.
- Cover the entry points, empty/cancel/error paths the change touches, not one convenient path. "A gap does not count as a pass": report an unreachable step as BLOCKED with the command and the unmet precondition, never verify it through another path.
- `api` writes are for setup or for things no UI path reaches (say so in the report). They never count as the proof of a UI change.
- Never hand in evidence from a run whose `doctor` fails, or from the dev hub on 7788.
- For a PR, copy 1-3 small PNGs into the PR (or `docs/verify/`) and summarize what each proves.

## Cleanup

```bash
node scripts/control-toki.mjs stop          # --keep-data keeps run/ for a post-mortem
```

**Kill what you started.** `stop` asks the hub to shut down (`POST /api/maintenance/stop`), closes Chromium over CDP, then `taskkill /T` (Windows) or the process group (POSIX) only for the pids in `state.json`, and only while that pid's port still answers (a dead service's pid may have been reused). It never kills by process name. It deletes `run/` (data + browser profile) and `state.json`, and **keeps `evidence/` and `logs/`**. If a process is still exiting it says `STILL RUNNING`, keeps `state.json`, and exits 1: wait a few seconds and run `stop` again. After stop, confirm the evidence path it printed still has your files.

Run `stop` after every failed attempt too, so broken runs do not strand ports and processes.

## Gotchas

- **Quota.** The hub uses the machine's real `claude.exe` login. Sending any chat message, pressing `Run ... now`, or turning on Training/skill suggestions starts a real bot turn and spends the owner's Claude quota. Do not do it unless the owner said yes for this run. Everything in the feature map is marked where it needs a turn.
- **Approval cards** only appear during a live bot turn (see `features/approvals.md`). Without the owner's OK, verify the permission menu and the empty Needs you state, and report the card itself as BLOCKED.
- **Pointer lock after the sidebar `New` menu's dialogs** (found 2026-11-24, reproduced 3 times): after `New group chat` › `Create` or `New bot` › `Create bot`, the dialog closes but `body` keeps `pointer-events: none`, so every later `click` times out with "`<html>` intercepts pointer events". `goto /` clears it. That is an app bug, not a driver bug; do not paper over it in a proof of those flows.
- **Pages cover the chat.** A bot page, Automations, Needs you and Usage render over the chat pane; the composer underneath is still in the ARIA tree but not clickable. Click `Back to chat` first.
- **Ambiguous names.** `New` exists in the sidebar and on several panels; `Pair a phone` exists in the sidebar and in Settings › Devices. Use `--exact` plus `--in <role>:<name>` or `--nth`.
- **Not a clean machine.** The throwaway hub still reads this machine's `~/.claude/skills` (Skills › `Import (N)`) and finds the local `claude.exe`. Counts there vary per machine; assert presence, not numbers.
- **Triggers and Connections** need a real GitHub/Google sign-in (OAuth in the system browser). In a throwaway run only the "Connect an app in Connections first." state is reachable.
- **Viewport.** Headless window 1400×900 gives a ~1380×750 page with sidebar, chat and Overview inline. Narrower windows fold panes and change what is clickable.
- **Chromium on Windows** can take 10+ s to exit after `taskkill /F`; `stop` closes it over CDP first and waits.
- **Launch is slow the first time** (vite optimizes deps, tsx compiles the hub): about a minute. Do not lower the timeouts to make it "pass".
- `--onboarding` runs leave the setup wizard over the app; `New` is not visible until it is finished, so launch only waits for sign-in in that mode.
