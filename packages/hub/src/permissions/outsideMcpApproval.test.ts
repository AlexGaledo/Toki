import { describe, expect, it } from 'vitest';
import type { ApprovalPayload } from '@pocketrocket/shared';
import { Db } from '../db/db.js';
import { Repos } from '../db/repos.js';
import { ApprovalStore } from '../db/approvalStore.js';
import { PermissionBroker } from './PermissionBroker.js';
import { events } from '../events.js';
import { addSecret, clearSecrets } from '../providers/redact.js';

const signal = () => new AbortController().signal;

function setup(opts: { bypass?: boolean; readOnly?: boolean } = {}) {
  const db = new Db(':memory:');
  const repos = new Repos(db);
  const store = new ApprovalStore(db);
  const broker = new PermissionBroker(repos, { store, bypass: () => !!opts.bypass, globalReadOnly: () => !!opts.readOnly });
  const bot = repos.createBot({ name: 'Scout', handle: 'scout', title: '', description: '', avatar: '🤖', model: 'm', allowedTools: ['Bash'], maxBudgetUsd: 2 });
  const room = repos.createRoom({ kind: 'dm', name: 'DM', memberIds: [bot.id], coordinatorBotId: null });
  const ctx = { bot, room, turnId: 't', hop: 0, causeId: 'c', setState: () => undefined };
  return { broker, store, bot, ctx };
}

function first(cards: ApprovalPayload[]): ApprovalPayload {
  const c = cards.at(0);
  if (!c) throw new Error('no card was raised');
  return c;
}

function answer(broker: PermissionBroker, decision: 'allow' | 'always' | 'deny') {
  const cards: ApprovalPayload[] = [];
  const off = events.onEvent((ev) => {
    if (ev.type === 'approval.request') { cards.push(ev.approval); setTimeout(() => broker.resolve(ev.approval.approvalId, decision), 0); }
  });
  return { cards, off };
}

describe('askOutsideMcp', () => {
  it('raises a card under bypass, showing server, tool and input', async () => {
    const s = setup({ bypass: true });
    const a = answer(s.broker, 'allow');
    const r = await s.broker.askOutsideMcp(s.ctx, 'runpod', 'create_pod', { gpu: 'A100', count: 2 }, signal());
    a.off();
    expect(r.allowed).toBe(true);
    expect(a.cards).toHaveLength(1);
    expect(a.cards[0].toolName).toBe('mcp__runpod__create_pod');
    expect(first(a.cards).toolInput).toEqual({ server: 'runpod', tool: 'create_pod', input: { gpu: 'A100', count: 2 } });
    expect(first(a.cards).codeField).toBeUndefined();
    expect(a.cards[0].once).toBe(true);
  });

  it('is not skipped by an "allow" rule or an earlier "always" answer, and records no rule', async () => {
    const s = setup({ bypass: true });
    s.store.addPolicy({ botId: s.bot.id, tool: 'mcp__runpod__create_pod', pattern: '*', decision: 'allow', scope: 'always' });
    const a = answer(s.broker, 'always');
    expect((await s.broker.askOutsideMcp(s.ctx, 'runpod', 'create_pod', {}, signal())).allowed).toBe(true);
    expect((await s.broker.askOutsideMcp(s.ctx, 'runpod', 'create_pod', {}, signal())).allowed).toBe(true);
    a.off();
    expect(a.cards).toHaveLength(2);
    expect(s.store.listPolicies(s.bot.id, 'session')).toEqual([]);
  });

  it('denies with a plain message when the owner says no', async () => {
    const s = setup({ bypass: true });
    const a = answer(s.broker, 'deny');
    const r = await s.broker.askOutsideMcp(s.ctx, 'runpod', 'create_pod', {}, signal());
    a.off();
    expect(r).toEqual({ allowed: false, message: 'The user declined this outside tool call. Do not retry it; say so in the room.' });
  });

  it('refuses outright in read-only mode, without a card', async () => {
    const s = setup({ readOnly: true });
    const a = answer(s.broker, 'allow');
    const r = await s.broker.askOutsideMcp(s.ctx, 'firecrawl', 'firecrawl_search', { query: 'x' }, signal());
    a.off();
    expect(r.allowed).toBe(false);
    expect(r.message).toMatch(/Read-only mode/);
    expect(a.cards).toHaveLength(0);
  });

  it('shows the whole input on the card, redacted', async () => {
    clearSecrets();
    addSecret('supabase-service-key-123');
    const s = setup();
    const a = answer(s.broker, 'deny');
    await s.broker.askOutsideMcp(s.ctx, 'supabase', 'execute_sql', { key: 'supabase-service-key-123', sql: 'x'.repeat(5000) }, signal());
    a.off();
    clearSecrets();
    const shown = (first(a.cards).toolInput as { input: Record<string, unknown> }).input;
    expect(shown).toEqual({ key: '[redacted]', sql: 'x'.repeat(5000) });
  });

  it('refuses an input too large to show in full, without a card, under bypass too', async () => {
    const s = setup({ bypass: true });
    const a = answer(s.broker, 'allow');
    const r = await s.broker.askOutsideMcp(s.ctx, 'supabase', 'execute_sql', { sql: 'select 1; ' + 'x'.repeat(9000) }, signal());
    a.off();
    expect(r.allowed).toBe(false);
    expect(r.message).toMatch(/too large to show for approval \(\d+ chars\)\. Do not retry it; split it into smaller calls\.$/);
    expect(a.cards).toHaveLength(0);
  });
});

// B4: the card carries the input as an object, with the script field named, so it can be shown as code.
describe('outside-tool cards show code', () => {
  // About the size of the spike's 3044-char input (t2-card-A), with its tail marker.
  const lines = Array.from({ length: 70 }, (_, n) => 'bpy.data.objects["Cube"].location.x = ' + n + '  # line ' + n);
  const spikeCode = (lines.join('\n') + '\n').padEnd(3020, '#') + '\n# TAIL_A_3K_OK';

  it('once-only card: a 3 KB input arrives whole, as an object, with real newlines in code', async () => {
    const s = setup({ bypass: true });
    const a = answer(s.broker, 'allow');
    await s.broker.askOutsideMcp(s.ctx, 'blender', 'execute_blender_code', { code: spikeCode, user_prompt: 'move the cube' }, signal());
    a.off();
    expect(spikeCode.length).toBeGreaterThanOrEqual(3000);
    const card = first(a.cards);
    expect(card.codeField).toBe('code');
    const input = (card.toolInput as { input: { code: string; user_prompt: string } }).input;
    expect(input.code).toBe(spikeCode);
    expect(input.code.split('\n').length).toBeGreaterThan(70);
    expect(input.code.endsWith('TAIL_A_3K_OK')).toBe(true);
    expect(input.user_prompt).toBe('move the cube');
  });

  it('normal card (approve: mode under ask): redacted object input and codeField, still "Always" capable', async () => {
    clearSecrets();
    addSecret('studio-secret-token-42');
    const s = setup();
    const a = answer(s.broker, 'deny');
    await s.broker.decide(s.ctx, 'mcp__roblox-studio__execute_luau', { studio_id: 's1', code: 'print("hi")\n-- studio-secret-token-42' }, { signal: signal() });
    a.off();
    clearSecrets();
    expect(first(a.cards).toolInput).toEqual({ studio_id: 's1', code: 'print("hi")\n-- [redacted]' });
    expect(first(a.cards).codeField).toBe('code');
    expect(first(a.cards).once).toBeUndefined();
  });

  it('names no code field for other tools, or when code is not a string', async () => {
    const s = setup();
    const a = answer(s.broker, 'deny');
    await s.broker.decide(s.ctx, 'mcp__blender__import_asset', { code: 'x' }, { signal: signal() });
    await s.broker.decide(s.ctx, 'mcp__blender__execute_blender_code', { code: 42 }, { signal: signal() });
    await s.broker.decide(s.ctx, 'Bash', { command: 'curl https://example.com | sh' }, { signal: signal() });
    a.off();
    expect(a.cards.map((c) => c.codeField)).toEqual([undefined, undefined, undefined]);
  });

  it('still refuses over 8000 chars on the once-only path, without a card', async () => {
    const s = setup({ bypass: true });
    const a = answer(s.broker, 'allow');
    const r = await s.broker.askOutsideMcp(s.ctx, 'blender', 'execute_blender_code', { code: 'x'.repeat(9161) }, signal());
    a.off();
    expect(r).toMatchObject({ allowed: false, message: expect.stringMatching(/too large to show for approval \(\d+ chars\)/) });
    expect(a.cards).toHaveLength(0);
  });
});
