import { z } from 'zod';

export const SECRET_PLACEHOLDER = '«secret»';

export interface RecordingInfo {
  id: string;
  botId: string;
  title: string;
  startedAt: number;
  endedAt: number | null;
  state: 'recording' | 'stopped';
  events: number;
  frames: number;
  framesDropped: number;
  bytes: number;
  capped: string[];
  skillId: string | null;
  error?: string;
}

export interface RecorderStatus {
  botId: string;
  available: boolean;
  reason?: string;
  active: RecordingInfo | null;
}

export interface TraceEvent {
  ts: number;
  t: 'start' | 'nav' | 'click' | 'type' | 'change' | 'key' | 'submit' | 'download' | 'window' | 'frame' | 'cap' | 'stop';
  [k: string]: unknown;
}

export type SkillVersionOrigin = 'demo' | 'correction' | 'reflection' | 'bot';
export type SkillVersionStatus = 'pending' | 'approved' | 'rejected';

export interface SkillVersion {
  id: string;
  skillId: string;
  version: number;
  status: SkillVersionStatus;
  origin: SkillVersionOrigin;
  note: string;
  createdByBot: string | null;
  createdAt: number;
  decidedAt: number | null;
}

export interface DiffLine {
  op: ' ' | '+' | '-';
  text: string;
}

export interface SkillVersionDetail extends SkillVersion {
  markdown: string;
  base: string;
  diff: DiffLine[];
  stale: boolean;
}

export interface SkillReflectionConfig {
  botId: string;
  enabled: boolean;
  every: number;
  dailyCapUsd: number;
}

export const REFLECTION_EVERY = { min: 1, max: 100, default: 5 } as const;
export const REFLECTION_DAILY_CAP = { min: 0.01, max: 2, default: 0.25 } as const;

export const RecorderStartSchema = z.object({ title: z.string().max(120).optional() });
export const DistillInputSchema = z.object({
  name: z.string().max(49).optional(),
  hint: z.string().max(1000).optional(),
});
export const SkillCorrectionSchema = z.object({ text: z.string().min(3).max(2000) });
export const SkillVersionDecisionSchema = z.object({ decision: z.enum(['approve', 'reject']) });
export const SkillReflectionPatchSchema = z.object({
  enabled: z.boolean().optional(),
  every: z.number().int().min(REFLECTION_EVERY.min).max(REFLECTION_EVERY.max).optional(),
  dailyCapUsd: z.number().min(REFLECTION_DAILY_CAP.min).max(REFLECTION_DAILY_CAP.max).optional(),
});
