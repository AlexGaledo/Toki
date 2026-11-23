import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { DESKTOP_HOME, SCREEN_DISPLAY, WORKSPACE_DIR } from '../config.js';

export type OpenWhere = 'explorer' | 'finder' | 'screen' | 'file-manager';

export interface OpenResult {
  ok: boolean;
  where: OpenWhere;
  path: string;
  error?: string;
}

export interface OpenDeps {
  platform?: NodeJS.Platform;
  screen?: boolean;
  spawnFn?: typeof spawn;
  mkdir?: (p: string) => void;
  computer?: OpenComputer;
  unavailable?: string;
}

export interface OpenComputer {
  display: string;
  xauthority: string;
  home: string;
}

export interface OpenComputers {
  enabled: boolean;
  status(botId: string): { state: string };
  existingEndpoint(botId: string): OpenComputer | null;
}

export function workspaceTarget(computers: OpenComputers, bot: { id: string; name: string } | null): Pick<OpenDeps, 'computer' | 'unavailable'> {
  if (!computers.enabled) return {};
  if (!bot) return { unavailable: "Each bot has its own computer here. Open a bot's Screen tab first, then open the workspace again." };
  const ep = computers.existingEndpoint(bot.id);
  if (!ep || computers.status(bot.id).state !== 'live') {
    return { unavailable: bot.name + "'s computer is asleep. Open its Screen tab and press Wake first, then open the workspace again." };
  }
  return { computer: { display: ep.display, xauthority: ep.xauthority, home: ep.home } };
}

export function openWorkspace(deps: OpenDeps = {}): Promise<OpenResult> {
  const platform = deps.platform ?? process.platform;
  const onScreen = deps.screen ?? false;
  const spawnFn = deps.spawnFn ?? spawn;
  const path = WORKSPACE_DIR;

  if (deps.unavailable) return Promise.resolve({ ok: false, where: 'screen', path, error: deps.unavailable });

  try {
    (deps.mkdir ?? ((p: string) => fs.mkdirSync(p, { recursive: true })))(path);
  } catch {
    /* already there, or unwritable — the launch below reports the real problem */
  }

  let cmd: string;
  let args: string[];
  let where: OpenWhere;
  let env: NodeJS.ProcessEnv = process.env;

  if (platform === 'win32') {
    cmd = 'explorer.exe';
    args = [path];
    where = 'explorer';
  } else if (platform === 'darwin') {
    cmd = 'open';
    args = [path];
    where = 'finder';
  } else if (deps.computer) {
    cmd = 'thunar';
    args = [path];
    where = 'screen';
    env = { ...process.env, DISPLAY: deps.computer.display, XAUTHORITY: deps.computer.xauthority, HOME: deps.computer.home };
  } else if (onScreen) {
    cmd = 'thunar';
    args = [path];
    where = 'screen';
    env = { ...process.env, DISPLAY: SCREEN_DISPLAY, HOME: DESKTOP_HOME };
  } else {
    cmd = 'xdg-open';
    args = [path];
    where = 'file-manager';
  }

  return new Promise<OpenResult>((resolve) => {
    let child;
    try {
      child = spawnFn(cmd, args, { env, detached: true, stdio: 'ignore' });
    } catch (e) {
      resolve({ ok: false, where, path, error: (e as Error).message });
      return;
    }
    let settled = false;
    const done = (r: OpenResult) => { if (!settled) { settled = true; resolve(r); } };
    child.once('error', (e: Error) => done({ ok: false, where, path, error: e.message }));
    child.once('spawn', () => done({ ok: true, where, path }));
    child.unref?.();
    // explorer.exe exits 1 even when it opened the window, so exit codes are never consulted: the process
    // starting at all is the success signal, and this timeout is only a floor for a runner that emits neither.
    setTimeout(() => done({ ok: true, where, path }), 2000);
  });
}
