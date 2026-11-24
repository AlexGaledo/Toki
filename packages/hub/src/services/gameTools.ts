import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type {
  GameToolsBlender, GameToolsBlenderMcp, GameToolsBlenderProcess, GameToolsStatus, GameToolsStudio, GameToolsUv,
} from '@pocketrocket/shared';
import {
  BLENDER_MCP_VERSION, MAX_CRASHES, blenderServerScript, blenderToolPaths, findBlenderExe, type BlenderStatus,
} from './BlenderHost.js';
import { baseChildEnv } from '../providers/env.js';

/**
 * Game tools detection (spec toki-local-first-gamedev §2, B1). Windows only. Every fact is a fixed reason word.
 * It reads Blender's install folder, Toki's own `<data>/tools/`, and Roblox's files under %LOCALAPPDATA%\Roblox.
 * It never reads or writes the owner's Blender config or add-on folders (%APPDATA%\Blender Foundation).
 */

/** The uv release `install-uv` fetches, and the sha256 of its Windows zip (from the release's `.sha256`). */
export const UV_VERSION = '0.11.15';
export const UV_SHA256 = '04b98d414a9000e25e5e0e7c9f53749e66b790cdaffc582829e6f58c544ee11c';
export const UV_URL = 'https://github.com/astral-sh/uv/releases/download/' + UV_VERSION + '/uv-x86_64-pc-windows-msvc.zip';
/** The 0.11.15 zip is 22.9 MB. */
export const UV_MAX_BYTES = 64 * 1024 * 1024;
/** The add-on `mcp-for-blender==2.3.1` ships (`blender_mcp/bundled/addon.py`), as B12 measured it. */
export const BLENDER_ADDON_SHA256 = 'b363e5b4765ec53895c92bc98f34335242065a164d95b673f1f843322ac4e03b';
export const STUDIO_PROCESS = 'RobloxStudioBeta.exe';
/** Shown when the settings file cannot be changed safely. Unverified until S2 opens Studio. */
export const STUDIO_MENU_PATH = 'Open Roblox Studio, open the Assistant, open its settings, and turn on the MCP server option. Then restart Studio.';
/** Written beside the pinned environment when its install finishes; detection trusts nothing without it. */
export const INSTALL_MARKER = 'toki-install.json';
export const CRASH_LOG_MAX = 64 * 1024;

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
  /** Toki's own Blender: its state and its run folder (`last-crash.log`) come from here. */
  blender?: { status(): BlenderStatus; runDir?: string };
  fetch?: typeof fetch;
  /** The hashed requirements file; defaults to `requirements.txt` beside Toki's Blender server script. */
  requirements?: string;
  /** Tests only: stand-ins for the pinned hashes. Never reachable from a request. */
  pins?: { uvSha256?: string; addonSha256?: string };
}

/** What a fix step did. `result` is a fixed word; `changed` lists what it wrote. */
export interface FixOutcome { ok: boolean; result: string; changed: string[]; detail?: string }

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
  get crashLogFile() { return path.join(this.deps.blender?.runDir ?? path.join(this.deps.dataDir, 'run', 'blender'), 'last-crash.log'); }

  /** "Open log": the last unexpected exit's tail as BlenderHost wrote it, at most 64 KB, or null. */
  crashLog(): string | null {
    try {
      return this.fs.readFileSync(this.crashLogFile, 'utf8').slice(-CRASH_LOG_MAX);
    } catch {
      return null;
    }
  }
  get robloxDir() { return path.join(this.env.LOCALAPPDATA ?? '', 'Roblox'); }
  get studioSettingsDir() { return path.join(this.robloxDir, 'AssistantSettings'); }
  get mcpBat() { return path.join(this.robloxDir, 'mcp.bat'); }
  get requirements() { return this.deps.requirements ?? path.join(path.dirname(blenderServerScript()), 'requirements.txt'); }
  /** Windows' own bsdtar unpacks the uv zip; nothing from a request reaches its arguments. */
  get tarExe() { return path.join(this.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'); }

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

  /**
   * `install-uv`: the pinned zip, checked against the sha256 compiled in before anything is written, unpacked into
   * `<data>/tools/uv/<version>/` through a staging folder. PATH and the registry are never changed.
   */
  async installUv(): Promise<FixOutcome> {
    if (this.platform !== 'win32') return { ok: false, result: 'unsupported', changed: [] };
    if (this.exists(this.tokiUvExe)) return { ok: true, result: 'already-installed', changed: [] };
    let buf: Buffer;
    try {
      const r = await (this.deps.fetch ?? fetch)(UV_URL, { redirect: 'follow', signal: AbortSignal.timeout(180_000) });
      if (!r.ok) {
        void r.body?.cancel().catch(() => undefined);
        return { ok: false, result: 'download-failed', changed: [] };
      }
      if (Number(r.headers.get('content-length') ?? 0) > UV_MAX_BYTES) {
        void r.body?.cancel().catch(() => undefined);
        return { ok: false, result: 'too-large', changed: [] };
      }
      buf = Buffer.from(await r.arrayBuffer());
    } catch {
      return { ok: false, result: 'download-failed', changed: [] };
    }
    if (buf.length > UV_MAX_BYTES) return { ok: false, result: 'too-large', changed: [] };
    // Checked in memory: a wrong file never reaches the disk.
    if (sha256(buf) !== (this.deps.pins?.uvSha256 ?? UV_SHA256)) return { ok: false, result: 'hash-mismatch', changed: [] };
    const stage = path.join(this.toolsDir, 'uv', '.staging-' + crypto.randomBytes(6).toString('hex'));
    try {
      this.fs.mkdirSync(stage, { recursive: true });
      const zip = path.join(stage, 'uv.zip');
      this.fs.writeFileSync(zip, buf);
      const r = await this.run(this.tarExe, ['-x', '-f', zip, '-C', stage], { env: baseChildEnv(), cwd: stage, timeoutMs: 120_000 });
      if (r.code !== 0 || !this.exists(path.join(stage, 'uv.exe'))) throw new Error('unpack');
      this.fs.rmSync(zip, { force: true });
      this.fs.renameSync(stage, this.uvDir);
    } catch {
      this.fs.rmSync(stage, { recursive: true, force: true });
      return { ok: false, result: 'unpack-failed', changed: [] };
    }
    return { ok: true, result: 'installed', changed: [this.uvDir], detail: UV_VERSION };
  }

  /**
   * `install-blender-mcp`: `uv venv` at `<data>/tools/blender-mcp/2.3.1`, then `uv pip install --require-hashes` from
   * the hub's own requirements file. The add-on must hash to the pinned value, or the whole folder is removed.
   */
  async installBlenderMcp(): Promise<FixOutcome> {
    if (this.platform !== 'win32') return { ok: false, result: 'unsupported', changed: [] };
    if (this.detectBlenderMcp().ok) return { ok: true, result: 'already-installed', changed: [] };
    const uv = this.findUv();
    if (!uv) return { ok: false, result: 'uv-missing', changed: [] };
    const req = this.requirements;
    if (!this.exists(req)) return { ok: false, result: 'requirements-missing', changed: [] };
    const { root, mcpExe, addon } = this.blenderMcp;
    const env = baseChildEnv({ UV_NO_CONFIG: '1' });
    const fail = (result: string): FixOutcome => {
      this.fs.rmSync(root, { recursive: true, force: true });
      return { ok: false, result, changed: [] };
    };
    // Only ever Toki's own folder: an incomplete or changed install starts over.
    this.fs.rmSync(root, { recursive: true, force: true });
    const venv = await this.run(uv.path, ['venv', '--no-config', '--python', '>=3.10', root], { env, timeoutMs: 300_000 });
    if (venv.code !== 0) return fail('venv-failed');
    const py = path.join(root, 'Scripts', 'python.exe');
    const pip = await this.run(uv.path, [
      'pip', 'install', '--no-config', '--python', py, '--require-hashes', '--only-binary', ':all:',
      '--index-url', 'https://pypi.org/simple', '-r', req,
    ], { env, timeoutMs: 600_000 });
    if (pip.code !== 0 || !this.exists(mcpExe) || !this.exists(addon)) return fail('install-failed');
    const addonSha256 = sha256(this.fs.readFileSync(addon));
    if (addonSha256 !== (this.deps.pins?.addonSha256 ?? BLENDER_ADDON_SHA256)) return fail('addon-mismatch');
    this.fs.writeFileSync(path.join(root, INSTALL_MARKER), JSON.stringify({ version: BLENDER_MCP_VERSION, addonSha256, at: new Date().toISOString() }) + '\n');
    return { ok: true, result: 'installed', changed: [root], detail: BLENDER_MCP_VERSION + ' ' + addonSha256 };
  }

  /**
   * `studio-mcp-setting`: only while Studio is closed. Each `<userId>.json` is backed up to `.toki-bak`, gets only
   * `mcp-server.enabled = true`, keeps every other key and its own layout, and is replaced atomically. A file that
   * does not parse, or has no `mcp-server` object, is left as it is. `mcp-prompt-sharing` is never touched.
   */
  async enableStudioMcp(): Promise<FixOutcome> {
    if (this.platform !== 'win32') return { ok: false, result: 'unsupported', changed: [] };
    const procs = await this.processes();
    if (procs.some((p) => p.name.toLowerCase() === STUDIO_PROCESS.toLowerCase())) return { ok: false, result: 'studio-running', changed: [] };
    const changed: string[] = [];
    let already = 0;
    let skipped = 0;
    for (const file of this.studioSettingFiles()) {
      let raw: string;
      let v: unknown;
      try {
        raw = this.fs.readFileSync(file, 'utf8');
        v = JSON.parse(raw);
      } catch {
        skipped++;
        continue;
      }
      if (!isObj(v) || !isObj(v['mcp-server'])) { skipped++; continue; }
      if (v['mcp-server'].enabled === true) { already++; continue; }
      const next = { ...v, 'mcp-server': { ...v['mcp-server'], enabled: true } };
      const crlf = raw.includes('\r\n');
      let text = JSON.stringify(next, null, /^\{\r?\n([ \t]+)"/.exec(raw)?.[1]);
      if (crlf) text = text.replace(/\n/g, '\r\n');
      if (/\n$/.test(raw)) text += crlf ? '\r\n' : '\n';
      const tmp = file + '.toki-tmp';
      try {
        this.fs.copyFileSync(file, file + '.toki-bak');
        this.fs.writeFileSync(tmp, text);
        this.fs.renameSync(tmp, file);
      } catch {
        this.fs.rmSync(tmp, { force: true });
        skipped++;
        continue;
      }
      changed.push(file);
    }
    if (changed.length) return { ok: true, result: 'enabled', changed };
    if (already && !skipped) return { ok: true, result: 'already-on', changed };
    return { ok: false, result: 'menu-path', changed, detail: STUDIO_MENU_PATH };
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
