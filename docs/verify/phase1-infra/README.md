# Phase 1 infra evidence: I4 and I1

These are tasks I4 and I1 from `docs/specs/toki-local-first-gamedev.md`. They were run on 2026-11-24 on the owner's PC
(Windows 11, rustc 1.96.0, about 1 to 2.7 GB of RAM free).

Nothing in these runs touched the installed desktop app, ports 7788 or 7789, or the VPS. Roblox Studio and Blender were
not launched. The only Studio facts read were the folder listing of `%LOCALAPPDATA%\Roblox\Versions` and the
`HKCU\Software\Roblox\RobloxStudio` `ContentFolder` value. `cargo test` used placeholders for the gitignored build
inputs that tauri-build requires: an empty `binaries/node-x86_64-pc-windows-msvc.exe`, and a real `hub/build` from
`pnpm hub:bundle`.

| File | What it shows |
|---|---|
| `i4-bundle.txt` | The real `pnpm hub:bundle`. First, HEAD's `build-hub.mjs` produced no `build/resources`. Then the change copied both files, byte for byte (sha256), and the hub's own resolver found them in the bundle, source and VPS-dist layouts |
| `i4-fail-then-pass.txt` | `scripts/hub-resources.test.mjs` fails against HEAD's `build-hub.mjs`. It also fails on a `deploy.sh` mutated with `--exclude=resources`, and passes with the change |
| `i1-mutations.txt` | Each I1 guard is broken in turn, and `cargo test` catches 10 of 10 |
| `i1-cargo.txt` | `cargo check` (clean) and the full `cargo test` (65 passed), not filtered. A later re-run of the tests was stopped for low memory; see the file |
| `scripts/mutations_i1.py` | The mutation run. From `packages/desktop/src-tauri`: `python -I ../../../docs/verify/phase1-infra/scripts/mutations_i1.py` |

## I4: where the files land

- **Desktop app.** `build-hub.mjs` empties `build/` down to `node_modules` and `package.json` after `pnpm deploy`, so
  `resources/` never shipped. Step 4b now copies `packages/hub/resources/` into `build/resources/` through
  `scripts/hub-resources.mjs`. The build fails if either file is missing or differs from the source. Tauri ships `build/`
  as `<install>/hub/`, and `HUB_DIR` is that folder because `hub.mjs` sits beside `node_modules`. So `BlenderHost` finds
  `<install>/hub/resources/blender/toki_blender_server.py`, and `requirements.txt` sits next to it.
- **Dev and the VPS.** `HUB_DIR` is `packages/hub`, whether the hub runs from `tsx src/` or `dist/hub.mjs`.
  `scripts/deploy.sh` tars the source tree with `resources/` in it, and a test checks that none of its `--exclude`s drops
  the files. Blender tools report `unsupported` on Linux (B1), but the files are there.
- **Override.** `POCKETROCKET_BLENDER_SERVER` takes an absolute path, documented in `docs/CONFIGURATION.md`. The desktop
  shell does not set it, because the default already resolves in the bundle.

## I1: "Open Studio"

- **The web UI's call (for D1).** Show the button only when `desktopCan('studio')` is true. The shell now passes
  `caps=localcopy,studio` on Windows, to the main window and to pop-outs. The click handler is:

  ```ts
  window.open(location.origin + '/?launch=studio', '_blank');
  ```

  The request has no IPC command and needs no capability. It arrives in `on_new_window`, which always denies the new
  window. Failures show as a desktop notification ("Couldn't open Roblox Studio": not installed, or didn't start). The
  page gets no result back, so the room strip should go on reading Studio's state from `GET /api/game-tools`.
- **What the page can't do.** The only accepted URL is exactly `/?launch=studio` on the hub's own origin and port, with
  no other parameter and no fragment. `blender`, unknown ids, paths, case variants, duplicate or extra parameters
  (`&path=`, `&exe=`, `&args=`) are refused with a notification. Other origins are not launch asks at all.
- **How Studio is found.** The shell finds Studio itself. It looks next to Roblox's `ContentFolder` registry value first,
  then for the newest `Versions\version-*\RobloxStudioBeta.exe`. It only accepts a file inside
  `%LOCALAPPDATA%\Roblox\Versions`, with no `..`. Studio starts with no arguments, with `CREATE_BREAKAWAY_FROM_JOB` and
  null stdio, and without `POCKETROCKET_TOKEN` in its environment. It is never assigned to the job (`proc.rs` allows
  breakaway). The shell starts it at most once per 10 s.
- **No Blender launcher (decision 7).**

## What is left for S2 (verify when Studio may be opened)

This step is recorded in `docs/verify/game-tools-spike.md`, "Not verified":

1. In an installed build, press "Open Studio". `RobloxStudioBeta.exe` should start from `Versions\version-*` with no
   arguments.
2. Studio should not be in Toki's job. Check with the Job tab in Process Explorer, or with `IsProcessInJob`.
3. Quit Toki from the tray. Studio should still be running. This is the breakaway proof, and only a real launch shows it.
4. Press the button twice within 10 s. Only one Studio should open.

## Not verified here

- The NSIS build, and an install on a clean machine (I4's "installed app has both files"). The bundle that Tauri copies
  is proven, but the installer itself was not built on this PC.
- `spawn_detached`, the only code that starts a real process, is not unit-tested. Running it would start Studio. The
  tests check what it is given through an injected spawner.
- The wiring in `new_window_elsewhere` needs a live `AppHandle`. It calls the tested functions
  (`request`, `GATE.pass`, `open`).
