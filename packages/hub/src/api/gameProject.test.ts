import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { GameToolsStatus } from '@pocketrocket/shared';
import { createHub, type Hub } from '../hub.js';
import { Db } from '../db/db.js';
import { listAudit } from '../services/AuditLog.js';
import { GAME_TEAM_TEMPLATE } from '../services/devTeamTemplate.js';
import { runGit } from '../services/git.js';
import { McpServerStore } from '../services/outsideMcpStore.js';
import { seedGameBots } from '../services/SeedBots.js';
import { cleanupFixtures, fakeRun, fixturePc } from '../services/__fixtures__/gamePc.js';
import { STUDIO_READ_TOOLS, STUDIO_SERVER, studioForGameRoom } from './gameTools.js';

// B7 through the route: POST /api/projects with template 'game'.
vi.setConfig({ testTimeout: 60_000 });

const TOKEN = 'game-project-test-token';
const pc = fixturePc();
const MCP_FILE = path.join(pc.root, 'mcp-servers.json');
const PROJECTS = path.join(pc.root, 'projects');

let hub: Hub;
let port: number;
beforeAll(async () => {
  hub = createHub({
    port: 0, dbFile: ':memory:', skipBootstrap: true, token: TOKEN, projectsDir: PROJECTS, roomsDir: path.join(pc.root, 'rooms'),
    mcpServers: { file: MCP_FILE },
    gameTools: { dataDir: pc.data, platform: 'win32', env: pc.env, run: fakeRun().run, processes: async () => [], registry: async () => null },
  });
  port = await hub.listen();
  hub.repos.createBot({ name: 'Lead', handle: 'lead-engineer', title: '', description: 'You lead.', avatar: 'bot', model: 'auto', allowedTools: ['Read'], maxBudgetUsd: 2 });
  const memory = { ensureHome: () => undefined, writeIdentity: () => undefined };
  expect(seedGameBots(hub.repos, memory, { dataDir: pc.data, platform: 'win32' }).map((b) => b.handle)).toEqual(['roblox-builder', 'blender-artist']);
  for (const name of GAME_TEAM_TEMPLATE.skills) {
    hub.repos.upsertSkill({ name, description: '', path: '/x/' + name, source: 'authored', reviewStatus: 'approved', createdByBot: null });
  }
});
afterAll(async () => {
  await hub.shutdown();
  cleanupFixtures();
});

function request(method: string, p: string, body?: unknown) {
  const headers: Record<string, string> = { host: '127.0.0.1:' + port, 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the helper reads whatever JSON the route replies with
  return new Promise<{ status: number; json: any }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
const studioRooms = () => (fs.existsSync(MCP_FILE) ? (JSON.parse(fs.readFileSync(MCP_FILE, 'utf8')) as Record<string, { rooms: string[] }>)[STUDIO_SERVER]?.rooms ?? null : null);

describe('POST /api/projects with template game', () => {
  it('makes the team, room, folders and git repo, and scopes the Studio recipe to the new room', async () => {
    const r = await request('POST', '/api/projects', { name: 'Obby Run', template: 'game' });
    expect(r.status).toBe(200);
    expect(r.json.project).toMatchObject({ slug: 'obby-run', kind: 'game', templateVersion: GAME_TEAM_TEMPLATE.version, roomId: r.json.room.id });
    expect(r.json.bots.map((b: { handle: string }) => b.handle)).toEqual(['obby-run-lead', 'obby-run-builder', 'obby-run-artist']);
    expect(r.json.setup).toEqual({ git: 'created', studio: 'added' });
    const dir = path.join(PROJECTS, 'obby-run');
    for (const f of ['art', 'exports', 'studio', 'places']) expect(fs.statSync(path.join(dir, f)).isDirectory(), f).toBe(true);
    expect((await runGit(['rev-list', '--count', 'HEAD'], { cwd: dir })).trim()).toBe('1');

    const recipe = JSON.parse(fs.readFileSync(MCP_FILE, 'utf8'));
    expect(recipe).toEqual({
      [STUDIO_SERVER]: {
        command: path.join(pc.env.SystemRoot!, 'System32', 'cmd.exe'), args: ['/d', '/c', path.join(pc.roblox, 'mcp.bat')],
        approve: 'mode', readTools: STUDIO_READ_TOOLS, rooms: [r.json.room.id],
      },
    });
    const audit = listAudit(hub.repos.db as Db, { limit: 50 }).filter((a) => a.action === 'game_tools.studio_setup');
    expect(audit.map((a) => a.target)).toEqual([r.json.room.id]);
  });

  it('NEGATIVE: a dev team or a plain project gets no setup, no game kind, and no Studio room', async () => {
    const before = studioRooms();
    const plain = await request('POST', '/api/projects', { name: 'Plain One' });
    expect(plain.json.setup).toBeUndefined();
    expect(plain.json.project.kind).toBeNull();
    expect(fs.existsSync(path.join(PROJECTS, 'plain-one', '.git'))).toBe(false);
    expect(studioRooms()).toEqual(before);
  });

  it('NEGATIVE: a client cannot set kind directly, and an unknown template is refused', async () => {
    const sneaky = await request('POST', '/api/projects', { name: 'Sneaky', kind: 'game' });
    expect(sneaky.status).toBe(200);
    expect(sneaky.json.project.kind).toBeNull();
    expect((await request('POST', '/api/projects', { name: 'Bogus', template: 'blender' })).status).toBe(400);
    expect((await request('GET', '/api/projects')).json.find((p: { slug: string }) => p.slug === 'bogus')).toBeUndefined();
  });
});

describe('studioForGameRoom', () => {
  const status = (reason: GameToolsStatus['studio']['reason']) => async () => ({ studio: { reason } }) as GameToolsStatus;
  it('NEGATIVE: writes nothing when Roblox Studio\'s launcher is not on this PC', async () => {
    const file = path.join(pc.root, 'no-studio.json');
    const store = new McpServerStore(file);
    const db = hub.repos.db as Db;
    const actor = { kind: 'hub-token' as const, id: null, ip: '127.0.0.1' };
    for (const reason of ['no-mcp-bat', 'unsupported'] as const) {
      expect(await studioForGameRoom({ tools: { status: status(reason), mcpBat: 'C:\\x\\mcp.bat' }, store, db }, 'room-1', actor)).toBe(reason);
    }
    expect(fs.existsSync(file)).toBe(false);
    // Studio closed is fine: the recipe starts mcp.bat when a turn mounts it.
    expect(await studioForGameRoom({ tools: { status: status('not-running'), mcpBat: 'C:\\x\\mcp.bat' }, store, db }, 'room-1', actor)).toBe('added');
    expect(store.list().find((s) => s.name === STUDIO_SERVER)?.rooms).toEqual(['room-1']);
  });
});
