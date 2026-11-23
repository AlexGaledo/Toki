import type { PcSyncImport, PcSyncJobInfo, PcSyncResult } from './projectRepos.js';

export type PcJobStatus = 'pending_approval' | 'queued' | 'claimed' | 'running' | 'done' | 'failed' | 'refused' | 'expired' | 'cancelled';

export interface PcRunnerStatus {
  paired: boolean;
  folders: string[];
  lastSeenAt: number | null;
  online: boolean;
}

export type PcJobMode = 'new' | 'resume' | 'sync' | 'move' | 'pull';
export type PcJobOrigin = 'bot' | 'owner';

export interface PcRunnerJob {
  id: string;
  bot: { id: string | null; handle: string | null };
  room: { id: string | null; name: string | null };
  mode: PcJobMode;
  sessionId: string | null;
  origin: PcJobOrigin;
  folder: string | null;
  resolvedFolder: string | null;
  newSessionId: string | null;
  prompt: string;
  status: PcJobStatus;
  output: string | null;
  costUsd: number | null;
  durationMs: number | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  refusedLocally: boolean;
  error: string | null;
  sync: PcSyncJobInfo | null;
  syncResult: PcSyncResult | null;
  hubImport: PcSyncImport | null;
  move: PcMoveJobInfo | null;
  moveResult: PcMoveResult | null;
  pull: PcPullJobInfo | null;
  pullResult: PcPullResult | null;
}

export type PcMoveRepoInfo = PcSyncJobInfo & { mode: 'bundle' };

export interface PcMoveJobInfo {
  room: string | null;
  title: string | null;
  repos: PcMoveRepoInfo[];
}

export interface PcMoveResult {
  repos: { repo: string; commit: string; branch: string; toplevel?: string }[];
  sessionBytes: number;
}

export interface PcPullJobInfo {
  repos: (PcSyncJobInfo & { branch: string; baseCommit: string })[];
  turns: number;
}

export interface PcPullResult {
  repos: { repo: string; commit: string; applied: boolean }[];
  sessionBytes: number;
}

export interface PcRunnerJobCreate {
  mode: PcJobMode;
  sessionId?: string;
  folder?: string;
  prompt?: string;
  project?: string;
  repo?: string;
  room?: string;
}

export const PC_SESSION_UPLOAD_MAX_BYTES = 100 * 1024 * 1024;
