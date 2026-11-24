import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_ATTACHMENT_IMAGE_BYTES, type ModelInfo, type ProviderCheck, type ProviderId, type Room, type ServerEvent, type ToolPayload } from '@pocketrocket/shared';
import { Db } from '../db/db.js';
import { Repos } from '../db/repos.js';
import { events } from '../events.js';
import { MemoryService } from '../services/MemoryService.js';
import { MediaStore } from '../services/MediaStore.js';
import { SkillService } from '../services/SkillService.js';
import { UsageTracker } from '../services/UsageTracker.js';
import { ProjectService } from '../services/ProjectService.js';
import { BlenderHost, blenderToolPaths } from '../services/BlenderHost.js';
import type { OutsideMcpServer } from '../services/outsideMcp.js';
import { PermissionBroker } from '../permissions/PermissionBroker.js';
import { TurnRegistry } from '../mcp/httpServer.js';
import { EMPTY_USAGE, type AgentProvider, type ToolResultImage, type TurnContext, type TurnOutcome, type TurnSink } from '../providers/types.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { RoomFiles } from '../rooms/roomFiles.js';
import { BotRunner } from './BotRunner.js';
import { isLookBackTool, lookBackServers, storeLookBack, stripCliImagePaths } from './lookBacks.js';

// B9: a game tool's picture is stored as media and attached to that tool's message.
const PNG = (tag: string) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('IHDR look-back ' + tag)]);
const CLI_PATH = 'C:\\Users\\owner\\.claude\\projects\\C--toki-data-workspace\\92e7\\tool-results\\mcp-blender-blob-1795504695902-t13vfx.png';
// The exact shape the spike saw in chat (docs/verify/game-tools-spike/t1-look-result.aria.yml).
const CLI_OUTPUT = '[image]\n[Image: source: ' + CLI_PATH + "]\nThrough camera 'Camera'. Framed 1 objects.";

type Call = { tool: string; output: string; image?: ToolResultImage };
class ToolProvider implements AgentProvider {
  readonly id = 'claude' as const;
  readonly label = 'Tools';
  readonly info = { id: 'claude' as ProviderId, label: 'Tools', blurb: '', authModes: [], secretKeys: [], permissions: 'full' as const, maturity: 'verified' as const };
  calls: Call[] = [];
  async models(): Promise<ModelInfo[]> { return []; }
  modelsSync(): ModelInfo[] { return []; }
  async check(): Promise<ProviderCheck> { return { ok: true, auth: 'unknown' }; }
  interrupt(): boolean { return false; }
  async runTurn(_ctx: TurnContext, sink: TurnSink): Promise<TurnOutcome> {
    this.calls.forEach((c, i) => {
      sink.onToolUse('tu-' + i, c.tool, {});
      sink.onToolResult('tu-' + i, c.output, false, c.image);
    });
    sink.onText('done');
    return { ok: true, costUsd: 0, usage: { ...EMPTY_USAGE }, durationMs: 1 };
  }
}

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function setup() {
  const db = new Db(':memory:');
  const repos = new Repos(db);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-lookback-'));
  dirs.push(tmp);
  const memory = new MemoryService();
  const projects = new ProjectService({ db, repos, memory, root: path.join(tmp, 'projects') });
  const provider = new ToolProvider();
  const providers = { active: () => provider, get: () => provider } as unknown as ProviderRegistry;
  const mediaDir = path.join(tmp, 'media');
  const media = new MediaStore(mediaDir);
  const runner = new BotRunner(
    repos, memory, new SkillService(repos), new PermissionBroker(repos), new UsageTracker(repos),
    { dispatchFromBot: () => [], setState: () => undefined }, providers, new TurnRegistry(), undefined, {}, media,
  );
  runner.projects = projects;
  runner.roomFiles = new RoomFiles({ projects, roomsDir: path.join(tmp, 'rooms'), dmDir: (id) => path.join(tmp, 'bots', id, 'files') });
  const tools = blenderToolPaths(tmp);
  for (const f of [tools.addon, tools.mcpExe]) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, ''); }
  const script = path.join(tmp, 'server.py');
  fs.writeFileSync(script, '');
  runner.blender = new BlenderHost({
    dataDir: tmp, exe: () => 'C:\\Blender\\blender.exe', script, pickPort: async () => 50123, listBlenders: async () => [],
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

  const updates: ServerEvent[] = [];
  const off = events.onEvent((ev) => { if (ev.type === 'message.update') updates.push(ev); });
  const run = async (room: Room, calls: Call[]) => {
    provider.calls = calls;
    await runner.runTurn({ bot, room, members: [bot], injected: 'hi', hop: 0, causeId: 'c-' + Math.random() });
    off();
    return repos.listMessages(room.id, { limit: 50 }).filter((m) => m.kind === 'tool');
  };
  const stored = () => (fs.existsSync(mediaDir) ? fs.readdirSync(mediaDir) : []);
  return { run, gameRoom, devRoom, updates, stored, media };
}
const img = (bytes: Buffer, mediaType = 'image/png'): ToolResultImage => ({ mediaType, data: bytes.toString('base64') });
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe('look-backs in a game room', () => {
  it("stores Blender's look as media, attaches it to that tool message, and drops the CLI's file path from the text", async () => {
    const s = setup();
    const bytes = PNG('cube');
    const [msg] = await s.run(s.gameRoom, [{ tool: 'mcp__blender__look', output: CLI_OUTPUT, image: img(bytes) }]);
    expect(msg!.attachments).toEqual(['img:' + sha(bytes)]);
    expect(s.media.read(sha(bytes))?.bytes.equals(bytes)).toBe(true);
    const out = (msg!.payload as ToolPayload).output!;
    expect(out).toBe("[image]\nThrough camera 'Camera'. Framed 1 objects.");
    expect(out).not.toContain('tool-results');
    expect(out).not.toContain('.claude');
    const patch = s.updates.find((e) => e.type === 'message.update' && e.id === msg!.id && e.patch.attachments);
    expect(patch && patch.type === 'message.update' && patch.patch.attachments).toEqual(['img:' + sha(bytes)]);
  });

  it('keeps one image per call: each call gets its own single attachment', async () => {
    const s = setup();
    const a = PNG('a');
    const b = PNG('b');
    const msgs = await s.run(s.gameRoom, [
      { tool: 'mcp__blender__look', output: 'one', image: img(a) },
      { tool: 'mcp__blender__get_scene_info', output: 'no picture' },
      { tool: 'mcp__blender__look', output: 'two', image: img(b) },
    ]);
    expect(msgs.map((m) => m.attachments ?? null)).toEqual([['img:' + sha(a)], null, ['img:' + sha(b)]]);
  });

  it('NEGATIVE: an image from another outside server is not stored, and its text is left alone', async () => {
    const s = setup();
    const [msg] = await s.run(s.gameRoom, [{ tool: 'mcp__figma__get_screenshot', output: CLI_OUTPUT, image: img(PNG('figma')) }]);
    expect(msg!.attachments).toBeUndefined();
    expect(s.stored()).toEqual([]);
    expect((msg!.payload as ToolPayload).output).toBe(CLI_OUTPUT);
  });

  it('NEGATIVE: a blender tool outside a game room (not the built-in server) is not stored', async () => {
    const s = setup();
    const [msg] = await s.run(s.devRoom, [{ tool: 'mcp__blender__look', output: 'x', image: img(PNG('dev')) }]);
    expect(msg!.attachments).toBeUndefined();
    expect(s.stored()).toEqual([]);
  });

  it('NEGATIVE: an image over the attachment limit, or not a picture, is dropped and the turn goes on', async () => {
    const s = setup();
    const huge = Buffer.concat([PNG('big'), Buffer.alloc(MAX_ATTACHMENT_IMAGE_BYTES)]);
    const msgs = await s.run(s.gameRoom, [
      { tool: 'mcp__blender__look', output: 'big', image: img(huge) },
      { tool: 'mcp__blender__look', output: 'svg', image: img(Buffer.from('<svg onload="x()"></svg>'), 'image/svg+xml') },
    ]);
    expect(msgs.map((m) => m.attachments ?? null)).toEqual([null, null]);
    expect(msgs.map((m) => (m.payload as ToolPayload).done)).toEqual([true, true]);
    expect(s.stored()).toEqual([]);
  });
});

describe('which servers get look-backs', () => {
  const blender = { kind: 'stdio', name: 'blender', command: 'x', args: [], env: {}, needs: [] } as unknown as OutsideMcpServer;
  const fileBlender = { ...blender } as OutsideMcpServer;
  const studio = { ...blender, name: 'roblox-studio' } as OutsideMcpServer;
  const other = { ...blender, name: 'figma' } as OutsideMcpServer;

  it("is the built-in blender entry and the Studio recipe, in a game room only", () => {
    expect([...lookBackServers({ game: true, blender, mounted: [studio, other, blender] })].sort()).toEqual(['blender', 'roblox-studio']);
    expect([...lookBackServers({ game: false, blender: null, mounted: [studio, other, fileBlender] })]).toEqual([]);
    // A file entry called blender is not Toki's own server.
    expect([...lookBackServers({ game: true, blender: null, mounted: [fileBlender] })]).toEqual([]);
    const set = lookBackServers({ game: true, blender, mounted: [studio, blender] });
    expect(isLookBackTool('mcp__roblox-studio__screen_capture', set)).toBe(true);
    expect(isLookBackTool('mcp__blender__look', set)).toBe(true);
    expect(isLookBackTool('mcp__blender-extra__look', set)).toBe(false);
    expect(isLookBackTool('mcp__figma__get_screenshot', set)).toBe(false);
  });

  it('strips only the CLI image-path line', () => {
    expect(stripCliImagePaths('[image]\r\n[Image: source: C:\\a\\tool-results\\b.png]\r\nok')).toBe('[image]\r\nok');
    expect(stripCliImagePaths('no path here [Image] ok')).toBe('no path here [Image] ok');
  });

  it('storeLookBack refuses before decoding an oversized base64 string', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-lookback-store-'));
    dirs.push(dir);
    const media = new MediaStore(dir);
    expect(storeLookBack(media, { mediaType: 'image/png', data: 'A'.repeat(Math.ceil(MAX_ATTACHMENT_IMAGE_BYTES / 3) * 4 + 8) })).toBeNull();
    expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toEqual([]);
  });
});
