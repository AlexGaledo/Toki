import fs from 'node:fs';
import path from 'node:path';
import {
  WorkflowPatchSchema, isValidFileName, linearOrder,
  type Bot, type Room, type TriggerEvent, type Workflow, type WorkflowApprovalCard, type WorkflowDecision, type WorkflowInput, type WorkflowNode, type WorkflowPatch,
  type WorkflowRunSummary, type WorkflowStepResult,
} from '@pocketrocket/shared';
import type { Repos } from '../db/repos.js';
import { WorkflowRepo, summary, type WorkflowRunRow } from '../db/workflowRepo.js';
import { events } from '../events.js';
import { MAX_PARK_MS } from '../permissions/PermissionBroker.js';
import type { RoomRouter } from '../rooms/RoomRouter.js';
import { workflowRef, type ParsedOwnerRef } from '../rooms/ownerRef.js';
import { wrapPrevious } from '../rooms/untrusted.js';
import type { TurnResult } from '../agent/BotRunner.js';
import type { UsageTracker } from './UsageTracker.js';
import type { RoomFiles } from '../rooms/roomFiles.js';
import { fileRootOf } from '../rooms/roomFiles.js';
import type { FileRevisions } from './FileRevisions.js';
import { FilesError, folderIn, parentOf, resolveIn, windowsNameProblem } from '../api/files.js';
import { settings } from './SettingsStore.js';
import { logError } from '../providers/redact.js';

export class WorkflowError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export const MAX_STEP_OUTPUT_CHARS = 20_000;
const MAX_STEERS = 20;

export interface WorkflowRunnerDeps {
  repos: Repos;
  workflows: WorkflowRepo;
  router: RoomRouter;
  usage: UsageTracker;
  roomFiles?: RoomFiles;
  revisions?: FileRevisions;
  triggerExists?: (id: string) => boolean;
  heldOwners?: () => string[];
  now?: () => number;
  cardTtlMs?: number;
}

export class WorkflowRunner {
  private readonly now: () => number;
  private readonly cardTtlMs: number;

  constructor(private deps: WorkflowRunnerDeps) {
    this.now = deps.now ?? Date.now;
    this.cardTtlMs = deps.cardTtlMs ?? MAX_PARK_MS;
    deps.router.registerOwner('workflow', {
      onDone: (ref, r) => ref.kind === 'workflow' && this.stepEnded(ref, r),
      onGone: (ref, why) => ref.kind === 'workflow' && this.stepGone(ref, why),
      onSteer: (ref, s) => ref.kind === 'workflow' && this.stepSteered(ref, s),
    });
    deps.router.workflowBudget = (runId) => this.budgetLeft(runId);
  }

  private get repo() { return this.deps.workflows; }

  check(w: { roomId: string; graph: Workflow['graph'] }): string | null {
    const { repos } = this.deps;
    const room = repos.getRoom(w.roomId);
    if (!room) return 'That chat does not exist.';
    const lin = linearOrder(w.graph);
    if (!lin.ok) return lin.error;
    for (const n of lin.order) {
      if (n.kind === 'agent') {
        const bot = repos.getBot(n.botId);
        if (!bot) return 'Step "' + n.id + '" names a bot that does not exist.';
        if (!room.memberIds.includes(bot.id)) return '@' + bot.handle + ' (step "' + n.id + '") is not in "' + room.name + '".';
      } else if (n.kind === 'trigger') {
        if (n.routineId && !repos.getRoutine(n.routineId)) return 'The routine of the trigger step does not exist.';
        if (n.triggerId && this.deps.triggerExists && !this.deps.triggerExists(n.triggerId)) return 'The event trigger of the trigger step does not exist.';
      } else if (n.kind === 'output' && n.target === 'file') {
        const why = fileProblem(n.path);
        if (why) return 'Step "' + n.id + '": ' + why;
      }
    }
    return null;
  }

  create(input: WorkflowInput): Workflow {
    const bad = this.check(input);
    if (bad) throw new WorkflowError(400, bad);
    const w = this.repo.create(input);
    events.emitEvent({ type: 'workflows.changed' });
    return w;
  }

  update(id: string, patch: WorkflowPatch): Workflow {
    const cur = this.repo.get(id);
    if (!cur) throw new WorkflowError(404, 'Workflow not found');
    const parsed = WorkflowPatchSchema.safeParse(patch);
    if (!parsed.success) throw new WorkflowError(400, parsed.error.issues.map((i) => i.path.join('.') + ': ' + i.message).join('; '));
    const merged = { ...cur, ...patch };
    const bad = this.check(merged);
    if (bad) throw new WorkflowError(400, bad);
    const w = this.repo.update(id, patch)!;
    events.emitEvent({ type: 'workflows.changed' });
    return w;
  }

  remove(id: string) {
    if (!this.repo.get(id)) throw new WorkflowError(404, 'Workflow not found');
    if (this.repo.activeRun(id)) throw new WorkflowError(409, 'This workflow has a run in progress. Cancel it first.');
    this.repo.delete(id);
    events.emitEvent({ type: 'workflows.changed' });
    events.emitEvent({ type: 'workflow.cards', cards: this.cards() });
  }

  budgetLeft(runId: string): number | undefined {
    const run = this.repo.getRun(runId);
    if (!run) return undefined;
    return run.budgetUsd - (run.causeId ? this.deps.usage.causeCost(run.causeId) : run.costUsd);
  }

  start(workflowId: string, o: { manual: boolean; input?: string }): WorkflowRunRow {
    const w = this.repo.get(workflowId);
    if (!w) throw new WorkflowError(404, 'Workflow not found');
    if (this.repo.activeRun(w.id)) throw new WorkflowError(409, 'This workflow already has a run in progress.');
    const bad = this.check(w);
    if (bad) throw new WorkflowError(400, bad);
    const room = this.deps.repos.getRoom(w.roomId)!;
    const order = (linearOrder(w.graph) as { ok: true; order: WorkflowNode[] }).order;
    const steps: WorkflowStepResult[] = order.map((n) => ({ nodeId: n.id, status: 'pending', output: null, costUsd: 0, startedAt: null, endedAt: null }));
    const t = this.now();
    steps[0] = { ...steps[0], status: 'done', output: cap(o.input ?? ''), startedAt: t, endedAt: t };
    let run = this.repo.createRun({ workflowId: w.id, roomId: room.id, graph: w.graph, budgetUsd: w.budgetUsd, manual: o.manual, steps, nodeId: order[0].id });
    const thread = this.deps.router.openThread(room, 'Workflow "' + clean(w.name) + '" started' + (o.manual ? ' by you.' : '.'), {
      workflowId: w.id, runId: run.id, name: w.name, ...(o.manual ? { manual: true } : {}),
    });
    run = this.save(run, { causeId: thread.id });
    this.run(() => this.proceed(run.id, 1), run.id);
    return this.repo.getRun(run.id)!;
  }

  fireRoutine(routineId: string, o: { manual: boolean }): boolean {
    const list = this.repo.forRoutine(routineId);
    if (!list.length) return false;
    const input = this.deps.repos.getRoutine(routineId)?.prompt ?? '';
    for (const w of list) if (w.enabled || o.manual) this.fireOne(w, { manual: o.manual, input });
    return true;
  }

  fireTrigger(triggerId: string, event: TriggerEvent, o: { manual: boolean }): boolean {
    const list = this.repo.forTrigger(triggerId);
    if (!list.length) return false;
    const input = ['source: ' + event.source, event.from ? 'from: ' + event.from : '', 'title: ' + event.title, '', event.text].filter((l, i) => l || i === 2).join('\n');
    for (const w of list) if (w.enabled || o.manual) this.fireOne(w, { manual: o.manual, input });
    return true;
  }

  private fireOne(w: Workflow, o: { manual: boolean; input: string }) {
    try {
      this.start(w.id, o);
    } catch (e) {
      if (!(e instanceof WorkflowError)) throw e;
      const room = this.deps.repos.getRoom(w.roomId);
      if (room) this.deps.router.systemNote(room, 'Workflow "' + clean(w.name) + '" was not started: ' + e.message, null, 0);
    }
  }

  private proceed(runId: string, idx: number, redo?: { note: string }) {
    let run = this.repo.getRun(runId);
    if (!run || run.status !== 'running') return;
    const order = this.orderOf(run);
    for (let i = idx; i < order.length; i++) {
      const node = order[i];
      if (node.kind === 'trigger') continue;
      if (node.kind === 'agent') return this.startAgent(run, i, order, redo);
      if (node.kind === 'approval') return this.enterApproval(run, i, order);
      const err = this.writeOutput(run, node, i, order);
      run = this.repo.getRun(runId)!;
      if (err) return this.failStep(run, i, err, err);
    }
    this.finish(run, 'success', null);
  }

  private startAgent(run: WorkflowRunRow, i: number, order: WorkflowNode[], redo?: { note: string }) {
    const node = order[i] as Extract<WorkflowNode, { kind: 'agent' }>;
    const wf = this.repo.get(run.workflowId);
    const room = this.deps.repos.getRoom(run.roomId);
    const bot = this.deps.repos.getBot(node.botId);
    if (!room || !bot || !room.memberIds.includes(bot.id)) {
      return this.failStep(run, i, 'its bot is no longer in the chat', 'Step "' + node.id + '" cannot run: its bot is no longer in the chat.');
    }
    const left = this.budgetLeft(run.id) ?? 0;
    if (left <= 0) {
      const spent = run.budgetUsd - left;
      return this.failStep(run, i, 'over budget', 'Stopped before step "' + node.id + '": this run spent $' + spent.toFixed(2) + ' of its $' + run.budgetUsd.toFixed(2) + ' budget.');
    }
    const prev = this.previousOutput(run, i, order);
    const text = stepText(wf?.name ?? 'workflow', i, order.length, node.prompt, prev, redo ? { note: redo.note, draft: run.steps[i].output ?? '' } : undefined);
    const steps = run.steps.slice();
    steps[i] = { ...steps[i], status: 'running', startedAt: this.now(), endedAt: null, output: redo ? null : steps[i].output ?? null };
    run = this.save(run, { nodeId: node.id, steps, status: 'running', expiresAt: null });
    this.deps.router.fireStep(room, bot, {
      causeId: run.causeId!, text, ownerRef: workflowRef(run.id, node.id), budgetUsd: left,
      payload: { workflowId: run.workflowId, runId: run.id, name: wf?.name ?? 'workflow', nodeId: node.id, ...(run.manual ? { manual: true } : {}) },
    });
  }

  private enterApproval(run: WorkflowRunRow, i: number, order: WorkflowNode[]) {
    const node = order[i];
    const steps = run.steps.slice();
    steps[i] = { ...steps[i], status: 'waiting', startedAt: steps[i].startedAt ?? this.now(), endedAt: null };
    run = this.save(run, { nodeId: node.id, steps, status: 'waiting', expiresAt: this.now() + this.cardTtlMs });
    const room = this.deps.repos.getRoom(run.roomId);
    const wf = this.repo.get(run.workflowId);
    if (room) this.deps.router.systemNote(room, 'Workflow "' + clean(wf?.name ?? 'workflow') + '" is waiting for your approval: ' + (node.kind === 'approval' ? clean(node.title) : '') + '. Answer it in Needs you.', run.causeId, 0);
    this.cardsChanged();
  }

  decide(runId: string, d: WorkflowDecision): WorkflowRunSummary {
    const run = this.repo.getRun(runId);
    if (!run) throw new WorkflowError(404, 'Run not found');
    if (run.status !== 'waiting') throw new WorkflowError(409, 'This run is not waiting for an answer.');
    if (run.expiresAt !== null && run.expiresAt <= this.now()) {
      this.sweep();
      throw new WorkflowError(409, 'This approval expired.');
    }
    const order = this.orderOf(run);
    const i = order.findIndex((n) => n.id === run.nodeId);
    if (i < 0 || order[i].kind !== 'approval') throw new WorkflowError(409, 'This run is not waiting for an answer.');
    const steps = run.steps.slice();
    const t = this.now();
    if (d.decision === 'approve') {
      steps[i] = { ...steps[i], status: 'done', output: 'Approved', endedAt: t };
      const r = this.save(run, { steps, status: 'running', expiresAt: null });
      this.cardsChanged();
      this.run(() => this.proceed(r.id, i + 1), r.id);
    } else if (d.decision === 'reject') {
      const note = d.note?.trim() ?? '';
      steps[i] = { ...steps[i], status: 'failed', output: note || 'Rejected', endedAt: t };
      for (let j = i + 1; j < steps.length; j++) steps[j] = { ...steps[j], status: 'skipped' };
      const r = this.save(run, { steps, expiresAt: null });
      this.finish(r, 'cancelled', 'Rejected by you.' + (note ? ' ' + note : ''));
      this.cardsChanged();
    } else {
      if (steps[i].sentBackNote) throw new WorkflowError(409, 'This was already sent back once. Approve or reject it.');
      let prevIdx = -1;
      for (let j = i - 1; j >= 0; j--) if (order[j].kind === 'agent') { prevIdx = j; break; }
      if (prevIdx < 0) throw new WorkflowError(409, 'There is no earlier step to send this back to.');
      steps[i] = { ...steps[i], status: 'pending', sentBackNote: d.note, endedAt: null };
      for (let j = prevIdx + 1; j < i; j++) steps[j] = { ...steps[j], status: 'pending' };
      const r = this.save(run, { steps, status: 'running', expiresAt: null, nodeId: order[prevIdx].id });
      this.cardsChanged();
      this.run(() => this.proceed(r.id, prevIdx, { note: d.note }), r.id);
    }
    return summary(this.repo.getRun(runId)!);
  }

  cards(): WorkflowApprovalCard[] {
    const out: WorkflowApprovalCard[] = [];
    for (const run of this.repo.runsWith('waiting')) {
      const order = this.tryOrder(run);
      const i = order ? order.findIndex((n) => n.id === run.nodeId) : -1;
      const node = order?.[i];
      if (!order || !node || node.kind !== 'approval') continue;
      out.push({
        runId: run.id, workflowId: run.workflowId, workflowName: this.repo.get(run.workflowId)?.name ?? 'Workflow', nodeId: node.id,
        title: node.title, draft: this.previousOutput(run, i, order), canSendBack: !run.steps[i].sentBackNote,
        expiresAt: run.expiresAt ?? this.now(),
      });
    }
    return out;
  }

  private stepEnded(ref: Extract<ParsedOwnerRef, { kind: 'workflow' }>, r: TurnResult) {
    this.run(() => {
      const run = this.repo.getRun(ref.runId);
      const i = run ? run.steps.findIndex((s) => s.nodeId === ref.nodeId) : -1;
      if (!run || run.status !== 'running' || run.nodeId !== ref.nodeId || i < 0 || run.steps[i].status !== 'running') return;
      const spent = run.causeId ? this.deps.usage.causeCost(run.causeId) : run.costUsd;
      const steps = run.steps.slice();
      steps[i] = { ...steps[i], costUsd: r.costUsd ?? 0, endedAt: this.now() };
      const cur = this.save(run, { steps, costUsd: spent });
      if (r.stoppedBy === 'owner') return this.failStep(cur, i, 'stopped by you', 'stopped by you');
      if (!r.ok) return this.failStep(cur, i, 'failed', 'Step "' + ref.nodeId + '" failed: ' + oneLine(r.error ?? 'the turn did not finish') + '.');
      const out = cap(r.finalText ?? '');
      if (!out.trim()) return this.failStep(cur, i, 'no answer', 'Step "' + ref.nodeId + '" gave no answer.');
      steps[i] = { ...steps[i], status: 'done', output: out };
      this.save(cur, { steps });
      this.proceed(ref.runId, i + 1);
    }, ref.runId);
  }

  private stepGone(ref: Extract<ParsedOwnerRef, { kind: 'workflow' }>, why: string) {
    this.run(() => {
      const run = this.repo.getRun(ref.runId);
      const i = run ? run.steps.findIndex((s) => s.nodeId === ref.nodeId) : -1;
      if (!run || run.status !== 'running' || run.nodeId !== ref.nodeId || i < 0) return;
      this.failStep(run, i, why, 'Step "' + ref.nodeId + '" stopped: ' + why + '.');
    }, ref.runId);
  }

  private stepSteered(ref: Extract<ParsedOwnerRef, { kind: 'workflow' }>, s: { at: number; text: string }) {
    this.run(() => {
      const run = this.repo.getRun(ref.runId);
      const i = run ? run.steps.findIndex((x) => x.nodeId === ref.nodeId) : -1;
      if (!run || i < 0 || run.steps[i].status !== 'running') return;
      const steps = run.steps.slice();
      steps[i] = { ...steps[i], steers: [...(steps[i].steers ?? []), { at: s.at, text: s.text.slice(0, 2000) }].slice(-MAX_STEERS) };
      this.save(run, { steps });
    }, ref.runId);
  }

  cancel(runId: string): WorkflowRunSummary {
    const run = this.repo.getRun(runId);
    if (!run) throw new WorkflowError(404, 'Run not found');
    if (run.status !== 'running' && run.status !== 'waiting') throw new WorkflowError(409, 'This run has already ended.');
    const steps = run.steps.map((s): WorkflowStepResult => (s.status === 'running' || s.status === 'waiting' ? { ...s, status: 'failed', endedAt: this.now() } : s.status === 'pending' ? { ...s, status: 'skipped' } : s));
    const cur = this.save(run, { steps, expiresAt: null });
    const node = this.tryOrder(run)?.find((n) => n.id === run.nodeId);
    const wasWaiting = run.status === 'waiting';
    this.finish(cur, 'cancelled', null);
    if (node?.kind === 'agent') this.deps.router.stopOwner(node.botId, run.roomId, 'workflow:' + run.id + ':');
    if (wasWaiting) this.cardsChanged();
    return summary(this.repo.getRun(runId)!);
  }

  retry(runId: string): WorkflowRunSummary {
    const run = this.repo.getRun(runId);
    if (!run) throw new WorkflowError(404, 'Run not found');
    if (run.status !== 'error') throw new WorkflowError(409, 'Only a run that ended in an error can be retried.');
    if (this.repo.activeRun(run.workflowId)) throw new WorkflowError(409, 'This workflow already has a run in progress.');
    const order = this.tryOrder(run);
    const i = run.steps.findIndex((s) => s.status === 'failed');
    if (!order || i < 0) throw new WorkflowError(409, 'There is no failed step to run again.');
    const steps = run.steps.slice();
    steps[i] = { ...steps[i], status: 'pending', endedAt: null };
    const wf = this.repo.get(run.workflowId);
    const r = this.save(run, { steps, status: 'running', error: null, endedAt: null, expiresAt: null, nodeId: order[i].id });
    if (wf && wf.budgetUsd > r.budgetUsd) this.repo.setRunBudget(r.id, wf.budgetUsd);
    this.run(() => this.proceed(r.id, i), r.id);
    return summary(this.repo.getRun(runId)!);
  }

  recover(): number {
    let n = 0;
    const held = this.deps.heldOwners?.() ?? [];
    for (const run of this.repo.runsWith('running')) {
      const prefix = 'workflow:' + run.id + ':';
      if (this.deps.repos.journalHasOwner(prefix) || held.some((h) => h.startsWith(prefix))) continue;
      const i = run.steps.findIndex((s) => s.nodeId === run.nodeId);
      n++;
      this.run(() => this.proceed(run.id, i >= 0 && run.steps[i].status === 'done' ? i + 1 : Math.max(i, 1)), run.id);
    }
    this.sweep();
    this.cardsChanged();
    return n;
  }

  sweep(): number {
    let n = 0;
    for (const run of this.repo.runsWith('waiting')) {
      if (run.expiresAt === null || run.expiresAt > this.now()) continue;
      const i = run.steps.findIndex((s) => s.nodeId === run.nodeId);
      const steps = run.steps.slice();
      if (i >= 0) steps[i] = { ...steps[i], status: 'failed', output: 'Nobody answered in time.', endedAt: this.now() };
      const cur = this.save(run, { steps, expiresAt: null });
      this.finish(cur, 'error', 'Nobody answered the approval within ' + Math.round(this.cardTtlMs / 3_600_000) + ' hours.');
      n++;
    }
    if (n) this.cardsChanged();
    return n;
  }

  list() {
    return this.repo.list();
  }
  getRun(runId: string) {
    return this.repo.getRun(runId);
  }

  private orderOf(run: WorkflowRunRow): WorkflowNode[] {
    const o = linearOrder(run.graph);
    if (!o.ok) throw new Error(o.error);
    return o.order;
  }
  private tryOrder(run: WorkflowRunRow): WorkflowNode[] | null {
    const o = linearOrder(run.graph);
    return o.ok ? o.order : null;
  }

  private previousOutput(run: WorkflowRunRow, i: number, order: WorkflowNode[]): string {
    for (let j = i - 1; j >= 0; j--) {
      if ((order[j].kind === 'agent' || order[j].kind === 'trigger') && run.steps[j]?.status === 'done') return run.steps[j].output ?? '';
    }
    return '';
  }

  private save(run: WorkflowRunRow, p: Parameters<WorkflowRepo['updateRun']>[1]): WorkflowRunRow {
    const r = this.repo.updateRun(run.id, p)!;
    events.emitEvent({ type: 'workflow.run', run: summary(r) });
    return r;
  }

  private cardsChanged() {
    events.emitEvent({ type: 'workflow.cards', cards: this.cards() });
  }

  private finish(run: WorkflowRunRow, status: 'success' | 'error' | 'cancelled', error: string | null) {
    const spent = run.causeId ? this.deps.usage.causeCost(run.causeId) : run.costUsd;
    this.save(run, { status, error, endedAt: this.now(), costUsd: spent, expiresAt: null });
  }

  private failStep(run: WorkflowRunRow, i: number, error: string, note: string) {
    const steps = run.steps.slice();
    steps[i] = { ...steps[i], status: 'failed', endedAt: this.now() };
    const cur = this.save(run, { steps });
    this.finish(cur, 'error', error);
    const room = this.deps.repos.getRoom(run.roomId);
    const wf = this.repo.get(run.workflowId);
    if (room) {
      const text = error === 'stopped by you'
        ? 'Workflow "' + clean(wf?.name ?? 'workflow') + '" was stopped by you at step "' + run.steps[i].nodeId + '". Retry runs that step again.'
        : 'Workflow "' + clean(wf?.name ?? 'workflow') + '" stopped: ' + note;
      this.deps.router.systemNote(room, text, run.causeId, 0);
    }
  }

  private writeOutput(run: WorkflowRunRow, node: Extract<WorkflowNode, { kind: 'output' }>, i: number, order: WorkflowNode[]): string | null {
    const { repos } = this.deps;
    const room = repos.getRoom(run.roomId);
    if (!room) return 'The chat no longer exists.';
    const text = cap(this.previousOutput(run, i, order));
    const t = this.now();
    let result: string | null = null;
    if (node.target === 'room') {
      let botId: string | null = null;
      for (let j = i - 1; j >= 0; j--) if (order[j].kind === 'agent') { botId = (order[j] as Extract<WorkflowNode, { kind: 'agent' }>).botId; break; }
      const bot: Bot | undefined = botId ? repos.getBot(botId) : undefined;
      const msg = repos.insertMessage({
        roomId: room.id, authorType: bot ? 'bot' : 'system', authorId: bot?.id ?? null, kind: bot ? 'text' : 'system', text,
        payload: null, causeId: run.causeId, hop: 0, turnId: null,
      });
      events.emitEvent({ type: 'message.new', message: msg });
    } else {
      result = this.writeFile(room, run, node.path ?? '', text);
      if (result) return result;
      const wf = this.repo.get(run.workflowId);
      this.deps.router.systemNote(room, 'Workflow "' + clean(wf?.name ?? 'workflow') + '" saved its output to ' + clean(node.path ?? '') + ' in this chat\'s files.', run.causeId, 0);
    }
    const steps = run.steps.slice();
    steps[i] = { ...steps[i], status: 'done', output: node.target === 'file' ? 'Saved to ' + node.path : 'Posted to the chat', startedAt: t, endedAt: t };
    this.save(run, { nodeId: node.id, steps });
    return null;
  }

  private writeFile(room: Room, run: WorkflowRunRow, rel: string, text: string): string | null {
    const files = this.deps.roomFiles;
    const folder = files?.folderOf(room);
    if (!files || !folder) return 'This chat has no files folder.';
    const why = fileProblem(rel);
    if (why) return why;
    try {
      const root = files.ensure(folder);
      const target = resolveIn(root, rel);
      const dir = folderIn(root, parentOf(target.rel), true);
      const abs = path.join(dir.abs, path.posix.basename(target.rel));
      if (fs.existsSync(abs) && !fs.statSync(abs).isFile()) return 'There is a folder called ' + target.rel + '.';
      const revisions = this.deps.revisions;
      if (revisions) {
        const root2 = fileRootOf(room, { ...folder, dir: root });
        const cur = revisions.readText(root2, target.rel);
        const w = revisions.writeText(root2, target.rel, text, cur.hash, { kind: 'owner', id: null, label: 'workflow', machine: process.platform === 'win32' ? 'pc' : 'vps', roomId: room.id, tool: 'workflow' });
        if (!w.ok) return 'The file changed while the workflow was writing it. Retry runs the step again.';
      } else {
        fs.writeFileSync(abs, text);
      }
      events.emitEvent({ type: 'files.changed', roomId: room.id, path: parentOf(target.rel) });
      return null;
    } catch (e) {
      if (e instanceof FilesError) return e.message;
      logError('[workflow ' + run.id + ']', e);
      return 'The file could not be written.';
    }
  }

  private run(fn: () => void, runId: string) {
    try {
      fn();
    } catch (e) {
      logError('[workflow ' + runId + ']', e);
      const run = this.repo.getRun(runId);
      if (run && (run.status === 'running' || run.status === 'waiting')) this.finish(run, 'error', 'The workflow hit an internal error: ' + oneLine((e as Error).message));
    }
  }
}

const clean = (s: string): string => s.replace(/\s+/g, ' ').replace(/"/g, "'").trim().slice(0, 120);
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim().slice(0, 300);
const cap = (s: string): string => (s.length > MAX_STEP_OUTPUT_CHARS ? s.slice(0, MAX_STEP_OUTPUT_CHARS) + '\n…[cut: ' + (s.length - MAX_STEP_OUTPUT_CHARS) + ' more characters]' : s);

function fileProblem(rel: string | undefined): string | null {
  if (!rel || !rel.trim()) return 'a file output needs a path.';
  const raw = rel.replaceAll('\\', '/');
  if (raw.includes('\0') || raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) return 'the path is relative to the chat\'s files folder.';
  const parts = raw.split('/').filter((p) => p && p !== '.');
  if (!parts.length) return 'a file output needs a path.';
  if (parts.includes('..')) return 'the path may not go up a folder.';
  for (const p of parts) {
    if (!isValidFileName(p)) return '"' + p + '" is not a valid file name.';
    const w = windowsNameProblem(p);
    if (w) return w + ': ' + p + '.';
  }
  return null;
}

export function stepText(name: string, i: number, total: number, prompt: string, previous: string, redo?: { note: string; draft: string }): string {
  const uses = /\{\{\s*previous\s*\}\}/.test(prompt);
  const parts = ['[Workflow "' + clean(name) + '", step ' + i + ' of ' + (total - 1) + '] ' + prompt.replace(/\{\{\s*previous\s*\}\}/g, "(the previous step's output, attached below)")];
  if (uses) parts.push(wrapPrevious(previous.trim() ? previous : '(nothing: this run started without input)'));
  if (redo) {
    parts.push(
      settings.get().userName + ' reviewed your draft and sent it back with this note: "' + redo.note.replace(/"/g, "'") + '". Revise it and reply with the complete revised version.',
      'Your earlier draft:',
      wrapPrevious(redo.draft),
    );
  }
  return parts.join('\n\n');
}
