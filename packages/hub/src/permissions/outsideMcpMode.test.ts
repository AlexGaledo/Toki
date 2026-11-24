import { describe, expect, it } from 'vitest';
import type { ApprovalPayload } from '@pocketrocket/shared';
import { Db } from '../db/db.js';
import { Repos } from '../db/repos.js';
import { ApprovalStore } from '../db/approvalStore.js';
import { PermissionBroker } from './PermissionBroker.js';
import { events } from '../events.js';
import { BLENDER_WM_MESSAGE, OUTSIDE_READONLY_MESSAGE, outsideMcpStep, type OutsideMcpServer } from '../services/outsideMcp.js';

// B3: `approve: 'mode'` follows the hub's approval mode.
const signal = () => new AbortController().signal;
const blender = { name: 'blender', approve: 'mode', readTools: ['get_addon_status', 'get_scene_info', 'look', 'search_assets'] } satisfies Pick<OutsideMcpServer, 'name' | 'approve' | 'readTools'>;
const runpod = { name: 'runpod', approve: 'every-call', readTools: [] } satisfies Pick<OutsideMcpServer, 'name' | 'approve' | 'readTools'>;
const code = { code: 'import bpy\nbpy.ops.mesh.primitive_cube_add()\ntoki_save()' };

function setup(opts: { bypass?: boolean; strict?: boolean; readOnly?: boolean } = {}) {
  const db = new Db(':memory:');
  const repos = new Repos(db);
  const store = new ApprovalStore(db);
  const broker = new PermissionBroker(repos, { store, bypass: () => !!opts.bypass, globalReadOnly: () => !!opts.readOnly });
  const bot = repos.createBot({ name: 'Artist', handle: 'artist', title: '', description: '', avatar: '🤖', model: 'm', allowedTools: ['Read'], maxBudgetUsd: 2 });
  const room = repos.createRoom({ kind: 'dm', name: 'DM', memberIds: [bot.id], coordinatorBotId: null });
  const ctx = { bot, room, turnId: 't', hop: 0, causeId: 'c', setState: () => undefined, strictApprovals: !!opts.strict };
  return { broker, store, bot, ctx };
}

function answer(broker: PermissionBroker, decision: 'allow' | 'always' | 'deny') {
  const cards: ApprovalPayload[] = [];
  const off = events.onEvent((ev) => {
    if (ev.type === 'approval.request') { cards.push(ev.approval); setTimeout(() => broker.resolve(ev.approval.approvalId, decision), 0); }
  });
  return { cards, off };
}

/** What the Claude provider does with one call: the hook's step, then canUseTool (broker.decide) when it passes. */
async function call(s: ReturnType<typeof setup>, server: typeof blender | typeof runpod, tool: string, input: Record<string, unknown>) {
  // BotRunner hands the provider bypass only when the broker's mode is bypass and the turn is not strict.
  const step = outsideMcpStep(server, tool, input, { bypass: s.broker.bypassedFor(s.ctx), readOnly: s.broker.readOnly });
  if (step.kind === 'refuse') return { ran: false, step };
  if (step.kind === 'allow') return { ran: true, step };
  if (step.kind === 'once') return { ran: (await s.broker.askOutsideMcp(s.ctx, server.name, tool, input, signal())).allowed, step };
  // pass: bypass mode skips canUseTool; otherwise the broker decides.
  if (s.broker.bypassedFor(s.ctx)) return { ran: true, step };
  return { ran: (await s.broker.decide(s.ctx, 'mcp__' + server.name + '__' + tool, input, { signal: signal() })).behavior === 'allow', step };
}

describe("approve: 'mode' under ask", () => {
  it('runs a readTools tool with no card at all (the spike t1-readtool-card case)', async () => {
    const s = setup();
    const a = answer(s.broker, 'deny');
    const r = await call(s, blender, 'get_scene_info', {});
    a.off();
    expect(r).toEqual({ ran: true, step: { kind: 'allow' } });
    expect(a.cards).toHaveLength(0);
  });

  it('raises one normal card for a write, with "Always allow" offered, and "Always" covers the next call', async () => {
    const s = setup();
    const a = answer(s.broker, 'always');
    expect((await call(s, blender, 'execute_blender_code', code)).ran).toBe(true);
    expect((await call(s, blender, 'execute_blender_code', code)).ran).toBe(true);
    a.off();
    expect(a.cards).toHaveLength(1);
    expect(a.cards.map((c) => [c.toolName, c.once])).toEqual([['mcp__blender__execute_blender_code', undefined]]);
  });

  it("follows the owner's approval rules for a write", async () => {
    const s = setup();
    s.store.addPolicy({ botId: s.bot.id, tool: 'mcp__blender__execute_blender_code', pattern: '*', decision: 'allow', scope: 'always' });
    const a = answer(s.broker, 'deny');
    expect((await call(s, blender, 'execute_blender_code', code)).ran).toBe(true);
    a.off();
    expect(a.cards).toHaveLength(0);

    const d = setup();
    d.store.addPolicy({ botId: d.bot.id, tool: 'mcp__blender__execute_blender_code', pattern: '*', decision: 'deny', scope: 'always' });
    const b = answer(d.broker, 'allow');
    expect((await call(d, blender, 'execute_blender_code', code)).ran).toBe(false);
    b.off();
    expect(b.cards).toHaveLength(0);
  });

  it('refuses a write whose input is over 8000 chars, without a card', async () => {
    const s = setup();
    const a = answer(s.broker, 'allow');
    const r = await call(s, blender, 'execute_blender_code', { code: '#'.repeat(9000) });
    a.off();
    expect(r.ran).toBe(false);
    expect(r.step).toMatchObject({ kind: 'refuse', message: expect.stringMatching(/too large to show for approval \(\d+ chars\)/) });
    expect(a.cards).toHaveLength(0);
  });
});

describe("approve: 'mode' under bypass", () => {
  it('runs reads and writes with no card', async () => {
    const s = setup({ bypass: true });
    const a = answer(s.broker, 'deny');
    expect(await call(s, blender, 'get_scene_info', {})).toEqual({ ran: true, step: { kind: 'pass' } });
    expect(await call(s, blender, 'execute_blender_code', code)).toEqual({ ran: true, step: { kind: 'pass' } });
    a.off();
    expect(a.cards).toHaveLength(0);
  });

  it('NEGATIVE: a routine (strict) turn under bypass still asks for a write, and runs reads with no card', async () => {
    const s = setup({ bypass: true, strict: true });
    const a = answer(s.broker, 'deny');
    expect((await call(s, blender, 'execute_blender_code', code)).ran).toBe(false);
    expect((await call(s, blender, 'get_scene_info', {})).ran).toBe(true);
    a.off();
    expect(a.cards.map((c) => c.toolName)).toEqual(['mcp__blender__execute_blender_code']);
  });

  it('NEGATIVE: an every-call server under bypass still asks, once-only, on every call', async () => {
    const s = setup({ bypass: true });
    const a = answer(s.broker, 'always');
    expect((await call(s, runpod, 'create_pod', { gpu: 'A100' })).step).toEqual({ kind: 'once' });
    expect((await call(s, runpod, 'create_pod', { gpu: 'A100' })).ran).toBe(true);
    a.off();
    expect(a.cards).toHaveLength(2);
    expect(a.cards.every((c) => c.once)).toBe(true);
  });
});

describe("NEGATIVE: approve: 'mode' under read-only", () => {
  it('refuses a write without a card, with the same words as an every-call server', async () => {
    const s = setup({ readOnly: true });
    const a = answer(s.broker, 'allow');
    const mode = await call(s, blender, 'execute_blender_code', code);
    const every = await call(s, runpod, 'create_pod', { gpu: 'A100' });
    a.off();
    expect(mode).toEqual({ ran: false, step: { kind: 'refuse', message: OUTSIDE_READONLY_MESSAGE } });
    expect(every.ran).toBe(false);
    expect(OUTSIDE_READONLY_MESSAGE).toMatch(/read-only/i);
    expect(a.cards).toHaveLength(0);
  });

  it('still runs a readTools tool with no card', async () => {
    const s = setup({ readOnly: true });
    const a = answer(s.broker, 'deny');
    expect(await call(s, blender, 'get_scene_info', {})).toEqual({ ran: true, step: { kind: 'allow' } });
    a.off();
    expect(a.cards).toHaveLength(0);
  });
});

describe('other approve values keep their behaviour', () => {
  it.each([true, false])('every-call / writes / none, bypass=%s', (bypass) => {
    const o = { bypass };
    expect(outsideMcpStep({ name: 'x', approve: 'every-call', readTools: ['r'] }, 'r', {}, o)).toEqual({ kind: 'once' });
    expect(outsideMcpStep({ name: 'x', approve: 'writes', readTools: ['r'] }, 'r', {}, o)).toEqual({ kind: 'pass' });
    expect(outsideMcpStep({ name: 'x', approve: 'writes', readTools: ['r'] }, 'w', {}, o)).toEqual({ kind: 'once' });
    expect(outsideMcpStep({ name: 'x', approve: 'none', readTools: [] }, 'w', {}, o)).toEqual({ kind: 'pass' });
  });
});

describe('NEGATIVE: Blender code with bpy.ops.wm. is refused in every mode', () => {
  const wm = { code: 'import bpy\nbpy.ops.wm.save_mainfile(filepath="x.blend")' };
  it.each([
    ['ask', {}], ['bypass', { bypass: true }], ['strict under bypass', { bypass: true, strict: true }],
  ] as const)('under %s, without a card', async (_label, opts) => {
    const s = setup(opts);
    const a = answer(s.broker, 'allow');
    const r = await call(s, blender, 'execute_blender_code', wm);
    a.off();
    expect(r).toEqual({ ran: false, step: { kind: 'refuse', message: BLENDER_WM_MESSAGE } });
    expect(a.cards).toHaveLength(0);
  });

  it('whatever approve value a server named blender has, and only for execute_blender_code', () => {
    for (const approve of ['every-call', 'writes', 'none', 'mode'] as const) {
      for (const bypass of [true, false]) {
        expect(outsideMcpStep({ name: 'blender', approve, readTools: [] }, 'execute_blender_code', wm, { bypass }))
          .toEqual({ kind: 'refuse', message: BLENDER_WM_MESSAGE });
      }
    }
    expect(outsideMcpStep(blender, 'execute_blender_code', code, { bypass: true })).toEqual({ kind: 'pass' });
    expect(outsideMcpStep(blender, 'get_scene_info', {}, { bypass: false })).toEqual({ kind: 'allow' });
    expect(BLENDER_WM_MESSAGE).toContain('Use toki_save(); the file is opened for you.');
  });
});
