# Phase 3 backend evidence: B10, B11, seed on demand, hub dir

These are tasks B10 and B11 from `docs/specs/toki-local-first-gamedev.md` (Phase 3: one app, two hosts), plus two backend fixes. Owner decision 6 applies: nothing is migrated, and each project is tagged with its host.

All runs were on 2026-11-24 on the owner's PC, with under 2 GB of RAM free.
- Nothing touched ports 7788 or 7789, the desktop app or its data, the PC runner, or the VPS.
- Nothing was read from the real VPS. The server's project list is a fixture.
- No Blender or Studio process started, and no bot turn ran.

| Commit | Task |
|---|---|
| ca43f26 | Fix 2: `resolveHubDir` finds the hub by `package.json`, so a vitest cache in `src/node_modules/.vite` no longer makes `src` the hub dir |
| 4a8ed9f | Fix 1: @roblox-builder and @blender-artist are made by the first game project, not at startup |
| 5c06ec3 | B10: `PUT /api/hosts/:host/projects`, host tags in `GET /api/projects`, `hosts.changed`, migration 331 |
| 1847740 | B11: `subscriptionNote` in `GET /api/usage` once a server host is known |
| 113bb0c | B11 test tightened after the fail-then-pass run |

| File | What it shows |
|---|---|
| `fail-then-pass.txt` | For each commit, its hub and shared source goes back to the parent and its tests run. They fail without the change and pass with it. B10 fails only as "module missing", which is why the mutation pass exists. B11's route test passed without the change, so it was tightened (113bb0c), and the rerun is at the end of the file. |
| `mutations.txt` | **Partial.** 12 of 27 mutants ran and all 12 were caught: every handler auth, host and method check, and every schema rule (500 cap, slug, name, control/bidi characters, strict keys, `connected` required). The Claude Code harness stopped the run for low system memory during mutant 13. The file it had mutated was restored from git and the tree checked clean. Mutants 13 to 27 did not run: replace, transaction, event, GET merge, the three bot-leak mutants, B11, seed and hub dir. |
| `live-stubs.txt` | A throwaway hub: real startup with `seedBots: true` and a temp data dir, deleted afterwards. See the summary below. |
| `checks.txt` | tsc for hub and web, eslint, ts-strict, repo-guards, and the targeted vitest runs |
| `scripts/` | `fail_then_pass.sh <commits>` from the repo root. `mutations.py` and `live_phase3.ts` from `packages/hub` (see each file's header) |

What `live-stubs.txt` shows:
- The bots after startup, with no game bots among them.
- `GET /api/usage` without the note, then a local project, then `PUT` of 3 fixture stubs.
- `GET /api/projects`: the local project tagged `pc`, followed by 3 stubs tagged `server`.
- `PUT {"connected":false}` keeps the stubs, and the usage note now shows.
- The refusals: 403 for a paired-device token (on both PUT and GET), 401 for a bot's MCP bearer, and 400 for 501 stubs, for a bidi-override name and for host `pc`. The stubs are unchanged after them.
- The SQLite rows and the events that were sent.

## Notes

- The bot-facing proof is `agent/stubsNeverReachBots.test.ts`, in two parts:
  - **A recorded turn.** It covers a project room and the persona, which may read every project, in both the project room and its DM. The stubs share the hub's DB, one stub slug clashes with a local project, and a folder with the stub's slug exists on disk. No stub name or slug appears in the system prompt, the input, any hub tool's name or description, or the output of every read-only hub tool. That includes `search_project_context`, queried with the stub's name. Neither `projectDirs` nor `readOnlyDirs` holds the stub's folder, and the project folder guard refuses `Read` and `Bash` on it.
  - **An architecture test.** Only `hub.ts` and `api/projects.ts` may import `RemoteProjects` or name its tables.
- `DEVICE_ALLOW` is unchanged and its snapshot test passes. Neither `/api/hosts/...` nor `/api/projects` is open to a paired device.
- The four new files were committed as CRLF by a Python text-mode write. The three task commits were rebuilt with LF before anything was pushed, and their contents are otherwise identical (`git diff --ignore-space-at-eol` is empty). Every run in this folder used the rebuilt hashes.
