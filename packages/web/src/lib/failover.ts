import type { Bot, BotBackup, FailoverActive, FailoverCard, ProviderId, ProviderLimitState, ProvidersResponse, Room } from '@pocketrocket/shared';
import { fmtReset } from './limits';

export function providerLabel(providers: ProvidersResponse | null, id: ProviderId): string {
  return providers?.providers.find((p) => p.id === id)?.label ?? id;
}

export function backupModelLabel(providers: ProvidersResponse | null, b: BotBackup): string {
  return providers?.providers.find((p) => p.id === b.provider)?.models.find((m) => m.id === b.model)?.label ?? b.model;
}

function sameBackup(a: BotBackup | null | undefined, b: BotBackup): boolean {
  return !!a && a.provider === b.provider && a.model === b.model;
}

export function continueBlocker(
  card: FailoverCard,
  ctx: { bot: Bot | undefined; room: Room | undefined; providers: ProvidersResponse | null; limits: readonly ProviderLimitState[]; now: number },
): string | null {
  const { bot, room, providers, limits, now } = ctx;
  const to = providerLabel(providers, card.backup.provider);
  if (!bot || !room || !room.memberIds.includes(bot.id)) return 'That bot is no longer in this chat.';
  if (!sameBackup(bot.backup, card.backup)) return bot.name + "'s backup changed since this card was raised. Send the message again.";
  if (providers && !providers.providers.some((p) => p.id === card.backup.provider)) return to + ' is not enabled on this hub.';
  const held = limits.some((l) => l.status === 'held' && l.until > now && l.provider === card.backup.provider && (!l.model || l.model === card.backup.model));
  if (held) return to + ' is at its own limit right now.';
  return null;
}

export function activeFor(active: readonly FailoverActive[], botId: string, now: number): FailoverActive | null {
  return active.find((a) => a.botId === botId && a.until > now) ?? null;
}

export function onBackupText(a: FailoverActive, providers: ProvidersResponse | null, now = Date.now()): string {
  return 'On ' + providerLabel(providers, a.backup.provider) + ' until ' + fmtReset(a.until, now);
}

export function cardsForRoom(cards: readonly FailoverCard[], roomId: string): FailoverCard[] {
  return cards.filter((c) => c.roomId === roomId).sort((a, b) => a.createdAt - b.createdAt);
}
