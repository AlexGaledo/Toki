# B12 evidence: Toki's headless Blender

Task B12 from `docs/specs/toki-local-first-gamedev.md`, run on 2026-11-24 on the owner's PC (Blender 5.2.2 LTS, RTX 3050
Laptop GPU). No other `blender.exe` was running before or after. Nothing touched ports 7788/7789, the desktop app, the PC
runner or the VPS.

| File | What it shows |
|---|---|
| `live-run.txt` | The live run: `BlenderHost` plus the real `mcp-for-blender==2.3.1` server and a real `blender -b --factory-startup` |
| `b12-look-rendered.png` | The rendered `look` (EEVEE, camera, 512 px) after `execute_blender_code` added `TokiCube` |
| `mutations.txt` | Each guarded line of `BlenderHost.ts` broken in turn: every mutation fails at least one test |
| `fail-then-pass.txt` | The other tests, failing before their change and passing after |
| `scripts/live_b12.ts` | The live driver. From `packages/hub`: `npx tsx ../../docs/verify/b12/scripts/live_b12.ts <tmpData> <outDir> <mcp-for-blender 2.3.1 venv>` |
| `scripts/visible_windows.ps1` | Lists a pid's top-level windows with `IsWindowVisible` |
| `scripts/mutations.py` | The mutation run. From `packages/hub`: `python -I ../../docs/verify/b12/scripts/mutations.py` |

B6 (installing the pinned environment) is not built yet. The live run linked the spike's uv cache env for
`mcp-for-blender==2.3.1` (add-on sha256 `b363e5b4765ec53895c92bc98f34335242065a164d95b673f1f843322ac4e03b`) into a
throwaway `<data>/tools/blender-mcp/2.3.1`.

## Results

- **The MCP server starts before Blender listens.** It lists its 10 tools, logs "Could not connect to Blender on startup",
  and connects on the first call. So Blender starts lazily, on the first `blender` tool call (the PreToolUse hook), not at
  the start of every game-room turn.
- **Start:** 10.4 s cold to READY (19.5 s in an earlier run), 4.6 s warm. `get_scene_info` 0.21 s; `execute_blender_code`
  0.03 s; the first rendered `look` 4.35 s.
- **Peak working set:** 590 MB after one EEVEE `look` (script-reported `PeakWorkingSetSize`; tasklist sampled 587 MB).
  About 208 to 220 MB with the scene loaded and no render.
- **No window:** 19 top-level windows during the render, 0 visible (GL and IME helper windows only).
- **Ports:** only 127.0.0.1:<live port> was listening. Nothing was on 9876.
- **Crash:** `taskkill /F` of Toki's own Blender was logged with its last lines, counted as one crash, and the next call
  restarted it on the same port from the saved file in 4.6 s. The first call through the already-connected MCP server
  then returned "Connection to Blender lost: [WinError 10054]", and the retry worked.
- **Idle stop and reopen:** after the idle stop (15 s in this run, 10 min in the hub), a fresh
  `blender -b --factory-startup art/b12-proof.blend` counted `scenes 1, objects 4, meshes 2, materials 2`, the same as
  the live session. The only difference from the session before the save is the factory `Dots Stroke` material, which
  had 0 users. A normal save drops it too.
