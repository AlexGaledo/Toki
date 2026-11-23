import type { Bot, Room } from '@pocketrocket/shared';
import type { ProjectInfo } from './api';
import type { BotStatus } from './botStatus';

export interface ProjectNode {
  project: ProjectInfo;
  room: Room | null;
  bots: Bot[];
  active: boolean;
  hiddenBots: number;
}

export interface RoomNode {
  room: Room;
  bots: Bot[];
  hiddenBots: number;
}

export interface ProjectTree {
  projects: ProjectNode[];
  rooms: RoomNode[];
  solo: Bot[];
  hiddenSolo: number;
  hidden: number;
}

export interface ProjectTreeInput {
  projects: readonly ProjectInfo[];
  rooms: readonly Room[];
  bots: readonly Bot[];
  statusOf: (botId: string) => BotStatus;
  activeRoomId: string | null;
  podiumIds?: ReadonlySet<string>;
  showPaused: boolean;
}

export function buildProjectTree({ projects, rooms, bots, statusOf, activeRoomId, podiumIds = new Set(), showPaused }: ProjectTreeInput): ProjectTree {
  const byId = new Map(bots.map((b) => [b.id, b]));
  const groups = rooms.filter((r) => r.kind === 'group');
  const roomById = new Map(groups.map((r) => [r.id, r]));
  const activeDmBot = rooms.find((r) => r.id === activeRoomId && r.kind === 'dm')?.memberIds[0] ?? null;

  const live = (id: string) => statusOf(id) !== 'paused';
  let hidden = 0;

  const listed = (ids: readonly string[]): { bots: Bot[]; hiddenBots: number } => {
    const all = ids.map((id) => byId.get(id)).filter((b): b is Bot => !!b && !podiumIds.has(b.id));
    const shown = all.filter((b) => showPaused || live(b.id) || b.id === activeDmBot);
    return { bots: shown, hiddenBots: all.length - shown.length };
  };
  const anyLive = (ids: readonly string[]) => ids.some((id) => byId.has(id) && live(id));

  const linked = new Set<string>();
  const projectNodes: ProjectNode[] = [];
  for (const project of projects) {
    const room = project.roomId ? roomById.get(project.roomId) ?? null : null;
    if (room) linked.add(room.id);
    const ids = room ? room.memberIds : project.memberIds;
    const active = !!room && room.id === activeRoomId;
    const holdsOpenDm = !!activeDmBot && ids.includes(activeDmBot);
    if (!showPaused && !active && !holdsOpenDm && !anyLive(ids)) { hidden++; continue; }
    projectNodes.push({ project, room, active, ...listed(ids) });
  }

  const roomNodes: RoomNode[] = [];
  for (const room of groups) {
    if (linked.has(room.id)) continue;
    const holdsOpenDm = !!activeDmBot && room.memberIds.includes(activeDmBot);
    if (!showPaused && room.id !== activeRoomId && !holdsOpenDm && !anyLive(room.memberIds)) { hidden++; continue; }
    roomNodes.push({ room, ...listed(room.memberIds) });
  }

  const inAnyGroup = new Set(groups.flatMap((r) => r.memberIds));
  const solo = listed(bots.filter((b) => !inAnyGroup.has(b.id)).map((b) => b.id));

  return { projects: projectNodes, rooms: roomNodes, solo: solo.bots, hiddenSolo: solo.hiddenBots, hidden };
}
