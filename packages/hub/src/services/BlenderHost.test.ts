import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { SpawnOptions } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BlenderHost, BUSY_MS, CRASH_WINDOW_MS, GUI_BLENDER_PORT, IDLE_MS, blenderServerScript, blenderToolPaths, parseTasklist,
  type RunningBlender,
} from './BlenderHost.js';

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  alive = true;
  constructor(public pid: number, public args: string[], public opts: SpawnOptions) { super(); }
  say(line: string) { this.stdout.write(line + '\n'); }
  ready() { this.say('TOKI_READY ' + this.args[this.args.indexOf('--port') + 1]); }
  /** What the script does on its stop file or idle: save, report RAM, exit 0. */
  exitClean(reason = 'stop') { this.say('TOKI_RAM 734003200'); this.say('TOKI_EXIT ' + reason); this.die(0); }
  die(code: number | null) {
    if (!this.alive) return;
    this.alive = false;
    setImmediate(() => this.emit('exit', code));
  }
  kill() { this.die(null); return true; }
}

const flush = () => new Promise((r) => setImmediate(r));
const dirs: string[] = [];

function setup(o: { others?: RunningBlender[]; ports?: number[]; idleMs?: number } = {}) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-blender-'));
  dirs.push(data);
  const tools = blenderToolPaths(data);
  fs.mkdirSync(path.dirname(tools.addon), { recursive: true });
  fs.writeFileSync(tools.addon, '# add-on');
  fs.mkdirSync(path.dirname(tools.mcpExe), { recursive: true });
  fs.writeFileSync(tools.mcpExe, '');
  const script = path.join(data, 'toki_blender_server.py');
  fs.writeFileSync(script, '# server');
  const children: FakeChild[] = [];
  let maxAlive = 0;
  const others = o.others ?? [];
  const ports = [...(o.ports ?? [50123, 50124, 50125])];
  const logs: string[] = [];
  const host = new BlenderHost({
    dataDir: data, exe: () => 'C:\\Blender\\blender.exe', script,
    spawn: (_cmd, args, opts) => {
      const c = new FakeChild(1000 + children.length, args, opts);
      children.push(c);
      maxAlive = Math.max(maxAlive, children.filter((x) => x.alive).length);
      return c;
    },
    listBlenders: async () => others,
    pickPort: async () => ports.shift() ?? 50999,
    log: (l) => logs.push(l),
    ...(o.idleMs ? { idleMs: () => o.idleMs! } : {}),
  });
  const project = (slug: string) => ({ slug, dir: path.join(data, 'projects', slug) });
  /** ensure() and, once Blender is spawned, its READY line. */
  const up = async (slug: string) => {
    const r = host.ensure(project(slug));
    await flush();
    const c = children.at(-1);
    if (c?.alive) c.ready();
    return r;
  };
  return { host, children, data, tools, script, others, logs, project, up, maxAlive: () => maxAlive };
}

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }); });
afterEach(() => { vi.useRealTimers(); for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

describe('BlenderHost: the command line', () => {
  it('always starts -b --factory-startup, hidden, with the server script and a clean env', async () => {
    const s = setup();
    process.env.POCKETROCKET_TOKEN_TEST_SENTINEL = 'x';
    expect(await s.up('alpha')).toBeNull();
    const c = s.children[0]!;
    expect(c.args.slice(0, 2)).toEqual(['-b', '--factory-startup']);
    expect(c.args.slice(c.args.indexOf('-P'), c.args.indexOf('-P') + 2)).toEqual(['-P', s.script]);
    expect(c.args).toContain('--python-exit-code');
    expect(c.opts.windowsHide).toBe(true);
    const env = c.opts.env as NodeJS.ProcessEnv;
    expect(env.BLENDERMCP_NO_UPDATE_CHECK).toBe('1');
    expect(env.DISABLE_TELEMETRY).toBe('true');
    expect(Object.keys(env).some((k) => /^(POCKETROCKET_|PYTHONPATH$|ANTHROPIC_)/i.test(k))).toBe(false);
    // No .blend yet: Blender starts on the factory scene, and the save path is still art/<slug>.blend.
    expect(c.args.filter((a) => a.endsWith('.blend'))).toEqual([path.join(s.project('alpha').dir, 'art', 'alpha.blend')]);
    expect(c.args.join(' ')).not.toMatch(/bpy\.ops\.wm/);
    delete process.env.POCKETROCKET_TOKEN_TEST_SENTINEL;
  });

  it('opens art/<slug>.blend from the command line when it exists, before -P', async () => {
    const s = setup();
    const blend = path.join(s.project('alpha').dir, 'art', 'alpha.blend');
    fs.mkdirSync(path.dirname(blend), { recursive: true });
    fs.writeFileSync(blend, 'BLENDER');
    await s.up('alpha');
    const a = s.children[0]!.args;
    expect(a.slice(0, 3)).toEqual(['-b', '--factory-startup', blend]);
    expect(a.indexOf(blend)).toBeLessThan(a.indexOf('-P'));
  });
});

describe('BlenderHost: the port', () => {
  it('mounts the built-in blender entry on the port Blender binds, and never 9876', async () => {
    const s = setup({ ports: [GUI_BLENDER_PORT, 50123] });
    const entry = await s.host.mcpEntry();
    expect(entry).toMatchObject({
      kind: 'stdio', name: 'blender', command: s.tools.mcpExe, approve: 'mode',
      readTools: ['get_addon_status', 'get_scene_info', 'look', 'search_assets'],
      env: { BLENDER_HOST: '127.0.0.1', BLENDER_PORT: '50123', DISABLE_TELEMETRY: 'true' },
    });
    await s.up('alpha');
    const a = s.children[0]!.args;
    expect(a[a.indexOf('--port') + 1]).toBe('50123');
    expect(s.host.status()).toMatchObject({ state: 'running', port: 50123 });
  });

  it('keeps the port across a restart, so a turn\'s MCP server finds the new Blender', async () => {
    const s = setup();
    await s.up('alpha');
    s.children[0]!.die(1);
    await flush();
    await s.up('alpha');
    const port = (c: FakeChild) => c.args[c.args.indexOf('--port') + 1];
    expect(port(s.children[1]!)).toBe(port(s.children[0]!));
    expect((await s.host.mcpEntry())!.env.BLENDER_PORT).toBe(port(s.children[0]!));
  });

  it('picks a new port when the script could not bind the old one', async () => {
    const s = setup();
    const r = s.host.ensure(s.project('alpha'));
    await flush();
    s.children[0]!.say('TOKI_BIND_FAILED 50123');
    s.children[0]!.die(3);
    expect(await r).toMatch(/port was taken/);
    expect((await s.host.mcpEntry())!.env.BLENDER_PORT).toBe('50124');
  });

  it("NEGATIVE: points the MCP server's add-on check and data at Toki's folders, never the owner's Blender config", async () => {
    const s = setup();
    const env = (await s.host.mcpEntry())!.env;
    const home = path.join(s.data, 'tools', 'blender-mcp', 'home');
    expect(env).toMatchObject({ APPDATA: home, XDG_CONFIG_HOME: path.join(home, '.config'), BLENDERMCP_ADDONS_DIR: path.dirname(s.tools.addon) });
    expect(fs.statSync(home).isDirectory()).toBe(true);
    expect(Object.values(env).join(' ')).not.toMatch(/Blender Foundation/);
  });

  it('mounts nothing when the Blender MCP tools are not installed', async () => {
    const s = setup();
    fs.rmSync(s.tools.mcpExe);
    expect(await s.host.mcpEntry()).toBeNull();
    fs.rmSync(s.tools.addon);
    expect(await s.host.ensure(s.project('alpha'))).toMatch(/Blender MCP tools are not installed/);
    expect(s.children).toHaveLength(0);
  });
});

describe('BlenderHost: one at a time', () => {
  it('reuses the running Blender for its project, also for calls that race the start', async () => {
    const s = setup();
    const a = s.host.ensure(s.project('alpha'));
    const b = s.host.ensure(s.project('alpha'));
    await flush();
    s.children[0]!.ready();
    expect(await Promise.all([a, b])).toEqual([null, null]);
    expect(await s.host.ensure(s.project('alpha'))).toBeNull();
    expect(s.children).toHaveLength(1);
  });

  it('NEGATIVE: refuses another project while Blender is busy, and switches only after 60 s of quiet', async () => {
    const s = setup();
    await s.up('alpha');
    expect(await s.host.ensure(s.project('beta'))).toBe('Blender is busy with alpha. Try again in a minute.');
    expect(s.children).toHaveLength(1);

    vi.advanceTimersByTime(BUSY_MS);
    const next = s.host.ensure(s.project('beta'));
    await flush();
    // It asks the old one to save and stop through its stop file, and waits for it to exit before starting.
    expect(fs.readFileSync(path.join(s.host.runDir, 'stop'), 'utf8')).toBe('another project needs Blender');
    expect(s.children).toHaveLength(1);
    s.children[0]!.exitClean();
    await flush(); await flush();
    s.children[1]!.ready();
    expect(await next).toBeNull();
    expect(s.host.status()).toMatchObject({ state: 'running', project: 'beta' });
    expect(s.maxAlive()).toBe(1);
  });

  it('NEGATIVE: refuses to start while a Blender it did not start is running, and never touches it', async () => {
    const s = setup({ others: [{ exe: 'blender.exe', pid: 4242 }] });
    expect(await s.host.ensure(s.project('alpha'))).toBe('Another Blender is running on this PC (blender.exe, pid 4242). Try again when it finishes.');
    expect(s.children).toHaveLength(0);
    s.others.splice(0);
    expect(await s.up('alpha')).toBeNull();
  });
});

describe('BlenderHost: idle stop', () => {
  it('asks Blender to save and stop after the idle time, and starts it again on the next call', async () => {
    const s = setup();
    await s.up('alpha');
    vi.advanceTimersByTime(IDLE_MS - 1000);
    await s.host.ensure(s.project('alpha'));
    vi.advanceTimersByTime(IDLE_MS - 1000);
    expect(fs.existsSync(path.join(s.host.runDir, 'stop'))).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(fs.readFileSync(path.join(s.host.runDir, 'stop'), 'utf8')).toBe('idle');
    s.children[0]!.exitClean();
    await flush();
    expect(s.host.status()).toMatchObject({ state: 'stopped', crashes: 0, lastPeakBytes: 734003200 });
    expect(s.logs.some((l) => /stopped for alpha \(idle\).*peak working set 700 MB/.test(l))).toBe(true);
    expect(await s.up('alpha')).toBeNull();
    expect(s.children).toHaveLength(2);
  });

  it('counts idle time from READY, so a slow first start is not stopped on arrival (the live run: a 19.5 s start)', async () => {
    const idle = 15_000;
    const s = setup({ idleMs: idle });
    const r = s.host.ensure(s.project('alpha'));
    const again = s.host.ensure(s.project('alpha'));
    await flush();
    vi.advanceTimersByTime(19_500);
    expect(fs.existsSync(path.join(s.host.runDir, 'stop'))).toBe(false);
    s.children[0]!.ready();
    expect(await Promise.all([r, again])).toEqual([null, null]);
    vi.advanceTimersByTime(idle - 1);
    expect(fs.existsSync(path.join(s.host.runDir, 'stop'))).toBe(false);
    vi.advanceTimersByTime(1);
    expect(fs.readFileSync(path.join(s.host.runDir, 'stop'), 'utf8')).toBe('idle');
  });

  it('kills it only when it does not exit within the grace period', async () => {
    const s = setup();
    await s.up('alpha');
    const stopped = s.host.stop('hub quit');
    await flush();
    expect(s.children[0]!.alive).toBe(true);
    vi.advanceTimersByTime(30_000);
    await stopped;
    expect(s.children[0]!.alive).toBe(false);
    expect(s.host.status().state).toBe('stopped');
  });
});

describe('BlenderHost: crashes', () => {
  it('restarts after a crash, and the fourth crash in 10 minutes stops the restarts until reset', async () => {
    const s = setup();
    for (let i = 0; i < 4; i++) {
      expect(await s.up('alpha')).toBeNull();
      s.children.at(-1)!.say('Error: EXCEPTION_ACCESS_VIOLATION');
      s.children.at(-1)!.die(3221225477);
      await flush();
      vi.advanceTimersByTime(1000);
    }
    expect(s.children).toHaveLength(4);
    expect(s.host.status()).toMatchObject({ state: 'stopped', crashes: 4, crashLog: expect.stringContaining('EXCEPTION_ACCESS_VIOLATION') });
    expect(await s.host.ensure(s.project('alpha'))).toMatch(/keeps crashing/);
    expect(s.children).toHaveLength(4);
    expect(fs.readFileSync(path.join(s.host.runDir, 'last-crash.log'), 'utf8')).toContain('exit code 3221225477');

    s.host.resetCrashes();
    expect(await s.up('alpha')).toBeNull();
    expect(s.children).toHaveLength(5);
  });

  it('counts only crashes inside the window, and not stops it asked for', async () => {
    const s = setup();
    for (let i = 0; i < 3; i++) {
      await s.up('alpha');
      s.children.at(-1)!.die(1);
      await flush();
    }
    vi.advanceTimersByTime(CRASH_WINDOW_MS);
    await s.up('alpha');
    s.children.at(-1)!.die(1);
    await flush();
    await s.up('alpha');
    void s.host.stop('idle');
    s.children.at(-1)!.exitClean();
    await flush();
    expect(s.host.status()).toMatchObject({ crashes: 1 });
    expect(await s.up('alpha')).toBeNull();
  });

  it('reports a crash before READY to the waiting call', async () => {
    const s = setup();
    const r = s.host.ensure(s.project('alpha'));
    await flush();
    s.children[0]!.die(1);
    expect(await r).toMatch(/stopped before it was ready \(exit code 1\)/);
  });
});

describe('BlenderHost: helpers', () => {
  it('reads blender.exe pids from tasklist CSV, and nothing from the no-match line', () => {
    expect(parseTasklist('"blender.exe","1424","Console","1","412,332 K"\r\n"Blender.exe","77","Console","1","1 K"\r\n'))
      .toEqual([{ exe: 'blender.exe', pid: 1424 }, { exe: 'Blender.exe', pid: 77 }]);
    expect(parseTasklist('INFO: No tasks are running which match the specified criteria.\r\n')).toEqual([]);
    expect(parseTasklist('"blender-launcher.exe","5","Console","1","1 K"')).toEqual([]);
  });

  it('finds the server script under the hub, or where POCKETROCKET_BLENDER_SERVER points (I4)', () => {
    const hub = path.resolve('/app/resources/hub');
    expect(blenderServerScript({}, hub)).toBe(path.join(hub, 'resources', 'blender', 'toki_blender_server.py'));
    const abs = path.resolve('/x/toki_blender_server.py');
    expect(blenderServerScript({ POCKETROCKET_BLENDER_SERVER: abs }, hub)).toBe(abs);
    expect(blenderServerScript({ POCKETROCKET_BLENDER_SERVER: 'relative.py' }, hub)).toBe(path.join(hub, 'resources', 'blender', 'toki_blender_server.py'));
  });
});
