# Phase 1 backend evidence: B1, B6, B2, B5

These are tasks B1, B6, B2 and B5 from `docs/specs/toki-local-first-gamedev.md`. They were run on 2026-11-24 on the owner's PC,
which has Blender 5.2.2 LTS, uv 0.11.15 on PATH, and Roblox Studio installed but closed.

The live runs used a throwaway hub on a random loopback port, with a fresh `%TEMP%\toki-phase1-*` data dir. Nothing touched
ports 7788 or 7789. No `blender.exe` was started except `blender -b --factory-startup --version`. Studio was not
launched, and the `studio-mcp-setting` step was never run against the owner's real AssistantSettings.

| File | What it shows |
|---|---|
| `live-status.txt` | `GET /api/game-tools` on this PC |
| `live-install.txt` | `install-uv` and `install-blender-mcp` into the temp data dir, the Studio recipe for one room, its check, the audit rows, and before/after snapshots: the HKCU `Environment\Path` value, the process PATH, the real AssistantSettings file, no `.toki-bak`, nothing changed under `%APPDATA%\Blender Foundation`, and no blender.exe left running |
| `mutations.txt` | Each guarded line broken in turn. 22 of 23 are caught. The survivor is the handler's own hub-only check, which sits behind the pipeline; it is now caught too (see `fail-then-pass.txt`) |
| `fail-then-pass.txt` | Each task's tests failing before its change and passing after, plus `pnpm lint` and `pnpm ts-strict` |
| `scripts/live_phase1.ts` | The live driver. From `packages/hub`: `POCKETROCKET_DATA=<new %TEMP% folder> npx tsx ../../docs/verify/phase1-backend/scripts/live_phase1.ts [--install]` |
| `scripts/mutations.py` | The mutation run. From `packages/hub`: `python -I ../../docs/verify/phase1-backend/scripts/mutations.py` |

## Results

- **Pins checked for real.** The uv 0.11.15 zip hashed to the compiled `UV_SHA256`, and it unpacked to `uv.exe`, `uvx.exe` and `uvw.exe`. The
  hashed requirements installed `mcp-for-blender` 2.3.1 with `--require-hashes --only-binary :all:` in 19.3 s, and the add-on
  hashed to B12's `b363e5b4…e03b`.
- **Studio:** detection on this PC reports `not-running`, with `setting: on`, `mcp.bat` present and `StudioMCP.exe` resolved. The
  recipe's check says `studio-not-open`.
- **The bot bearer gets 401, not 403.** A live per-turn MCP bearer is not a hub credential, so the token guard refuses it with 401
  before any route runs. A paired device gets 403 from `DEVICE_ALLOW`, which is unchanged, and from the handler itself.
