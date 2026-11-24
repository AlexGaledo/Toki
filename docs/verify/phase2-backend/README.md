# Phase 2 backend evidence: B7, B8, B9, and the game-tools event

Tasks B7, B8 and B9 from `docs/specs/toki-local-first-gamedev.md`, plus two Phase 1 UI follow-ups: the `game-tools.changed`
WS event and `pnpm ts-strict --update`. Run on 2026-11-24 on the owner's PC: Blender 5.2.2, Roblox Studio installed but
closed. No `blender.exe` or `RobloxStudioBeta.exe` was running before or after. Ports 7788 and 7789 were not touched, and
neither were the desktop app and its data, the PC runner or the VPS. No bot turn ran, so no Claude quota was spent.

| File | What it shows |
|---|---|
| `live-create.txt` | A throwaway hub with the real startup (built-in skills, seed bots) and a fresh data dir: `POST /api/projects {"template":"game"}` and its reply, the folder tree, `.gitignore`, `git log --stat`, `mcp-servers.json` scoped to the new room only, the audit row, the `projects` table (`kind = 'game'` vs a plain control), the events sent, and `TEMPLATE.md` |
| `fail-then-pass.txt` | Each task's new tests failing with its source change reverted and passing with it, then a 24-file targeted sweep (314 tests) |
| `mutations.txt` | 23 guarded lines broken in turn. The first pass caught 21. The 2 survivors (the hub-only check on the new route, and the size check before decoding) got tests in bd45584, and the rerun catches both |
| `scripts/live_phase2.ts` | The live driver. From `packages/hub`: `POCKETROCKET_DATA=<new temp folder> npx tsx ../../docs/verify/phase2-backend/scripts/live_phase2.ts` |
| `scripts/mutations.py` | From `packages/hub`: `python -I ../../docs/verify/phase2-backend/scripts/mutations.py` |

Also run: `tsc --noEmit` for hub and web (both clean), eslint on every changed file (clean), `pnpm ts-strict` (1493 frozen
errors, none new), `node --test scripts/repo-guards.test.mjs` (6/6), and `changelog-guard.mjs` (released sections intact).
Per the RAM rule, only targeted vitest files ran: there was no full `pnpm test` or `pnpm -r build`.

## Notes on the live run

- The data dir was `%LOCALAPPDATA%\Temptoki-phase2-28651`. A lost path separator put it next to `%TEMP%` instead of inside it.
  It was still a new, empty folder, and it was deleted after the run.
- `@lead-engineer` and the `safe-shipping` skill exist on the owner's hub but not on a fresh one, so the driver added
  them first (the bot through `POST /api/bots`). Everything else came from the hub's own startup.
- `setup.studio: "added"` is real detection: the owner's `%LOCALAPPDATA%\Roblox\mcp.bat` exists. The recipe only names it.
  Nothing ran it, and the owner's AssistantSettings were only read (B1), never written.
- The 3.5 s create time is mostly B1's status read, which runs `blender -b --factory-startup --version` once, plus git.

## Not verified here

- **The skills' A/B test** (`docs/project-folders.md`: 3 runs with and 3 without on a trap task) did not run. That is 6 bot
  turns at minimum, over the 2-Haiku-run budget. The unit tests prove only that the skills join the pool at startup and
  state the rules, in order. They do not prove that a bot follows them.
- **A live look-back.** No Blender was running and 2 GB was free at the time, but a live `look` needs Toki's Blender
  (590 MB peak in B12) plus a Claude CLI turn, on a PC whose free RAM is usually under 1 GB. B9 is proven with a fake SDK
  message instead, as allowed. `screen_capture` from Studio is unverified until S2.
- **Studio end to end.** The recipe is written for the new room, but no Studio tool was called (S2).
- **The Blender mount from a live turn.** `blenderTurn.test.ts` shows that the template's room mounts `blender` and another
  room of the same bot does not, using a fake provider. No live turn ran.
