import type { ProjectStub } from '@pocketrocket/shared';
import type { ProjectInfo } from './api';
import { splitProjects, type ProjectListItem } from './hosts';

export function projectOfRoom(projects: readonly ProjectInfo[], roomId: string | null | undefined): ProjectInfo | null {
  if (!roomId) return null;
  return projects.find((p) => p.roomId === roomId) ?? null;
}

/** This hub's projects and the other host's stubs, kept apart (D4). Empty, never an error, when the hub refuses. */
export async function fetchProjects(list: () => Promise<ProjectListItem[]>): Promise<{ local: ProjectInfo[]; stubs: ProjectStub[] }> {
  try {
    return splitProjects(await list());
  } catch {
    return { local: [], stubs: [] };
  }
}
