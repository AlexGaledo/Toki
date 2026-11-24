import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({ options: [] as Record<string, unknown>[] }));
vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>()),
  query: ({ options }: { options: Record<string, unknown> }) => {
    sdk.options.push(options);
    async function* gen() {
      yield { type: 'result', subtype: 'success', total_cost_usd: 0, duration_ms: 1, usage: {}, result: 'ok' };
    }
    return Object.assign(gen(), { interrupt: async () => undefined });
  },
}));

import { DATA_DIR, WORKSPACE_DIR } from '../config.js';
import { ClaudeProvider } from './claude.js';
import type { TurnContext } from './types.js';
import type { OutsideMcpServer } from '../services/outsideMcp.js';
import { HUB_KEYS_MESSAGE } from '../permissions/secretFiles.js';

type Hook = { matcher: string; hooks: ((i: unknown) => Promise<{ hookSpecificOutput?: { permissionDecision: string; permissionDecisionReason: string } }>)[] };

const servers: OutsideMcpServer[] = [
  { kind: 'stdio', name: 'runpod', command: 'npx', args: ['-y', 'runpod-mcp'], env: { RUNPOD_API_KEY: 'rp-key-12345678' }, approve: 'every-call', readTools: [], needs: [] },
  { kind: 'stdio', name: 'firecrawl', command: 'npx', args: [], env: {}, approve: 'writes', readTools: ['firecrawl_search'], needs: [] },
  { kind: 'http', name: 'wika', url: 'https://dashboard.wikaph.com/api/mcp', token: 'k-123456789', approve: 'none', readTools: [], needs: [] },
  { kind: 'stdio', name: 'blender', command: 'C:\\tools\\mcp-for-blender.exe', args: [], env: {}, approve: 'mode', readTools: ['get_scene_info', 'look'], needs: [] },
];

function firstHook(h: Hook): Hook['hooks'][number] {
  const f = h.hooks.at(0);
  if (!f) throw new Error('hook has no handler');
  return f;
}

async function runTurn(bypass: boolean, gate?: (name: string, input: Record<string, unknown>) => Promise<string | null>, extra: Partial<TurnContext> = {}) {
  const ctx = {
    turnId: 't', bot: { id: 'b', handle: 'b' }, room: {}, members: [], systemPrompt: '', input: 'hi', resumeToken: null,
    workspaceDir: WORKSPACE_DIR, botHome: path.join(os.tmpdir(), 'prc-home'), tools: [], allowedBuiltins: ['Read', 'Bash'],
    bypassPermissions: bypass, permission: async () => 'allow', pluginDir: null, model: 'claude-sonnet-5',
    maxBudgetUsd: 1, maxTurns: 1, signal: new AbortController().signal, mcp: { url: '', token: '' },
    outsideMcp: servers, outsideMcpGate: gate, ...extra,
  } as unknown as TurnContext;
  const sink = { onSession() {}, onDelta() {}, onText() {}, onToolUse() {}, onToolResult() {}, onState() {} };
  await new ClaudeProvider().runTurn(ctx, sink);
  const o = sdk.options.at(-1) as { mcpServers: Record<string, unknown>; hooks: { PreToolUse: Hook[] } };
  return { o, hooks: o.hooks.PreToolUse };
}

describe('outside MCP servers in the Claude provider', () => {
  it('maps stdio entries to stdio servers and keeps http as before', async () => {
    const { o } = await runTurn(false);
    expect(o.mcpServers.runpod).toEqual({ type: 'stdio', command: 'npx', args: ['-y', 'runpod-mcp'], env: { RUNPOD_API_KEY: 'rp-key-12345678' } });
    expect(o.mcpServers.wika).toEqual({ type: 'http', url: 'https://dashboard.wikaph.com/api/mcp', headers: { Authorization: 'Bearer k-123456789' } });
  });

  it('gates approve servers under bypass: card per call, readTools skip, answers allow or deny', async () => {
    const asked: string[] = [];
    let verdict: string | null = null;
    const { hooks } = await runTurn(true, async (name) => { asked.push(name); return verdict; });
    const hook = hooks.find((h) => h.matcher.startsWith('mcp__('))!;
    const re = new RegExp('^(' + hook.matcher + ')$');
    expect(re.test('mcp__runpod__create_pod')).toBe(true);
    expect(re.test('mcp__firecrawl__firecrawl_scrape')).toBe(true);
    expect(re.test('mcp__wika__api_request')).toBe(false);
    expect(re.test('mcp__pocketrocket__send_message')).toBe(false);

    expect((await hook.hooks[0]({ tool_name: 'mcp__runpod__create_pod', tool_input: { gpu: 'x' } })).hookSpecificOutput)
      .toMatchObject({ permissionDecision: 'allow' });
    expect(await hook.hooks[0]({ tool_name: 'mcp__firecrawl__firecrawl_search', tool_input: {} })).toEqual({});
    verdict = 'The user declined this outside tool call.';
    expect((await hook.hooks[0]({ tool_name: 'mcp__firecrawl__firecrawl_scrape', tool_input: {} })).hookSpecificOutput)
      .toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: verdict });
    expect(asked).toEqual(['mcp__runpod__create_pod', 'mcp__firecrawl__firecrawl_scrape']);
  });

  it("approve 'mode' under ask: read tools allowed with no card, writes left to the normal card, wm code refused", async () => {
    const asked: string[] = [];
    const { hooks } = await runTurn(false, async (name) => { asked.push(name); return null; });
    const hook = hooks.find((h) => h.matcher.startsWith('mcp__('))!;
    const run = firstHook(hook);
    expect(new RegExp('^(' + hook.matcher + ')$').test('mcp__blender__look')).toBe(true);
    expect((await run({ tool_name: 'mcp__blender__get_scene_info', tool_input: {} })).hookSpecificOutput)
      .toMatchObject({ permissionDecision: 'allow' });
    // {} hands the call to canUseTool, which raises the normal card with rules and "Always allow".
    expect(await run({ tool_name: 'mcp__blender__execute_blender_code', tool_input: { code: 'x = 1' } })).toEqual({});
    expect((await run({ tool_name: 'mcp__blender__execute_blender_code', tool_input: { code: 'bpy.ops.wm.quit_blender()' } })).hookSpecificOutput)
      .toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: expect.stringContaining('toki_save()') });
    expect(asked).toEqual([]);
  });

  it("approve 'mode' under bypass: no card for reads or writes, wm code still refused", async () => {
    const asked: string[] = [];
    const { hooks } = await runTurn(true, async (name) => { asked.push(name); return null; });
    const hook = hooks.find((h) => h.matcher.startsWith('mcp__('))!;
    const run = firstHook(hook);
    expect(await run({ tool_name: 'mcp__blender__get_scene_info', tool_input: {} })).toEqual({});
    expect(await run({ tool_name: 'mcp__blender__execute_blender_code', tool_input: { code: 'x = 1' } })).toEqual({});
    expect((await run({ tool_name: 'mcp__blender__execute_blender_code', tool_input: { code: 'bpy.ops.wm.save_mainfile()' } })).hookSpecificOutput)
      .toMatchObject({ permissionDecision: 'deny' });
    expect(asked).toEqual([]);
  });

  it("NEGATIVE: a blender server with approve 'none' is still hooked, so wm code is refused", async () => {
    const none: OutsideMcpServer[] = [{ kind: 'stdio', name: 'blender', command: 'C:\tools\mcp-for-blender.exe', args: [], env: {}, approve: 'none', readTools: [], needs: [] }];
    const { hooks } = await runTurn(true, async () => null, { outsideMcp: none });
    const hook = hooks.find((h) => h.matcher.startsWith('mcp__('));
    expect(hook?.matcher).toBe('mcp__(blender)__.*');
    expect((await firstHook(hook!)({ tool_name: 'mcp__blender__execute_blender_code', tool_input: { code: 'bpy.ops.wm.quit_blender()' } })).hookSpecificOutput)
      .toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: expect.stringContaining('toki_save()') });
  });

  it('denies a gated call when no gate is wired', async () => {
    const { hooks } = await runTurn(true);
    const hook = hooks.find((h) => h.matcher.startsWith('mcp__('))!;
    expect((await hook.hooks[0]({ tool_name: 'mcp__runpod__create_pod', tool_input: {} })).hookSpecificOutput)
      .toMatchObject({ permissionDecision: 'deny' });
  });

  it('installs the secret-file guard in bypass and in ask mode', async () => {
    for (const bypass of [true, false]) {
      const { hooks } = await runTurn(bypass);
      const results = await Promise.all(
        hooks.filter((h) => new RegExp('^(' + h.matcher + ')$').test('Bash'))
          .map((h) => h.hooks[0]({ tool_name: 'Bash', tool_input: { command: 'cat ../secrets.json' }, cwd: WORKSPACE_DIR })),
      );
      expect(results.map((r) => r.hookSpecificOutput).filter(Boolean)).toContainEqual(
        expect.objectContaining({ permissionDecision: 'deny', permissionDecisionReason: HUB_KEYS_MESSAGE }),
      );
      const read = hooks.find((h) => new RegExp('^(' + h.matcher + ')$').test('Read'))!;
      expect((await read.hooks[0]({ tool_name: 'Read', tool_input: { file_path: path.join(DATA_DIR, 'hub-token') }, cwd: WORKSPACE_DIR })).hookSpecificOutput)
        .toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: HUB_KEYS_MESSAGE });
    }
  });
});

describe("B12: Toki's Blender behind the outside hook", () => {
  const blenderHook = async (extra: Partial<TurnContext>) => {
    const { hooks } = await runTurn(false, async () => null, extra);
    return firstHook(hooks.find((h) => h.matcher.startsWith('mcp__('))!);
  };

  it('starts Blender before a blender tool runs, and refuses the call with its reason when it cannot', async () => {
    const calls: string[] = [];
    let down: string | null = null;
    const hook = await blenderHook({ blenderEnsure: async () => { calls.push('ensure'); return down; } });
    expect(await hook({ tool_name: 'mcp__blender__execute_blender_code', tool_input: { code: 'x=1' } })).toEqual({});
    expect((await hook({ tool_name: 'mcp__blender__get_scene_info', tool_input: {} })).hookSpecificOutput).toMatchObject({ permissionDecision: 'allow' });
    expect(calls).toEqual(['ensure', 'ensure']);
    down = 'Another Blender is running on this PC (blender.exe, pid 42). Try again when it finishes.';
    expect((await hook({ tool_name: 'mcp__blender__get_scene_info', tool_input: {} })).hookSpecificOutput)
      .toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: down });
  });

  it('does not start Blender for a refused call or for another server', async () => {
    const calls: string[] = [];
    const hook = await blenderHook({ blenderEnsure: async () => { calls.push('ensure'); return null; } });
    await hook({ tool_name: 'mcp__blender__execute_blender_code', tool_input: { code: 'bpy.ops.wm.quit_blender()' } });
    await hook({ tool_name: 'mcp__runpod__create_pod', tool_input: {} });
    expect(calls).toEqual([]);
  });

  it('NEGATIVE: under read-only a mode write is refused by the hook, a read still runs', async () => {
    const hook = await blenderHook({ approvalsReadOnly: true, blenderEnsure: async () => null });
    expect((await hook({ tool_name: 'mcp__blender__execute_blender_code', tool_input: { code: 'x=1' } })).hookSpecificOutput)
      .toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: expect.stringMatching(/read-only/i) });
    expect((await hook({ tool_name: 'mcp__blender__look', tool_input: {} })).hookSpecificOutput).toMatchObject({ permissionDecision: 'allow' });
  });
});
