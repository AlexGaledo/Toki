import type { Bot, DeliveryPayload, Message, ProvidersResponse, QueueReason, SendMode, Settings } from '@pocketrocket/shared';

export interface DeliveryLine { botId: string; text: string; steered: boolean }

export function deliveryOf(m: Pick<Message, 'authorType' | 'payload'>): DeliveryPayload | null {
  if (m.authorType !== 'user' || !m.payload || typeof m.payload !== 'object') return null;
  const p = m.payload as DeliveryPayload;
  const steered = p.steered && typeof p.steered === 'object' ? p.steered : undefined;
  const queued = p.queued && typeof p.queued === 'object' ? p.queued : undefined;
  if (!(steered && Object.keys(steered).length) && !(queued && Object.keys(queued).length)) return null;
  return { ...(steered ? { steered } : {}), ...(queued ? { queued } : {}) };
}

function queuedText(name: string, reason: QueueReason | undefined, providerLabel: string | null): string {
  switch (reason) {
    case 'provider': return 'Queued: ' + (providerLabel ?? name) + " can't take messages mid-task";
    case 'between-runs': return 'Queued: ' + name + ' was between steps';
    case 'requeued': return 'Queued: ' + name + ' answers this next';
    case 'paused': return 'Queued: ' + name + "'s queue was paused";
    default: return 'Queued for after ' + name + "'s reply";
  }
}

export function deliveryLines(p: DeliveryPayload, bots: Pick<Bot, 'id' | 'name'>[], providerLabel: string | null = null): DeliveryLine[] {
  const name = (id: string) => bots.find((b) => b.id === id)?.name ?? 'The bot';
  const queued = p.queued ?? {};
  const out: DeliveryLine[] = [];
  for (const id of Object.keys(p.steered ?? {})) if (!queued[id]) out.push({ botId: id, text: 'Joined ' + name(id) + "'s reply", steered: true });
  for (const [id, q] of Object.entries(queued)) out.push({ botId: id, text: queuedText(name(id), q?.reason, providerLabel), steered: false });
  return out;
}

export function canSteer(providers: ProvidersResponse | null, settings: Pick<Settings, 'provider'>): boolean {
  return !!providers?.providers.find((p) => p.id === (settings.provider ?? providers.active))?.steer;
}

export function sendKey(e: { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): { mode?: SendMode } | null {
  if (e.key !== 'Enter' || e.shiftKey || e.altKey) return null;
  return e.ctrlKey || e.metaKey ? { mode: 'queue' } : {};
}

export function showSendChoice(busyBotIds: readonly string[], steerable: (botId: string) => boolean): boolean {
  return busyBotIds.some(steerable);
}

export function earlierTurns(groups: readonly { items: readonly Pick<Message, 'turnId'>[] }[]): Set<string>[] {
  const seen = new Set<string>();
  return groups.map((g) => {
    const before = new Set(seen);
    for (const m of g.items) if (m.turnId) seen.add(m.turnId);
    return before;
  });
}
