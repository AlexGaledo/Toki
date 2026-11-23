import { execFile } from 'node:child_process';
import type { ComputerControl, ControlStatus, TakeoverPayload } from '@pocketrocket/shared';
import type { Repos } from '../db/repos.js';
import { events } from '../events.js';
import type { ComputerEndpoint, ComputerManager } from './ComputerManager.js';
import { DESKTOP_AVAILABLE } from '../config.js';

export interface VncControl {
  setViewOnly(ep: ComputerEndpoint, on: boolean): Promise<void>;
}

/**
 * `x11vnc -R viewonly|noviewonly` against the running server on that display (x11vnc remote control goes
 * through an X property, so it needs the display and its MIT cookie, not the VNC port).
 */
export function x11vncControl(): VncControl {
  return {
    setViewOnly: (ep, on) =>
      new Promise<void>((resolve, reject) =>
        execFile(
          'x11vnc',
          ['-display', ep.display, '-auth', ep.xauthority, '-sync', '-R', on ? 'viewonly' : 'noviewonly'],
          { timeout: 8000, env: { ...process.env, DISPLAY: ep.display, XAUTHORITY: ep.xauthority } },
          (e, _out, stderr) => (e ? reject(new Error((String(stderr).trim() || e.message).slice(0, 300))) : resolve()),
        ),
      ),
  };
}

export interface TakeoverRecord {
  messageId: string;
  roomId: string;
  reason: string;
  causeId: string;
  hop: number;
  ownerRef: string | null;
  parked: boolean;
  createdAt: number;
}

type HandBack = { kind: 'handed-back'; note: string } | { kind: 'timeout' } | { kind: 'aborted' };

interface Entry {
  control: ComputerControl;
  holder: string | null;
  since: number;
  takeover: TakeoverRecord | null;
}

export const TAKEOVER_WAIT_MS = 10 * 60 * 1000;
export const MAX_PARK_MS = (Number(process.env.POCKETROCKET_MAX_PARK_HOURS) || 24) * 60 * 60 * 1000;

export const USER_HAS_CONTROL =
  'The user has taken control of your computer, so the browser and desktop tools are paused. Wait: do not retry ' +
  'them until you are told the user handed it back. Use the time for other work, or end your turn.';
export const COMPUTER_PAUSED = 'The user paused you, so your browser and desktop tools do not act. Wait until you are resumed.';
export const SHARED_SCREEN_IN_USE =
  'The user has control of the shared screen, so the browser and desktop tools are paused. Wait until they hand it back.';

export interface ComputerControlOptions {
  computers: ComputerManager;
  repos: Repos;
  vnc?: VncControl;
  now?: () => number;
  takeoverWaitMs?: number;
  maxParkMs?: number;
}

export class ComputerControlService {
  private entries = new Map<string, Entry>();
  private handBackWaiters = new Map<string, (h: HandBack) => void>();
  private unpauseWaiters = new Map<string, (() => void)[]>();
  private notes = new Map<string, string>();
  private off: (() => void) | null = null;
  private readonly computers: ComputerManager;
  private readonly repos: Repos;
  private readonly vnc: VncControl;
  private readonly now: () => number;
  readonly takeoverWaitMs: number;
  readonly maxParkMs: number;
  onParkedHandBack?: (botId: string, t: TakeoverRecord, note: string | null) => void;

  constructor(opts: ComputerControlOptions) {
    this.computers = opts.computers;
    this.repos = opts.repos;
    this.vnc = opts.vnc ?? x11vncControl();
    this.now = opts.now ?? Date.now;
    this.takeoverWaitMs = opts.takeoverWaitMs ?? TAKEOVER_WAIT_MS;
    this.maxParkMs = opts.maxParkMs ?? MAX_PARK_MS;
  }

  start() {
    this.off ??= events.onEvent((ev) => {
      if (ev.type === 'computer.state' && ev.status.perBot && ev.status.state === 'live') this.applyViewOnly(ev.status.botId);
    });
    for (const b of this.repos.listBots()) if (this.computers.status(b.id).state === 'live') this.applyViewOnly(b.id);
    if (!this.computers.enabled && DESKTOP_AVAILABLE) this.applyViewOnly(null);
  }
  stop() {
    this.off?.();
    this.off = null;
  }

  get(botId: string): ControlStatus {
    const e = this.entries.get(botId);
    return {
      botId,
      control: e?.control ?? 'agent',
      holder: e?.holder ?? null,
      since: e?.since ?? 0,
      takeover: e?.takeover
        ? { messageId: e.takeover.messageId, roomId: e.takeover.roomId, reason: e.takeover.reason, parked: e.takeover.parked }
        : null,
    };
  }
  list(): ControlStatus[] {
    return [...this.entries.keys()].map((id) => this.get(id));
  }

  blockedReason(botId: string): string | null {
    const c = this.get(botId).control;
    if (c === 'user') return USER_HAS_CONTROL;
    if (c === 'paused') return COMPUTER_PAUSED;
    if (!this.computers.enabled && [...this.entries.values()].some((e) => e.control === 'user')) return SHARED_SCREEN_IN_USE;
    return null;
  }

  viewOnly(scope: string | null): boolean {
    if (scope === null) return ![...this.entries.values()].some((e) => e.control === 'user');
    return this.get(scope).control !== 'user';
  }

  isPaused(botId: string): boolean {
    return this.get(botId).control === 'paused';
  }
  waitUnpaused(botId: string): Promise<void> {
    if (!this.isPaused(botId)) return Promise.resolve();
    return new Promise((resolve) => {
      const list = this.unpauseWaiters.get(botId) ?? [];
      list.push(resolve);
      this.unpauseWaiters.set(botId, list);
    });
  }
  takeNote(botId: string): string | undefined {
    const n = this.notes.get(botId);
    this.notes.delete(botId);
    return n;
  }

  set(botId: string, control: ComputerControl, o: { holder?: string | null; note?: string } = {}): ControlStatus {
    const prev = this.entries.get(botId);
    const was = prev?.control ?? 'agent';
    const entry: Entry = {
      control,
      holder: control === 'agent' ? null : (o.holder ?? prev?.holder ?? null),
      since: this.now(),
      takeover: prev?.takeover ?? null,
    };
    this.entries.set(botId, entry);
    const note = (o.note ?? '').trim();
    if (control === 'agent' && was !== 'agent') {
      if (entry.takeover) this.finishTakeover(botId, entry, note);
      else if (note) this.notes.set(botId, note);
    }
    if (control !== 'paused') {
      const waiters = this.unpauseWaiters.get(botId) ?? [];
      this.unpauseWaiters.delete(botId);
      for (const w of waiters) w();
    }
    if (was !== control) this.applyViewOnly(botId);
    if (!this.computers.enabled && (was === 'user') !== (control === 'user')) this.applyViewOnly(null);
    this.emit(botId);
    return this.get(botId);
  }

  private finishTakeover(botId: string, entry: Entry, note: string) {
    const t = entry.takeover!;
    entry.takeover = null;
    this.updateCard(t, { status: 'done', ...(note ? { note } : {}) });
    const waiter = this.handBackWaiters.get(botId);
    if (waiter) waiter({ kind: 'handed-back', note });
    else if (t.parked) this.onParkedHandBack?.(botId, t, note);
  }

  beginTakeover(botId: string, t: Omit<TakeoverRecord, 'parked' | 'createdAt'>): ControlStatus {
    const prev = this.entries.get(botId);
    if (prev?.takeover && prev.takeover.messageId !== t.messageId) this.updateCard(prev.takeover, { status: 'expired' });
    this.entries.set(botId, {
      control: 'user', holder: prev?.control === 'user' ? prev.holder : null, since: this.now(),
      takeover: { ...t, parked: false, createdAt: this.now() },
    });
    if ((prev?.control ?? 'agent') !== 'user') {
      this.applyViewOnly(botId);
      if (!this.computers.enabled) this.applyViewOnly(null);
    }
    this.emit(botId);
    return this.get(botId);
  }

  waitHandBack(botId: string, signal: AbortSignal): Promise<HandBack> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (h: HandBack) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        if (this.handBackWaiters.get(botId) === finish) this.handBackWaiters.delete(botId);
        resolve(h);
      };
      const onAbort = () => finish({ kind: 'aborted' });
      const timer = setTimeout(() => finish({ kind: 'timeout' }), this.takeoverWaitMs);
      if (signal.aborted) return finish({ kind: 'aborted' });
      signal.addEventListener('abort', onAbort, { once: true });
      this.handBackWaiters.set(botId, finish);
    });
  }

  parkTakeover(botId: string): boolean {
    const e = this.entries.get(botId);
    if (!e?.takeover) return false;
    e.takeover.parked = true;
    this.updateCard(e.takeover, { status: 'parked', ownerRef: e.takeover.ownerRef });
    this.emit(botId);
    return true;
  }

  restoreParked(): number {
    let restored = 0;
    for (const m of this.repos.parkedTakeovers()) {
      const p = m.payload as TakeoverPayload;
      const t: TakeoverRecord = {
        messageId: m.id, roomId: m.roomId, reason: p.reason, causeId: m.causeId ?? '', hop: m.hop, ownerRef: p.ownerRef ?? (p.runId ? 'routine:' + p.runId : null),
        parked: true, createdAt: m.createdAt,
      };
      if (!this.repos.getBot(p.botId)) {
        this.updateCard(t, { status: 'expired' });
        continue;
      }
      const prev = this.entries.get(p.botId)?.takeover;
      if (prev) this.updateCard(prev, { status: 'expired' });
      else restored++;
      this.entries.set(p.botId, { control: 'user', holder: null, since: m.createdAt, takeover: t });
    }
    return restored;
  }

  parkedOwnerRefs(): string[] {
    return [...this.entries.values()].map((e) => (e.takeover?.parked ? e.takeover.ownerRef : null)).filter((id): id is string => !!id);
  }

  dropTakeover(botId: string) {
    const e = this.entries.get(botId);
    if (!e?.takeover || e.takeover.parked) return;
    this.updateCard(e.takeover, { status: 'expired' });
    e.takeover = null;
    this.emit(botId);
  }

  sweep(now = this.now()): string[] {
    const gone: string[] = [];
    for (const [botId, e] of this.entries) {
      const t = e.takeover;
      if (!t || !t.parked || now - t.createdAt < this.maxParkMs) continue;
      e.takeover = null;
      this.updateCard(t, { status: 'expired' });
      this.set(botId, 'agent');
      this.onParkedHandBack?.(botId, t, null);
      gone.push(botId);
    }
    return gone;
  }

  prune(liveBotIds: string[]) {
    const keep = new Set(liveBotIds);
    for (const id of [...this.entries.keys()]) if (!keep.has(id)) this.entries.delete(id);
    for (const id of [...this.notes.keys()]) if (!keep.has(id)) this.notes.delete(id);
  }

  private updateCard(t: TakeoverRecord, patch: Partial<TakeoverPayload>) {
    const cur = this.repos.getMessage(t.messageId);
    if (!cur || cur.kind !== 'takeover') return;
    const payload = { ...(cur.payload as TakeoverPayload), ...patch };
    const updated = this.repos.updateMessage(t.messageId, { payload });
    if (updated) events.emitEvent({ type: 'message.update', id: t.messageId, roomId: t.roomId, patch: { payload: updated.payload } });
  }

  private emit(botId: string) {
    events.emitEvent({ type: 'computer.control', status: this.get(botId) });
  }

  private applyViewOnly(scope: string | null) {
    let ep: ComputerEndpoint | null;
    if (scope === null) ep = this.computers.legacyEndpoint();
    else {
      ep = this.computers.existingEndpoint(scope);
      if (!ep || this.computers.status(scope).state !== 'live') return;
    }
    if (!ep) return;
    const on = this.viewOnly(scope);
    void this.vnc.setViewOnly(ep, on).catch((e) => {
      if (scope !== null) console.warn('[control] x11vnc view-only=' + on + ' failed for ' + scope + ': ' + (e as Error).message);
    });
  }
}
