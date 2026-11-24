import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { GameToolsStatus, Room } from '@pocketrocket/shared';
import { createHub, type Hub } from '../hub.js';
import { listAudit } from '../services/AuditLog.js';
import { STUDIO_PROCESS, UV_URL, UV_VERSION, sha256, type ProcessRow, type RunFn } from '../services/gameTools.js';
import { SETTINGS, cleanupFixtures, fixturePc } from '../services/__fixtures__/gamePc.js';
import { STUDIO_READ_TOOLS, STUDIO_SERVER, createGameToolsApi } from './gameTools.js';
import { setPrincipal } from './guard.js';

vi.setConfig({ testTimeout: 60_000 });

const TOKEN = 'game-tools-test-hub-token';
const ZIP = Buffer.from('PK fake uv zip');
const pc = fixturePc();
const MCP_FILE = path.join(pc.root, 'mcp-servers.json');

const fetches: string[] = [];
let fetchGate: Promise<void> = Promise.resolve();
const runs: { exe: string; args: string[] }[] = [];
let procs: ProcessRow[] = [];

const run: RunFn = async (exe, args) => {
  runs.push({ exe, args });
  if (/tar\.exe$/.test(exe)) {
    const into = args[args.indexOf('-C') + 1]!;
    fs.writeFileSync(path.join(into, 'uv.exe'), 'exe');
    return { code: 0, stdout: '', stderr: '' };
  }
  if (args.includes('--version')) return { code: 0, stdout: /blender/i.test(exe) ? 'Blender 5.2.2 LTS\n' : 'uv 0.11.15\n', stderr: '' };
  return { code: 0, stdout: '', stderr: '' };
};

let hub: Hub;
let port: number;
let group: Room;
let group2: Room;
let dm: Room;
beforeAll(async () => {
  hub = createHub({
    port: 0, dbFile: ':memory:', skipBootstrap: true, token: TOKEN,
    projectsDir: path.join(pc.root, 'projects'), roomsDir: path.join(pc.root, 'rooms'),
    mcpServers: { file: MCP_FILE },
    gameTools: {
      dataDir: pc.data, platform: 'win32', env: pc.env, run,
      processes: async () => procs,
      registry: async () => null,
      fetch: (async (u: string) => { fetches.push(u); await fetchGate; return new Response(new Uint8Array(ZIP)); }) as unknown as typeof fetch,
      pins: { uvSha256: sha256(ZIP) },
    },
  });
  port = await hub.listen();
  const bot = hub.repos.createBot({ name: 'artist', handle: 'artist', title: '', description: '', avatar: 'A', model: 'claude-sonnet-5', allowedTools: ['Read'], maxBudgetUsd: 1 });
  group = hub.repos.createRoom({ kind: 'group', name: 'Space Game', memberIds: [bot.id], coordinatorBotId: null }) as Room;
  group2 = hub.repos.createRoom({ kind: 'group', name: 'Kart Game', memberIds: [bot.id], coordinatorBotId: null }) as Room;
  dm = hub.repos.createRoom({ kind: 'dm', name: 'DM', memberIds: [bot.id], coordinatorBotId: null }) as Room;
});
afterAll(async () => {
  await hub.shutdown();
  cleanupFixtures();
});

function request(method: string, p: string, opts: { body?: unknown; raw?: string; token?: string | null } = {}) {
  const headers: Record<string, string> = { host: '127.0.0.1:' + port, 'content-type': 'application/json' };
  if (opts.token !== null) headers.authorization = 'Bearer ' + (opts.token ?? TOKEN);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the helper reads whatever JSON each route replies with
  return new Promise<{ status: number; json: any }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json: unknown = null;
        try { json = raw ? JSON.parse(raw) : null; } catch { /* not JSON */ }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on('error', reject);
    req.end(opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)));
  });
}

const gameRows = () => listAudit(hub.repos.db).filter((r) => r.action.startsWith('game_tool'));
const ROUTES: [string, string, unknown?][] = [
  ['GET', '/api/game-tools'],
  ['POST', '/api/game-tools/fix/install-uv', {}],
  ['POST', '/api/game-tools/fix/studio-mcp-setting', {}],
  ['POST', '/api/game-tools/studio/setup', { roomId: 'placeholder' }],
];
const nothingWritten = () => {
  expect(fs.existsSync(path.join(pc.data, 'tools'))).toBe(false);
  expect(fs.existsSync(MCP_FILE)).toBe(false);
  expect(fs.readFileSync(pc.settingsFile, 'utf8')).toBe(SETTINGS);
  expect(fs.existsSync(pc.settingsFile + '.toki-bak')).toBe(false);
  expect(fetches).toEqual([]);
  expect(gameRows()).toEqual([]);
};

describe('NEGATIVE: who may call game tools', () => {
  it('403s a paired device on every route, and writes nothing', async () => {
    const minted = await request('POST', '/api/devices/pairing', { body: {} });
    const paired = await request('POST', '/api/devices/pair', { token: null, body: { code: minted.json.code, name: 'phone' } });
    expect(paired.status).toBe(200);
    for (const [m, p, b] of ROUTES) expect((await request(m, p, { token: paired.json.token, body: b })).status, m + ' ' + p).toBe(403);
    nothingWritten();
  });

  it("refuses a live bot MCP bearer on every route before the handler (401: it is not a hub credential), and writes nothing", async () => {
    const bearer = hub.turns.registerTurn([]);
    try {
      for (const [m, p, b] of ROUTES) expect((await request(m, p, { token: bearer, body: b })).status, m + ' ' + p).toBe(401);
    } finally {
      hub.turns.unregister(bearer);
    }
    // A hub-token request clears the auth limiter the refusals fed.
    expect((await request('GET', '/api/game-tools')).status).toBe(200);
    nothingWritten();
  });
});

describe('GET /api/game-tools', () => {
  it('reports the fixture PC with fixed reason words', async () => {
    const r = await request('GET', '/api/game-tools');
    expect(r.status).toBe(200);
    const s = r.json as GameToolsStatus;
    expect(s.supported).toBe(true);
    expect(s.blender).toMatchObject({ ok: true, reason: 'found', version: '5.2.2' });
    expect(s.uv).toMatchObject({ ok: false, reason: 'not-installed', fix: 'install-uv' });
    expect(s.blenderMcp).toMatchObject({ ok: false, reason: 'not-installed', fix: 'install-blender-mcp' });
    expect(s.blenderProcess).toMatchObject({ state: 'stopped', crashes: 0, crashLog: false });
    expect(s.studio).toMatchObject({ reason: 'setting-off', fix: 'studio-mcp-setting', verified: false });
  });
});

describe('NEGATIVE: no request field reaches a command, argument or env', () => {
  it('refuses any field a fix step does not take, and runs nothing', async () => {
    for (const body of [{ url: 'https://evil.example/uv.zip' }, { sha256: '00' }, { args: ['--x'] }, { env: { PATH: 'C:\\evil' } }, []]) {
      expect((await request('POST', '/api/game-tools/fix/install-uv', { body })).status).toBe(400);
    }
    expect((await request('POST', '/api/game-tools/fix/run-anything', { body: {} })).status).toBe(404);
    expect((await request('POST', '/api/game-tools/fix/..%2Finstall-uv', { body: {} })).status).toBe(404);
    expect(fetches).toEqual([]);
    expect(runs.filter((r) => !r.args.includes('--version'))).toEqual([]);
  });

  it('refuses command, args or env on the Studio setup, and an unknown room', async () => {
    for (const extra of [{ command: 'C:\\evil.exe' }, { args: ['/c', 'calc'] }, { env: { X: '1' } }, { name: 'other' }]) {
      expect((await request('POST', '/api/game-tools/studio/setup', { body: { roomId: group.id, ...extra } })).status).toBe(400);
    }
    expect((await request('POST', '/api/game-tools/studio/setup', { body: { roomId: '..\\..\\Windows' } })).status).toBe(404);
    expect((await request('POST', '/api/game-tools/studio/setup', { body: { roomId: dm.id } })).status).toBe(400);
    expect(fs.existsSync(MCP_FILE)).toBe(false);
  });

  it('writes the fixed Studio recipe for one room, and adds a second room without changing the command', async () => {
    const r = await request('POST', '/api/game-tools/studio/setup', { body: { roomId: group.id } });
    expect(r.status).toBe(200);
    const fixed = {
      command: path.join(pc.env.SystemRoot!, 'System32', 'cmd.exe'),
      args: ['/d', '/c', path.join(pc.roblox, 'mcp.bat')],
      approve: 'mode',
      readTools: STUDIO_READ_TOOLS,
    };
    expect(JSON.parse(fs.readFileSync(MCP_FILE, 'utf8'))).toEqual({ [STUDIO_SERVER]: { ...fixed, rooms: [group.id] } });
    expect(r.json.server).toMatchObject({ name: STUDIO_SERVER, kind: 'stdio', status: 'configured', rooms: [group.id], approve: 'mode', envKeys: [] });
    expect((await request('POST', '/api/game-tools/studio/setup', { body: { roomId: group2.id } })).status).toBe(200);
    expect((await request('POST', '/api/game-tools/studio/setup', { body: { roomId: group.id } })).status).toBe(200);
    expect(JSON.parse(fs.readFileSync(MCP_FILE, 'utf8'))).toEqual({ [STUDIO_SERVER]: { ...fixed, rooms: [group.id, group2.id] } });
    expect(gameRows().filter((x) => x.action === 'game_tools.studio_setup').map((x) => x.target)).toEqual([group.id, group2.id, group.id]);
  });

  it('downloads only the pinned uv URL, whatever the query string says', async () => {
    const r = await request('POST', '/api/game-tools/fix/install-uv?url=https://evil.example/uv.zip&sha256=00', { body: {} });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, step: 'install-uv', result: 'installed', changed: [path.join(pc.data, 'tools', 'uv', UV_VERSION)] });
    expect((r.json.status as GameToolsStatus).uv).toMatchObject({ ok: true, reason: 'toki' });
    expect(fetches).toEqual([UV_URL]);
    expect(runs.filter((x) => /tar\.exe$/.test(x.exe)).map((x) => x.exe)).toEqual([path.join(pc.env.SystemRoot!, 'System32', 'tar.exe')]);
  });
});

describe('every write is audited, and nothing else is', () => {
  it('records one named row per write, with no generic request row', async () => {
    const rows = listAudit(hub.repos.db);
    expect(rows.filter((x) => x.action === 'game_tools.uv_installed')).toMatchObject([{ actorKind: 'hub-token', target: 'tools/uv/' + UV_VERSION, detail: UV_VERSION }]);
    expect(rows.filter((x) => x.action.startsWith('game-tool'))).toEqual([]);
  });

  it('refuses the Studio setting while Studio runs, logs the refusal, and changes nothing', async () => {
    procs = [{ name: STUDIO_PROCESS, pid: 812 }];
    try {
      const r = await request('POST', '/api/game-tools/fix/studio-mcp-setting', { body: {} });
      expect(r.status).toBe(409);
      expect(r.json).toMatchObject({ ok: false, result: 'studio-running', changed: [] });
    } finally {
      procs = [];
    }
    expect(fs.readFileSync(pc.settingsFile, 'utf8')).toBe(SETTINGS);
    expect(gameRows().at(0)).toMatchObject({ action: 'game_tools.fix_failed', target: 'studio-mcp-setting', detail: 'studio-running' });
    const ok = await request('POST', '/api/game-tools/fix/studio-mcp-setting', { body: {} });
    expect(ok.json).toMatchObject({ ok: true, result: 'enabled', changed: [pc.settingsFile] });
    expect(gameRows().at(0)).toMatchObject({ action: 'game_tools.studio_mcp_enabled', target: '1742184827.json' });
  });
});

describe('approval mode does not gate setup (owner decision 2)', () => {
  it('works under ask and under bypass', async () => {
    for (const approvals of ['bypass', 'ask']) {
      expect((await request('PUT', '/api/settings', { body: { approvals } })).json.approvals).toBe(approvals);
      expect((await request('GET', '/api/game-tools')).status).toBe(200);
      const r = await request('POST', '/api/game-tools/fix/blender-reset', { body: {} });
      expect(r.status).toBe(200);
      expect(r.json).toMatchObject({ ok: true, step: 'blender-reset', result: 'reset' });
      expect(gameRows().at(0)).toMatchObject({ action: 'game_tools.blender_reset' });
    }
  });

  it('runs one step at a time', async () => {
    fs.rmSync(path.join(pc.data, 'tools'), { recursive: true, force: true });
    let open: () => void = () => undefined;
    fetchGate = new Promise((r) => { open = r; });
    const first = request('POST', '/api/game-tools/fix/install-uv', { body: {} });
    await new Promise((r) => setTimeout(r, 200));
    const second = await request('POST', '/api/game-tools/fix/blender-reset', { body: {} });
    expect(second.status).toBe(409);
    expect(second.json.result).toBe('busy');
    open();
    expect((await first).status).toBe(200);
    fetchGate = Promise.resolve();
  });
});

describe('B5: status checks', () => {
  const cmd = path.join(pc.env.SystemRoot!, 'System32', 'cmd.exe');
  const check = async () => (await request('POST', '/api/mcp-servers/' + STUDIO_SERVER + '/check')).json;

  it('reports the Studio recipe with fixed words: setting-off, studio-not-open, then command-found', async () => {
    fs.mkdirSync(path.dirname(cmd), { recursive: true });
    fs.writeFileSync(cmd, '');
    fs.writeFileSync(pc.settingsFile, SETTINGS);
    expect(await check()).toMatchObject({ ok: false, result: 'setting-off' });
    fs.writeFileSync(pc.settingsFile, SETTINGS.replace(/false\n {4}\}\n\}$/, 'true\n    }\n}'));
    expect(await check()).toMatchObject({ ok: false, result: 'studio-not-open' });
    procs = [{ name: STUDIO_PROCESS, pid: 812 }];
    try {
      expect(await check()).toMatchObject({ ok: true, result: 'command-found' });
    } finally {
      procs = [];
    }
    fs.rmSync(path.join(pc.roblox, 'mcp.bat'));
    expect(await check()).toMatchObject({ ok: false, result: 'command-missing' });
    fs.writeFileSync(path.join(pc.roblox, 'mcp.bat'), '@echo off\r\n');
    fs.rmSync(cmd);
    expect(await check()).toMatchObject({ ok: false, result: 'command-missing' });
  });

  it("serves BlenderHost's crash log for Open log, redacted, and null when there is none", async () => {
    expect((await request('GET', '/api/game-tools/blender/crash-log')).json).toEqual({ log: null });
    const file = path.join(pc.data, 'run', 'blender', 'last-crash.log');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'exit code 3221225477\nError: EXCEPTION_ACCESS_VIOLATION\nhub token ' + TOKEN + '\n');
    const r = await request('GET', '/api/game-tools/blender/crash-log');
    expect(r.json.log).toContain('EXCEPTION_ACCESS_VIOLATION');
    expect(r.json.log).not.toContain(TOKEN);
    expect((await request('GET', '/api/game-tools')).json.blenderProcess).toMatchObject({ state: 'stopped', crashLog: true });
  });
});

describe('NEGATIVE: the handler itself refuses anything but the hub token (defence behind the pipeline)', () => {
  it('403s a device, runner or missing principal even if the pipeline let one through', async () => {
    const tools = { status: async () => { throw new Error('must not run'); }, toolsDir: path.join(pc.data, 'tools') };
    const handler = createGameToolsApi({
      tools: tools as never, blender: { resetCrashes: () => { throw new Error('must not run'); } },
      store: {} as never, repos: { getRoom: () => undefined }, db: {} as never,
    });
    const principals: (Parameters<typeof setPrincipal>[1] | null)[] = [{ kind: 'device', deviceId: 'phone' }, { kind: 'runner' }, null];
    for (const p of principals) {
      for (const [method, url] of [['GET', '/api/game-tools'], ['POST', '/api/game-tools/fix/blender-reset']] as const) {
        const req = Object.assign(new PassThrough(), { method, url, headers: {}, socket: { remoteAddress: '127.0.0.1' } }) as unknown as http.IncomingMessage;
        if (p) setPrincipal(req, p);
        let status = 0;
        const res = { writeHead: (s: number) => { status = s; }, end: () => undefined } as unknown as http.ServerResponse;
        (req as unknown as PassThrough).end('{}');
        expect(await handler(req, res)).toBe(true);
        expect(status, (p?.kind ?? 'none') + ' ' + method + ' ' + url).toBe(403);
      }
    }
  });
});
