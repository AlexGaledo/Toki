import type { ProjectInfo } from './api';

export function projectOfRoom(projects: readonly ProjectInfo[], roomId: string | null | undefined): ProjectInfo | null {
  if (!roomId) return null;
  return projects.find((p) => p.roomId === roomId) ?? null;
}

export async function fetchProjects(list: () => Promise<ProjectInfo[]>): Promise<ProjectInfo[]> {
  try {
    const projects = await list();
    return Array.isArray(projects) ? projects : [];
  } catch {
    return [];
  }
}
