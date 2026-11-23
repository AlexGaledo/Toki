import { getItem, setItem } from './persist';
import type { Bot, BotState, ControlStatus, Message, Room, ToolPayload } from '@pocketrocket/shared';

export type ScreenSize = 'glance' | 'watch' | 'focus';

export function deviceId(): string {
  let id = getItem('pocketrocket.deviceId');
  if (!id) {
    id = 'web-' + Math.random().toString(36).slice(2, 10);
    setItem('pocketrocket.deviceId', id);
  }
  return id;
}

export function holdsScreen(c: ControlStatus | undefined): boolean {
  return c?.control === 'user' && (c.holder === 'recorder' || c.holder === deviceId());
}

export const hasComputer = (b: Bot | undefined) => !!b && (b.allowedTools.includes('Browser') || b.allowedTools.includes('Desktop'));

export const isComputerTool = (name: string) => name.startsWith('mcp__browser__') || name.startsWith('mcp__pocketrocket__desktop_');

export interface ScreenState {
  bots: Bot[];
  rooms: Room[];
  activeRoomId: string | null;
  panelBotId: string | null;
  panelOpen: boolean;
  panelKind?: 'screen' | 'files' | 'overview';
  control: Record<string, ControlStatus>;
  botStates: Record<string, BotState>;
  messages: Record<string, Message[]>;
  streaming: Record<string, unknown>;
}

const BUSY: readonly BotState[] = ['thinking', 'working', 'blocked', 'waiting'];

function hostOf(url: unknown): string {
  if (typeof url !== 'string' || !url) return '';
  try {
    return new URL(url.includes('://') ? url : 'https://' + url).hostname;
  } catch {
    return '';
  }
}

export function computerUse(botId: string, s: ScreenState): string | null {
  if (s.control[botId]?.takeover) return 'Waiting for you';
  const st = s.botStates[botId];
  const list = s.activeRoomId ? s.messages[s.activeRoomId] : undefined;
  if (!st || !BUSY.includes(st) || !list) return null;
  let turn: string | null | undefined;
  let open = false;
  let used = false;
  let site = '';
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (m.authorId !== botId || m.kind !== 'tool') continue;
    const p = m.payload as ToolPayload;
    if (turn === undefined) {
      turn = m.turnId;
      open = !p.done;
    } else if (m.turnId !== turn) break;
    if (isComputerTool(p.name)) {
      used = true;
      site ||= hostOf((p.input as { url?: unknown } | null)?.url);
    }
  }
  if (!used || !(open || (turn && s.streaming[turn]))) return null;
  return site ? 'Browsing ' + site : 'Using its screen';
}

const watching = (s: ScreenState) => s.panelOpen && (s.panelKind ?? 'screen') === 'screen';

export function selectScreenBotId(s: ScreenState): string | null {
  const held = s.bots.filter((b) => holdsScreen(s.control[b.id]));
  if (held.length) return (held.find((b) => b.id === s.panelBotId) ?? held[0]).id;
  const room = s.rooms.find((r) => r.id === s.activeRoomId);
  if (!room) return s.panelBotId ?? s.bots[0]?.id ?? null;
  const picked = s.panelBotId && room.memberIds.includes(s.panelBotId) ? s.panelBotId : room.memberIds[0] ?? null;
  if (room.kind === 'group' && !watching(s) && !(picked && computerUse(picked, s))) {
    return room.memberIds.find((id) => computerUse(id, s)) ?? picked;
  }
  return picked;
}

export function selectScreenSize(s: ScreenState): ScreenSize {
  const id = selectScreenBotId(s);
  if (id && holdsScreen(s.control[id])) return 'focus';
  return watching(s) ? 'watch' : 'glance';
}
