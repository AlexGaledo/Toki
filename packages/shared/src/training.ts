import { z } from 'zod';

export const TRAINING_CRON = '0 3 * * 0';
/** The CLI checks spend itself, so one call can run slightly over. */
export const TRAINING_PASS_BUDGET_USD = 0.1;
export const TRAINING_WEEKLY_CAP_USD = 0.25;
export const TRAINING_RULE_MAX_CHARS = 300;
export const TRAINING_EVIDENCE_MAX_CHARS = 20_000;
export const MAX_TRAINING_PENDING = 10;

export type TrainingStatus = 'pending' | 'blocked' | 'approved' | 'rejected' | 'undone';

export interface TrainingProposal {
  id: string;
  botId: string;
  status: TrainingStatus;
  rule: string;
  reason: string;
  evidenceSummary: string;
  verifierNote: string;
  inDescription?: boolean;
  createdAt: number;
  decidedAt: number | null;
  undoneAt: number | null;
}

export interface TrainingState {
  botId: string;
  enabled: boolean;
  lastRunAt: number | null;
  proposals: TrainingProposal[];
}

export type TrainingOutcome = 'off' | 'unavailable' | 'no_evidence' | 'pending_full' | 'budget' | 'failed' | 'no_change' | 'proposed' | 'blocked';

export interface TrainingPassResult {
  outcome: TrainingOutcome;
  message: string;
  proposal?: TrainingProposal;
}

export const TrainingPatchSchema = z.object({ enabled: z.boolean() });
export const TrainingDecisionSchema = z.object({ decision: z.enum(['approve', 'reject', 'undo']) });
export type TrainingDecision = z.infer<typeof TrainingDecisionSchema>['decision'];
