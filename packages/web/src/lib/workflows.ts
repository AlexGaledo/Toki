import { create } from 'zustand';
import {
  WorkflowInputSchema, linearOrder,
  type Bot, type Room, type Routine, type Trigger, type Workflow, type WorkflowApprovalCard, type WorkflowGraph, type WorkflowNode,
  type WorkflowNodeKind, type WorkflowRunStatus, type WorkflowRunSummary, type WorkflowStepStatus,
} from '@pocketrocket/shared';
import { api } from './api';

export function stepsOf(g: WorkflowGraph): { steps: WorkflowNode[]; ordered: boolean } {
  const r = linearOrder(g);
  return r.ok ? { steps: r.order, ordered: true } : { steps: g.nodes, ordered: false };
}

export function graphOf(steps: WorkflowNode[]): WorkflowGraph {
  return { nodes: steps, edges: steps.slice(1).map((n, i) => ({ from: steps[i].id, to: n.id })) };
}

export function newStepId(steps: WorkflowNode[], kind: WorkflowNodeKind): string {
  const used = new Set(steps.map((s) => s.id));
  for (let n = 1; ; n++) if (!used.has(kind + '-' + n)) return kind + '-' + n;
}

export function newStep(steps: WorkflowNode[], kind: Exclude<WorkflowNodeKind, 'trigger'>, botId: string): WorkflowNode {
  const id = newStepId(steps, kind);
  if (kind === 'agent') return { id, kind, botId, prompt: '' };
  if (kind === 'approval') return { id, kind, title: 'Approve before continuing' };
  return { id, kind, target: 'room' };
}

export function insertStep(steps: WorkflowNode[], index: number, node: WorkflowNode): WorkflowNode[] {
  const at = Math.min(Math.max(index, 1), steps.length);
  return [...steps.slice(0, at), node, ...steps.slice(at)];
}

export function canMove(steps: WorkflowNode[], index: number, dir: -1 | 1): boolean {
  const to = index + dir;
  return steps[index]?.kind !== 'trigger' && to >= 1 && to < steps.length;
}
export function moveStep(steps: WorkflowNode[], index: number, dir: -1 | 1): WorkflowNode[] {
  if (!canMove(steps, index, dir)) return steps;
  const out = steps.slice();
  [out[index], out[index + dir]] = [out[index + dir], out[index]];
  return out;
}

export function canDuplicate(steps: WorkflowNode[], index: number): boolean {
  return steps[index] !== undefined && steps[index].kind !== 'trigger' && steps.length < 30;
}
export function duplicateStep(steps: WorkflowNode[], index: number): WorkflowNode[] {
  const src = steps[index];
  if (!src || !canDuplicate(steps, index)) return steps;
  const copy = { ...src, id: newStepId(steps, src.kind) } as WorkflowNode;
  return [...steps.slice(0, index + 1), copy, ...steps.slice(index + 1)];
}

export const canDelete = (steps: WorkflowNode[], index: number) => steps[index] !== undefined && steps[index].kind !== 'trigger';
export function removeStep(steps: WorkflowNode[], index: number): WorkflowNode[] {
  return canDelete(steps, index) ? steps.filter((_, i) => i !== index) : steps;
}

export function updateStep(steps: WorkflowNode[], id: string, patch: Partial<WorkflowNode>): WorkflowNode[] {
  return steps.map((s) => (s.id === id ? ({ ...s, ...patch } as WorkflowNode) : s));
}

export const KIND_LABEL: Record<WorkflowNodeKind, string> = { trigger: 'Trigger', agent: 'Bot step', approval: 'Approval', output: 'Output' };

export const STEP_STATUS_LABEL: Record<WorkflowStepStatus, string> = {
  pending: 'Not started', running: 'Running', waiting: 'Waiting', done: 'Done', failed: 'Failed', skipped: 'Skipped',
};
export const STEP_STATUS_TONE: Record<WorkflowStepStatus, 'muted' | 'ok' | 'warn' | 'bad' | 'accent'> = {
  pending: 'muted', running: 'accent', waiting: 'warn', done: 'ok', failed: 'bad', skipped: 'muted',
};
export const RUN_STATUS_LABEL: Record<WorkflowRunStatus, string> = {
  running: 'Running', waiting: 'Waiting for you', success: 'Done', error: 'Failed', cancelled: 'Cancelled',
};
export const RUN_STATUS_TONE: Record<WorkflowRunStatus, 'muted' | 'ok' | 'warn' | 'bad' | 'accent'> = {
  running: 'accent', waiting: 'warn', success: 'ok', error: 'bad', cancelled: 'muted',
};
export const runIsOpen = (r: Pick<WorkflowRunSummary, 'status'> | null | undefined) => r?.status === 'running' || r?.status === 'waiting';

export interface StepContext { bots: Bot[]; routines: Routine[]; triggers: Trigger[] }

export function describeStep(n: WorkflowNode, c: StepContext): { title: string; detail: string } {
  switch (n.kind) {
    case 'trigger': {
      if (n.routineId) return { title: 'Starts on a schedule', detail: c.routines.find((r) => r.id === n.routineId)?.name ?? 'A schedule that is gone' };
      if (n.triggerId) return { title: 'Starts on an event', detail: c.triggers.find((t) => t.id === n.triggerId)?.name ?? 'A trigger that is gone' };
      return { title: 'Starts when you press Run now', detail: 'Never on its own' };
    }
    case 'agent': return { title: c.bots.find((b) => b.id === n.botId)?.name ?? 'A bot that is gone', detail: n.prompt.trim() || 'No instructions yet' };
    case 'approval': return { title: n.title || 'Approval', detail: 'You approve, reject or send back' };
    case 'output': return { title: n.target === 'file' ? 'Save to a file' : 'Post to the chat', detail: n.target === 'file' ? (n.path?.trim() || 'No file name yet') : 'In this workflow’s chat' };
  }
}

export interface Problems {
  general: string[];
  byNode: Record<string, string[]>;
  ok: boolean;
}

export interface DraftLike { name: string; roomId: string; graph: WorkflowGraph; budgetUsd: number }

export function validateDraft(d: DraftLike, room: Room | undefined): Problems {
  const general: string[] = [];
  const byNode: Record<string, string[]> = {};
  const add = (id: string, msg: string) => { (byNode[id] ??= []).push(msg); };
  if (!d.name.trim()) general.push('Give the workflow a name.');
  if (!room) general.push('Pick the chat this workflow runs in.');
  if (!(d.budgetUsd > 0) || d.budgetUsd > 50) general.push('The budget per run must be above $0 and at most $50.');
  const shape = linearOrder(d.graph);
  if (!shape.ok) general.push(shape.error);
  for (const n of d.graph.nodes) {
    if (n.kind === 'agent') {
      if (!n.botId) add(n.id, 'Pick a bot.');
      else if (room && !room.memberIds.includes(n.botId)) add(n.id, 'This bot is not in the chat. Pick one that is, or add it to the chat.');
      if (!n.prompt.trim()) add(n.id, 'Write what the bot should do.');
      else if (n.prompt.length > 8000) add(n.id, 'The instructions are over 8000 characters.');
    } else if (n.kind === 'approval') {
      if (!n.title.trim()) add(n.id, 'Give the approval a title.');
    } else if (n.kind === 'output' && n.target === 'file' && !n.path?.trim()) add(n.id, 'Say which file to save to.');
  }
  if (!general.length && !Object.keys(byNode).length && !WorkflowInputSchema.safeParse({ ...d, enabled: true }).success) {
    general.push('Something in a step is a value the hub will not accept. Check the step fields.');
  }
  return { general, byNode, ok: !general.length && !Object.keys(byNode).length };
}

export function starterGraph(botId: string): WorkflowGraph {
  return graphOf([
    { id: 'trigger-1', kind: 'trigger', routineId: null, triggerId: null, manual: true },
    { id: 'agent-1', kind: 'agent', botId, prompt: 'Describe what this step should do.' },
    { id: 'output-1', kind: 'output', target: 'room' },
  ]);
}

interface WfState {
  workflows: Workflow[] | null;
  cards: WorkflowApprovalCard[];
  runs: Record<string, WorkflowRunSummary>;
  error: string | null;
  loadWorkflows: () => Promise<void>;
  loadCards: () => Promise<void>;
  dropCard: (runId: string, nodeId: string) => void;
  applyEvent: (ev: { type: string; run?: WorkflowRunSummary; cards?: WorkflowApprovalCard[] }) => void;
}

export const useWorkflows = create<WfState>((set, get) => ({
  workflows: null,
  cards: [],
  runs: {},
  error: null,
  loadWorkflows: async () => {
    try {
      set({ workflows: await api.workflows.list(), error: null });
    } catch (e) {
      const status = (e as { status?: number }).status;
      set({ workflows: get().workflows ?? [], error: status === 404 ? null : (e as Error).message });
    }
  },
  loadCards: async () => {
    try { set({ cards: await api.workflows.cards() }); } catch { /* an older hub or a device without access: no cards */ }
  },
  dropCard: (runId, nodeId) => set((s) => ({ cards: s.cards.filter((c) => !(c.runId === runId && c.nodeId === nodeId)) })),
  applyEvent: (ev) => {
    if (ev.type === 'workflows.changed') void get().loadWorkflows();
    else if (ev.type === 'workflow.cards' && Array.isArray(ev.cards)) set({ cards: ev.cards });
    else if (ev.type === 'workflow.run' && ev.run) {
      const run = ev.run;
      set((s) => ({
        runs: { ...s.runs, [run.id]: run },
        workflows: s.workflows?.map((w) => (w.id === run.workflowId && (!w.lastRun || run.startedAt >= w.lastRun.startedAt) ? { ...w, lastRun: run } : w)) ?? null,
      }));
    }
  },
}));

export function refreshWorkflows(): Promise<unknown> {
  return Promise.all([useWorkflows.getState().loadWorkflows(), useWorkflows.getState().loadCards()]);
}

export function dispatchWorkflowEvent(raw: unknown): boolean {
  const ev = raw as { type?: unknown } | null;
  if (!ev || (ev.type !== 'workflows.changed' && ev.type !== 'workflow.run' && ev.type !== 'workflow.cards')) return false;
  useWorkflows.getState().applyEvent(ev as Parameters<WfState['applyEvent']>[0]);
  return true;
}

export function expiresIn(expiresAt: number, now: number): string {
  const ms = expiresAt - now;
  if (ms <= 0) return 'Expired';
  if (ms < 3_600_000) return Math.max(1, Math.round(ms / 60_000)) + ' min left';
  return Math.round(ms / 3_600_000) + ' h left';
}
