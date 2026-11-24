# Phase 3 UI evidence: D4, Open folder, and the B11 note

This covers task D4 from `docs/specs/toki-local-first-gamedev.md` (Phase 3: one app, two hosts), plus two related web pieces:
- the "Open folder" button on PC projects (the D3 follow-up, using I3's `openfolder` call);
- the B11 `subscriptionNote` on the Usage page.

Owner decision 6 applies: projects stay on their host. A Server project opened while the server is offline asks to connect.

Everything ran on 2026-11-24 on the owner's PC, with about 2.6 GB of RAM free.

| Commit | Task |
|---|---|
| 8cc8868 | D4: host keying and the split, host tags, the Server project prompt, `hosts.changed`, the `project=<slug>` deep link, Back to this PC |
| b3a92ac | Open folder in Settings › Projects (D3 follow-up) |
| 54f4194 | B11 in the web: the shared-subscription note on the Usage page |
| fe19e50 | D4 tests tightened after the first mutation pass |

## How it works

- **The split.** `GET /api/projects` is now a mixed list. The web splits it in one place (`splitProjects` in `lib/hosts.ts`):
  - the store's `projects` holds only this hub's projects;
  - `stubs` holds the server's.

  Every `/api/projects/:slug/*` caller reads `projects`, including Settings cards (lint, members, repos), the overview, the map and the PC move panel. So a stub whose slug clashes with a local project never reaches one of those routes. `api.projects.list()` is typed as the mixed list, so a caller that skips the split does not compile: `PcMovePanel` and `ProjectsSection` were caught that way. Rows are keyed `host:slug`.
- **Tags.** The tags read "This PC" or "Server", as text in a `Badge`. They show once a server is known (at least one stub), and on the server's own page, where that hub's own projects read "Server". A PC with no server shows no tags, which is a judgment call (see Notes).
- **Opening a stub.** `openStubAction` decides:
  - Connected, with the `hosts` cap: `window.open(origin + '/?openproject=server:' + slug, '_blank')`, with no prompt.
  - Offline, with `hosts`: the prompt in the ask phase.
  - No `hosts` cap (outside the desktop app, or an older shell): the prompt in the "elsewhere" phase, which says to open it from the desktop app and has only Close.
- **The prompt** (`components/dialogs/ServerProjectPrompt.tsx`) uses `DialogShell`, `DialogTitle` and `DialogDescription` with `stacked`, so it also opens over Settings. The state machine is `promptStep`:
  - ask → working: Connect makes the same `openproject` call.
  - working → failed: only on `hosts.changed` when the host reads offline. An unrelated re-read, such as `rooms.changed`, does not end it.
  - working stays working while the host reads connected, because the shell is about to navigate the window.
  - failed → working: Try again.

  The failed line reads "Couldn't connect. The desktop notification says why." Connect uses `aria-disabled` while working, not `disabled`, so keyboard focus stays in the dialog. A press while working is a no-op.
- **`hosts.changed`** re-reads the list.
- **The deep link.** `project=<slug>` is taken only if it is a real slug. Once the first list arrives it opens that local project's room, then removes only `project` from the URL. It never matches a stub, and a slug that is not on this hub gets a toast.
- **Back to this PC** shows when `host=server` and `hosts` are on the page (`desktopHost()` in `lib/auth.ts`). It calls `/?openhost=pc`.
- **Open folder** shows when `desktopCan('openfolder')` and calls `/?openfolder=<slug>`. It is only on PC project cards.

## Live run (verify-toki)

The driver was `node scripts/control-toki.mjs` with the root `%TEMP%\toki-verify-p3ui`. It ran a throwaway hub with a temp data dir, Vite and headless Chromium on free ports (hub 470xx). `doctor` passed before the evidence and again at the end, and `stop` closed all three and deleted the data.
- Nothing touched ports 7788 or 7789, the desktop app or its data, or the VPS.
- No bot turn ran, and no Blender or Studio process started.

**Setup through `api`, not the UI:**
- `POST /api/projects` for Wika and Obby Run, each with one existing bot.
- `PUT /api/hosts/server/projects` with the hub token: stubs Obby Run (a slug clash with the local one), Tower Climb and CRM sync, `connected: false`.
- For the deep link, a project with a room: `POST /api/bots` for @lead-engineer, @software-engineer and @quality-engineer (fixtures), `POST /api/skills` for safe-shipping (a fixture), then `POST /api/projects {"name":"Arena","team":true}`.

**Faking the desktop.** The page was loaded with the shell's own query, `goto "/?desktop=1&caps=localcopy,openfolder,hosts,server"`, so `lib/auth.ts` stores those caps exactly as it does in the app. The server page was `?desktop=1&caps=hosts&host=server&project=arena`.

**The desktop calls.** In plain Chromium, a desktop call opens as a new tab of the app; in the shell, those URLs never load. `scripts/tabs.mjs` lists the tabs and closes the call tabs, and its output is the proof of each exact call.

**The shell's failure.** The shell signals a failed connect with `PUT {connected:false}`. The run sent that with `api` while the prompt was working.

| File (all in `d4/`) | What it shows |
|---|---|
| `list-light.*`, `list-dark.*`, `list-light-narrow.*`, `list-dark-narrow.*` | The mixed list in the sidebar. Each row is named in words: `button "Wika This PC"`, `button "Obby Run Server (offline)"`. The local Obby Run and the server Obby Run are two items. The narrow shots are at 390×844 with the drawer open |
| `prompt-ask-light.*`, `prompt-ask-dark.*`, `prompt-ask-dark-narrow.*` | `dialog "Tower Climb"` / `"CRM sync"`: "This project is on your server. Connect to open it." with Cancel and Connect. At 390 px it is the bottom sheet |
| `prompt-cancel-then-enter.aria.yml` | After Cancel, Enter opens the prompt again, so focus went back to the sidebar row. Escape does the same (`actions.jsonl`) |
| `prompt-working-keyboard.aria.yml`, `prompt-working-light.png` | Keyboard only: Tab to Connect, then Enter. The status reads "Connecting to your server…" and Connect reads "Connecting…" (`[disabled]` is how the snapshot shows `aria-disabled`) |
| `connect-call-tabs.txt` | Each Connect made exactly `/?openproject=server:tower-climb` (or `crm-sync`) |
| `prompt-failed-light.*`, `prompt-failed-dark.*` | After `PUT {connected:false}`, `hosts.changed` ended the working state: "Couldn't connect. The desktop notification says why." with Try again |
| `prompt-try-again-keyboard.aria.yml` | Enter on Try again (focus never left Connect) goes back to working |
| `prompt-over-settings.aria.yml` | From Settings › Projects, "Open Obby Run on your server" opens the prompt over Settings. Escape closes only the prompt |
| `prompt-elsewhere.aria.yml`, `prompt-elsewhere-dark.png` | With caps lacking `hosts`, the prompt says "Open it from the desktop app, which can connect to your server." and has only Close |
| `list-connected.aria.yml`, `connected-open-tabs.txt` | With the server connected, the rows have no "(offline)". A click on Obby Run (Server) made `/?openproject=server:obby-run` with no dialog |
| `settings-projects-light.*`, `settings-projects-dark.*`, `settings-*-narrow.*` | Settings › Projects: PC cards with "This PC" and `button "Open the folder of Wika"`; Server cards with "Server", "On your server, which is offline. Last listed …" and "Open … on your server", and no path, members or repos |
| `open-folder-tabs.txt` | Open folder made exactly `/?openfolder=wika` |
| `server-page-deeplink.*` | The server page (`host=server`, `project=arena`): the Arena room is open and the URL is `/?desktop=1&caps=hosts&host=server`, with `project` gone. The page's own projects are tagged "Server", and `button "Back to this PC"` is there |
| `back-to-pc-tabs.txt` | Back to this PC made exactly `/?openhost=pc` |
| `pc-page-no-hosts-cap.aria.yml` | The PC page has no Back to this PC |
| `usage-note-dark.*`, `usage-note-light.*`, `usage-note-light-narrow.*` | Usage shows "Your PC and your server both spend from the same Claude subscription, …" under Plan limits. The `api GET /api/usage` call in `actions.jsonl` carries the same `subscriptionNote` |
| `api-projects-final.json` | A read-only second view: `GET /api/projects` at the end, with 3 `pc` and 3 `server` rows |

Two small visual edits came after some shots. `prompt-ask-light.png` shows a 12 px gap above the empty status line, which was removed before the later prompt shots. `usage-note-dark.png` shows the note one size larger than the final `text-hint`. The ARIA snapshots are unaffected.

## Logic proofs

- **`fail-then-pass.txt`** (`bash docs/verify/phase3-ui/scripts/fail_then_pass.sh 8cc8868 b3a92ac 54f4194`).
  - With 8cc8868's source put back, 18 of its 20 tests fail. Some fail only as "module missing", which is why the mutation pass exists.
  - With b3a92ac's source put back, the Open folder test fails.
  - 54f4194 (the usage note) has no unit test. It is UI only, proven by the usage shots above, so the script ran the whole suite twice, and both runs passed.
- **`mutations.txt`** (`python -I ../../docs/verify/phase3-ui/scripts/mutations.py` from `packages/web`). It covers the host keying, the slug clash, never calling slug routes for a stub, the cap gating, the exact calls, the prompt state machine, `hosts.changed`, the deep link, Open folder and `desktopHost`.
  - The first pass caught 16 of 19. The three survivors were the `openproject` encoding, Connect without the hosts-cap check, and `desktopHost` without the desktop-mode check.
  - fe19e50 added a test for each, and the rerun caught 19 of 19.
- **`checks.txt`:**
  - `pnpm lint` is clean.
  - `pnpm ts-strict`: 1493 frozen, none new.
  - contrast, token-parity and repo-guards: 14 of 14.
  - The bundle budget: 928,541 bytes against 1,320,000.
  - `tsc --noEmit` for web.
  - The whole web vitest suite: 54 files, 421 tests.
  - No full `pnpm test` and no `pnpm -r build`, because of the RAM rule.

## Notes

- **Tags only once a server is known.** The spec says the list shows PC projects tagged "This PC" and stubs tagged "Server". With no server there is nothing to tell apart, so no tags show. Showing "This PC" always is a one-line change in `showHostTags`.
- **Reduced motion.** No new motion. The prompt uses `DialogShell`'s existing open and close, which `index.css` already turns into a plain fade under `prefers-reduced-motion`.
- **Contrast.** No new tokens. The tags are `Badge` (muted), and the failed line is `text-bad`, as elsewhere, both covered by `contrast.test.mjs`.
- **Not verified here (needs the installed app and the real server, by rule):**
  - the shell taking the three calls;
  - the real navigation to the server page with `project=<slug>`;
  - the desktop notification's reason;
  - D4's three manual checks from the spec: a PC project offline opens, a Server project offline prompts, and Connect opens it.

  The infra README's "Verify on the owner's machine" list covers them.
- **For pr-backend.** An optional fixed-word `error` on `PUT /api/hosts/:host/projects` would let the prompt show the reason instead of pointing at the notification. The infra README raised the same follow-up.
- **For pr-infra.** The working state has no timeout: it ends only on `hosts.changed` with `connected: false`, or on navigation. If the shell ever fails without sending that PUT, the prompt stays at "Connecting…" until Cancel.
- **Paths in evidence.** `actions.jsonl` and `api-projects-final.json` hold the temp run's absolute paths, which include the Windows user folder, as in earlier phases. The UI masks them as `~`.
