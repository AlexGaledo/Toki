import { randomBytes } from 'node:crypto';
import type { DevicesRepo } from '../db/devices.js';
import type { Repos } from '../db/repos.js';
import { events } from '../events.js';
import { encryptPayload, isPushEndpoint, loadOrCreateVapid, vapidAuthorization, type VapidKeys } from './WebPush.js';

/**
 * What a push can say. That is the entire payload: `{"kind":"approval"}`. The service worker turns the kind
 * into fixed wording ("A bot needs your approval"), so no bot name, room, tool, message text or cost ever
 * leaves the machine through Apple/Google/Mozilla (decision Q10).
 */
export type PushKind = 'approval' | 'routine' | 'test';
export const PUSH_KINDS: readonly PushKind[] = ['approval', 'routine', 'test'];

export function pushPayload(kind: PushKind): Buffer {
  return Buffer.from(JSON.stringify({ kind }));
}

const COALESCE_MS = 30_000;

export interface TelegramSink {
  ready(): boolean;
  notify(kind: PushKind): Promise<void>;
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: Buffer }) => Promise<{ status: number }>;

export interface PushDeps {
  devices: DevicesRepo;
  repos: Repos;
  vapid: () => VapidKeys;
  subject: string;
  fetch?: Fetch;
  now?: () => number;
}

export class PushError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export class PushService {
  private last = new Map<string, number>();
  private telegram: TelegramSink | null = null;
  private turnCause = new Map<string, string>();
  private off: (() => void) | null = null;
  private keys: VapidKeys | null = null;
  private readonly fetch: Fetch;
  private readonly now: () => number;

  constructor(private deps: PushDeps) {
    this.fetch = deps.fetch ?? ((url, init) => fetch(url, { ...init, body: new Uint8Array(init.body) }).then((r) => ({ status: r.status })));
    this.now = deps.now ?? Date.now;
  }

  static withFile(deps: Omit<PushDeps, 'vapid'> & { vapidPath: string }): PushService {
    return new PushService({ ...deps, vapid: () => loadOrCreateVapid(deps.vapidPath) });
  }

  publicKey(): string {
    this.keys ??= this.deps.vapid();
    return this.keys.publicKey;
  }

  subscribe(deviceId: string | null, body: unknown): { ok: true } {
    const b = (body ?? {}) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
    const endpoint = typeof b.endpoint === 'string' ? b.endpoint : '';
    const p256dh = typeof b.keys?.p256dh === 'string' ? b.keys.p256dh : '';
    const auth = typeof b.keys?.auth === 'string' ? b.keys.auth : '';
    if (!isPushEndpoint(endpoint)) throw new PushError(400, 'Not a browser push service endpoint');
    if (!/^[A-Za-z0-9_-]{80,100}$/.test(p256dh) || Buffer.from(p256dh, 'base64url').length !== 65) throw new PushError(400, 'Bad p256dh key');
    if (!/^[A-Za-z0-9_-]{16,32}$/.test(auth)) throw new PushError(400, 'Bad auth secret');
    const existing = this.deps.devices.subscriptions().find((s) => s.endpoint === endpoint);
    if (existing && existing.deviceId !== deviceId) throw new PushError(409, 'That subscription belongs to another device');
    this.deps.devices.upsertSubscription({ id: 'ps_' + randomBytes(8).toString('hex'), deviceId, endpoint, p256dh, auth, now: this.now() });
    return { ok: true };
  }

  unsubscribe(deviceId: string | null, body: unknown): { ok: boolean } {
    const endpoint = typeof (body as { endpoint?: unknown })?.endpoint === 'string' ? (body as { endpoint: string }).endpoint : '';
    return { ok: this.deps.devices.deleteSubscription(endpoint, { deviceId }) };
  }

  status(deviceId: string | null): { publicKey: string; subscriptions: number } {
    return { publicKey: this.publicKey(), subscriptions: this.deps.devices.subscriptions(deviceId).length };
  }

  async send(kind: PushKind, only?: { deviceId: string | null }): Promise<{ sent: number; failed: number }> {
    const subs = only ? this.deps.devices.subscriptions(only.deviceId) : this.deps.devices.subscriptions();
    if (!subs.length) return { sent: 0, failed: 0 };
    let keys: VapidKeys;
    try { keys = this.keys ??= this.deps.vapid(); } catch (e) {
      console.warn('[push] no VAPID key: ' + (e as Error).message);
      return { sent: 0, failed: subs.length };
    }
    const payload = pushPayload(kind);
    let sent = 0;
    let failed = 0;
    await Promise.all(subs.map(async (s) => {
      try {
        const res = await this.fetch(s.endpoint, {
          method: 'POST',
          headers: {
            TTL: kind === 'approval' ? '600' : '3600',
            Urgency: kind === 'approval' ? 'high' : 'normal',
            Topic: kind,
            'Content-Encoding': 'aes128gcm',
            'Content-Type': 'application/octet-stream',
            Authorization: vapidAuthorization(s.endpoint, keys, this.deps.subject, Math.floor(this.now() / 1000)),
          },
          body: encryptPayload(payload, s),
        });
        if (res.status === 404 || res.status === 410) this.deps.devices.deleteSubscription(s.endpoint);
        if (res.status >= 200 && res.status < 300) sent++;
        else failed++;
      } catch {
        failed++;
      }
    }));
    return { sent, failed };
  }

  setTelegram(t: TelegramSink | null): void {
    this.telegram = t;
  }

  notify(kind: Exclude<PushKind, 'test'>): void {
    const t = this.now();
    if (this.gate('web', kind, t, () => this.deps.devices.subscriptions().length > 0)) void this.send(kind);
    const tg = this.telegram;
    if (tg && this.gate('telegram', kind, t, () => tg.ready())) void tg.notify(kind).catch(() => { /* never breaks an approval card */ });
  }

  private gate(sink: string, kind: PushKind, t: number, hasTarget: () => boolean): boolean {
    const key = sink + ':' + kind;
    if (t - (this.last.get(key) ?? -Infinity) < COALESCE_MS) return false;
    if (!hasTarget()) return false;
    this.last.set(key, t);
    return true;
  }

  start(): void {
    this.off = events.onEvent((ev) => {
      if (ev.type === 'approval.request') this.notify('approval');
      else if (ev.type === 'turn.start') {
        if (this.turnCause.size > 500) this.turnCause.clear();
        this.turnCause.set(ev.turnId, ev.causeId);
      }
      else if (ev.type === 'turn.end') {
        const cause = this.turnCause.get(ev.turnId);
        this.turnCause.delete(ev.turnId);
        if (cause && this.deps.repos.getMessage(cause)?.kind === 'routine') this.notify('routine');
      }
    });
  }
  stop(): void {
    this.off?.();
    this.off = null;
    this.turnCause.clear();
  }
}
