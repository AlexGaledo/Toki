import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { blenderToolPaths } from './BlenderHost.js';
import { GameTools, INSTALL_MARKER, STUDIO_MENU_PATH, STUDIO_PROCESS, UV_URL, UV_VERSION, sha256, type GameToolsDeps, type ProcessRow, type RunFn } from './gameTools.js';
import { SETTINGS, cleanupFixtures, fixturePc, recordingFs } from './__fixtures__/gamePc.js';

afterEach(cleanupFixtures);

const ZIP = Buffer.from('PK fake uv zip');
const ADDON = '# mcp-for-blender 2.3.1 bundled add-on';

function setup(o: {
  body?: Buffer; status?: number; throws?: boolean; length?: number; procs?: ProcessRow[]; uvOnPath?: boolean;
  tarFails?: boolean; pipFails?: boolean; addon?: string; setting?: string | null; extra?: Partial<GameToolsDeps>;
} = {}) {
  const pc = fixturePc({ uvOnPath: o.uvOnPath, setting: o.setting });
  const rec = recordingFs();
  const runs: { exe: string; args: string[]; env: NodeJS.ProcessEnv; cwd?: string }[] = [];
  const fetches: string[] = [];
  const regCalls: string[] = [];
  const tools = blenderToolPaths(pc.data, 'win32');
  const run: RunFn = async (exe, args, opts) => {
    runs.push({ exe, args, env: opts.env, cwd: opts.cwd });
    if (/tar\.exe$/.test(exe)) {
      if (o.tarFails) return { code: 1, stdout: '', stderr: 'tar: bad zip' };
      const into = args[args.indexOf('-C') + 1]!;
      for (const f of ['uv.exe', 'uvx.exe', 'uvw.exe']) fs.writeFileSync(path.join(into, f), 'exe');
      return { code: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'venv') {
      fs.mkdirSync(path.join(args[args.length - 1]!, 'Scripts'), { recursive: true });
      fs.writeFileSync(path.join(args[args.length - 1]!, 'Scripts', 'python.exe'), '');
      return { code: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'pip') {
      if (o.pipFails) return { code: 2, stdout: '', stderr: 'hash mismatch' };
      fs.writeFileSync(tools.mcpExe, '');
      fs.mkdirSync(path.dirname(tools.addon), { recursive: true });
      fs.writeFileSync(tools.addon, o.addon ?? ADDON);
      return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 0, stdout: 'uv 0.11.15\n', stderr: '' };
  };
  const fetchFn = (async (u: string) => {
    fetches.push(u);
    if (o.throws) throw new Error('offline');
    const body = o.body ?? ZIP;
    return new Response(new Uint8Array(body), {
      status: o.status ?? 200, headers: { 'content-length': String(o.length ?? body.length) },
    });
  }) as unknown as typeof fetch;
  const requirements = path.join(pc.root, 'resources', 'requirements.txt');
  fs.mkdirSync(path.dirname(requirements), { recursive: true });
  fs.writeFileSync(requirements, 'mcp-for-blender==2.3.1 --hash=sha256:00\n');
  const gt = new GameTools({
    dataDir: pc.data, platform: 'win32', env: pc.env, fs: rec.fsx, run, fetch: fetchFn, requirements,
    processes: async () => o.procs ?? [],
    registry: async (k, v) => { regCalls.push(k + ' ' + v); return null; },
    pins: { uvSha256: sha256(ZIP), addonSha256: sha256(ADDON) },
    ...o.extra,
  });
  return { pc, gt, rec, runs, fetches, regCalls, tools, requirements };
}

const WRITES = ['writeFileSync', 'mkdirSync', 'renameSync', 'copyFileSync', 'rmSync'];
const writesOf = (calls: { op: string; p: string }[]) => calls.filter((c) => WRITES.includes(c.op));
const tree = (dir: string): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map(String).sort() : []);

describe('install-uv', () => {
  it('downloads the pinned zip, unpacks it with Windows tar into <data>/tools/uv/<version>/, and leaves no staging', async () => {
    const s = setup();
    const r = await s.gt.installUv();
    expect(r).toEqual({ ok: true, result: 'installed', changed: [s.gt.uvDir], detail: UV_VERSION });
    expect(s.fetches).toEqual([UV_URL]);
    expect(UV_URL).toBe('https://github.com/astral-sh/uv/releases/download/0.11.15/uv-x86_64-pc-windows-msvc.zip');
    expect(tree(path.join(s.pc.data, 'tools', 'uv'))).toEqual([UV_VERSION, path.join(UV_VERSION, 'uv.exe'), path.join(UV_VERSION, 'uvw.exe'), path.join(UV_VERSION, 'uvx.exe')]);
    expect(s.runs).toHaveLength(1);
    expect(s.runs[0]!.exe).toBe(path.join(s.pc.env.SystemRoot!, 'System32', 'tar.exe'));
    expect(s.runs[0]!.args.slice(0, 3)).toEqual(['-x', '-f', path.join(s.runs[0]!.cwd!, 'uv.zip')]);
    expect((await s.gt.status()).uv).toMatchObject({ ok: true, reason: 'toki' });
    expect(await s.gt.installUv()).toEqual({ ok: true, result: 'already-installed', changed: [] });
  });

  it('NEGATIVE: a wrong sha256 leaves nothing on disk and runs nothing', async () => {
    const s = setup({ body: Buffer.from('PK a different zip') });
    expect(await s.gt.installUv()).toEqual({ ok: false, result: 'hash-mismatch', changed: [] });
    expect(fs.existsSync(path.join(s.pc.data, 'tools'))).toBe(false);
    expect(writesOf(s.rec.calls)).toEqual([]);
    expect(s.runs).toEqual([]);
  });

  it('NEGATIVE: PATH and the registry are unchanged by an install', async () => {
    const procPath = process.env.PATH;
    const s = setup();
    const envBefore = JSON.stringify(s.pc.env);
    await s.gt.installUv();
    expect(JSON.stringify(s.pc.env)).toBe(envBefore);
    expect(process.env.PATH).toBe(procPath);
    expect(s.regCalls).toEqual([]);
    // The only program it runs is tar: no setx, reg, or powershell.
    expect(s.runs.map((r) => path.basename(r.exe))).toEqual(['tar.exe']);
    expect(writesOf(s.rec.calls).every((c) => c.p.startsWith(path.join(s.pc.data, 'tools', 'uv')))).toBe(true);
  });

  it('cleans up a failed unpack, and reports download failures without writing', async () => {
    const bad = setup({ tarFails: true });
    expect(await bad.gt.installUv()).toEqual({ ok: false, result: 'unpack-failed', changed: [] });
    expect(tree(path.join(bad.pc.data, 'tools', 'uv'))).toEqual([]);
    for (const o of [{ status: 404 }, { throws: true }]) {
      const s = setup(o);
      expect((await s.gt.installUv()).result).toBe('download-failed');
      expect(writesOf(s.rec.calls)).toEqual([]);
    }
    const big = setup({ length: 65 * 1024 * 1024 });
    expect((await big.gt.installUv()).result).toBe('too-large');
    expect(writesOf(big.rec.calls)).toEqual([]);
  });
});

describe('install-blender-mcp', () => {
  it('needs uv first', async () => {
    const s = setup();
    expect(await s.gt.installBlenderMcp()).toEqual({ ok: false, result: 'uv-missing', changed: [] });
    expect(s.runs).toEqual([]);
  });

  it('makes the venv and installs from the hashed requirements, records the add-on hash, then reports installed', async () => {
    const s = setup({ uvOnPath: true });
    const prev = process.env.POCKETROCKET_TOKEN;
    process.env.POCKETROCKET_TOKEN = 'hub-token-must-not-leak';
    try {
      const r = await s.gt.installBlenderMcp();
      expect(r).toEqual({ ok: true, result: 'installed', changed: [s.tools.root], detail: '2.3.1 ' + sha256(ADDON) });
    } finally {
      if (prev === undefined) delete process.env.POCKETROCKET_TOKEN; else process.env.POCKETROCKET_TOKEN = prev;
    }
    const uv = path.join(s.pc.root, 'PyScripts', 'uv.exe');
    expect(s.runs.map((x) => [x.exe, x.args])).toEqual([
      [uv, ['venv', '--no-config', '--python', '>=3.10', s.tools.root]],
      [uv, ['pip', 'install', '--no-config', '--python', path.join(s.tools.root, 'Scripts', 'python.exe'), '--require-hashes',
        '--only-binary', ':all:', '--index-url', 'https://pypi.org/simple', '-r', s.requirements]],
    ]);
    for (const x of s.runs) {
      expect(x.env.UV_NO_CONFIG).toBe('1');
      expect(x.env.POCKETROCKET_TOKEN).toBeUndefined();
    }
    expect(JSON.parse(fs.readFileSync(path.join(s.tools.root, INSTALL_MARKER), 'utf8'))).toMatchObject({ version: '2.3.1', addonSha256: sha256(ADDON) });
    expect((await s.gt.status()).blenderMcp).toMatchObject({ ok: true, reason: 'installed' });
    expect(await s.gt.installBlenderMcp()).toEqual({ ok: true, result: 'already-installed', changed: [] });
  });

  it('NEGATIVE: an add-on that does not hash to the pin removes the whole environment', async () => {
    const s = setup({ uvOnPath: true, addon: '# a different add-on' });
    expect(await s.gt.installBlenderMcp()).toEqual({ ok: false, result: 'addon-mismatch', changed: [] });
    expect(fs.existsSync(s.tools.root)).toBe(false);
    expect((await s.gt.status()).blenderMcp.reason).toBe('not-installed');
  });

  it('NEGATIVE: a failed pip install (such as a hash mismatch) removes the whole environment', async () => {
    const s = setup({ uvOnPath: true, pipFails: true });
    expect(await s.gt.installBlenderMcp()).toEqual({ ok: false, result: 'install-failed', changed: [] });
    expect(fs.existsSync(s.tools.root)).toBe(false);
  });
});

describe('studio-mcp-setting', () => {
  it('NEGATIVE: refuses while RobloxStudioBeta.exe runs, and writes nothing', async () => {
    const s = setup({ procs: [{ name: STUDIO_PROCESS, pid: 812 }] });
    expect(await s.gt.enableStudioMcp()).toEqual({ ok: false, result: 'studio-running', changed: [] });
    expect(fs.readFileSync(s.pc.settingsFile, 'utf8')).toBe(SETTINGS);
    expect(writesOf(s.rec.calls)).toEqual([]);
  });

  it('sets only mcp-server.enabled, keeps every other key and the layout, and writes a .toki-bak', async () => {
    const s = setup();
    expect(await s.gt.enableStudioMcp()).toEqual({ ok: true, result: 'enabled', changed: [s.pc.settingsFile] });
    const after = fs.readFileSync(s.pc.settingsFile, 'utf8');
    expect(after).toBe(SETTINGS.replace(/"enabled": false\n {4}\}\n\}$/, '"enabled": true\n    }\n}'));
    const was = JSON.parse(SETTINGS);
    expect(JSON.parse(after)).toEqual({ ...was, 'mcp-server': { enabled: true } });
    expect(JSON.parse(after)['mcp-prompt-sharing']).toEqual({ enabled: false });
    expect(Object.keys(JSON.parse(after))).toEqual(Object.keys(was));
    expect(fs.readFileSync(s.pc.settingsFile + '.toki-bak', 'utf8')).toBe(SETTINGS);
    expect(fs.existsSync(s.pc.settingsFile + '.toki-tmp')).toBe(false);
    // The write is atomic: a temp file renamed over the original.
    expect(s.rec.calls.filter((c) => c.op === 'renameSync').map((c) => c.p)).toEqual([s.pc.settingsFile + '.toki-tmp']);
    expect(await s.gt.enableStudioMcp()).toEqual({ ok: true, result: 'already-on', changed: [] });
  });

  it('keeps CRLF, a final newline, and unknown keys inside mcp-server', async () => {
    const crlf = '{\r\n  "mcp-server": {\r\n    "enabled": false,\r\n    "port": 7\r\n  },\r\n  "x": [\r\n    1\r\n  ]\r\n}\r\n';
    const s = setup({ setting: crlf });
    await s.gt.enableStudioMcp();
    expect(fs.readFileSync(s.pc.settingsFile, 'utf8')).toBe(crlf.replace('"enabled": false', '"enabled": true'));
  });

  it('NEGATIVE: changes nothing when a file will not parse or has no mcp-server key, and shows the menu path', async () => {
    for (const bad of ['{ "mcp-server": { "enabled": false }', '{"integrations":{}}', '[1,2]']) {
      const s = setup({ setting: bad });
      expect(await s.gt.enableStudioMcp()).toEqual({ ok: false, result: 'menu-path', changed: [], detail: STUDIO_MENU_PATH });
      expect(fs.readFileSync(s.pc.settingsFile, 'utf8')).toBe(bad);
      expect(fs.existsSync(s.pc.settingsFile + '.toki-bak')).toBe(false);
      expect(writesOf(s.rec.calls)).toEqual([]);
    }
  });

  it('handles each account file on its own: a bad one does not stop a good one', async () => {
    const s = setup();
    const other = path.join(path.dirname(s.pc.settingsFile), '42.json');
    fs.writeFileSync(other, 'not json');
    expect(await s.gt.enableStudioMcp()).toEqual({ ok: true, result: 'enabled', changed: [s.pc.settingsFile] });
    expect(fs.readFileSync(other, 'utf8')).toBe('not json');
  });
});
