import { describe, expect, it } from 'vitest';
import type { ModelInfo, ProviderCheck, ProviderId } from '@pocketrocket/shared';
import { MessageVerificationSchema } from '@pocketrocket/shared';
import { Db } from '../db/db.js';
import { Repos } from '../db/repos.js';
import { MemoryService } from '../services/MemoryService.js';
import { SkillService } from '../services/SkillService.js';
import { UsageTracker } from '../services/UsageTracker.js';
import { PermissionBroker } from '../permissions/PermissionBroker.js';
import { TurnRegistry } from '../mcp/httpServer.js';
import { EMPTY_USAGE, type AgentProvider, type TurnContext, type TurnOutcome, type TurnSink } from '../providers/types.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { BotRunner } from './BotRunner.js';
import { classifyVerification, type TurnToolCall } from './verification.js';

const edit = (file = 'src/a.ts'): TurnToolCall => ({ name: 'Edit', input: { file_path: file, old_string: 'a', new_string: 'b' } });
const bash = (command: string): TurnToolCall => ({ name: 'Bash', input: { command } });

describe('classifyVerification (B1)', () => {
  it('write then test: verified', () => {
    expect(classifyVerification([edit(), bash('pnpm test')])).toBeUndefined();
    expect(classifyVerification([edit(), bash('npx vitest run src/a.test.ts')])).toBeUndefined();
    expect(classifyVerification([edit(), bash('cargo check')])).toBeUndefined();
    expect(classifyVerification([edit(), bash('npm run typecheck')])).toBeUndefined();
  });

  it('test then write: unverified', () => {
    const v = classifyVerification([bash('pnpm test'), edit('a.ts'), { name: 'Write', input: { file_path: 'b.ts', content: '' } }, edit('a.ts')]);
    expect(v).toEqual({ state: 'unverified', reason: 'edited 2 files, ran no test/build/screenshot after' });
    expect(MessageVerificationSchema.parse(v)).toEqual(v);
  });

  it('no writes: nothing to label', () => {
    expect(classifyVerification([])).toBeUndefined();
    expect(classifyVerification([{ name: 'Read', input: { file_path: 'a.ts' } }, bash('ls')])).toBeUndefined();
  });

  it('write then screenshot: verified', () => {
    expect(classifyVerification([edit(), { name: 'mcp__browser__browser_take_screenshot', input: {} }])).toBeUndefined();
    expect(classifyVerification([edit(), { name: 'mcp__pocketrocket__desktop_screenshot', input: {} }])).toBeUndefined();
  });

  it('a command that only looks around does not count as a check', () => {
    expect(classifyVerification([edit(), bash('git status'), bash('cat src/a.ts')])?.state).toBe('unverified');
    // "latest" contains "test" but not as a word.
    expect(classifyVerification([edit(), bash('echo latest')])?.state).toBe('unverified');
  });

  it('counts provider equivalents: MultiEdit, NotebookEdit, Codex/OpenCode patches, ACP edit and execute', () => {
    expect(classifyVerification([{ name: 'MultiEdit', input: { file_path: 'a.ts' } }])?.reason).toBe('edited 1 file, ran no test/build/screenshot after');
    expect(classifyVerification([{ name: 'NotebookEdit', input: { notebook_path: 'n.ipynb' } }])?.state).toBe('unverified');
    expect(classifyVerification([{ name: 'ApplyPatch', input: {} }])?.state).toBe('unverified');
    const acpEdit: TurnToolCall = { name: 'Change a file', input: { title: 'Change a file', kind: 'edit', paths: ['x.ts', 'y.ts'] } };
    expect(classifyVerification([acpEdit])?.reason).toBe('edited 2 files, ran no test/build/screenshot after');
    expect(classifyVerification([acpEdit, { name: 'Run', input: { kind: 'execute', command: 'go test ./...' } }])).toBeUndefined();
  });
});

type Step = { text: string } | { tool: string; input: unknown };

class ScriptedProvider implements AgentProvider {
  readonly id = 'claude' as const;
  readonly label = 'Scripted';
  readonly info = { id: 'claude' as ProviderId, label: 'Scripted', blurb: '', authModes: [], secretKeys: [], permissions: 'full' as const, maturity: 'verified' as const };
  constructor(private steps: Step[]) {}
  async models(): Promise<ModelInfo[]> { return []; }
  modelsSync(): ModelInfo[] { return []; }
  async check(): Promise<ProviderCheck> { return { ok: true, auth: 'unknown' }; }
  interrupt(): boolean { return false; }
  async runTurn(_ctx: TurnContext, sink: TurnSink): Promise<TurnOutcome> {
    sink.onSession('s1');
    let n = 0;
    for (const s of this.steps) {
      if ('text' in s) sink.onText(s.text);
      else {
        const id = 't' + n++;
        sink.onToolUse(id, s.tool, s.input);
        sink.onToolResult(id, 'ok', false);
      }
    }
    return { ok: true, costUsd: 0, usage: { ...EMPTY_USAGE }, durationMs: 1 };
  }
}

function setup(steps: Step[]) {
  const repos = new Repos(new Db(':memory:'));
  const bot = repos.createBot({ name: 'Dev', handle: 'dev', title: '', description: '', avatar: '🤖', model: 'm1', allowedTools: ['Read'], maxBudgetUsd: 10 });
  const room = repos.createRoom({ kind: 'dm', name: 'D', memberIds: [bot.id], coordinatorBotId: null });
  const provider = new ScriptedProvider(steps);
  const providers = { active: () => provider, get: () => provider } as unknown as ProviderRegistry;
  const runner = new BotRunner(
    repos, new MemoryService(), new SkillService(repos), new PermissionBroker(repos), new UsageTracker(repos),
    { dispatchFromBot: () => [], setState: () => undefined }, providers, new TurnRegistry(),
  );
  const run = () => runner.runTurn({ bot, room, members: [bot], injected: 'go', hop: 0, causeId: 'c1' } as never);
  const replies = () => repos.messagesAfter(room.id, 0).filter((m) => m.kind === 'text');
  return { run, replies };
}

describe('BotRunner labels an unverified final reply', () => {
  it('puts the verification on the reply of a turn that edited and checked nothing after', async () => {
    const s = setup([{ tool: 'Edit', input: { file_path: 'src/page.tsx' } }, { text: 'Done, the header is fixed.' }]);
    await s.run();
    const [reply] = s.replies();
    expect(reply.payload).toEqual({ verification: { state: 'unverified', reason: 'edited 1 file, ran no test/build/screenshot after' } });
  });

  it('leaves the reply alone when the turn ran the build after its last edit', async () => {
    const s = setup([{ tool: 'Edit', input: { file_path: 'src/page.tsx' } }, { tool: 'Bash', input: { command: 'pnpm -r build' } }, { text: 'Done, build is green.' }]);
    await s.run();
    expect(s.replies()[0].payload).toBeNull();
  });
});
