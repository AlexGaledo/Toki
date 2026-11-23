import type { ContextUsage } from '@pocketrocket/shared';
import { laneKey } from './queue';

export type Contexts = Record<string, ContextUsage>;

export const contextKey = laneKey;

export function applyContext(contexts: Contexts, botId: string, roomId: string, usage: ContextUsage | undefined): Contexts {
  const key = contextKey(botId, roomId);
  if (usage) return { ...contexts, [key]: usage };
  if (!(key in contexts)) return contexts;
  const next = { ...contexts };
  delete next[key];
  return next;
}

export function replaceRoomContexts(contexts: Contexts, roomId: string, byBot: Record<string, ContextUsage>): Contexts {
  const suffix = ':' + roomId;
  const next: Contexts = {};
  for (const [key, u] of Object.entries(contexts)) if (!key.endsWith(suffix)) next[key] = u;
  for (const [botId, u] of Object.entries(byBot)) next[contextKey(botId, roomId)] = u;
  return next;
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return +(n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return Math.round(n / 1_000) + 'k';
  return String(Math.round(n));
}

export function contextMeterProps(u: ContextUsage): { value: number; detail: string; marker?: { value: number; label: string } } {
  const pct = (n: number) => (u.window > 0 ? (n / u.window) * 100 : 0);
  return {
    value: pct(u.contextTokens),
    detail: fmtTokens(u.contextTokens) + ' of ' + fmtTokens(u.window) + ' tokens',
    ...(u.rotateAt != null && u.rotateAt < u.window ? { marker: { value: pct(u.rotateAt), label: 'a fresh session starts at ' + fmtTokens(u.rotateAt) } } : {}),
  };
}
