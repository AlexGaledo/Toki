import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { MAX_STUBS_PER_HOST, type ServerEvent } from '@pocketrocket/shared';
import { createHub, type Hub } from '../hub.js';
import { events } from '../events.js';
import { Db } from '../db/db.js';
import { Repos } from '../db/repos.js';
import { MemoryService } from '../services/MemoryService.js';
import { ProjectService } from '../services/ProjectService.js';
import { RemoteProjects } from '../services/RemoteProjects.js';
import { createProjectsApi } from './projects.js';
import { deviceMayAccess, runnerMayAccess, setPrincipal, type Principal } from './guard.js';

// B10 (spec toki-local-first-gamedev, Phase 3): PUT /api/hosts/:host/projects and the stubs in GET /api/projects.
const TOKEN = 'host-stubs-test-token';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-hoststubs-'));
let hub: Hub;
let port: number;
beforeAll(async () => {
  hub = createHub({
    port: 0, dbFile: ':memory:', skipBootstrap: true, token: TOKEN, projectsDir: path.join(tmp, 'projects'), roomsDir: path.join(tmp, 'rooms'),
    pcRunner: { file: path.join(tmp, 'pc-runner.json') },
  });
  port = await hub.listen();
});
afterAll(async () => {
  await hub.shutdown();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function request(method: string, p: string, opts: { token?: string | null; body?: unknown } = {}) {
  const headers: Record<string, string> = { host: '127.0.0.1:' + port, 'content-type': 'application/json' };
  const token = opts.token === undefined ? TOKEN : opts.token;
  if (token) headers.authorization = 'Bearer ' + token;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the helper reads whatever JSON the route replies with
  return new Promise<{ status: number; json: any }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end(opts.body === undefined ? undefined : JSON.stringify(opts.body));
  });
}
const PUT_PATH = '/api/hosts/server/projects';
const stubs = (n: number, prefix = 'game') => Array.from({ length: n }, (_, i) => ({ slug: prefix + '-' + i, name: 'Game ' + i }));
function collect() {
  const seen: ServerEvent[] = [];
  const off = events.onEvent((e) => { if (e.type === 'hosts.changed' || e.type === 'projects.changed') seen.push(e); });
  return { seen, off };
}

describe('PUT /api/hosts/:host/projects with the hub token', () => {
  it('replaces the server\'s stubs, sets connected, and sends hosts.changed with no names in it', async () => {
    const ev = collect();
    const r = await request('PUT', PUT_PATH, { body: { connected: true, projects: [{ slug: 'tower-climb', name: 'Tower Climb' }, { slug: 'obby-run', name: 'Obby Run' }] } });
    ev.off();
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ host: 'server', connected: true, stubs: 2 });
    expect(ev.seen).toEqual([{ type: 'hosts.changed' }]);

    const again = await request('PUT', PUT_PATH, { body: { connected: true, projects: [{ slug: 'obby-run', name: 'Obby Run 2' }] } });
    expect(again.json.stubs).toBe(1);
    const list = (await request('GET', '/api/projects')).json as { host: string; slug: string; name: string }[];
    expect(list.filter((p) => p.host === 'server').map((p) => [p.slug, p.name])).toEqual([['obby-run', 'Obby Run 2']]);
  });

  it('without projects, keeps the last known stubs and only changes connected', async () => {
    await request('PUT', PUT_PATH, { body: { connected: true, projects: [{ slug: 'obby-run', name: 'Obby Run' }] } });
    const r = await request('PUT', PUT_PATH, { body: { connected: false } });
    expect(r.json).toMatchObject({ connected: false, stubs: 1 });
    const server = (await request('GET', '/api/projects')).json.filter((p: { host: string }) => p.host === 'server');
    expect(server).toEqual([{ host: 'server', slug: 'obby-run', name: 'Obby Run', seenAt: expect.any(Number), connected: false }]);
  });

  it('GET /api/projects tags local projects pc and lists both, local first', async () => {
    expect((await request('POST', '/api/projects', { body: { name: 'Obby Run' } })).status).toBe(200);
    await request('PUT', PUT_PATH, { body: { connected: true, projects: [{ slug: 'obby-run', name: 'Obby Run' }] } });
    const list = (await request('GET', '/api/projects')).json as { host: string; slug: string; dir?: string; memberIds?: string[] }[];
    expect(list.map((p) => [p.host, p.slug])).toEqual([['pc', 'obby-run'], ['server', 'obby-run']]);
    expect(list[0]!.dir).toBe(path.join(tmp, 'projects', 'obby-run'));
    // A stub is a name only: no folder, members or room on this hub.
    expect(Object.keys(list[1]!).sort()).toEqual(['connected', 'host', 'name', 'seenAt', 'slug']);
  });

  it(`takes ${MAX_STUBS_PER_HOST} stubs and NEGATIVE: refuses ${MAX_STUBS_PER_HOST + 1}, leaving the old list`, async () => {
    expect((await request('PUT', PUT_PATH, { body: { connected: true, projects: stubs(MAX_STUBS_PER_HOST) } })).json.stubs).toBe(MAX_STUBS_PER_HOST);
    const r = await request('PUT', PUT_PATH, { body: { connected: true, projects: stubs(MAX_STUBS_PER_HOST + 1, 'more') } });
    expect(r.status).toBe(400);
    const server = (await request('GET', '/api/projects')).json.filter((p: { host: string }) => p.host === 'server');
    expect(server).toHaveLength(MAX_STUBS_PER_HOST);
    expect(server.some((p: { slug: string }) => p.slug.startsWith('more-'))).toBe(false);
  });

  it('NEGATIVE: refuses names and slugs a project could not have, and changes nothing', async () => {
    await request('PUT', PUT_PATH, { body: { connected: true, projects: [{ slug: 'keep', name: 'Keep' }] } });
    const bad: unknown[] = [
      [{ slug: 'ok', name: '' }],
      [{ slug: 'ok', name: '   ' }],
      [{ slug: 'ok', name: 'x'.repeat(61) }],
      [{ slug: 'ok', name: 'Bell\u0007' }],
      [{ slug: 'ok', name: 'evil\u202egnp.exe' }],
      [{ slug: 'Upper', name: 'Upper' }],
      [{ slug: '../etc', name: 'Up' }],
      [{ slug: 'a'.repeat(41), name: 'Long' }],
      [{ slug: 'two--dashes', name: 'Two' }],
      [{ slug: 'ok', name: 'One' }, { slug: 'ok', name: 'Two' }],
      [{ slug: 'ok', name: 'Ok', dir: 'C:\\evil' }],
    ];
    for (const projects of bad) {
      const r = await request('PUT', PUT_PATH, { body: { connected: true, projects } });
      expect(r.status, JSON.stringify(projects)).toBe(400);
    }
    expect((await request('PUT', PUT_PATH, { body: { projects: [] } })).status).toBe(400);
    expect((await request('PUT', PUT_PATH, { body: { connected: 'yes' } })).status).toBe(400);
    const server = (await request('GET', '/api/projects')).json.filter((p: { host: string }) => p.host === 'server');
    expect(server.map((p: { slug: string }) => p.slug)).toEqual(['keep']);
  });

  it('NEGATIVE: only the server host: pc and unknown hosts are refused, and other methods are not routes', async () => {
    for (const host of ['pc', 'evil', 'SERVER', 'server%2f..']) {
      expect((await request('PUT', '/api/hosts/' + encodeURIComponent(host) + '/projects', { body: { connected: true, projects: [] } })).status, host).toBe(400);
    }
    expect((await request('GET', PUT_PATH)).status).toBe(405);
    expect((await request('DELETE', PUT_PATH)).status).toBe(405);
    expect((await request('PUT', '/api/hosts/server', { body: { connected: true } })).status).toBe(404);
    // `..` is resolved away before routing, so it never names a host.
    expect((await request('PUT', '/api/hosts/../projects', { body: { connected: true } })).status).toBe(404);
  });
});

describe('NEGATIVE: nobody but the hub token writes stubs (through the real pipeline)', () => {
  const before = async () => (await request('GET', '/api/projects')).json.filter((p: { host: string }) => p.host === 'server');

  it('a paired device gets 403, and cannot read projects or stubs either', async () => {
    const minted = await request('POST', '/api/devices/pairing', { body: {} });
    const paired = await request('POST', '/api/devices/pair', { token: null, body: { code: minted.json.code, name: 'Phone' } });
    expect(paired.status).toBe(200);
    const device = paired.json.token as string;
    const was = await before();
    const ev = collect();
    const r = await request('PUT', PUT_PATH, { token: device, body: { connected: true, projects: [{ slug: 'phone', name: 'Phone' }] } });
    ev.off();
    expect(r.status).toBe(403);
    expect(ev.seen).toEqual([]);
    expect((await request('GET', '/api/projects', { token: device })).status).toBe(403);
    expect(await before()).toEqual(was);
    expect(deviceMayAccess('PUT', PUT_PATH)).toBe(false);
    expect(deviceMayAccess('GET', '/api/projects')).toBe(false);
  });

  it('a bot\'s per-turn MCP bearer gets 401', async () => {
    const bearer = hub.turns.registerTurn([]);
    try {
      const was = await before();
      expect((await request('PUT', PUT_PATH, { token: bearer, body: { connected: true, projects: [{ slug: 'bot', name: 'Bot' }] } })).status).toBe(401);
      expect((await request('GET', '/api/projects', { token: bearer })).status).toBe(401);
      expect(await before()).toEqual(was);
    } finally {
      hub.turns.unregister(bearer);
    }
  });

  it('the PC runner token gets 403', async () => {
    const t = await request('POST', '/api/pc-runner/token', { body: {} });
    expect(t.status).toBe(200);
    expect((await request('PUT', PUT_PATH, { token: t.json.token, body: { connected: true, projects: [] } })).status).toBe(403);
    expect(runnerMayAccess('PUT', PUT_PATH)).toBe(false);
  });
});

describe('NEGATIVE: the handler itself refuses every principal but the hub token (defence behind the pipeline)', () => {
  const repos = new Repos(new Db(':memory:'));
  const remote = new RemoteProjects({ db: repos.db });
  const projects = new ProjectService({ db: repos.db, repos, memory: new MemoryService(), root: path.join(tmp, 'handler') });
  const handle = createProjectsApi({ projects, repos, db: repos.db, remote });

  async function call(principal: Principal | null) {
    const body = JSON.stringify({ connected: true, projects: [{ slug: 'sneaky', name: 'Sneaky' }] });
    const req = Object.assign(new PassThrough(), { method: 'PUT', url: PUT_PATH, headers: { 'content-type': 'application/json' } }) as unknown as IncomingMessage;
    if (principal) setPrincipal(req, principal);
    let status = 0;
    const res = { writeHead: (s: number) => { status = s; return res; }, end: () => res } as unknown as ServerResponse;
    const done = handle(req, res);
    (req as unknown as PassThrough).end(body);
    await done;
    return status;
  }

  it('a password session, a device, the runner and no principal get 403; the hub token gets 200', async () => {
    expect(await call({ kind: 'hub', sessionId: 's1', userId: 'u1' })).toBe(403);
    expect(await call({ kind: 'device', deviceId: 'd1' })).toBe(403);
    expect(await call({ kind: 'runner' })).toBe(403);
    expect(await call(null)).toBe(403);
    expect(remote.list()).toEqual([]);
    expect(await call({ kind: 'hub', userId: 'u1' })).toBe(200);
    expect(remote.list().map((p) => p.slug)).toEqual(['sneaky']);
  });
});
