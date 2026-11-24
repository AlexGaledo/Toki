import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execFile, spawn, type SpawnOptions } from 'node:child_process';
import { HUB_DIR } from '../config.js';
import { baseChildEnv } from '../providers/env.js';
import { logError } from '../providers/redact.js';
import type { OutsideMcpStdio } from './outsideMcp.js';

/**
 * Toki's own headless Blender (spec toki-local-first-gamedev, B12; owner decision 7). One process at a time, started
 * on the first Blender call a game room makes, stopped when idle, restarted after a crash up to a cap. It never opens a
 * window: every start is `-b --factory-startup`, and it never kills a Blender it did not start.
 */

export const BLENDER_MCP_VERSION = '2.3.1';
export const BLENDER_READ_TOOLS = ['get_addon_status', 'get_scene_info', 'look', 'search_assets'];
/** The port a GUI Blender's add-on uses. Toki's never takes it. */
export const GUI_BLENDER_PORT = 9876;
export const IDLE_MS = 10 * 60_000;
/** Another project may take Blender over only after this much quiet. */
export const BUSY_MS = 60_000;
export const CRASH_WINDOW_MS = 10 * 60_000;
/** More crashes than this inside the window stop the restarts. */
export const MAX_CRASHES = 3;
export const READY_TIMEOUT_MS = 90_000;
export const STOP_GRACE_MS = 30_000;
export const AUTOSAVE_S = 300;
const TAIL_LINES = 50;

/**
 * The server script. I4 ships `packages/hub/resources/blender/` inside the bundle; it is found at
 * `<HUB_DIR>/resources/blender/toki_blender_server.py`, or wherever `POCKETROCKET_BLENDER_SERVER` points.
 */
export function blenderServerScript(env: NodeJS.ProcessEnv = process.env, hubDir: string = HUB_DIR): string {
  const v = env.POCKETROCKET_BLENDER_SERVER;
  return v && path.isAbsolute(v) ? v : path.join(hubDir, 'resources', 'blender', 'toki_blender_server.py');
}

/** The pinned Blender MCP environment B6 installs: its server exe and the add-on it bundles. */
export function blenderToolPaths(dataDir: string, platform: NodeJS.Platform = process.platform) {
  const root = path.join(dataDir, 'tools', 'blender-mcp', BLENDER_MCP_VERSION);
  const win = platform === 'win32';
  const site = win ? path.join(root, 'Lib', 'site-packages') : path.join(root, 'lib', 'python3', 'site-packages');
  return {
    root,
    /** The MCP server's APPDATA: its logs and state stay in Toki's data folder. */
    home: path.join(dataDir, 'tools', 'blender-mcp', 'home'),
    mcpExe: path.join(root, win ? 'Scripts' : 'bin', win ? 'mcp-for-blender.exe' : 'mcp-for-blender'),
    addon: path.join(site, 'blender_mcp', 'bundled', 'addon.py'),
  };
}

/** `POCKETROCKET_BLENDER_EXE`, else the newest `Blender <ver>\blender.exe` under Program Files. B1 refines detection. */
export function findBlenderExe(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  const set = env.POCKETROCKET_BLENDER_EXE;
  if (set && path.isAbsolute(set) && fs.existsSync(set)) return set;
  if (platform !== 'win32') return null;
  const base = path.join(env.ProgramFiles ?? 'C:\\Program Files', 'Blender Foundation');
  let dirs: string[];
  try {
    dirs = fs.readdirSync(base).filter((d) => /^Blender \d+(\.\d+)*$/.test(d));
  } catch {
    return null;
  }
  const ver = (d: string) => d.slice('Blender '.length).split('.').map(Number);
  dirs.sort((a, b) => {
    const x = ver(a), y = ver(b);
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
    return 0;
  });
  for (const d of dirs) {
    const exe = path.join(base, d, 'blender.exe');
    if (fs.existsSync(exe)) return exe;
  }
  return null;
}

export interface RunningBlender { pid: number; exe: string }

/** `tasklist /FO CSV /NH` lines for blender.exe. */
export function parseTasklist(out: string): RunningBlender[] {
  const found: RunningBlender[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^"([^"]+)","(\d+)"/.exec(line.trim());
    if (m && m[1]!.toLowerCase() === 'blender.exe') found.push({ exe: m[1]!, pid: Number(m[2]) });
  }
  return found;
}

export function listBlenders(platform: NodeJS.Platform = process.platform): Promise<RunningBlender[]> {
  return new Promise((resolve) => {
    if (platform === 'win32') {
      execFile('tasklist', ['/FI', 'IMAGENAME eq blender.exe', '/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 10_000 },
        (_e, out) => resolve(parseTasklist(String(out ?? ''))));
      return;
    }
    execFile('ps', ['-A', '-o', 'pid=,comm='], { timeout: 10_000 }, (_e, out) => resolve(String(out ?? '').split('\n')
      .map((l) => /^\s*(\d+)\s+(\S+)/.exec(l))
      .filter((m): m is RegExpExecArray => !!m && path.basename(m[2]!) === 'blender')
      .map((m) => ({ pid: Number(m[1]), exe: m[2]! }))));
  });
}

/** A free loopback port: bind 127.0.0.1:0, read the number, close. */
export function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const a = srv.address();
      srv.close(() => (a && typeof a === 'object' ? resolve(a.port) : reject(new Error('no port'))));
    });
  });
}

export interface BlenderChild {
  pid?: number;
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  on(ev: 'exit', fn: (code: number | null) => void): unknown;
  on(ev: 'error', fn: (e: Error) => void): unknown;
  kill(): boolean;
}

export interface BlenderProject { slug: string; dir: string }

export interface BlenderHostDeps {
  dataDir: string;
  exe?: () => string | null;
  script?: string;
  spawn?: (command: string, args: string[], opts: SpawnOptions) => BlenderChild;
  listBlenders?: () => Promise<RunningBlender[]>;
  pickPort?: () => Promise<number>;
  exists?: (p: string) => boolean;
  now?: () => number;
  idleMs?: () => number;
  log?: (line: string) => void;
  platform?: NodeJS.Platform;
}

export type BlenderStatus =
  | { state: 'stopped'; crashes: number; crashLog: string | null; lastPeakBytes: number | null }
  | { state: 'starting' | 'running'; project: string; pid: number | null; port: number; idleMs: number; peakBytes: number; crashes: number };

interface Proc {
  slug: string;
  child: BlenderChild;
  port: number;
  startedAt: number;
  lastUse: number;
  ready: Promise<string | null>;
  readyDone: boolean;
  settle: (why: string | null) => void;
  exited: Promise<void>;
  stopping: string | null;
  scriptExit: string | null;
  peakBytes: number;
  tail: string[];
  stopFile: string;
}

export class BlenderHost {
  private proc: Proc | null = null;
  private port: number | null = null;
  private crashes: number[] = [];
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private crashLog: string | null = null;
  private lastPeakBytes: number | null = null;

  constructor(private deps: BlenderHostDeps) {}

  private now() { return (this.deps.now ?? Date.now)(); }
  private log(line: string) { (this.deps.log ?? console.log)('[blender] ' + line); }
  private exists(p: string) { return (this.deps.exists ?? fs.existsSync)(p); }
  private get tools() { return blenderToolPaths(this.deps.dataDir, this.deps.platform); }
  get runDir() { return path.join(this.deps.dataDir, 'run', 'blender'); }

  blendPath(p: BlenderProject): string {
    return path.join(p.dir, 'art', p.slug + '.blend');
  }

  /** Stable while it stays free, so a turn's MCP server finds a restarted Blender on the same port. Never 9876. */
  async livePort(): Promise<number> {
    while (this.port === null || this.port === GUI_BLENDER_PORT) this.port = await (this.deps.pickPort ?? freeLoopbackPort)();
    return this.port;
  }

  /** The built-in `blender` entry for a game room's turn, or null when the Blender MCP tools are not installed. */
  async mcpEntry(): Promise<OutsideMcpStdio | null> {
    const { mcpExe, addon, home } = this.tools;
    if (!this.exists(mcpExe) || !this.exists(addon)) return null;
    const port = await this.livePort();
    fs.mkdirSync(home, { recursive: true });
    return {
      kind: 'stdio', name: 'blender', command: mcpExe, args: [],
      env: {
        BLENDER_HOST: '127.0.0.1', BLENDER_PORT: String(port), DISABLE_TELEMETRY: 'true',
        // The server scans %APPDATA%\Blender Foundation for the owner's add-on at startup, tells the bot to run
        // `install-addon` (which writes there) when it is old, and keeps its logs under APPDATA. Point all of it at Toki.
        APPDATA: home, XDG_CONFIG_HOME: path.join(home, '.config'), BLENDERMCP_ADDONS_DIR: path.dirname(addon),
      },
      approve: 'mode', readTools: [...BLENDER_READ_TOOLS], needs: [],
    };
  }

  status(): BlenderStatus {
    const crashes = this.recentCrashes();
    const p = this.proc;
    if (!p) return { state: 'stopped', crashes, crashLog: this.crashLog, lastPeakBytes: this.lastPeakBytes };
    return {
      state: p.readyDone ? 'running' : 'starting', project: p.slug, pid: p.child.pid ?? null, port: p.port,
      idleMs: this.now() - p.lastUse, peakBytes: p.peakBytes, crashes,
    };
  }

  /** "Try again" after the crash cap. */
  resetCrashes(): void {
    this.crashes = [];
  }

  private recentCrashes(): number {
    const now = this.now();
    this.crashes = this.crashes.filter((t) => now - t < CRASH_WINDOW_MS);
    return this.crashes.length;
  }

  /** Null when Blender is up for this project (started if needed), else why the call is refused. */
  ensure(project: BlenderProject): Promise<string | null> {
    const run = this.chain.then(() => this.ensureNow(project));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async ensureNow(project: BlenderProject): Promise<string | null> {
    const cur = this.proc;
    if (cur && cur.slug === project.slug && !cur.stopping) {
      this.touch();
      return cur.ready;
    }
    if (cur) {
      if (!cur.stopping && this.now() - cur.lastUse < BUSY_MS) return 'Blender is busy with ' + cur.slug + '. Try again in a minute.';
      await this.stop('another project needs Blender');
    }
    if (this.recentCrashes() > MAX_CRASHES) {
      return 'Blender keeps crashing, so Toki stopped restarting it. Open the log in Settings > Game tools, then press Try again.';
    }
    const exe = (this.deps.exe ?? findBlenderExe)();
    if (!exe) return 'Blender is not installed on this PC. Install it from blender.org, then try again.';
    const { addon } = this.tools;
    const script = this.deps.script ?? blenderServerScript();
    if (!this.exists(addon)) return 'The Blender MCP tools are not installed. Install them in Settings > Game tools, then try again.';
    if (!this.exists(script)) return 'Toki\'s Blender server script is missing (' + script + '). Reinstall Toki.';
    const others = await (this.deps.listBlenders ?? listBlenders)();
    const other = others[0];
    if (other) return 'Another Blender is running on this PC (' + other.exe + ', pid ' + other.pid + '). Try again when it finishes.';
    return this.start(project, exe, addon, script, await this.livePort());
  }

  private start(project: BlenderProject, exe: string, addon: string, script: string, port: number): Promise<string | null> {
    fs.mkdirSync(this.runDir, { recursive: true });
    const stopFile = path.join(this.runDir, 'stop');
    fs.rmSync(stopFile, { force: true });
    const blend = this.blendPath(project);
    const idleS = Math.ceil(((this.deps.idleMs?.() ?? IDLE_MS) + BUSY_MS) / 1000);
    // `-b --factory-startup` always first. The .blend is opened from the command line, never with bpy.ops.wm.
    const args = [
      '-b', '--factory-startup', ...(this.exists(blend) ? [blend] : []), '--python-exit-code', '1', '-P', script, '--',
      '--port', String(port), '--addon', addon, '--blend', blend, '--stop', stopFile, '--idle', String(idleS), '--autosave', String(AUTOSAVE_S),
    ];
    const child = (this.deps.spawn ?? ((c, a, o) => spawn(c, a, o) as BlenderChild))(exe, args, {
      cwd: this.runDir,
      // Not the hub's env: no token, no PYTHONPATH. windowsHide sets CREATE_NO_WINDOW; the child stays in the hub's job.
      env: baseChildEnv({ BLENDERMCP_NO_UPDATE_CHECK: '1', DISABLE_TELEMETRY: 'true' }),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let settle: (why: string | null) => void = () => undefined;
    const ready = new Promise<string | null>((r) => { settle = r; });
    let exitedDone: () => void = () => undefined;
    const exited = new Promise<void>((r) => { exitedDone = r; });
    const now = this.now();
    const proc: Proc = {
      slug: project.slug, child, port, startedAt: now, lastUse: now, ready, readyDone: false, settle: () => undefined, exited,
      stopping: null, scriptExit: null, peakBytes: 0, tail: [], stopFile,
    };
    let settled = false;
    proc.settle = (why) => {
      if (settled) return;
      settled = true;
      proc.readyDone = why === null;
      settle(why);
    };
    this.proc = proc;
    this.log('starting for ' + project.slug + ' on 127.0.0.1:' + port + ' (pid ' + (child.pid ?? '?') + ')');
    const readyTimer = setTimeout(() => {
      if (settled || this.proc !== proc) return;
      proc.settle('Blender did not start within ' + READY_TIMEOUT_MS / 1000 + ' s. Try again.');
      proc.stopping = 'did not start';
      child.kill();
    }, READY_TIMEOUT_MS);
    readyTimer.unref?.();

    const onLine = (line: string) => {
      proc.tail.push(line);
      if (proc.tail.length > TAIL_LINES) proc.tail.shift();
      const m = /^TOKI_(\w+)\s*(.*)$/.exec(line.trim());
      if (!m) return;
      const [, tag, rest] = m;
      if (tag === 'READY') {
        clearTimeout(readyTimer);
        proc.settle(null);
        // Idle time counts from here: a cold start can take longer than the idle time.
        this.touch();
        this.log('ready for ' + project.slug + ' after ' + ((this.now() - proc.startedAt) / 1000).toFixed(1) + ' s');
      } else if (tag === 'RAM') {
        proc.peakBytes = Math.max(proc.peakBytes, Number(rest) || 0);
      } else if (tag === 'BIND_FAILED') {
        // Someone took the port: the next start picks another.
        this.port = null;
        proc.scriptExit = 'port taken';
      } else if (tag === 'EXIT') {
        proc.scriptExit = rest || 'exit';
      }
    };
    for (const s of [child.stdout, child.stderr]) {
      if (!s) continue;
      let buf = '';
      s.on('data', (d: Buffer | string) => {
        buf += String(d);
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          onLine(buf.slice(0, i).replace(/\r$/, ''));
          buf = buf.slice(i + 1);
        }
      });
    }

    let gone = false;
    const onGone = (code: number | null, err?: Error) => {
      if (gone) return;
      gone = true;
      clearTimeout(readyTimer);
      if (this.proc === proc) {
        this.proc = null;
        this.clearIdle();
      }
      const secs = ((this.now() - proc.startedAt) / 1000).toFixed(0);
      this.lastPeakBytes = proc.peakBytes || null;
      const why = proc.stopping ?? (proc.scriptExit ? 'script: ' + proc.scriptExit : null);
      this.log('stopped for ' + proc.slug + ' (' + (why ?? 'exit code ' + code) + ') after ' + secs + ' s; peak working set '
        + (proc.peakBytes ? (proc.peakBytes / 1048576).toFixed(0) + ' MB' : 'unknown'));
      if (why === null || why === 'did not start') {
        this.crashes.push(this.now());
        this.crashLog = [err ? 'spawn error: ' + err.message : 'exit code ' + code, ...proc.tail].join('\n');
        try {
          fs.writeFileSync(path.join(this.runDir, 'last-crash.log'), this.crashLog);
        } catch (e) {
          logError('[blender] crash log', e);
        }
        this.log('unexpected exit for ' + proc.slug + '; last ' + proc.tail.length + ' lines:\n' + proc.tail.join('\n'));
      }
      proc.settle(proc.scriptExit === 'port taken'
        ? 'Blender\'s port was taken by another program. Try again.'
        : 'Blender stopped before it was ready (' + (err ? err.message : 'exit code ' + code) + '). Try again.');
      exitedDone();
    };
    child.on('exit', (code) => onGone(code));
    child.on('error', (e) => onGone(null, e));
    return ready;
  }

  /** A Blender call: resets the idle clock. */
  touch(): void {
    const p = this.proc;
    if (!p) return;
    p.lastUse = this.now();
    this.clearIdle();
    this.idleTimer = setTimeout(() => void this.stop('idle'), this.deps.idleMs?.() ?? IDLE_MS);
    this.idleTimer.unref?.();
  }

  private clearIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  /** Asks the script to save and quit through its stop file; kills it only after the grace period. */
  async stop(why: string): Promise<void> {
    const p = this.proc;
    if (!p) return;
    if (!p.stopping) {
      p.stopping = why;
      this.clearIdle();
      try {
        fs.writeFileSync(p.stopFile, why);
      } catch (e) {
        logError('[blender] stop file', e);
        p.child.kill();
      }
    }
    let t: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([p.exited, new Promise<void>((r) => { t = setTimeout(() => { p.child.kill(); r(); }, STOP_GRACE_MS); })]);
    clearTimeout(t);
    await p.exited;
  }

  shutdown(): Promise<void> {
    return this.stop('hub quit');
  }
}
