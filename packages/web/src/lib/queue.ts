import type { LaneQueue, QueueItem } from '@pocketrocket/shared';

export type Queues = Record<string, LaneQueue>;

export const laneKey = (botId: string, roomId: string) => botId + ':' + roomId;

export function laneShows(q: Pick<LaneQueue, 'items' | 'paused'>): boolean {
  return q.items.length > 0 || q.paused;
}

export function applyLaneQueue(queues: Queues, q: LaneQueue): Queues {
  const key = laneKey(q.botId, q.roomId);
  if (laneShows(q)) return { ...queues, [key]: q };
  if (!(key in queues)) return queues;
  const next = { ...queues };
  delete next[key];
  return next;
}

export function replaceRoomQueues(queues: Queues, roomId: string, lanes: LaneQueue[]): Queues {
  let next: Queues = {};
  for (const [key, q] of Object.entries(queues)) if (q.roomId !== roomId) next[key] = q;
  for (const q of lanes) if (q.roomId === roomId) next = applyLaneQueue(next, q);
  return next;
}

export function roomLanes(queues: Queues, roomId: string, memberIds: readonly string[]): LaneQueue[] {
  const out: LaneQueue[] = [];
  for (const id of memberIds) {
    const q = queues[laneKey(id, roomId)];
    if (q) out.push(q);
  }
  return out;
}

export function countWords(n: number): string {
  return n + (n === 1 ? ' message' : ' messages');
}

export function itemSource(item: Pick<QueueItem, 'kind' | 'authorType' | 'authorId'>, name: (botId: string) => string | undefined): string | null {
  switch (item.kind) {
    case 'message': return item.authorType === 'user' ? null : 'From ' + (item.authorId ? name(item.authorId) ?? 'a bot' : 'a bot');
    case 'handoff': return 'Hand-off' + (item.authorId && name(item.authorId) ? ' from ' + name(item.authorId) : '');
    case 'routine': return 'Routine';
    case 'trigger': return 'Trigger';
    case 'followup': return 'Follow-up from the hub';
    default: return null;
  }
}

export function editRefusalText(item: Pick<QueueItem, 'editable' | 'editRefusal' | 'authorType'>): string | null {
  if (item.editable || item.authorType !== 'user') return null;
  return "Can't edit: " + lowerFirst(item.editRefusal?.trim() || 'a bot has started on it.');
}

function lowerFirst(s: string): string {
  return s ? s[0].toLowerCase() + s.slice(1) : s;
}
