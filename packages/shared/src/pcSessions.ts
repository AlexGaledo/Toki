import { z } from 'zod';
import type { PcSessionLink } from './projectRepos.js';

export const PC_ENTRY_KINDS = ['user', 'assistant', 'tool_use', 'tool_result', 'summary'] as const;
export type PcEntryKind = (typeof PC_ENTRY_KINDS)[number];

export const PC_ENTRY_TEXT_CAPS: Record<PcEntryKind, number> = {
  user: 8000,
  assistant: 8000,
  tool_use: 400,
  tool_result: 1000,
  summary: 2000,
};
export const PC_SESSION_MAX_TEXT_BYTES = 5 * 1024 * 1024;
export const PC_MIRROR_MAX_BYTES = 400 * 1024 * 1024;
export const PC_MIRROR_RETENTION_DAYS = 90;
export const PC_BATCH_MAX_ENTRIES = 500;
export const PC_LIVE_MS = 10 * 60_000;
export const PC_SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;

export const PcEntrySchema = z.object({
  uuid: z.string().min(1).max(200),
  parentUuid: z.string().max(200).nullable().optional(),
  at: z.number().finite(),
  kind: z.enum(PC_ENTRY_KINDS),
  text: z.string(),
  tool: z.string().max(200).optional(),
  isError: z.boolean().optional(),
  isSidechain: z.boolean().optional(),
  model: z.string().max(200).optional(),
});
export type PcEntry = z.infer<typeof PcEntrySchema>;
export type PcStoredEntry = PcEntry & { seq: number; machine?: string };

export const PcRepoSchema = z.object({
  name: z.string().max(300),
  remote: z.string().max(500).nullable(),
  branch: z.string().max(300).nullable(),
  head: z.string().max(100).nullable(),
});
export type PcRepo = z.infer<typeof PcRepoSchema>;

export const PcSessionPutSchema = z.object({
  machine: z.string().min(1).max(100),
  parentId: z.string().regex(PC_SESSION_ID_RE).nullable().optional(),
  projectDir: z.string().max(1000),
  cwd: z.string().max(1000).nullable(),
  repo: PcRepoSchema.nullable(),
  title: z.string().max(1000).nullable(),
  firstAt: z.number().finite(),
  lastAt: z.number().finite(),
});
export type PcSessionPut = z.infer<typeof PcSessionPutSchema>;

export const PcEntriesPostSchema = z.object({
  from: z.number().int().min(0),
  to: z.number().int().min(0),
  entries: z.array(PcEntrySchema).max(PC_BATCH_MAX_ENTRIES),
});
export type PcEntriesPost = z.infer<typeof PcEntriesPostSchema>;

export interface PcSessionSummary {
  id: string;
  parentId: string | null;
  machine: string;
  projectDir: string;
  cwd: string | null;
  repo: PcRepo | null;
  title: string | null;
  firstAt: number;
  lastAt: number;
  entryCount: number;
  bytes: number;
  truncated: boolean;
  status: 'live' | 'ended';
  links: PcSessionLink[];
  move?: PcSessionMove | null;
}

export const PC_MOVE_STATES = ['moving', 'on-vps', 'pulling', 'local'] as const;
export type PcMoveState = (typeof PC_MOVE_STATES)[number];

export interface PcSessionMove {
  state: PcMoveState;
  room: string | null;
  project: string | null;
  repos: { project: string; repo: string; branch: string }[];
  worktree: string | null;
  movedAt: number;
  pulledAt: number | null;
  turnRunning: boolean;
}

export const PcContinueSchema = z.object({ prompt: z.string().min(1).max(8000) });
export type PcContinue = z.infer<typeof PcContinueSchema>;

export const PC_OFFLOAD_MAX_CONTEXT_TOKENS = 120_000;
export const PC_OFFLOAD_MODEL = 'claude-sonnet-5-5';

export type PcSessionDetail = PcSessionSummary & { children: PcSessionSummary[] };

export interface PcSessionUpdatedEvent {
  type: 'pc_session_updated';
  id: string;
  lastAt: number;
}
