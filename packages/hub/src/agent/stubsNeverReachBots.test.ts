import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelInfo, ProviderCheck, ProviderId, Room } from '@pocketrocket/shared';
import { Db } from '../db/db.js';
import { Repos } from '../db/repos.js';
import { MemoryService } from '../services/MemoryService.js';
import { SkillService } from '../services/SkillService.js';
import { UsageTracker } from '../services/UsageTracker.js';
import { ProjectService } from '../services/ProjectService.js';
import { RemoteProjects } from '../services/RemoteProjects.js';
import { PermissionBroker } from '../permissions/PermissionBroker.js';
import { TurnRegistry } from '../mcp/httpServer.js';
import { EMPTY_USAGE, type AgentProvider, type TurnContext, type TurnOutcome, type TurnSink } from '../providers/types.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { RoomFiles } from '../rooms/roomFiles.js';
import { BotRunner } from './BotRunner.js';
import { settings } from '../services/SettingsStore.js';

// B10: stubs (other hosts' project names) never reach a bot: not the prompt, the roots, the hub tools or the folder guard.

class RecordingProvider implements AgentProvider {
  readonly id = 'claude' as const;
  readonly label = 'Recording';
  readonly info = { id: 'claude' as ProviderId, label: 'Recording', blurb: '', authModes: [], secretKeys: [], permissions: 'full' as const, maturity: 'verified' as const };
  seen: TurnContext[] = [];
  async models(): Promise<ModelInfo[]> { return []; }
  modelsSync(): ModelInfo[] { return []; }
  async check(): Promise<ProviderCheck> { return { ok: true, auth: 'unknown' }; }
  interrupt(): boolean { return false; }
  async runTurn(ctx: TurnContext, sink: TurnSink): Promise<TurnOutcome> {
    this.seen.push({ ...ctx });
    sink.onText('done');
    return { ok: true, costUsd: 0, usage: { ...EMPTY_USAGE }, durationMs: 1 };
  }
}

const STUB_SLUG = 'vps-secret-quest';
const STUB_NAME = 'Vps Secret Quest';
// Same slug as a local project, different name: only the local one may show.
const CLASH_NAME = 'Alpha On The Server';

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function setup() {
  const db = new Db(':memory:');
  const repos = new Repos(db);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-stubs-'));
  dirs.push(tmp);
  const memory = new MemoryService();
  const projects = new ProjectService({ db, repos, memory, root: path.join(tmp, 'projects') });
  const roomFiles = new RoomFiles({ projects, roomsDir: path.join(tmp, 'rooms'), dmDir: (id) => path.join(tmp, 'bots', id, 'files') });
  const provider = new RecordingProvider();
  const providers = { active: () => provider, get: () => provider } as unknown as ProviderRegistry;
  const runner = new BotRunner(
    repos, memory, new SkillService(repos), new PermissionBroker(repos, { bypass: () => true }), new UsageTracker(repos),
    { dispatchFromBot: () => [], setState: () => undefined }, providers, new TurnRegistry(),
  );
  runner.projects = projects;
  runner.roomFiles = roomFiles;

  const bot = repos.createBot({ name: 'Lead', handle: 'lead', title: '', description: '', avatar: '', model: 'm1', allowedTools: ['Read'], maxBudgetUsd: 1 });
  const roomA = repos.createRoom({ kind: 'group', name: 'A', memberIds: [bot.id], coordinatorBotId: null }) as Room;
  const dm = repos.createRoom({ kind: 'dm', name: 'DM', memberIds: [bot.id], coordinatorBotId: null }) as Room;
  projects.create({ name: 'Alpha', memberIds: [bot.id] });
  db.run('UPDATE projects SET room_id=? WHERE slug=?', roomA.id, 'alpha');

  // The same DB, as on a real hub. A folder with the stub's slug on disk must stay closed too.
  new RemoteProjects({ db }).put('server', { connected: true, projects: [{ slug: STUB_SLUG, name: STUB_NAME }, { slug: 'alpha', name: CLASH_NAME }] });
  fs.mkdirSync(path.join(projects.root, STUB_SLUG), { recursive: true });
  fs.writeFileSync(path.join(projects.root, STUB_SLUG, 'current.md'), 'stub');

  const run = async (room: Room) => {
    await runner.runTurn({ bot, room, members: [bot], injected: 'hi', hop: 0, causeId: 'c-' + room.id });
    return provider.seen[provider.seen.length - 1]!;
  };
  return { bot, run, projects, roomA, dm };
}

async function toolTexts(ctx: TurnContext): Promise<string> {
  expect(ctx.tools.filter((x) => x.readOnly).length).toBeGreaterThan(3);
  const out: string[] = ctx.tools.map((t) => t.name + ' ' + t.description);
  for (const t of ctx.tools.filter((x) => x.readOnly)) {
    const args = t.name === 'search_project_context' ? { query: STUB_NAME } : {};
    try {
      const r = await t.handler(args);
      out.push(...r.content.map((c) => (c.type === 'text' ? c.text : '')));
    } catch (e) {
      out.push(String(e));
    }
  }
  return out.join('\n');
}

function expectNoStub(ctx: TurnContext, projectsRoot: string, tools: string) {
  const stubDir = path.join(projectsRoot, STUB_SLUG);
  for (const text of [ctx.systemPrompt, ctx.input, tools]) {
    expect(text).not.toContain(STUB_NAME);
    expect(text).not.toContain(STUB_SLUG);
    expect(text).not.toContain(CLASH_NAME);
  }
  expect(ctx.projectDirs ?? []).not.toContain(stubDir);
  expect(ctx.readOnlyDirs ?? []).not.toContain(stubDir);
  expect(ctx.projectGuard!('Read', { file_path: path.join(stubDir, 'current.md') }, ctx.workspaceDir)).toMatch(/another room/);
  expect(ctx.projectGuard!('Bash', { command: 'cat ' + stubDir.replaceAll('\\', '/') + '/current.md' }, ctx.workspaceDir)).toMatch(/another room/);
}

describe('stubs never reach a bot', () => {
  it('ProjectService, which every bot path reads, knows only local projects', () => {
    const s = setup();
    expect(s.projects.list().map((p) => [p.slug, p.name])).toEqual([['alpha', 'Alpha']]);
    expect(s.projects.knownSlugs()).toEqual(['alpha']);
    expect(s.projects.get(STUB_SLUG)).toBeUndefined();
    expect(() => s.projects.need(STUB_SLUG)).toThrow('No project called');
    expect(s.projects.get('alpha')!.name).toBe('Alpha');
  });

  it('in a project room: not in the prompt, the roots, the hub tools or the folder guard', async () => {
    const s = setup();
    const ctx = await s.run(s.roomA);
    expect(ctx.systemPrompt).toContain(s.projects.dirOf('alpha'));
    expect(ctx.tools.map((t) => t.name)).toContain('search_project_context');
    expectNoStub(ctx, s.projects.root, await toolTexts(ctx));
  });

  it('for the persona, who may read every project: still only local ones', async () => {
    const s = setup();
    const realGet = settings.get.bind(settings);
    vi.spyOn(settings, 'get').mockImplementation(() => ({ ...realGet(), personaBotId: s.bot.id }));
    for (const room of [s.roomA, s.dm]) {
      const ctx = await s.run(room);
      expect(ctx.readOnlyDirs ?? []).toEqual(room === s.dm ? [s.projects.dirOf('alpha')] : []);
      expectNoStub(ctx, s.projects.root, await toolTexts(ctx));
    }
  });
});

describe('architecture: only the owner-facing API reads stubs', () => {
  const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  function files(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return e.name === 'node_modules' || e.name === '__fixtures__' ? [] : files(p);
      return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [p] : [];
    });
  }

  it('NEGATIVE: nothing but hub.ts and api/projects.ts imports RemoteProjects or touches its tables', () => {
    const offenders = files(src)
      .filter((f) => !f.endsWith(path.join('services', 'RemoteProjects.ts')) && !f.endsWith(path.join('db', 'migrations.ts')))
      .filter((f) => {
        const text = fs.readFileSync(f, 'utf8');
        return /RemoteProjects\.js|\bproject_stubs\b|\bremote_hosts\b/.test(text);
      })
      .map((f) => path.relative(src, f).replaceAll('\\', '/'))
      .sort();
    expect(offenders).toEqual(['api/projects.ts', 'hub.ts']);
  });
});
