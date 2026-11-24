import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type {
  GameToolsBlender, GameToolsBlenderMcp, GameToolsBlenderProcess, GameToolsStatus, GameToolsStudio, GameToolsUv,
} from '@pocketrocket/shared';
import { BLENDER_MCP_VERSION, MAX_CRASHES, blenderToolPaths, findBlenderExe, type BlenderStatus } from './BlenderHost.js';
import { baseChildEnv } from '../providers/env.js';

/**
 * Game tools detection (spec toki-local-first-gamedev §2, B1). Windows only. Every fact is a fixed reason word.
 * It reads Blender's install folder, Toki's own `<data>/tools/`, and Roblox's files under %LOCALAPPDATA%\Roblox.
 * It never reads or writes the owner's Blender config or add-on folders (%APPDATA%\Blender Foundation).
 */

/** The uv release `install-uv` fetches, and the sha256 of its Windows zip (from the release's `.sha256`). */
export const UV_VERSION = '0.11.15';
export const UV_SHA256 = '04b98d414a9000e25e5e0e7c9f53749e66b790cdaffc582829e6f58c544ee11c';
/** The add-on `mcp-for-blender==2.3.1` ships (`blender_mcp/bundled/addon.py`), as B12 measured it. */
export const BLENDER_ADDON_SHA256 = 'b363e5b4765ec53895c92bc98f34335242065a164d95b673f1f843322ac4e03b';
export const STUDIO_PROCESS = 'RobloxStudioBeta.exe';
/** Written beside the pinned environment when its install finishes; detection trusts nothing without it. */
export const INSTALL_MARKER = 'toki-install.json';

export interface RunResult { code: number | null; stdout: string; stderr: string }
export type RunFn = (exe: string, args: string[], opts: { env: NodeJS.ProcessEnv; cwd?: string; timeoutMs: number }) => Promise<RunResult>;
export interface ProcessRow { name: string; pid: number }

export type GameFs = Pick<typeof fs,
  'existsSync' | 'readdirSync' | 'readFileSync' | 'writeFileSync' | 'renameSync' | 'rmSync' | 'mkdirSync' | 'copyFileSync'>;

export interface GameToolsDeps {
  dataDir: string;
  platform?: NodeJS.Platform;
  /** Where PATH, ProgramFiles, LOCALAPPDATA and SystemRoot come from. Read only. */
  env?: NodeJS.ProcessEnv;
  fs?: GameFs;
  run?: RunFn;
  processes?: () => Promise<ProcessRow[]>;
  /** `HKCU\...` value lookup. There is no registry write anywhere in game tools. */
  registry?: (key: string, value: string) => Promise<string | null>;
  blender?: { status(): BlenderStatus };
}

/** `tasklist /FO CSV /NH`: every row's image name and pid. */
export function parseTasklistAll(out: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^"([^"]+)","(\d+)"/.exec(line.trim());
    if (m) rows.push({ name: m[1]!, pid: Number(m[2]) });
  }
  return rows;
}

export const defaultRun: RunFn = (exe, args, opts) => new Promise((resolve) => {
  execFile(exe, args, { env: opts.env, cwd: opts.cwd, timeout: opts.timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
    (e, stdout, stderr) => {
      const code = e ? (typeof (e as { code?: unknown }).code === 'number' ? (e as { code: number }).code : null) : 0;
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
});

function defaultProcesses(platform: NodeJS.Platform): Promise<ProcessRow[]> {
  if (platform !== 'win32') return Promise.resolve([]);
  return defaultRun('tasklist', ['/FO', 'CSV', '/NH'], { env: baseChildEnv(), timeoutMs: 10_000 })
    .then((r) => parseTasklistAll(r.stdout));
}

async function defaultRegistry(key: string, value: string): Promise<string | null> {
  const r = await defaultRun('reg', ['query', key, '/v', value], { env: baseChildEnv(), timeoutMs: 10_000 });
  const m = new RegExp('^\\s*' + value.replace(/[^A-Za-z0-9]/g, '\\$&') + '\\s+REG_(?:EXPAND_)?SZ\\s+(.+?)\\s*$', 'mi').exec(r.stdout);
  return m ? m[1]! : null;
}

export const sha256 = (buf: Buffer | string): string => crypto.createHash('sha256').update(buf).digest('hex');

export class GameTools {
  private versions = new Map<string, string | null>();

  constructor(protected deps: GameToolsDeps) {}

  protected get platform() { return this.deps.platform ?? process.platform; }
  protected get env() { return this.deps.env ?? process.env; }
  protected get fs(): GameFs { return this.deps.fs ?? fs; }
  protected get run(): RunFn { return this.deps.run ?? defaultRun; }
  protected processes() { return (this.deps.processes ?? (() => defaultProcesses(this.platform)))(); }
  protected registry(key: string, value: string) { return (this.deps.registry ?? defaultRegistry)(key, value); }
  protected exists(p: string) { return this.fs.existsSync(p); }

  get toolsDir() { return path.join(this.deps.dataDir, 'tools'); }
  get uvDir() { return path.join(this.toolsDir, 'uv', UV_VERSION); }
  get tokiUvExe() { return path.join(this.uvDir, 'uv.exe'); }
  get blenderMcp() { return blenderToolPaths(this.deps.dataDir, this.platform); }
  get crashLogFile() { return path.join(this.deps.dataDir, 'run', 'blender', 'last-crash.log'); }
  get robloxDir() { return path.join(this.env.LOCALAPPDATA ?? '', 'Roblox'); }
  get studioSettingsDir() { return path.join(this.robloxDir, 'AssistantSettings'); }
  get mcpBat() { return path.join(this.robloxDir, 'mcp.bat'); }

  async status(): Promise<GameToolsStatus> {
    if (this.platform !== 'win32') return unsupported();
    const procs = await this.processes();
    const blender = await this.detectBlender();
    const [uv, studio] = await Promise.all([this.detectUv(), this.detectStudio(procs)]);
    return { supported: true, blender, uv, blenderMcp: this.detectBlenderMcp(), blenderProcess: this.detectProcess(procs), studio };
  }

  async detectBlender(): Promise<GameToolsBlender> {
    const exe = findBlenderExe(this.env, this.platform, this.fs);
    if (!exe) return { ok: false, reason: 'not-installed', exe: null, version: null, fix: null };
    return { ok: true, reason: 'found', exe, version: await this.blenderVersion(exe), fix: null };
  }

  /** Asked once per exe, and only ever with `-b --factory-startup` (owner decision 7). */
  private async blenderVersion(exe: string): Promise<string | null> {
    if (this.versions.has(exe)) return this.versions.get(exe) ?? null;
    const r = await this.run(exe, ['-b', '--factory-startup', '--version'], { env: baseChildEnv(), timeoutMs: 30_000 });
    const v = /^Blender (\d+\.\d+(?:\.\d+)?)/m.exec(r.stdout)?.[1] ?? null;
    this.versions.set(exe, v);
    return v;
  }

  /** uv.exe on PATH first, then Toki's own copy. */
  findUv(): { path: string; reason: 'system' | 'toki' } | null {
    for (const dir of (this.env.PATH ?? this.env.Path ?? '').split(';').filter(Boolean)) {
      const exe = path.join(dir, 'uv.exe');
      if (path.isAbsolute(exe) && this.exists(exe)) return { path: exe, reason: 'system' };
    }
    return this.exists(this.tokiUvExe) ? { path: this.tokiUvExe, reason: 'toki' } : null;
  }

  async detectUv(): Promise<GameToolsUv> {
    const found = this.findUv();
    if (!found) return { ok: false, reason: 'not-installed', path: null, version: null, pinned: UV_VERSION, fix: 'install-uv' };
    const r = await this.run(found.path, ['--version'], { env: baseChildEnv(), timeoutMs: 10_000 });
    const version = /^uv (\d+\.\d+\.\d+)/m.exec(r.stdout)?.[1] ?? null;
    return { ok: true, reason: found.reason, path: found.path, version, pinned: UV_VERSION, fix: null };
  }

  /** The recorded add-on hash, or null when the install never finished. */
  private recordedAddonSha(): string | null {
    try {
      const m = JSON.parse(this.fs.readFileSync(path.join(this.blenderMcp.root, INSTALL_MARKER), 'utf8')) as { addonSha256?: unknown };
      return typeof m.addonSha256 === 'string' && /^[0-9a-f]{64}$/.test(m.addonSha256) ? m.addonSha256 : null;
    } catch {
      return null;
    }
  }

  detectBlenderMcp(): GameToolsBlenderMcp {
    const { root, mcpExe, addon } = this.blenderMcp;
    const base = { version: BLENDER_MCP_VERSION };
    if (!this.exists(root)) return { ...base, ok: false, reason: 'not-installed', addonSha256: null, fix: 'install-blender-mcp' };
    const recorded = this.recordedAddonSha();
    if (!this.exists(mcpExe) || !this.exists(addon) || !recorded) {
      return { ...base, ok: false, reason: 'incomplete', addonSha256: null, fix: 'install-blender-mcp' };
    }
    const actual = sha256(this.fs.readFileSync(addon));
    if (actual !== recorded) return { ...base, ok: false, reason: 'addon-mismatch', addonSha256: actual, fix: 'install-blender-mcp' };
    return { ...base, ok: true, reason: 'installed', addonSha256: actual, fix: null };
  }

  detectProcess(procs: readonly ProcessRow[]): GameToolsBlenderProcess {
    const s = this.deps.blender?.status() ?? { state: 'stopped' as const, crashes: 0, crashLog: null, lastPeakBytes: null };
    const crashLog = this.exists(this.crashLogFile);
    const base = { project: null, pid: null, port: null, idleMs: null, exe: null, crashes: s.crashes, crashLog, fix: null };
    if (s.state !== 'stopped') {
      return { ...base, state: s.state, project: s.project, pid: s.pid, port: s.port, idleMs: s.idleMs };
    }
    if (s.crashes > MAX_CRASHES) return { ...base, state: 'crashing', fix: 'blender-reset' };
    const other = procs.find((p) => p.name.toLowerCase() === 'blender.exe');
    if (other) return { ...base, state: 'other', pid: other.pid, exe: other.name };
    return { ...base, state: 'stopped' };
  }

  /** `Versions\<v>\StudioMCP.exe`, else beside the registry's `ContentFolder`, as mcp.bat resolves it. */
  private async studioMcpFound(): Promise<boolean> {
    const versions = path.join(this.robloxDir, 'Versions');
    try {
      if (this.fs.readdirSync(versions).some((d) => this.exists(path.join(versions, d, 'StudioMCP.exe')))) return true;
    } catch { /* no Versions folder: try the registry */ }
    const content = await this.registry('HKCU\\Software\\Roblox\\RobloxStudio', 'ContentFolder');
    return !!content && path.isAbsolute(content) && this.exists(path.join(content, '..', 'StudioMCP.exe'));
  }

  /** The `<userId>.json` files in AssistantSettings. */
  studioSettingFiles(): string[] {
    try {
      return this.fs.readdirSync(this.studioSettingsDir).filter((f) => /^\d+\.json$/.test(f)).map((f) => path.join(this.studioSettingsDir, f));
    } catch {
      return [];
    }
  }

  /** `on` when any account has `mcp-server.enabled === true`; `unknown` when a file does not parse. */
  studioSetting(): GameToolsStudio['setting'] {
    const files = this.studioSettingFiles();
    if (!files.length) return 'missing';
    let unknown = false;
    for (const f of files) {
      const v = readSettings(this.fs, f);
      if (!v) { unknown = true; continue; }
      const s = v['mcp-server'];
      if (isObj(s) && s.enabled === true) return 'on';
      if (!isObj(s)) unknown = true;
    }
    return unknown ? 'unknown' : 'off';
  }

  async detectStudio(procs: readonly ProcessRow[]): Promise<GameToolsStudio> {
    const mcpBat = this.exists(this.mcpBat);
    const studioMcp = mcpBat && await this.studioMcpFound();
    const setting = this.studioSetting();
    const running = procs.some((p) => p.name.toLowerCase() === STUDIO_PROCESS.toLowerCase());
    const reason: GameToolsStudio['reason'] = !mcpBat ? 'no-mcp-bat' : !studioMcp ? 'no-studio-mcp'
      : setting === 'off' ? 'setting-off' : setting !== 'on' ? 'setting-unknown' : !running ? 'not-running' : 'ready';
    return {
      ok: reason === 'ready', reason, mcpBat, studioMcp, setting, running, verified: false,
      fix: setting === 'off' ? 'studio-mcp-setting' : null,
    };
  }
}

export const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The parsed settings object, or null when it does not parse as one. */
export function readSettings(fsx: Pick<GameFs, 'readFileSync'>, file: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(fsx.readFileSync(file, 'utf8'));
    return isObj(v) ? v : null;
  } catch {
    return null;
  }
}

function unsupported(): GameToolsStatus {
  return {
    supported: false,
    blender: { ok: false, reason: 'unsupported', exe: null, version: null, fix: null },
    uv: { ok: false, reason: 'unsupported', path: null, version: null, pinned: UV_VERSION, fix: null },
    blenderMcp: { ok: false, reason: 'unsupported', version: BLENDER_MCP_VERSION, addonSha256: null, fix: null },
    blenderProcess: { state: 'unsupported', project: null, pid: null, port: null, idleMs: null, exe: null, crashes: 0, crashLog: false, fix: null },
    studio: { ok: false, reason: 'unsupported', mcpBat: false, studioMcp: false, setting: 'missing', running: false, verified: false, fix: null },
  };
}
