import { execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { Bot, ComputerStatus } from '@pocketrocket/shared';
import {
  CDP_URL, COMPUTERS_DIR, COMPUTERS_ENABLED, COMPUTER_IDLE_MIN, COMPUTER_QUOTA_BYTES, DATA_DIR, DESKTOP_HOME,
  MAX_RUNNING_COMPUTERS, SCREEN_DISPLAY, SCREEN_URL,
} from '../config.js';
import type { ComputerRow, ComputersRepo } from '../db/computers.js';
import { events } from '../events.js';

export const SLOT_BASE = { display: 200, cdp: 9400, vnc: 5800, novnc: 6200 } as const;
export const MAX_SLOT = 99;
export const COMPUTER_UNIT_PREFIX = 'pocketrocket-computer@';
export const ROUTINE_GRACE_MS = 10 * 60 * 1000;
const BOT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const WARM_MAX = 2;
export const COMPUTER_RAM_BYTES = 600 * 1024 ** 2;
export const RAM_RESERVE_BYTES = 1024 ** 3;
export const COLD_MS = 2 * 60_000;
const ALWAYS_ON_RETRY_MS = 2 * 60_000;
const LOW_RAM_REASON = "Not started: the server is low on memory. It still starts if the bot needs it for work.";

export interface SlotPorts {
  slot: number;
  display: string;
  cdpPort: number;
  vncPort: number;
  novncPort: number;
}

export function slotPorts(slot: number): SlotPorts {
  if (!Number.isInteger(slot) || slot < 1 || slot > MAX_SLOT) throw new Error('computer slot out of range: ' + slot);
  return {
    slot,
    display: ':' + (SLOT_BASE.display + slot),
    cdpPort: SLOT_BASE.cdp + slot,
    vncPort: SLOT_BASE.vnc + slot,
    novncPort: SLOT_BASE.novnc + slot,
  };
}

export function unitName(slot: number, botId: string): string {
  if (!BOT_ID_RE.test(botId)) throw new Error('bad bot id for a computer unit');
  slotPorts(slot);
  return COMPUTER_UNIT_PREFIX + slot + '-' + botId + '.service';
}

export interface ComputerEndpoint {
  perBot: boolean;
  botId: string | null;
  slot: number | null;
  display: string;
  xauthority: string;
  home: string;
  filesDir: string | null;
  cdpUrl: string;
  screenUrl: string;
  vncPort: number | null;
}

export interface Systemctl {
  start(unit: string): Promise<void>;
  stop(unit: string): Promise<void>;
  isActive(unit: string): Promise<boolean>;
}

export function userSystemctl(): Systemctl {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const env = { ...process.env, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || '/run/user/' + uid };
  const run = (args: string[]) =>
    new Promise<void>((resolve, reject) =>
      execFile('systemctl', ['--user', ...args], { env, timeout: 30_000 }, (e, _out, stderr) =>
        e ? reject(new Error((String(stderr).trim() || e.message).slice(0, 300))) : resolve(),
      ),
    );
  return {
    start: (unit) => run(['start', unit]),
    stop: (unit) => run(['stop', unit]),
    isActive: (unit) => run(['is-active', '--quiet', unit]).then(() => true, () => false),
  };
}

export function probeUrl(url: string): Promise<boolean> {
  const u = new URL(url);
  return new Promise((resolve) => {
    const s = net.connect({ host: u.hostname, port: Number(u.port || 80) });
    const done = (v: boolean) => { s.destroy(); resolve(v); };
    s.setTimeout(600, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

/** Bytes under `dir`, not following symlinks (so `~/Shared` → workspace is never counted against a bot). */
export async function duBytes(dir: string): Promise<number> {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { stack.push(p); continue; }
      try { total += (await fs.promises.lstat(p)).size; } catch { /* vanished */ }
    }
  }
  return total;
}

export function memAvailableBytes(): number | null {
  try {
    const m = /^MemAvailable:\s+(\d+) kB/m.exec(fs.readFileSync('/proc/meminfo', 'utf8'));
    return m ? Number(m[1]) * 1024 : null;
  } catch {
    return null;
  }
}

export class AlwaysOnRefused extends Error {}

export type Eviction = 'any' | 'cold' | 'none';

export type EnsureResult = { ok: true; endpoint: ComputerEndpoint } | { ok: false; reason: string };
export type AcquireResult = EnsureResult & { release: () => void };

export interface ComputerManagerOptions {
  enabled?: boolean;
  maxRunning?: number;
  idleMs?: number;
  quotaBytes?: number;
  dir?: string;
  dataDir?: string;
  systemctl?: Systemctl;
  probe?: (url: string) => Promise<boolean>;
  diskUsage?: (dir: string) => Promise<number>;
  now?: () => number;
  startTimeoutMs?: number;
  pollMs?: number;
  routineDueSoon?: (botId: string, withinMs: number) => boolean;
  memAvailable?: () => number | null;
}

const fmtGb = (b: number) => (b / 1024 ** 3).toFixed(1) + ' GB';

export class ComputerManager {
  readonly enabled: boolean;
  readonly maxRunning: number;
  readonly idleMs: number;
  readonly quotaBytes: number;
  private dir: string;
  private dataDir: string;
  private sys: Systemctl;
  private probe: (url: string) => Promise<boolean>;
  private diskUsage: (dir: string) => Promise<number>;
  private now: () => number;
  private startTimeoutMs: number;
  private pollMs: number;
  private routineDueSoon: (botId: string, withinMs: number) => boolean;
  private memAvailable: () => number | null;
  private usesComputer: (botId: string) => boolean = () => true;
  private personHolds: (botId: string) => boolean = () => false;
  private alwaysOnRetryAt = new Map<string, number>();
  private restoring = false;
  private busy = new Map<string, number>();
  private viewers = new Map<string, number>();
  private starting = new Map<string, Promise<EnsureResult>>();
  private reasons = new Map<string, string>();
  private timers: NodeJS.Timeout[] = [];

  constructor(private repo: ComputersRepo, opts: ComputerManagerOptions = {}) {
    this.enabled = opts.enabled ?? COMPUTERS_ENABLED;
    this.maxRunning = Math.max(1, opts.maxRunning ?? MAX_RUNNING_COMPUTERS);
    this.idleMs = opts.idleMs ?? COMPUTER_IDLE_MIN * 60_000;
    this.quotaBytes = opts.quotaBytes ?? COMPUTER_QUOTA_BYTES;
    this.dir = opts.dir ?? COMPUTERS_DIR;
    this.dataDir = opts.dataDir ?? DATA_DIR;
    this.sys = opts.systemctl ?? userSystemctl();
    this.probe = opts.probe ?? probeUrl;
    this.diskUsage = opts.diskUsage ?? duBytes;
    this.now = opts.now ?? Date.now;
    this.startTimeoutMs = opts.startTimeoutMs ?? 25_000;
    this.pollMs = opts.pollMs ?? 250;
    this.routineDueSoon = opts.routineDueSoon ?? (() => false);
    this.memAvailable = opts.memAvailable ?? memAvailableBytes;
  }

  wire(o: { usesComputer?: (botId: string) => boolean; personHolds?: (botId: string) => boolean }) {
    if (o.usesComputer) this.usesComputer = o.usesComputer;
    if (o.personHolds) this.personHolds = o.personHolds;
  }

  legacyEndpoint(): ComputerEndpoint {
    return {
      perBot: false, botId: null, slot: null, display: SCREEN_DISPLAY,
      xauthority: process.env.XAUTHORITY || path.join(DESKTOP_HOME, '.Xauthority'), home: DESKTOP_HOME, filesDir: null,
      cdpUrl: CDP_URL, screenUrl: SCREEN_URL, vncPort: null,
    };
  }

  endpoint(botId: string | null): ComputerEndpoint {
    if (!this.enabled || !botId || !BOT_ID_RE.test(botId)) return this.legacyEndpoint();
    const row = this.repo.allocate(botId, MAX_SLOT, this.quotaBytes, this.now());
    if (!row) return this.legacyEndpoint();
    return this.endpointFor(row);
  }

  existingEndpoint(botId: string): ComputerEndpoint | null {
    if (!this.enabled) return null;
    const row = this.repo.get(botId);
    return row ? this.endpointFor(row) : null;
  }

  private endpointFor(row: ComputerRow): ComputerEndpoint {
    const p = slotPorts(row.slot);
    const home = path.join(this.dir, row.botId, 'home');
    return {
      perBot: true, botId: row.botId, slot: row.slot, display: p.display, xauthority: path.join(home, '.Xauthority'), home,
      filesDir: path.join(this.dir, row.botId, 'files'),
      cdpUrl: 'http://127.0.0.1:' + p.cdpPort, screenUrl: 'http://127.0.0.1:' + p.novncPort, vncPort: p.vncPort,
    };
  }

  status(botId: string): ComputerStatus {
    const row = this.enabled ? this.repo.get(botId) : undefined;
    const reason = this.reasons.get(botId);
    return {
      botId, perBot: this.enabled,
      state: row?.state ?? 'asleep', slot: row?.slot ?? null, keepAwake: row?.keepAwake ?? false,
      diskBytes: row?.diskBytes ?? 0, quotaBytes: row?.quotaBytes ?? this.quotaBytes, lastUsedAt: row?.lastUsedAt ?? null,
      ...(this.enabled ? { alwaysOn: { used: this.alwaysOnRows().length, limit: this.alwaysOnLimit } } : {}),
      ...(reason ? { reason } : {}),
    };
  }

  private emit(botId: string) {
    events.emitEvent({ type: 'computer.state', status: this.status(botId) });
  }

  async acquire(botId: string): Promise<AcquireResult> {
    this.busy.set(botId, (this.busy.get(botId) ?? 0) + 1);
    this.touch(botId);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const n = (this.busy.get(botId) ?? 1) - 1;
      if (n > 0) this.busy.set(botId, n);
      else this.busy.delete(botId);
      this.touch(botId);
    };
    const r = await this.ensureRunning(botId);
    return { ...r, release };
  }

  turnsOn(botId: string): number {
    return this.busy.get(botId) ?? 0;
  }

  ensureRunning(botId: string, evict: Eviction = 'any'): Promise<EnsureResult> {
    if (!this.enabled) return Promise.resolve({ ok: true, endpoint: this.legacyEndpoint() });
    const pending = this.starting.get(botId);
    if (pending) return pending;
    const p = this.start(botId, evict).finally(() => this.starting.delete(botId));
    this.starting.set(botId, p);
    return p;
  }

  private fail(botId: string, shown: string, told = shown): EnsureResult {
    this.setReason(botId, shown);
    return { ok: false, reason: told };
  }

  private setReason(botId: string, reason: string) {
    if (this.reasons.get(botId) === reason) return;
    this.reasons.set(botId, reason);
    this.emit(botId);
  }

  private running(): ComputerRow[] {
    return this.repo.list().filter((r) => r.state !== 'asleep');
  }

  private ramForOneMore(): boolean {
    const available = this.memAvailable();
    return available === null || available - RAM_RESERVE_BYTES >= COMPUTER_RAM_BYTES;
  }

  async warm(focusBotId?: string | null): Promise<string[]> {
    if (!this.enabled) return [];
    const recent = this.repo.list()
      .filter((r) => r.lastUsedAt !== null && r.botId !== focusBotId)
      .sort((a, b) => b.lastUsedAt! - a.lastUsedAt!)
      .map((r) => r.botId);
    const targets = [...(focusBotId ? [focusBotId] : []), ...recent].filter((id) => this.usesComputer(id)).slice(0, WARM_MAX);
    const started: string[] = [];
    for (const id of targets) {
      const row = this.repo.get(id);
      if (row && row.state !== 'asleep') continue;
      if (this.running().length >= this.maxRunning - 1 || !this.ramForOneMore()) break;
      if ((await this.ensureRunning(id, 'none')).ok) started.push(id);
    }
    return started;
  }

  async wakeFocused(botId: string): Promise<EnsureResult> {
    if (!this.enabled) return { ok: true, endpoint: this.legacyEndpoint() };
    if (!this.usesComputer(botId)) return { ok: false, reason: 'This bot has no Browser or Desktop.' };
    const row = this.repo.get(botId);
    if ((!row || row.state === 'asleep') && !this.ramForOneMore()) return this.fail(botId, LOW_RAM_REASON);
    this.touch(botId);
    return this.ensureRunning(botId, 'cold');
  }

  private async start(botId: string, evict: Eviction): Promise<EnsureResult> {
    if (!BOT_ID_RE.test(botId)) return { ok: false, reason: 'Invalid bot id.' };
    const row = this.repo.allocate(botId, MAX_SLOT, this.quotaBytes, this.now());
    if (!row) return this.fail(botId, 'Every computer slot (' + MAX_SLOT + ') is taken.');
    const endpoint = this.endpointFor(row);
    const unit = unitName(row.slot, botId);
    if (row.state === 'live') {
      if (await this.sys.isActive(unit)) {
        if (await this.probe(endpoint.cdpUrl)) {
          this.reasons.delete(botId);
          return { ok: true, endpoint };
        }
        // The unit can outlive its browser (Chromium gone while Xvfb and noVNC stay up, seen after a hub restart).
        // Handing that out would fail every browser call, so the computer is restarted instead.
        console.warn('[computers] ' + botId + "'s browser is not answering; restarting its computer");
        await this.sys.stop(unit).catch(() => undefined);
      }
      this.repo.setState(botId, 'asleep');
    }

    const cur = this.repo.get(botId)!;
    if (cur.diskBytes >= cur.quotaBytes) {
      return this.fail(botId, 'Its disk is full (' + fmtGb(cur.diskBytes) + ' of ' + fmtGb(cur.quotaBytes) + '). Free space in ' + endpoint.filesDir + ' first.');
    }
    const running = this.running().filter((r) => r.botId !== botId);
    let victim: ComputerRow | undefined;
    const overCap = running.length >= this.maxRunning;
    const lowRam = evict !== 'none' && running.length > 0 && !this.ramForOneMore();
    if (overCap || lowRam) {
      const t = this.now();
      victim = evict === 'none' ? undefined : running
        .filter((r) => this.stoppable(r) && !this.personHolds(r.botId) && (evict === 'any' || t - (r.lastUsedAt ?? r.createdAt) >= COLD_MS))
        .sort((a, b) => (a.lastUsedAt ?? a.createdAt) - (b.lastUsedAt ?? b.createdAt))[0];
      if (!victim) {
        if (!overCap) return this.fail(botId, 'The server is low on memory and every running computer is in use. Try again when one is idle.');
        const shown = 'All ' + this.maxRunning + ' computers are in use or were used moments ago. Try again in a minute.';
        return evict === 'any'
          ? this.fail(botId, shown, this.maxRunning + ' computers are already running and all are in use (MAX_RUNNING_COMPUTERS=' + this.maxRunning + '). Try again when one is idle.')
          : this.fail(botId, shown);
      }
      this.repo.setState(victim.botId, 'asleep');
    }
    this.repo.setState(botId, 'starting');
    this.repo.touch(botId, this.now());
    this.reasons.delete(botId);
    this.emit(botId);
    if (victim) await this.stopUnit(victim.botId, 'evicted to make room');

    try {
      await this.sys.start(unit);
    } catch (e) {
      this.repo.setState(botId, 'asleep');
      return this.fail(botId, 'Its computer could not start: ' + (e as Error).message);
    }
    if (!(await this.waitFor(endpoint.cdpUrl))) {
      await this.sys.stop(unit).catch(() => undefined);
      this.repo.setState(botId, 'asleep');
      return this.fail(botId, 'Its computer did not come up within ' + Math.round(this.startTimeoutMs / 1000) + 's.');
    }
    this.repo.setState(botId, 'live');
    this.emit(botId);
    return { ok: true, endpoint };
  }

  private async waitFor(url: string): Promise<boolean> {
    const deadline = Date.now() + this.startTimeoutMs;
    for (;;) {
      if (await this.probe(url)) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, this.pollMs));
    }
  }

  private stoppable(r: ComputerRow): boolean {
    return r.state === 'live' && !this.alwaysOnKept().has(r.botId) && !this.viewers.get(r.botId) && !this.busy.get(r.botId);
  }

  get alwaysOnLimit(): number {
    return this.maxRunning - 1;
  }

  private alwaysOnRows(): ComputerRow[] {
    const up = (r: ComputerRow) => (r.state === 'asleep' ? 0 : 1);
    return this.repo.list()
      .filter((r) => r.keepAwake && this.usesComputer(r.botId))
      .sort((a, b) => up(b) - up(a) || (b.lastUsedAt ?? b.createdAt) - (a.lastUsedAt ?? a.createdAt));
  }

  private alwaysOnKept(): Set<string> {
    return new Set(this.alwaysOnRows().slice(0, this.alwaysOnLimit).map((r) => r.botId));
  }

  async restoreAlwaysOn(): Promise<string[]> {
    if (!this.enabled || this.restoring) return [];
    this.restoring = true;
    const started: string[] = [];
    try {
      const rows = this.alwaysOnRows();
      for (const r of rows.slice(this.alwaysOnLimit)) {
        if (r.state === 'asleep') this.setReason(r.botId, 'Always on, but only ' + this.alwaysOnLimit + ' fit on this server. Turn another one off.');
      }
      for (const r of rows.slice(0, this.alwaysOnLimit)) {
        if (r.state !== 'asleep' || (this.alwaysOnRetryAt.get(r.botId) ?? 0) > this.now()) continue;
        if (this.running().length >= this.maxRunning) continue;
        if (!this.ramForOneMore()) {
          this.setReason(r.botId, LOW_RAM_REASON);
          continue;
        }
        if ((await this.ensureRunning(r.botId, 'none')).ok) {
          this.alwaysOnRetryAt.delete(r.botId);
          started.push(r.botId);
        } else {
          this.alwaysOnRetryAt.set(r.botId, this.now() + ALWAYS_ON_RETRY_MS);
        }
      }
    } finally {
      this.restoring = false;
    }
    return started;
  }

  async stop(botId: string, why = 'stopped'): Promise<void> {
    const row = this.enabled ? this.repo.get(botId) : undefined;
    if (!row) return;
    this.repo.setState(botId, 'asleep');
    this.emit(botId);
    await this.stopUnit(botId, why);
  }

  private async stopUnit(botId: string, why: string) {
    const row = this.repo.get(botId);
    if (!row) return;
    try {
      await this.sys.stop(unitName(row.slot, botId));
    } catch (e) {
      console.warn('[computers] could not stop ' + botId + ' (' + why + '): ' + (e as Error).message);
    }
    this.emit(botId);
  }

  touch(botId: string) {
    if (this.enabled) this.repo.touch(botId, this.now());
  }

  setKeepAwake(botId: string, on: boolean): ComputerStatus {
    if (!this.enabled) return this.status(botId);
    if (on && !this.repo.get(botId)?.keepAwake) {
      if (!this.usesComputer(botId)) throw new AlwaysOnRefused('This bot has no Browser or Desktop, so it has no computer to keep on.');
      if (this.alwaysOnLimit < 1) throw new AlwaysOnRefused('This server runs one computer at a time, so none can be Always on.');
      if (this.alwaysOnRows().length >= this.alwaysOnLimit) {
        throw new AlwaysOnRefused(
          'Only ' + this.alwaysOnLimit + ' can be Always on: ' + this.maxRunning + ' computers run at once, and one place stays free for whichever bot works next. Turn another one off first.',
        );
      }
    }
    if (this.repo.allocate(botId, MAX_SLOT, this.quotaBytes, this.now())) {
      this.repo.setKeepAwake(botId, on);
      if (!on) this.reasons.delete(botId);
      this.emit(botId);
      if (on) void this.restoreAlwaysOn().catch((e) => console.warn('[computers] ' + (e as Error).message));
    }
    return this.status(botId);
  }

  viewerOpened(botId: string): () => void {
    this.viewers.set(botId, (this.viewers.get(botId) ?? 0) + 1);
    this.touch(botId);
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      const n = (this.viewers.get(botId) ?? 1) - 1;
      if (n > 0) this.viewers.set(botId, n);
      else this.viewers.delete(botId);
      this.touch(botId);
    };
  }

  async sweep(): Promise<string[]> {
    if (!this.enabled) return [];
    const t = this.now();
    const stopped: string[] = [];
    for (const r of this.repo.list()) {
      if (!this.stoppable(r)) continue;
      if (t - (r.lastUsedAt ?? r.createdAt) < this.idleMs) continue;
      if (this.routineDueSoon(r.botId, ROUTINE_GRACE_MS)) continue;
      await this.stop(r.botId, 'idle');
      stopped.push(r.botId);
    }
    return stopped;
  }

  async refreshDisk(): Promise<void> {
    if (!this.enabled) return;
    for (const r of this.repo.list()) {
      const bytes = await this.diskUsage(path.join(this.dir, r.botId));
      if (bytes !== r.diskBytes) {
        this.repo.setDisk(r.botId, bytes);
        this.emit(r.botId);
      }
    }
  }

  async reconcile(): Promise<void> {
    if (!this.enabled) return;
    for (const r of this.repo.list()) {
      const active = await this.sys.isActive(unitName(r.slot, r.botId)).catch(() => false);
      const state = active ? 'live' : 'asleep';
      if (state !== r.state) this.repo.setState(r.botId, state);
    }
  }

  async prune(liveBotIds: Iterable<string>): Promise<string[]> {
    if (!this.enabled) return [];
    const keep = new Set(liveBotIds);
    const gone: string[] = [];
    for (const r of this.repo.list()) {
      if (keep.has(r.botId)) continue;
      await this.sys.stop(unitName(r.slot, r.botId)).catch(() => undefined);
      this.repo.remove(r.botId);
      this.busy.delete(r.botId);
      this.viewers.delete(r.botId);
      this.reasons.delete(r.botId);
      this.alwaysOnRetryAt.delete(r.botId);
      fs.rmSync(path.join(this.dir, r.botId), { recursive: true, force: true });
      gone.push(r.botId);
    }
    return gone;
  }

  async migrateLegacy(bots: Bot[], legacyRunning: () => Promise<boolean> = () => this.probe(CDP_URL)): Promise<string | null> {
    if (!this.enabled) return null;
    const marker = path.join(this.dir, '.legacy-migrated');
    if (fs.existsSync(marker)) return null;
    const profile = path.join(this.dataDir, 'browser-profile');
    const dhome = path.join(this.dataDir, 'desktop-home');
    if (!fs.existsSync(profile) && !fs.existsSync(dhome)) return null;
    const target = [...bots].filter((b) => b.allowedTools.includes('Browser')).sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!target || !BOT_ID_RE.test(target.id)) return null;
    if (await legacyRunning()) {
      console.warn('[computers] the shared screen is still running, so its logins were not moved to @' + target.handle + '. Stop pocketrocket-screen and restart the hub.');
      return null;
    }
    if (!this.repo.allocate(target.id, MAX_SLOT, this.quotaBytes, this.now())) return null;
    const cdir = path.join(this.dir, target.id);
    fs.mkdirSync(cdir, { recursive: true });
    const moved: string[] = [];
    for (const [from, to] of [[profile, path.join(cdir, 'browser')], [dhome, path.join(cdir, 'home')]] as const) {
      if (!fs.existsSync(from) || !isEmptyOrMissing(to)) continue;
      fs.rmSync(to, { recursive: true, force: true });
      moveDir(from, to);
      moved.push(path.basename(from));
    }
    fs.writeFileSync(marker, JSON.stringify({ botId: target.id, moved, at: this.now() }) + '\n');
    console.log('[computers] moved the shared screen\'s ' + moved.join(' and ') + ' to @' + target.handle + '\'s computer');
    return target.id;
  }

  async startBackground(bots: Bot[]): Promise<void> {
    if (!this.enabled) return;
    await this.reconcile();
    await this.prune(bots.map((b) => b.id));
    await this.migrateLegacy(bots).catch((e) => console.warn('[computers] legacy migration failed: ' + (e as Error).message));
    const every = (ms: number, fn: () => Promise<unknown>) => {
      const t = setInterval(() => void fn().catch((e) => console.warn('[computers] ' + (e as Error).message)), ms);
      t.unref();
      this.timers.push(t);
    };
    every(60_000, () => this.sweep());
    every(60_000, () => this.restoreAlwaysOn());
    every(60 * 60_000, () => this.refreshDisk());
    const first = setTimeout(() => void this.refreshDisk().catch(() => undefined), 30_000);
    first.unref();
    this.timers.push(first);
    await this.restoreAlwaysOn();
  }

  stopBackground() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }
}

function isEmptyOrMissing(dir: string): boolean {
  try {
    return fs.readdirSync(dir).length === 0;
  } catch {
    return true;
  }
}

function moveDir(from: string, to: string) {
  try {
    fs.renameSync(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
    fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}
