/**
 * A throwaway hub entry for the ui-gaps verify run: `packages/hub/src/index.ts` plus the seams `createHub` already
 * has for tests (`gameTools.platform`, `gameTools.env`, `gameTools.processes`). Launched by the driver:
 *   node scripts/control-toki.mjs launch --hub-entry docs/verify/ui-gaps/scripts/hub_entry.ts
 * Inputs (TOKI_VERIFY_*; the driver drops every POCKETROCKET_* it inherits):
 * - TOKI_VERIFY_PLATFORM=linux   detection answers as a server (non-Windows) hub does: `supported: false`.
 * - TOKI_VERIFY_FAKE_PC=<dir>    must be under %TEMP%. Game tools read `<dir>/pf` as Program Files and `<dir>/local`
 *   as %LOCALAPPDATA%, so Blender and Roblox are whatever that folder holds, and the real Roblox files are never read.
 *   `<dir>/studio-running` present = a `RobloxStudioBeta.exe` row is added to the real process list (Studio itself is
 *   never started). `<dir>/crash-now` present = the hub's own BlenderHost is asked to start 4 times for a scratch
 *   project, the way a game room's Blender call asks; with the crash stub as blender.exe each start is a real crash.
 * Nothing else differs from index.ts.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHub } from '../../../../packages/hub/src/hub.js';
import { startWorkspaceWeb } from '../../../../packages/hub/src/api/workspaceWeb.js';
import { WORKSPACE_DIR, WORKSPACE_WEB_PORT } from '../../../../packages/hub/src/config.js';
import { defaultRun, parseTasklistAll, type GameToolsDeps } from '../../../../packages/hub/src/services/gameTools.js';
import { baseChildEnv } from '../../../../packages/hub/src/providers/env.js';

const origEmitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  if (String(warning).includes('canUseTool will not be invoked')) return;
  (origEmitWarning as (...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

const gameTools: Partial<Omit<GameToolsDeps, 'blender'>> = {};
const platform = process.env.TOKI_VERIFY_PLATFORM;
if (platform) gameTools.platform = platform as NodeJS.Platform;

const fake = process.env.TOKI_VERIFY_FAKE_PC ? path.resolve(process.env.TOKI_VERIFY_FAKE_PC) : null;
if (fake) {
  const rel = path.relative(path.resolve(os.tmpdir()).toLowerCase(), fake.toLowerCase());
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('TOKI_VERIFY_FAKE_PC must be under ' + os.tmpdir());
  const pf = path.join(fake, 'pf');
  const stubExe = path.join(pf, 'Blender Foundation', 'Blender 9.9', 'blender.exe');
  // BlenderHost reads process.env: the stub when present. Its start only ever runs on crash-now below.
  process.env.POCKETROCKET_BLENDER_EXE = stubExe;
  gameTools.env = { ...process.env, ProgramFiles: pf, LOCALAPPDATA: path.join(fake, 'local') };
  gameTools.processes = async () => {
    const r = await defaultRun('tasklist', ['/FO', 'CSV', '/NH'], { env: baseChildEnv(), timeoutMs: 10_000 });
    const rows = parseTasklistAll(r.stdout);
    return fs.existsSync(path.join(fake, 'studio-running')) ? [...rows, { name: 'RobloxStudioBeta.exe', pid: 4242 }] : rows;
  };
}

const hub = createHub({ seedBots: true, ...(Object.keys(gameTools).length ? { gameTools } : {}) });
await hub.listen();
await startWorkspaceWeb(WORKSPACE_DIR, WORKSPACE_WEB_PORT);
console.log('[ui-gaps] entry: platform=' + (platform ?? process.platform) + ' fakePc=' + (fake ? 'yes' : 'no'));

if (fake) {
  const trigger = path.join(fake, 'crash-now');
  const proj = { slug: 'crash-test', dir: path.join(fake, 'crash-test') };
  let busy = false;
  setInterval(() => {
    if (busy || !fs.existsSync(trigger)) return;
    busy = true;
    fs.rmSync(trigger, { force: true });
    void (async () => {
      for (let i = 1; i <= 4; i++) {
        const why = await hub.runner.blender!.ensure(proj);
        console.log('[ui-gaps] start ' + i + ': ' + (why ?? 'ready'));
      }
    })().finally(() => { busy = false; });
  }, 1000).unref();
}

process.on('SIGINT', () => void hub.stop('SIGINT'));
process.on('SIGTERM', () => void hub.stop('SIGTERM'));
