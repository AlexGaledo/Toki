import { nanoid } from 'nanoid';
import type {
  Workflow, WorkflowGraph, WorkflowInput, WorkflowPatch, WorkflowRun, WorkflowRunStatus, WorkflowRunSummary, WorkflowStepResult,
} from '@pocketrocket/shared';
import type { Db, Row } from './db.js';

export type WorkflowTriggerKind = 'routine' | 'trigger' | 'manual';

export interface WorkflowRunRow extends WorkflowRun {
  roomId: string;
  causeId: string | null;
  graph: WorkflowGraph;
  budgetUsd: number;
  expiresAt: number | null;
}

export class WorkflowRepo {
  constructor(private db: Db, private now: () => number = Date.now) {}

  private toWorkflow(r: Row): Workflow {
    const id = r.id as string;
    return {
      id, name: r.name as string, enabled: !!r.enabled, roomId: r.room_id as string,
      graph: JSON.parse(r.graph_json as string) as WorkflowGraph, budgetUsd: r.budget_usd as number,
      createdAt: r.created_at as number, updatedAt: r.updated_at as number, lastRun: this.lastRun(id),
    };
  }
  list(): Workflow[] {
    return this.db.all('SELECT * FROM workflows ORDER BY created_at, rowid').map((r) => this.toWorkflow(r));
  }
  get(id: string): Workflow | undefined {
    const r = this.db.get('SELECT * FROM workflows WHERE id=?', id);
    return r ? this.toWorkflow(r) : undefined;
  }
  create(i: WorkflowInput): Workflow {
    const id = nanoid(10);
    const t = this.now();
    const k = triggerColumns(i.graph);
    this.db.run(
      'INSERT INTO workflows (id, name, enabled, room_id, trigger_kind, routine_id, trigger_id, graph_json, budget_usd, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      id, i.name, i.enabled ? 1 : 0, i.roomId, k.kind, k.routineId, k.triggerId, JSON.stringify(i.graph), i.budgetUsd, t, t,
    );
    return this.get(id)!;
  }
  update(id: string, p: WorkflowPatch): Workflow | undefined {
    const cur = this.get(id);
    if (!cur) return undefined;
    const n = { ...cur, ...p };
    const k = triggerColumns(n.graph);
    this.db.run(
      'UPDATE workflows SET name=?, enabled=?, room_id=?, trigger_kind=?, routine_id=?, trigger_id=?, graph_json=?, budget_usd=?, updated_at=? WHERE id=?',
      n.name, n.enabled ? 1 : 0, n.roomId, k.kind, k.routineId, k.triggerId, JSON.stringify(n.graph), n.budgetUsd, this.now(), id,
    );
    return this.get(id);
  }
  delete(id: string) {
    this.db.tx(() => {
      this.db.run('DELETE FROM workflow_runs WHERE workflow_id=?', id);
      this.db.run('DELETE FROM workflows WHERE id=?', id);
    });
  }
  forRoutine(routineId: string): Workflow[] {
    return this.db.all('SELECT * FROM workflows WHERE routine_id=? ORDER BY created_at, rowid', routineId).map((r) => this.toWorkflow(r));
  }
  forTrigger(triggerId: string): Workflow[] {
    return this.db.all('SELECT * FROM workflows WHERE trigger_id=? ORDER BY created_at, rowid', triggerId).map((r) => this.toWorkflow(r));
  }

  private toRun(r: Row): WorkflowRunRow {
    return {
      id: r.id as string, workflowId: r.workflow_id as string, status: r.status as WorkflowRunStatus,
      nodeId: (r.node_id as string) ?? null, costUsd: r.cost_usd as number, startedAt: r.started_at as number,
      endedAt: (r.ended_at as number) ?? null, error: (r.error as string) ?? null, manual: !!r.manual,
      steps: JSON.parse(r.steps_json as string) as WorkflowStepResult[],
      roomId: (r.room_id as string) ?? '', causeId: (r.cause_id as string) ?? null, graph: JSON.parse(r.graph_json as string) as WorkflowGraph,
      budgetUsd: r.budget_usd as number, expiresAt: (r.expires_at as number) ?? null,
    };
  }
  createRun(o: { workflowId: string; roomId: string; graph: WorkflowGraph; budgetUsd: number; manual: boolean; steps: WorkflowStepResult[]; nodeId: string | null }): WorkflowRunRow {
    const id = nanoid(10);
    this.db.run(
      "INSERT INTO workflow_runs (id, workflow_id, room_id, node_id, status, steps_json, graph_json, budget_usd, manual, started_at) VALUES (?,?,?,?,'running',?,?,?,?,?)",
      id, o.workflowId, o.roomId, o.nodeId, JSON.stringify(o.steps), JSON.stringify(o.graph), o.budgetUsd, o.manual ? 1 : 0, this.now(),
    );
    return this.getRun(id)!;
  }
  getRun(id: string): WorkflowRunRow | undefined {
    const r = this.db.get('SELECT * FROM workflow_runs WHERE id=?', id);
    return r ? this.toRun(r) : undefined;
  }
  updateRun(id: string, p: Partial<Pick<WorkflowRunRow, 'causeId' | 'nodeId' | 'status' | 'steps' | 'costUsd' | 'error' | 'expiresAt' | 'endedAt'>>): WorkflowRunRow | undefined {
    const cur = this.getRun(id);
    if (!cur) return undefined;
    const n = { ...cur, ...p };
    this.db.run(
      'UPDATE workflow_runs SET cause_id=?, node_id=?, status=?, steps_json=?, cost_usd=?, error=?, expires_at=?, ended_at=? WHERE id=?',
      n.causeId, n.nodeId, n.status, JSON.stringify(n.steps), n.costUsd, n.error ?? null, n.expiresAt, n.endedAt, id,
    );
    return this.getRun(id);
  }
  setRunBudget(id: string, budgetUsd: number) {
    this.db.run('UPDATE workflow_runs SET budget_usd=? WHERE id=?', budgetUsd, id);
  }
  listRuns(workflowId: string, limit = 20): WorkflowRunSummary[] {
    return this.db.all('SELECT * FROM workflow_runs WHERE workflow_id=? ORDER BY started_at DESC, rowid DESC LIMIT ?', workflowId, limit).map((r) => summary(this.toRun(r)));
  }
  lastRun(workflowId: string): WorkflowRunSummary | null {
    const r = this.db.get('SELECT * FROM workflow_runs WHERE workflow_id=? ORDER BY started_at DESC, rowid DESC LIMIT 1', workflowId);
    return r ? summary(this.toRun(r)) : null;
  }
  runsWith(...statuses: WorkflowRunStatus[]): WorkflowRunRow[] {
    return this.db.all(`SELECT * FROM workflow_runs WHERE status IN (${statuses.map(() => '?').join(',')}) ORDER BY started_at, rowid`, ...statuses).map((r) => this.toRun(r));
  }
  activeRun(workflowId: string): WorkflowRunRow | undefined {
    const r = this.db.get("SELECT * FROM workflow_runs WHERE workflow_id=? AND status IN ('running','waiting') ORDER BY started_at DESC LIMIT 1", workflowId);
    return r ? this.toRun(r) : undefined;
  }
}

export function summary(r: WorkflowRunRow): WorkflowRunSummary {
  return { id: r.id, workflowId: r.workflowId, status: r.status, nodeId: r.nodeId, costUsd: r.costUsd, startedAt: r.startedAt, endedAt: r.endedAt, error: r.error ?? null, manual: r.manual };
}

function triggerColumns(g: WorkflowGraph): { kind: WorkflowTriggerKind; routineId: string | null; triggerId: string | null } {
  const t = g.nodes.find((n) => n.kind === 'trigger');
  if (t?.kind === 'trigger') {
    if (t.routineId) return { kind: 'routine', routineId: t.routineId, triggerId: null };
    if (t.triggerId) return { kind: 'trigger', routineId: null, triggerId: t.triggerId };
  }
  return { kind: 'manual', routineId: null, triggerId: null };
}
