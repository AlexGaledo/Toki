import type { TurnResult } from '../agent/BotRunner.js';

export const routineRef = (runId: string): string => 'routine:' + runId;
export const workflowRef = (runId: string, nodeId: string): string => 'workflow:' + runId + ':' + nodeId;

export type ParsedOwnerRef =
  | { kind: 'routine'; runId: string }
  | { kind: 'workflow'; runId: string; nodeId: string };

export function parseOwnerRef(ref: string | null | undefined): ParsedOwnerRef | null {
  if (!ref) return null;
  const [kind, a, b, ...rest] = ref.split(':');
  if (rest.length) return null;
  if (kind === 'routine' && a && b === undefined) return { kind, runId: a };
  if (kind === 'workflow' && a && b) return { kind, runId: a, nodeId: b };
  return null;
}

export interface OwnerHandler {
  onDone(ref: ParsedOwnerRef, result: TurnResult): void;
  onGone(ref: ParsedOwnerRef, reason: string): void;
  onSteer?(ref: ParsedOwnerRef, steer: { at: number; text: string }): void;
}
