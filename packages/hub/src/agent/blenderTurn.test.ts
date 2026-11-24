import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ModelInfo, ProviderCheck, ProviderId, Room } from '@pocketrocket/shared';
import { Db } from '../db/db.js';
import { Repos } from '../db/repos.js';
import { MemoryService } from '../services/MemoryService.js';
import { SkillService } from '../services/SkillService.js';
import { UsageTracker } from '../services/UsageTracker.js';
import { ProjectService } from '../services/ProjectService.js';
import { BlenderHost, blenderToolPaths, type RunningBlender } from '../services/BlenderHost.js';
import { PermissionBroker } from '../permissions/PermissionBroker.js';
import { TurnRegistry } from '../mcp/httpServer.js';
import { EMPTY_USAGE, type AgentProvider, type TurnContext, type TurnOutcome, type TurnSink } from '../providers/types.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { RoomFiles } from '../rooms/roomFiles.js';
import { BotRunner } from './BotRunner.js';

// B12: a game project's room mounts Toki's own headless Blender as the built-in `blender` server.
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

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function setup(o: { readOnly?: boolean; tools?: boolean } = {}) {
  const db = new Db(':memory:');
  const repos = new Repos(db);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-blenderturn-'));
  dirs.push(tmp);
  const memory = new MemoryService();
  const projects = new ProjectService({ db, repos, memory, root: path.join(tmp, 'projects') });
  const roomFiles = new RoomFiles({ projects, roomsDir: path.join(tmp, 'rooms'), dmDir: (id) => path.join(tmp, 'bots', id, 'files') });
  const provider = new RecordingProvider();
  const providers = { active: () => provider, get: () => provider } as unknown as ProviderRegistry;
  const runner = new BotRunner(
    repos, memory, new SkillService(repos), new PermissionBroker(repos, { globalReadOnly: () => !!o.readOnly }), new UsageTracker(repos),
    { dispatchFromBot: () => [], setState: () => undefined }, providers, new TurnRegistry(),
  );
  runner.projects = projects;
  runner.roomFiles = roomFiles;

  const tools = blenderToolPaths(tmp);
  if (o.tools !== false) {
    for (const f of [tools.addon, tools.mcpExe]) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, ''); }
  }
  const others: RunningBlender[] = [{ exe: 'blender.exe', pid: 77 }];
  const script = path.join(tmp, 'server.py');
  fs.writeFileSync(script, '');
  runner.blender = new BlenderHost({
    dataDir: tmp, exe: () => 'C:\\Blender\\blender.exe', script, pickPort: async () => 50123, listBlenders: async () => others,
    spawn: () => { throw new Error('not in this test'); }, log: () => undefined,
  });

  const bot = repos.createBot({ name: 'Artist', handle: 'artist', title: '', description: '', avatar: '', model: 'm1', allowedTools: ['Read'], maxBudgetUsd: 1 });
  const group = (name: string) => repos.createRoom({ kind: 'group', name, memberIds: [bot.id], coordinatorBotId: null }) as Room;
  const gameRoom = group('Game');
  const devRoom = group('Dev');
  projects.create({ name: 'Cat Game', memberIds: [bot.id] });
  projects.create({ name: 'Website', memberIds: [bot.id] });
  db.run('UPDATE projects SET room_id=?, kind=? WHERE slug=?', gameRoom.id, 'game', 'cat-game');
  db.run('UPDATE projects SET room_id=? WHERE slug=?', devRoom.id, 'website');

  const run = async (room: Room) => {
    await runner.runTurn({ bot, room, members: [bot], injected: 'hi', hop: 0, causeId: 'c-' + room.id });
    return provider.seen[provider.seen.length - 1]!;
  };
  return { run, gameRoom, devRoom, tools, projects };
}

describe("a game room's turn", () => {
  it('mounts the built-in blender server on the live port, approve mode, with the read tools', async () => {
    const s = setup();
    const ctx = await s.run(s.gameRoom);
    const b = ctx.outsideMcp?.filter((x) => x.name === 'blender');
    expect(b).toEqual([{
      kind: 'stdio', name: 'blender', command: s.tools.mcpExe, args: [],
      env: {
        BLENDER_HOST: '127.0.0.1', BLENDER_PORT: '50123', DISABLE_TELEMETRY: 'true',
        APPDATA: s.tools.home, XDG_CONFIG_HOME: path.join(s.tools.home, '.config'), BLENDERMCP_ADDONS_DIR: path.dirname(s.tools.addon),
      },
      approve: 'mode', readTools: ['get_addon_status', 'get_scene_info', 'look', 'search_assets'], needs: [],
    }]);
    expect(s.projects.get('cat-game')?.kind).toBe('game');
  });

  it('hands the hook an ensure for this project, which refuses while another Blender runs', async () => {
    const s = setup();
    const ctx = await s.run(s.gameRoom);
    expect(await ctx.blenderEnsure!()).toBe('Another Blender is running on this PC (blender.exe, pid 77). Try again when it finishes.');
  });

  it('NEGATIVE: a room of a project that is not a game gets no blender server and no ensure', async () => {
    const s = setup();
    const ctx = await s.run(s.devRoom);
    expect(ctx.outsideMcp?.some((x) => x.name === 'blender')).toBe(false);
    expect(ctx.blenderEnsure).toBeUndefined();
  });

  it('mounts nothing while the Blender MCP tools are not installed', async () => {
    const s = setup({ tools: false });
    const ctx = await s.run(s.gameRoom);
    expect(ctx.outsideMcp?.some((x) => x.name === 'blender')).toBe(false);
    expect(ctx.blenderEnsure).toBeUndefined();
  });

  it('tells the provider when the hub is read-only', async () => {
    const s = setup({ readOnly: true });
    expect((await s.run(s.gameRoom)).approvalsReadOnly).toBe(true);
    const t = setup();
    expect((await t.run(t.gameRoom)).approvalsReadOnly).toBe(false);
  });
});
