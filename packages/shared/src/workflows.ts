import { z } from 'zod';

export const WORKFLOW_NODE_KINDS = ['trigger', 'agent', 'approval', 'output'] as const;
export type WorkflowNodeKind = (typeof WORKFLOW_NODE_KINDS)[number];

const Ui = z.object({ x: z.number(), y: z.number() }).optional();
const NodeId = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/, 'Step ids use letters, digits, - and _ only');

export const WorkflowTriggerNodeSchema = z.object({
  id: NodeId, kind: z.literal('trigger'), ui: Ui,
  routineId: z.string().min(1).nullable().default(null),
  triggerId: z.string().min(1).nullable().default(null),
  manual: z.boolean().default(false),
});
export const WorkflowAgentNodeSchema = z.object({
  id: NodeId, kind: z.literal('agent'), ui: Ui,
  botId: z.string().min(1),
  prompt: z.string().min(1).max(8000),
});
export const WorkflowApprovalNodeSchema = z.object({
  id: NodeId, kind: z.literal('approval'), ui: Ui,
  title: z.string().min(1).max(200),
});
export const WorkflowOutputNodeSchema = z.object({
  id: NodeId, kind: z.literal('output'), ui: Ui,
  target: z.enum(['room', 'file']),
  path: z.string().max(300).optional(),
});
export const WorkflowNodeSchema = z.discriminatedUnion('kind', [
  WorkflowTriggerNodeSchema, WorkflowAgentNodeSchema, WorkflowApprovalNodeSchema, WorkflowOutputNodeSchema,
]);
export type WorkflowNode = z.infer<typeof WorkflowNodeSchema>;

export const WorkflowEdgeSchema = z.object({ from: NodeId, to: NodeId });
export type WorkflowEdge = z.infer<typeof WorkflowEdgeSchema>;

export const WorkflowGraphSchema = z.object({
  nodes: z.array(WorkflowNodeSchema).min(2).max(30),
  edges: z.array(WorkflowEdgeSchema).max(30),
});
export type WorkflowGraph = z.infer<typeof WorkflowGraphSchema>;

export function linearOrder(g: WorkflowGraph): { ok: true; order: WorkflowNode[] } | { ok: false; error: string } {
  const byId = new Map<string, WorkflowNode>();
  for (const n of g.nodes) {
    if (byId.has(n.id)) return { ok: false, error: 'Two steps share the id "' + n.id + '".' };
    byId.set(n.id, n);
  }
  const triggers = g.nodes.filter((n) => n.kind === 'trigger');
  if (triggers.length !== 1) return { ok: false, error: 'A workflow needs exactly one trigger step.' };
  const next = new Map<string, string>();
  const prev = new Map<string, string>();
  for (const e of g.edges) {
    if (!byId.has(e.from) || !byId.has(e.to)) return { ok: false, error: 'A connection points at a step that does not exist.' };
    if (e.from === e.to) return { ok: false, error: 'A step cannot lead to itself.' };
    if (next.has(e.from)) return { ok: false, error: 'Workflows are a single path for now: a step can lead to only one next step.' };
    if (prev.has(e.to)) return { ok: false, error: 'Workflows are a single path for now: a step can follow only one step.' };
    next.set(e.from, e.to);
    prev.set(e.to, e.from);
  }
  const t = triggers[0];
  if (prev.has(t.id)) return { ok: false, error: 'Nothing can come before the trigger.' };
  const order: WorkflowNode[] = [t];
  const seen = new Set([t.id]);
  for (let cur = next.get(t.id); cur; cur = next.get(cur)) {
    if (seen.has(cur)) return { ok: false, error: 'The steps loop back on themselves.' };
    seen.add(cur);
    order.push(byId.get(cur)!);
  }
  if (order.length !== g.nodes.length) return { ok: false, error: 'Every step must be connected in one line from the trigger.' };
  if (order.length < 2) return { ok: false, error: 'Add at least one step after the trigger.' };
  if (order[1].kind === 'approval') return { ok: false, error: 'An approval step needs a step before it to approve.' };
  const tr = t as z.infer<typeof WorkflowTriggerNodeSchema>;
  const sources = [tr.routineId ? 1 : 0, tr.triggerId ? 1 : 0, tr.manual ? 1 : 0].reduce((a, b) => a + b, 0);
  if (sources !== 1) return { ok: false, error: 'The trigger step needs exactly one of: a routine, an event trigger, or Run now only.' };
  return { ok: true, order };
}

export const WorkflowInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  enabled: z.boolean().default(true),
  roomId: z.string().min(1),
  graph: WorkflowGraphSchema,
  budgetUsd: z.number().positive().max(50).default(2),
});
export type WorkflowInput = z.infer<typeof WorkflowInputSchema>;
export const WorkflowPatchSchema = WorkflowInputSchema.partial();
export type WorkflowPatch = z.infer<typeof WorkflowPatchSchema>;

export interface Workflow {
  id: string;
  name: string;
  enabled: boolean;
  roomId: string;
  graph: WorkflowGraph;
  budgetUsd: number;
  createdAt: number;
  updatedAt: number;
  lastRun: WorkflowRunSummary | null;
}

export const WORKFLOW_RUN_STATUSES = ['running', 'waiting', 'success', 'error', 'cancelled'] as const;
export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUSES)[number];

export type WorkflowStepStatus = 'pending' | 'running' | 'waiting' | 'done' | 'failed' | 'skipped';

export interface WorkflowStepResult {
  nodeId: string;
  status: WorkflowStepStatus;
  output: string | null;
  costUsd: number;
  startedAt: number | null;
  endedAt: number | null;
  steers?: { at: number; text: string }[];
  sentBackNote?: string | null;
}

export interface WorkflowRunSummary {
  id: string;
  workflowId: string;
  status: WorkflowRunStatus;
  nodeId: string | null;
  costUsd: number;
  startedAt: number;
  endedAt: number | null;
  error?: string | null;
  manual: boolean;
}
export interface WorkflowRun extends WorkflowRunSummary {
  steps: WorkflowStepResult[];
}

export interface WorkflowApprovalCard {
  runId: string;
  workflowId: string;
  workflowName: string;
  nodeId: string;
  title: string;
  draft: string;
  canSendBack: boolean;
  expiresAt: number;
}
export const WorkflowDecisionSchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('approve') }),
  z.object({ decision: z.literal('reject'), note: z.string().max(2000).optional() }),
  z.object({ decision: z.literal('send_back'), note: z.string().trim().min(1).max(2000) }),
]);
export type WorkflowDecision = z.infer<typeof WorkflowDecisionSchema>;
