import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createHub, type Hub } from '../hub.js';
import { GAME_TEAM_TEMPLATE } from '../services/devTeamTemplate.js';
import { BUILTIN_SKILLS } from '../services/builtinSkills.js';
import { cleanupFixtures, fakeRun, fixturePc } from '../services/__fixtures__/gamePc.js';

// ui-gaps P1 finding: on a fresh install, Create project with the Game team failed with 409, because nothing made
// @lead-engineer or the safe-shipping skill. "No setup needed" means a brand-new hub can make a game project at once.
vi.setConfig({ testTimeout: 60_000 });

const TOKEN = 'fresh-game-project-token';
const pc = fixturePc();

let hub: Hub;
let port: number;
beforeAll(async () => {
  hub = createHub({
    port: 0, dbFile: ':memory:', skipBootstrap: true, token: TOKEN, seedBots: true,
    projectsDir: path.join(pc.root, 'projects'), roomsDir: path.join(pc.root, 'rooms'),
    mcpServers: { file: path.join(pc.root, 'mcp-servers.json') },
    gameTools: { dataDir: pc.data, platform: 'win32', env: pc.env, run: fakeRun().run, processes: async () => [], registry: async () => null },
  });
  port = await hub.listen();
  // What startup's ensureBuiltinSkills adds (skipBootstrap keeps the test off the real skills folder): rows only.
  for (const b of BUILTIN_SKILLS) hub.repos.upsertSkill({ name: b.name, description: b.description, path: '/x/' + b.name, source: 'authored', reviewStatus: 'approved', createdByBot: null });
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

describe('Game team on a fresh hub', () => {
  it('every skill the template needs is a built-in, so startup adds it before any project exists', () => {
    const names = BUILTIN_SKILLS.map((s) => s.name);
    for (const s of GAME_TEAM_TEMPLATE.skills) expect(names, s).toContain(s);
  });

  it('creates a game project with no setup: the lead, builder and artist sources are made on demand', async () => {
    expect(hub.repos.getBotByHandle('lead-engineer')).toBeFalsy();
    const r = await request('POST', '/api/projects', { name: 'First Game', template: 'game' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.bots.map((b: { handle: string }) => b.handle)).toEqual(['first-game-lead', 'first-game-builder', 'first-game-artist']);
    expect(hub.repos.getBotByHandle('lead-engineer')).toBeTruthy();
    expect(fs.existsSync(path.join(pc.root, 'projects', 'first-game', 'art'))).toBe(true);
  });

  it('a second game project reuses the same sources and makes no new ones', async () => {
    const before = hub.repos.listBots().length;
    const r = await request('POST', '/api/projects', { name: 'Second Game', template: 'game' });
    expect(r.status).toBe(200);
    expect(hub.repos.listBots().length).toBe(before + 3);
  });
});
