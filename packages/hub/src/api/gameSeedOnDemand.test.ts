import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

// createHub({ seedBots: true }) seeds into DATA_DIR, so point it at a throwaway folder before config.ts loads.
const DATA = await vi.hoisted(async () => {
  const nodeFs = await import('node:fs');
  const nodeOs = await import('node:os');
  const nodePath = await import('node:path');
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'pr-seed-on-demand-'));
  process.env.POCKETROCKET_DATA = dir;
  return dir;
});

import { createHub, type Hub } from '../hub.js';
import { DATA_DIR } from '../config.js';
import { GAME_TEAM_TEMPLATE } from '../services/devTeamTemplate.js';
import { BLENDER_ARTIST_HANDLE, ROBLOX_BUILDER_HANDLE } from '../services/SeedBots.js';
import { cleanupFixtures, fakeRun, fixturePc } from '../services/__fixtures__/gamePc.js';

// Owner call (phase 3): @roblox-builder and @blender-artist are made by the first game project, not at startup.
vi.setConfig({ testTimeout: 60_000 });

const TOKEN = 'seed-on-demand-token';
const pc = fixturePc();
let hub: Hub;
let port: number;

beforeAll(async () => {
  expect(path.resolve(DATA_DIR)).toBe(path.resolve(DATA));
  hub = createHub({
    seedBots: true, port: 0, dbFile: ':memory:', skipBootstrap: true, token: TOKEN,
    projectsDir: path.join(pc.root, 'projects'), roomsDir: path.join(pc.root, 'rooms'),
    mcpServers: { file: path.join(pc.root, 'mcp-servers.json') },
    gameTools: { dataDir: pc.data, platform: 'win32', env: pc.env, run: fakeRun().run, processes: async () => [], registry: async () => null },
  });
  port = await hub.listen();
});
afterAll(async () => {
  await hub.shutdown();
  cleanupFixtures();
  fs.rmSync(DATA, { recursive: true, force: true });
});

function post(p: string, body: unknown) {
  const headers = { host: '127.0.0.1:' + port, 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the helper reads whatever JSON the route replies with
  return new Promise<{ status: number; json: any }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: p, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}
const handles = () => hub.repos.listBots().map((b) => b.handle);

describe('the game template\'s source bots are seeded on demand', () => {
  it('NEGATIVE: a Windows hub that seeds its bots does not make them at startup', () => {
    expect(handles()).not.toContain(ROBLOX_BUILDER_HANDLE);
    expect(handles()).not.toContain(BLENDER_ARTIST_HANDLE);
    expect(fs.existsSync(path.join(pc.data, '.seeded-bots', ROBLOX_BUILDER_HANDLE))).toBe(false);
  });

  it('NEGATIVE: a plain project or a dev team does not make them either', async () => {
    expect((await post('/api/projects', { name: 'Plain' })).status).toBe(200);
    expect(handles()).not.toContain(ROBLOX_BUILDER_HANDLE);
  });

  it('makes them with the first game project, once, and the second game project reuses them', async () => {
    hub.repos.createBot({ name: 'Lead', handle: 'lead-engineer', title: '', description: 'You lead.', avatar: 'bot', model: 'auto', allowedTools: ['Read'], maxBudgetUsd: 2 });
    for (const name of GAME_TEAM_TEMPLATE.skills) {
      if (!hub.repos.listSkills().some((s) => s.name === name)) {
        hub.repos.upsertSkill({ name, description: '', path: '/x/' + name, source: 'authored', reviewStatus: 'approved', createdByBot: null });
      }
    }
    const first = await post('/api/projects', { name: 'Obby Run', template: 'game' });
    expect(first.status).toBe(200);
    expect(first.json.bots.map((b: { handle: string }) => b.handle)).toEqual(['obby-run-lead', 'obby-run-builder', 'obby-run-artist']);
    expect(handles().filter((h) => h === ROBLOX_BUILDER_HANDLE || h === BLENDER_ARTIST_HANDLE)).toEqual([ROBLOX_BUILDER_HANDLE, BLENDER_ARTIST_HANDLE]);
    const sources = hub.repos.listBots().filter((b) => b.handle === ROBLOX_BUILDER_HANDLE || b.handle === BLENDER_ARTIST_HANDLE).map((b) => b.id);

    const second = await post('/api/projects', { name: 'Tower Climb', template: 'game' });
    expect(second.status).toBe(200);
    expect(hub.repos.listBots().filter((b) => b.handle === ROBLOX_BUILDER_HANDLE || b.handle === BLENDER_ARTIST_HANDLE).map((b) => b.id)).toEqual(sources);
  });
});
