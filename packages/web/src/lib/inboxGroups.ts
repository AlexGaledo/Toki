import type { ProjectInfo } from './api';
import { projectOfRoom } from './projects';

export interface InboxGroup<T> {
  project: ProjectInfo | null;
  items: T[];
}

export function groupByProject<T extends { roomId: string | null }>(items: readonly T[], projects: readonly ProjectInfo[]): InboxGroup<T>[] {
  const byProject = new Map<string, T[]>();
  const other: T[] = [];
  for (const it of items) {
    const p = projectOfRoom(projects, it.roomId);
    if (!p) { other.push(it); continue; }
    const list = byProject.get(p.slug);
    if (list) list.push(it); else byProject.set(p.slug, [it]);
  }
  const groups: InboxGroup<T>[] = projects.filter((p) => byProject.has(p.slug)).map((p) => ({ project: p, items: byProject.get(p.slug)! }));
  if (other.length) groups.push({ project: null, items: other });
  return groups;
}
