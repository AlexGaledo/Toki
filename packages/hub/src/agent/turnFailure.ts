import { TURN_FAILURE_BEHAVIOUR, type TurnFailurePayload } from '@pocketrocket/shared';
import type { TurnLimit } from '../providers/types.js';

const EXTERNAL = new RegExp(
  [
    'interrupted', 'aborted',
    'not logged in', 'not signed in', 'signed out', 'please (?:log|sign) in', 'authenticat', 'unauthori[sz]ed', 'api key',
    'budget', 'credit balance', 'usage limit', 'rate.?limit', 'quota', 'overloaded',
    'failed to start', 'executable not found', 'claude update', 'econn', 'etimedout', 'enotfound', 'fetch failed', 'network',
  ].join('|'),
  'i',
);

export interface FailureLimit extends TurnLimit {
  provider: string;
}

const WINDOWS: Record<string, string> = {
  five_hour: '5-hour',
  seven_day: 'weekly',
  seven_day_opus: 'weekly Opus',
  seven_day_sonnet: 'weekly Sonnet',
  seven_day_overage_included: 'weekly',
  overage: 'extra usage',
};

export function resetTime(resetsAt: number, now = Date.now(), timeZone?: string): string {
  const fmt = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { timeZone, ...o }).format(resetsAt);
  const time = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(resetsAt);
  const day = (t: number) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(t);
  if (day(resetsAt) === day(now)) return time;
  if (resetsAt - now < 6 * 24 * 3600_000) return fmt({ weekday: 'short' }) + ' ' + time;
  return fmt({ month: 'short', day: 'numeric' }) + ' ' + time;
}

export function limitText(limit: FailureLimit, now = Date.now(), timeZone?: string): string {
  const who = limit.provider;
  if (limit.kind === 'usage') {
    const win = limit.window ? WINDOWS[limit.window] : undefined;
    return who + ' ' + (win ? win + ' ' : 'usage ') + 'limit reached' +
      (limit.resetsAt && limit.resetsAt > now ? ', resets ' + resetTime(limit.resetsAt, now, timeZone) : '');
  }
  if (limit.kind === 'overloaded') return who + ' is overloaded right now; try again in a few minutes';
  if (limit.kind === 'auth') return who + ' sign-in failed; sign in again on the hub';
  return who + ' could not be reached';
}

export function turnFailureNote(
  botName: string, error: string, aborted: boolean, limit?: FailureLimit, now?: number, timeZone?: string,
): { text: string; payload: TurnFailurePayload } {
  if (limit) return { text: botName + ' turn ended: ' + limitText(limit, now, timeZone) + '.', payload: { turnFailure: 'external' } };
  return {
    text: botName + ' turn ended: ' + error,
    payload: { turnFailure: aborted || EXTERNAL.test(error) ? 'external' : TURN_FAILURE_BEHAVIOUR },
  };
}
