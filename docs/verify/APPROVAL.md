# Approval ledger: local-first Toki with Blender and Roblox Studio

The owner's goal: "iteratively develop games inside toki while it being connected to roblox studio and blender", with
no setup, "mainly connected to local computer then optional vps." Spec: `docs/specs/toki-local-first-gamedev.md`.
Branch: `feat/gamedev-tools`. Ledger written 2026-11-24 from the evidence READMEs in this folder.

**Proof types**

| Type | Meaning |
|---|---|
| fail-then-pass | The task's tests fail with its source change reverted, and pass with it. |
| mutation | Guarded lines are broken one at a time, and the tests catch each one. |
| verify-toki | A throwaway Toki driven through its UI (`scripts/control-toki.mjs`), with screenshots and ARIA snapshots. |
| live | Real processes on the owner's PC: Blender, uv, installs, or hub routes. |

**Status**

| Status | Meaning |
|---|---|
| approved | The acceptance criteria are proven by the evidence. |
| approved with gaps | Proven except for the items listed in "Still to verify live" or "Unfinished proofs". |
| not done | No proof yet. |

| Task | What | Commit(s) | Proof type | Evidence | Status |
|---|---|---|---|---|---|
| S1 | Spike: game tools on the owner's PC | 0840b6f | live | `docs/verify/game-tools-spike.md`, `game-tools-spike/` | approved |
| S2 | Studio steps with Studio open | none | none | none | not done |
| B1 | Detection (Blender, uv, Blender MCP tools, Studio) | fcbe5d8 | fail-then-pass, mutation, live | `phase1-backend/` (`live-status.txt`, `mutations.txt`, `fail-then-pass.txt`) | approved with gaps (the Studio "open" state was not seen) |
| B2 | Game tools routes, hub token only, audited | e632778, daa692e | fail-then-pass, mutation, live | `phase1-backend/` | approved |
| B3 | `approve: 'mode'`, `readTools` without a card under ask, `bpy.ops.wm.` refusal | 3f874e9, d3f3517 (read-only fix), 28517d0 | fail-then-pass, mutation, verify-toki | `b12/fail-then-pass.txt` (read-only gap), `phase1-ui/b3/`, `b3-b4/mutations.txt` | approved with gaps (bypass shown live in `e2e/`; no live turn showing "Always allow" under ask) |
| B4 | Card input as an object, with `codeField` | b4d4875, 28517d0 | fail-then-pass, mutation, verify-toki | `b3-b4/fail-then-pass.txt`, `b3-b4/mutations.txt`, `phase1-ui/d1/strip-and-d5-card.aria.yml` | approved (the normal-card path is unit-tested only) |
| B5 | Status checks from BlenderHost and Studio, crash log | 074b918 | fail-then-pass, mutation, live | `phase1-backend/` | approved with gaps (Studio states) |
| B6 | Install uv, the pinned Blender MCP tools, Studio's MCP setting | 196b4ce | fail-then-pass, mutation, live | `phase1-backend/live-install.txt` | approved with gaps (the Studio setting step never ran on the real file) |
| B7 | Game team template | 574e6a2, 4a8ed9f (seeds on demand) | fail-then-pass, mutation, live | `phase2-backend/live-create.txt`, `mutations.txt` | approved |
| B8 | blender-loop and studio-loop skills | d608323 | fail-then-pass | `phase2-backend/fail-then-pass.txt` | approved with gaps (the A/B trap test did not run) |
| B9 | Look-backs from the SDK tool result | 4041481, bd45584 | fail-then-pass, mutation, live | `phase2-backend/`, `e2e/` | approved |
| B10 | Server project stubs, host tags | 5c06ec3 | fail-then-pass, mutation (27/27), live | `phase3-backend/live-stubs.txt`, `mutations.txt` | approved |
| B11 | Shared-subscription note | 1847740, 113bb0c, 54f4194 (web) | fail-then-pass, live, verify-toki | `phase3-backend/live-stubs.txt`, `phase3-ui/d4/usage-note-*` | approved with gaps (its mutants not run) |
| B12 | Toki's headless Blender | d3f3517, ca43f26 (hub dir) | fail-then-pass, mutation, live | `b12/` (`live-run.txt`, `b12-look-rendered.png`, `mutations.txt`) | approved (live bot turn through the mount in `e2e/`) |
| I1 | "Open Studio" only | 477db49 | mutation | `phase1-infra/i1-mutations.txt`, `i1-cargo.txt` | approved with gaps (no real launch; S2) |
| I2 | PC hub always runs; server tunnel on 7790 | 39afb96 | mutation (partial) | `phase3-infra/mutations.txt`, `cargo.txt` | approved with gaps (no live SSH; 35 of 46 mutants not run) |
| I3 | Stub refresh, 30 s loss, host requests, Open folder | 0fe6cc0, c6fe9b2 | mutation (partial) | `phase3-infra/mutations.txt`, `stub-schema.txt` | approved with gaps (wire tests used fake hubs; no live server) |
| I4 | Ship the Blender server script and requirements | d4a4b0d | fail-then-pass, live | `phase1-infra/i4-bundle.txt`, `i4-fail-then-pass.txt` | approved with gaps (NSIS installer not built) |
| D1 | Settings › Game tools and the room strip | 8118dfc, 6f668ee, e9d7020 | fail-then-pass, mutation, verify-toki | `phase1-ui/d1/`, `phase2-ui/b/` | approved with gaps (crash, other-Blender and Studio-open states are unit-tested only; Open Studio not live) |
| D2 | Look-back thumbnails | c98e388, 222a003, 9970651 | fail-then-pass, mutation, verify-toki | `phase2-ui/d2/` | approved with gaps (the look-back was seeded, not from a live turn) |
| D3 | Template picker, Open folder | b04029c, b3a92ac | fail-then-pass, mutation, verify-toki | `phase2-ui/d3/`, `phase3-ui/d4/settings-projects-*` | approved |
| D4 | Host tags, Server project prompt, Back to this PC | 8cc8868, fe19e50 | fail-then-pass, mutation, verify-toki | `phase3-ui/d4/` | approved with gaps (the shell taking the calls is not live) |
| D5 | Code on approval cards | 7b239e6 | fail-then-pass, mutation, verify-toki | `phase1-ui/d5/` | approved |
| P1 | Guide, CHANGELOG, this ledger | this commit | none (docs) | `docs/GUIDE.md` ("Make games with Blender and Studio", "This PC and your server"), `CHANGELOG.md` [Unreleased] | approved with gaps (the guide is checked against the code and the READMEs, not walked through in the app) |

## Still to verify live

These need the owner's machine with Studio open, the installed app, or the real server. Each source README has the exact
steps.

**S2: Roblox Studio** (`game-tools-spike.md` "Not verified", `phase1-infra/README.md`)
1. A `mcp-server` flip made with Studio closed takes effect the next time Studio starts. This is the **Turn on Studio
   MCP** step on the real `AssistantSettings` file.
2. `execute_luau` and `multi_edit` cards from a real turn. They should show code, and "Always allow" should work under
   Ask.
3. `screen_capture` returns an image block, and it becomes a look-back.
4. `save_place` from a bot.
5. Detection and the room strip with Studio open: "Studio open", and "Close Roblox Studio first" while the setting is off.
6. **Open Studio** in an installed build:
   - it starts `RobloxStudioBeta.exe` with no arguments;
   - Studio is not in Toki's job;
   - Studio stays open after you quit Toki;
   - a second press within 10 s opens no second Studio.

**Desktop tunnel and two hosts** (`phase3-infra/README.md` "Verify on the owner's machine", `phase3-ui/README.md`)
1. An old `{"mode":"remote",...}` config:
   - the PC hub starts on 7788 and no tunnel opens;
   - the tray's **Open your server** opens `127.0.0.1:7790` and shows the server hub with no token prompt;
   - `netstat` shows 7790 on 127.0.0.1 only.
2. After connecting, `GET /api/projects` on the PC hub lists the server's projects tagged `server` and `connected: true`.
3. Loss: cut the network or stop the server's hub. Within 30 s:
   - the stubs read `connected: false`;
   - a notification shows;
   - the window returns to the PC hub;
   - a PC bot turn keeps running throughout.
4. Port 7790 already in use: Connect refuses with the port message.
5. Restarts:
   - Restart hub while connected: the stubs return.
   - Quit and start again: a stale `connected: true` is cleared.
6. **Open folder** in an installed build opens Explorer on `projects/<slug>`, and a missing folder gives a notification.
7. D4's three checks in the real shell:
   - a PC project opens while the server is offline;
   - a Server project shows the prompt while offline;
   - Connect opens it, and the server page loads `project=<slug>`;
   - the desktop notification gives the reason on a failed connect.

**Blender and the game room from a real bot turn** (`phase2-backend/README.md`, `phase2-ui/README.md`)
1. ~~A live look-back.~~ Done in `e2e/`: a real Haiku turn called `look` and the image was attached to the tool message. The browser rendering is covered by D2.
2. ~~A game-room turn mounts `blender` and Blender starts on the first call~~ (done in `e2e/`). Still open: another room of the same bot gets no
   `blender` live (unit-tested in `blenderTurn.test.ts`).
3. The skills' A/B trap test: 3 runs with the skills and 3 without (`docs/project-folders.md`).
4. The room strip updating live on `game-tools.changed` as Blender starts and stops.

**Install and UI states** (`phase1-infra/README.md`, `phase1-ui/README.md`, `phase2-ui/README.md`)
1. The NSIS installer contains `hub/resources/blender/` on a clean install.
2. The UI states this PC could not show:
   - a crashing Blender with **Open log** and **Try again**;
   - another Blender running;
   - a VPS hub showing "not supported";
   - Blender not installed.
3. A keyboard Tab walk through Settings › Game tools, and the classic layout.

## Unfinished proofs (not live, but incomplete)

- **phase3-backend mutations:** done. Mutants 13 to 27 were rerun after the memory stop and all 15 were caught, so all 27 are caught (`phase3-backend/mutations.txt`).
- **phase3-infra mutations:** 35 of 46 did not run, because the run was capped for time.
- **B3 and B4:** the first pass caught 37 of 44 mutants. Six of the survivors were real gaps, and each now has a test (28517d0). The seventh survivor makes no difference that matters: it would also hide known secrets on hub and browser tool cards. The rerun caught mutants 1 to 31 before the run stopped for low memory. Mutants 32 to 44 were not rerun; in the first pass they were all caught except 44, the harmless one.

- **Studio `http_get`:** taken off `readTools` (131e52f), so it asks under ask. Tested fail-then-pass in `b3-b4/http-get-fail-then-pass.txt`. A recipe already in `mcp-servers.json` keeps the old list until its room's Studio setup runs again.

## Follow-ups raised by the evidence (not part of any task)

- An optional fixed-word `error` on `PUT /api/hosts/:host/projects`, so the connect prompt can show the reason
  (pr-backend).
- The connect prompt's working state has no timeout of its own (pr-infra or pr-design-system).
- The server hub's page sends pop-outs and "Open on my PC" to the browser without a token (pr-infra).
- Host tags show only once a server is known. Showing "This PC" always is a one-line change (owner's call).
- At 390 px, the existing project header row shows a faint horizontal scrollbar in Settings (pr-design-system).
