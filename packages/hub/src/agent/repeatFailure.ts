import { SUPPORT_HANDLE } from '../services/SeedBots.js';

export const REPEAT_WINDOW_MS = 10 * 60_000;
export const REPEAT_COOLDOWN_MS = 30 * 60_000;

export type FailureKind = 'browser' | 'computer';

export function browserRefusal(toolName: string, output: string): string | null {
  if (!toolName.startsWith('mcp__browser__')) return null;
  const m = /ECONNREFUSED\s+([\w.[\]:-]+:\d+)/.exec(output);
  return m ? 'ECONNREFUSED ' + m[1] : null;
}

export function brokenStart(reason: string): boolean {
  return /could not start|did not come up/i.test(reason);
}

export class RepeatFailureWatch {
  private seen = new Map<string, number[]>();
  private noted = new Map<string, number>();
  private windowMs: number;
  private cooldownMs: number;
  private now: () => number;

  constructor(o: { windowMs?: number; cooldownMs?: number; now?: () => number } = {}) {
    this.windowMs = o.windowMs ?? REPEAT_WINDOW_MS;
    this.cooldownMs = o.cooldownMs ?? REPEAT_COOLDOWN_MS;
    this.now = o.now ?? Date.now;
  }

  record(botId: string, signature: string): boolean {
    const key = botId + '\n' + signature;
    const t = this.now();
    const hits = (this.seen.get(key) ?? []).filter((at) => t - at < this.windowMs);
    hits.push(t);
    this.seen.set(key, hits);
    if (hits.length < 2) return false;
    const last = this.noted.get(key);
    if (last !== undefined && t - last < this.cooldownMs) return false;
    this.noted.set(key, t);
    this.seen.delete(key);
    return true;
  }

  clear(botId: string) {
    for (const key of [...this.seen.keys()]) if (key.startsWith(botId + '\n')) this.seen.delete(key);
  }
}

export function escalationNote(o: { handle: string; kind: FailureKind; error: string; support: boolean }): string {
  const who = o.support ? '@' + SUPPORT_HANDLE : 'Owner';
  const what = o.kind === 'browser' ? 'browser' : 'computer';
  return who + ': @' + o.handle + "'s " + what + ' failed twice in a row with the same error (' + o.error + '). ' +
    'It needs a restart, which the bot cannot do itself: open @' + o.handle + "'s Screen tab and press Wake " +
    '(the hub restarts a computer whose browser stopped answering). Retrying from the bot will not fix it.';
}
