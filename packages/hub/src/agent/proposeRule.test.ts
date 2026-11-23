import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MODELS, type ModelInfo, type ProviderCheck } from '@pocketrocket/shared';
import { Db } from '../db/db.js';
import { Repos } from '../db/repos.js';
import { ApprovalStore } from '../db/approvalStore.js';
import { events } from '../events.js';
import { MemoryService } from '../services/MemoryService.js';
import { SkillService } from '../services/SkillService.js';
import { UsageTracker } from '../services/UsageTracker.js';
import { PermissionBroker, commandMatches, type PermCtx } from '../permissions/PermissionBroker.js';
import { TurnRegistry } from '../mcp/httpServer.js';
import { EMPTY_USAGE, type AgentProvider, type TurnContext, type TurnOutcome, type TurnSink } from '../providers/types.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { WORKSPACE_DIR, botHome } from '../config.js';
import { BotRunner, type TurnRequest } from './BotRunner.js';

const CLAUDE: ModelInfo[] = MODELS.map((m) => ({ id: m.id, label: m.label }));

class ScriptedProvider implements AgentProvider {
  readonly id = 'claude' as const;
  readonly label = 'Scripted';
  readonly info = { id: 'claude' as const, label: 'Scripted', blurb: '', authModes: [], secretKeys: [], permissions: 'full' as const, maturity: 'verified' as const };
  seen: TurnContext[] = [];
  answers: string[] = [];
  constructor(private call: { name: string; input: Record<string, unknown> }) {}
  async models(): Promise<ModelInfo[]> { return CLAUDE; }
  modelsSync(): ModelInfo[] { return CLAUDE; }
  async check(): Promise<ProviderCheck> { return { ok: true, auth: 'unknown' }; }
  interrupt(): boolean { return false; }
  async runTurn(ctx: TurnContext, sink: TurnSink): Promise<TurnOutcome> {
    this.seen.push({ ...ctx });
    sink.onSession('session-' + this.seen.length);
    const out = await ctx.tools.find((t) => t.name === this.call.name)!.handler(this.call.input);
    this.answers.push((out.content[0] as { text: string }).text);
    sink.onText('ok');
    return { ok: true, costUsd: 0.01, usage: { ...EMPTY_USAGE, costUsd: 0.01 }, durationMs: 1 };
  }
}

const homes: string[] = [];
afterEach(() => {
  for (const id of homes.splice(0)) fs.rmSync(botHome(id), { recursive: true, force: true });
});

const FORCE_PUSH = { kind: 'command', pattern: 'git push --force', instead: 'open a PR and let CI merge it', reason: 'Told twice not to force-push' };
const signal = new AbortController().signal;

function setup(input: Record<string, unknown> = FORCE_PUSH, opts: { bypass?: boolean } = {}) {
  const db = new Db(':memory:');
  const repos = new Repos(db);
  const store = new ApprovalStore(db);
  const bot = repos.createBot({ name: 'Worker', handle: 'worker', title: '', description: '', avatar: '', model: 'claude-sonnet-5', allowedTools: ['Read'], maxBudgetUsd: 2 });
  const other = repos.createBot({ name: 'Other', handle: 'other', title: '', description: '', avatar: '', model: 'claude-sonnet-5', allowedTools: ['Read'], maxBudgetUsd: 2 });
  homes.push(bot.id, other.id);
  const room = repos.createRoom({ kind: 'dm', name: 'DM', memberIds: [bot.id], coordinatorBotId: null });
  const provider = new ScriptedProvider({ name: 'propose_rule', input });
  const providers = { active: () => provider, get: () => provider } as unknown as ProviderRegistry;
  const broker = new PermissionBroker(repos, { store, bypass: () => !!opts.bypass });
  const runner = new BotRunner(
    repos, new MemoryService(), new SkillService(repos), broker, new UsageTracker(repos),
    { dispatchFromBot: () => [], setState: () => undefined }, providers, new TurnRegistry(),
  );
  const turn = (p: Partial<TurnRequest> = {}) => runner.runTurn({ bot, room, members: [bot], injected: '#1 [alex]: hello', hop: 0, causeId: 'c1', ...p });
  const ctx = (b = bot): PermCtx => ({ bot: b, room, turnId: 't', hop: 0, causeId: 'c', setState: () => undefined });
  const cards = () => repos.listMessages(room.id).filter((m) => m.kind === 'approval');
  const propose = async (decision: 'allow' | 'deny', p: Partial<TurnRequest> = {}) => {
    const off = events.onEvent((ev) => { if (ev.type === 'approval.request') setTimeout(() => broker.resolve(ev.approval.approvalId, decision), 0); });
    try { await turn(p); } finally { off(); }
    return provider.answers.at(-1)!;
  };
  return { repos, store, bot, other, room, provider, broker, ctx, cards, propose };
}

describe('propose_rule', () => {
  it('shows the exact rule on a card; on yes the command is refused with the owner\'s "do instead", under bypass too', async () => {
    const s = setup();
    expect(await s.propose('allow')).toContain('Rule added');
    const card = s.cards()[0];
    expect(card.payload).toMatchObject({ toolName: 'propose_rule', toolInput: { kind: 'command', pattern: 'git push --force', instead: 'open a PR and let CI merge it' }, once: true });
    expect((card.payload as { reason: string }).reason).toContain('"git push --force"');
    expect(s.store.listPolicies(s.bot.id)).toMatchObject([{ tool: 'Bash', pattern: 'git push --force', decision: 'deny', message: 'open a PR and let CI merge it' }]);

    for (const command of ['git push --force', 'cd app && git push --force origin main', "bash -c 'GIT_PUSH=1 git  push --force'", 'GIT PUSH --FORCE']) {
      const r = await s.broker.decide(s.ctx(), 'Bash', { command }, { signal });
      expect(r, command).toMatchObject({ behavior: 'deny' });
      expect((r as { message: string }).message).toMatch(/not allowed: a rule the user approved forbids "git push --force"\. Do not retry it; instead: open a PR and let CI merge it\.$/);
    }
    const bypassed = new PermissionBroker(s.repos, { store: s.store, bypass: () => true });
    expect(await bypassed.decide(s.ctx(), 'Bash', { command: 'git push --force' }, { signal })).toMatchObject({ behavior: 'deny' });
    expect(await bypassed.decide(s.ctx(), 'Bash', { command: 'git push origin main' }, { signal })).toEqual({ behavior: 'allow' });
    expect(await s.broker.ask(s.ctx(), { action: 'push', command: 'git push --force origin' }, signal)).toMatchObject({ allowed: false, message: expect.stringContaining('open a PR') });
    expect(await bypassed.decide(s.ctx(s.other), 'Bash', { command: 'git push --force' }, { signal })).toEqual({ behavior: 'allow' });
    expect(await s.broker.decide(s.ctx(), 'Bash', { command: 'ls' }, { signal })).toEqual({ behavior: 'allow' });
    expect(s.cards()).toHaveLength(1);
  });

  it('adds nothing when the owner says no', async () => {
    const s = setup(FORCE_PUSH, { bypass: true });
    expect(await s.propose('deny')).toMatch(/declined this rule/);
    expect(s.cards()).toHaveLength(1);
    expect(s.store.listPolicies(s.bot.id, 'all')).toEqual([]);
    expect(s.broker.learnedRule(s.bot.id, 'Bash', { command: 'git push --force' })).toBeNull();
    expect(await s.broker.decide(s.ctx(), 'Bash', { command: 'git push --force' }, { signal })).toEqual({ behavior: 'allow' });
  });

  it('is refused before any card on a turn the owner did not start directly', async () => {
    for (const p of [{ causeKind: 'routine', strictApprovals: true }, { causeKind: 'trigger', strictApprovals: true }, { causeKind: 'bot', hop: 1 }] as Partial<TurnRequest>[]) {
      const s = setup();
      const answer = await s.propose('allow', p);
      expect(toolNames(s.provider.seen[0])).toContain('propose_rule');
      expect(answer, JSON.stringify(p)).toMatch(/only be proposed on a turn the owner started directly/);
      expect(s.cards()).toEqual([]);
      expect(s.store.listPolicies(s.bot.id, 'all')).toEqual([]);
    }
  });

  it('a path rule refuses writing at or under the path, with the message', async () => {
    const s = setup({ kind: 'path', pattern: 'release', instead: 'write release notes in docs/changes instead', reason: 'Asked twice' });
    await s.propose('allow');
    const dir = path.join(WORKSPACE_DIR, 'release');
    expect(s.store.listPolicies(s.bot.id)).toMatchObject([{ tool: 'file_write', pattern: dir }]);
    for (const [tool, input] of [['Write', { file_path: path.join(dir, 'notes.md') }], ['Edit', { file_path: dir }]] as const) {
      const r = await s.broker.decide(s.ctx(), tool, input, { signal });
      expect(r, tool).toMatchObject({ behavior: 'deny', message: expect.stringContaining('docs/changes') });
    }
    expect(await s.broker.decide(s.ctx(), 'Read', { file_path: path.join(dir, 'notes.md') }, { signal })).toEqual({ behavior: 'allow' });
    expect(await s.broker.decide(s.ctx(), 'Write', { file_path: path.join(WORKSPACE_DIR, 'release-2', 'x.md') }, { signal })).toEqual({ behavior: 'allow' });
    expect((await s.broker.ask(s.ctx(), { action: 'write', paths: [path.join(dir, 'x')] }, signal)).allowed).toBe(false);
  });

  it('refuses a pattern that names everything', async () => {
    const s = setup({ ...FORCE_PUSH, pattern: ' * ' });
    expect(await s.propose('allow')).toMatch(/not everything/);
    expect(s.cards()).toEqual([]);
  });
});

describe('commandMatches', () => {
  it('matches whole words anywhere in the command, case-insensitively', () => {
    expect(commandMatches('npm publish', 'cd pkg && npm   publish --tag next')).toBe(true);
    expect(commandMatches('npm publish', '(npm publish)')).toBe(true);
    expect(commandMatches('npm publish', 'npm publisher')).toBe(false);
    expect(commandMatches('git push --force', 'git push --force-with-lease')).toBe(false);
    expect(commandMatches('git push --force*', 'git push --force-with-lease')).toBe(true);
    expect(commandMatches('rm -rf', 'echo "rm -rf"')).toBe(true);
    expect(commandMatches('*', 'anything')).toBe(false);
  });
});

const toolNames = (c: TurnContext) => c.tools.map((t) => t.name);
