import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BLENDER_MCP_VERSION, blenderToolPaths } from '../BlenderHost.js';
import { INSTALL_MARKER, sha256, type GameFs, type RunFn } from '../gameTools.js';

/** Game tools fixtures: a fake PC tree in a temp folder. Nothing here touches the real %APPDATA% or %LOCALAPPDATA%. */
const dirs: string[] = [];
export function cleanupFixtures(): void {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
}

/** The real AssistantSettings shape on the owner's PC (4-space indent, LF, no final newline), with the setting off. */
export const SETTINGS = '{\n    "mcp-prompt-sharing": {\n        "enabled": false\n    },\n    "AssistantSkillsCloudMigrated": true,\n'
  + '    "integrations": {\n        "integrations": []\n    },\n    "mcp-server": {\n        "enabled": false\n    }\n}';

/** A fixture PC: Program Files, %LOCALAPPDATA%\Roblox, the owner's own %APPDATA%\Blender Foundation, Toki's data dir. */
export function fixturePc(o: { blenders?: string[]; uvOnPath?: boolean; studio?: boolean; setting?: string | null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-gametools-'));
  dirs.push(root);
  const pf = path.join(root, 'Program Files');
  for (const v of o.blenders ?? ['4.2', '5.2']) {
    fs.mkdirSync(path.join(pf, 'Blender Foundation', 'Blender ' + v), { recursive: true });
    fs.writeFileSync(path.join(pf, 'Blender Foundation', 'Blender ' + v, 'blender.exe'), '');
  }
  const local = path.join(root, 'Local');
  const roblox = path.join(local, 'Roblox');
  if (o.studio !== false) {
    fs.mkdirSync(path.join(roblox, 'Versions', 'version-abc'), { recursive: true });
    fs.writeFileSync(path.join(roblox, 'Versions', 'version-abc', 'StudioMCP.exe'), '');
    fs.writeFileSync(path.join(roblox, 'mcp.bat'), '@echo off\r\n');
    fs.mkdirSync(path.join(roblox, 'AssistantSettings'), { recursive: true });
    if (o.setting !== null) fs.writeFileSync(path.join(roblox, 'AssistantSettings', '1742184827.json'), o.setting ?? SETTINGS);
  }
  // The owner's own Blender config and old add-ons: Toki must never read or write here.
  const appData = path.join(root, 'Roaming');
  const ownerAddons = path.join(appData, 'Blender Foundation', 'Blender', '5.2', 'scripts', 'addons');
  fs.mkdirSync(ownerAddons, { recursive: true });
  fs.writeFileSync(path.join(ownerAddons, 'blender_mcp_addon.py'), '# v1.8');
  const sysBin = path.join(root, 'PyScripts');
  fs.mkdirSync(sysBin, { recursive: true });
  if (o.uvOnPath) fs.writeFileSync(path.join(sysBin, 'uv.exe'), '');
  const data = path.join(root, 'data');
  fs.mkdirSync(data, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ProgramFiles: pf, LOCALAPPDATA: local, APPDATA: appData, SystemRoot: path.join(root, 'Windows'),
    PATH: [sysBin, path.join(root, 'nothing')].join(';'),
  };
  return { root, pf, local, roblox, appData, ownerAddons, data, env, settingsFile: path.join(roblox, 'AssistantSettings', '1742184827.json') };
}

/** Records every path the code touches, through to the real fs. */
export function recordingFs() {
  const calls: { op: string; p: string }[] = [];
  const fsx = new Proxy(fs, {
    get(t, k: string) {
      const v = (t as unknown as Record<string, unknown>)[k];
      if (typeof v !== 'function') return v;
      return (...a: unknown[]) => { calls.push({ op: k, p: String(a[0]) }); return (v as (...x: unknown[]) => unknown).apply(t, a); };
    },
  }) as GameFs;
  return { fsx, calls };
}

export function fakeRun(answers: Record<string, string> = {}) {
  const calls: { exe: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const run: RunFn = async (exe, args, opts) => {
    calls.push({ exe, args, env: opts.env });
    if (args.includes('--version') && /blender\.exe$/i.test(exe)) return { code: 0, stdout: answers.blender ?? 'Blender 5.2.2 LTS\nbuild date: 2026-10-01\n', stderr: '' };
    if (args[0] === '--version') return { code: 0, stdout: answers.uv ?? 'uv 0.11.15 (3cffe97c2 2026-05-18 x86_64-pc-windows-msvc)\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  return { run, calls };
}

export function installBlenderMcp(data: string, addon = '# add-on 2.3.1', recorded?: string) {
  const t = blenderToolPaths(data, 'win32');
  fs.mkdirSync(path.dirname(t.mcpExe), { recursive: true });
  fs.writeFileSync(t.mcpExe, '');
  fs.mkdirSync(path.dirname(t.addon), { recursive: true });
  fs.writeFileSync(t.addon, addon);
  fs.writeFileSync(path.join(t.root, INSTALL_MARKER), JSON.stringify({ version: BLENDER_MCP_VERSION, addonSha256: recorded ?? sha256(addon) }));
  return t;
}
