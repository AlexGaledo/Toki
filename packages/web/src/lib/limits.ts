import type { Bot, ProviderId, ProviderLimitState, ProvidersResponse } from '@pocketrocket/shared';

export function activeLimits(limits: readonly ProviderLimitState[], now: number): ProviderLimitState[] {
  return limits.filter((l) => l.until > now);
}

export function botProvider(bot: Pick<Bot, 'provider'>, defaultProvider: ProviderId): ProviderId {
  return bot.provider ?? defaultProvider;
}

export function usesApiKey(providers: ProvidersResponse | null, id: ProviderId): boolean {
  return providers?.providers.find((p) => p.id === id)?.check.auth === 'apiKey';
}

export function heldLimitFor(bot: Pick<Bot, 'provider' | 'model'>, defaultProvider: ProviderId, limits: readonly ProviderLimitState[]): ProviderLimitState | null {
  const provider = botProvider(bot, defaultProvider);
  const hits = limits.filter((l) => l.status === 'held' && l.provider === provider && (!l.model || l.model === bot.model));
  return hits.reduce<ProviderLimitState | null>((a, l) => (!a || l.until > a.until ? l : a), null);
}

export function allOnClaude(members: readonly Pick<Bot, 'provider'>[], defaultProvider: ProviderId): boolean {
  return members.every((b) => botProvider(b, defaultProvider) === 'claude');
}

export function heldGroups<B extends Pick<Bot, 'provider' | 'model'>>(
  members: readonly B[],
  defaultProvider: ProviderId,
  limits: readonly ProviderLimitState[],
  providers: ProvidersResponse | null,
): { limit: ProviderLimitState; bots: B[] }[] {
  const groups: { limit: ProviderLimitState; bots: B[] }[] = [];
  for (const b of members) {
    const l = heldLimitFor(b, defaultProvider, limits);
    if (!l || usesApiKey(providers, l.provider)) continue;
    const g = groups.find((x) => x.limit === l);
    if (g) g.bots.push(b);
    else groups.push({ limit: l, bots: [b] });
  }
  return groups;
}

export function planMeters(limits: readonly ProviderLimitState[], providers: ProvidersResponse | null): ProviderLimitState[] {
  return limits.filter((l) => l.kind === 'usage' && (l.status === 'held' || l.utilization != null) && !usesApiKey(providers, l.provider));
}

const WINDOW_LABEL: Record<string, string> = {
  five_hour: '5-hour limit',
  seven_day: 'weekly limit',
  seven_day_opus: 'weekly Opus limit',
  seven_day_sonnet: 'weekly Sonnet limit',
  overage: 'extra usage limit',
};

export function windowLabel(window: string | undefined): string {
  return (window && WINDOW_LABEL[window]) || 'usage limit';
}

export function limitName(l: Pick<ProviderLimitState, 'window'>, providerLabel: string): string {
  return providerLabel + ' ' + windowLabel(l.window);
}

/** Claude is believed to report 0..1 (not yet confirmed on Max), so a value above 1 is already a percentage. */
export function limitPercent(l: Pick<ProviderLimitState, 'utilization' | 'status'>): number {
  const u = l.utilization;
  if (u == null || !Number.isFinite(u)) return l.status === 'held' ? 100 : 0;
  const pct = u > 1 ? u : u * 100;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

export function fmtReset(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (new Date(now).toDateString() === d.toDateString()) return time;
  if (ts - now < 6 * 24 * 3600_000) return d.toLocaleDateString([], { weekday: 'short' }) + ' ' + time;
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ' ' + time;
}

export function resetPhrase(l: Pick<ProviderLimitState, 'resetsAt'>, now = Date.now()): string | null {
  return l.resetsAt ? 'resets ' + fmtReset(l.resetsAt, now) : null;
}
