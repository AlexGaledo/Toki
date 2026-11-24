import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BlenderStatus } from './BlenderHost.js';
import { GameTools, INSTALL_MARKER, STUDIO_PROCESS, UV_VERSION, parseTasklistAll, sha256, type ProcessRow } from './gameTools.js';
import { SETTINGS, cleanupFixtures, fakeRun, fixturePc, installBlenderMcp, recordingFs } from './__fixtures__/gamePc.js';

afterEach(cleanupFixtures);

const stopped: BlenderStatus = { state: 'stopped', crashes: 0, crashLog: null, lastPeakBytes: null };

function tools(pc: ReturnType<typeof fixturePc>, o: { procs?: ProcessRow[]; blender?: BlenderStatus; registry?: string | null; platform?: NodeJS.Platform } = {}) {
  const rec = recordingFs();
  const r = fakeRun();
  const regCalls: string[] = [];
  const gt = new GameTools({
    dataDir: pc.data, platform: o.platform ?? 'win32', env: pc.env, fs: rec.fsx, run: r.run,
    processes: async () => o.procs ?? [],
    registry: async (k, v) => { regCalls.push(k + ' ' + v); return o.registry ?? null; },
    blender: { status: () => o.blender ?? stopped },
  });
  return { gt, rec, run: r, regCalls };
}

describe('game tools detection: platform', () => {
  it('reports unsupported on every item off Windows, and touches nothing', async () => {
    const pc = fixturePc({ uvOnPath: true });
    const { gt, rec, run } = tools(pc, { platform: 'linux' });
    const s = await gt.status();
    expect(s.supported).toBe(false);
    expect([s.blender.reason, s.uv.reason, s.blenderMcp.reason, s.blenderProcess.state, s.studio.reason]).toEqual(Array(5).fill('unsupported'));
    expect(rec.calls).toEqual([]);
    expect(run.calls).toEqual([]);
  });
});

describe('game tools detection: Blender', () => {
  it('finds the newest Blender, numerically, and asks its version only with -b --factory-startup, once', async () => {
    const pc = fixturePc({ blenders: ['4.2', '5.2', '10.0'] });
    const { gt, run } = tools(pc);
    const a = await gt.status();
    await gt.status();
    expect(a.blender).toEqual({ ok: true, reason: 'found', exe: path.join(pc.pf, 'Blender Foundation', 'Blender 10.0', 'blender.exe'), version: '5.2.2', fix: null });
    const asked = run.calls.filter((c) => /blender\.exe$/.test(c.exe));
    expect(asked.map((c) => c.args)).toEqual([['-b', '--factory-startup', '--version']]);
    expect(asked[0]!.env.POCKETROCKET_TOKEN).toBeUndefined();
  });

  it('reports not-installed with no fix (Toki never installs Blender)', async () => {
    const pc = fixturePc({ blenders: [] });
    const { gt, run } = tools(pc);
    expect((await gt.status()).blender).toEqual({ ok: false, reason: 'not-installed', exe: null, version: null, fix: null });
    expect(run.calls.some((c) => /blender/i.test(c.exe))).toBe(false);
  });
});

describe('game tools detection: uv', () => {
  it('prefers uv.exe on PATH', async () => {
    const pc = fixturePc({ uvOnPath: true });
    const { gt } = tools(pc);
    expect((await gt.status()).uv).toMatchObject({ ok: true, reason: 'system', version: '0.11.15', pinned: UV_VERSION, fix: null });
  });

  it("falls back to Toki's own pinned copy, then offers install-uv", async () => {
    const pc = fixturePc();
    const { gt } = tools(pc);
    expect((await gt.status()).uv).toMatchObject({ ok: false, reason: 'not-installed', path: null, fix: 'install-uv' });
    fs.mkdirSync(gt.uvDir, { recursive: true });
    fs.writeFileSync(gt.tokiUvExe, '');
    expect((await gt.status()).uv).toMatchObject({ ok: true, reason: 'toki', path: path.join(pc.data, 'tools', 'uv', UV_VERSION, 'uv.exe') });
  });
});

describe('game tools detection: the Blender MCP environment', () => {
  it('reports not-installed, then incomplete without the install marker, then installed', async () => {
    const pc = fixturePc();
    const { gt } = tools(pc);
    expect((await gt.status()).blenderMcp).toEqual({ ok: false, reason: 'not-installed', version: '2.3.1', addonSha256: null, fix: 'install-blender-mcp' });
    const t = installBlenderMcp(pc.data);
    fs.rmSync(path.join(t.root, INSTALL_MARKER));
    expect((await gt.status()).blenderMcp.reason).toBe('incomplete');
    installBlenderMcp(pc.data);
    expect((await gt.status()).blenderMcp).toEqual({ ok: true, reason: 'installed', version: '2.3.1', addonSha256: sha256('# add-on 2.3.1'), fix: null });
  });

  it('NEGATIVE: an add-on changed after install is addon-mismatch, not installed', async () => {
    const pc = fixturePc();
    const { gt } = tools(pc);
    const t = installBlenderMcp(pc.data);
    fs.writeFileSync(t.addon, '# add-on 2.3.1\nimport evil');
    expect((await gt.status()).blenderMcp).toMatchObject({ ok: false, reason: 'addon-mismatch', fix: 'install-blender-mcp' });
  });
});

describe('game tools detection: the Blender process', () => {
  it("reports Toki's own Blender from BlenderHost", async () => {
    const pc = fixturePc();
    const { gt } = tools(pc, {
      blender: { state: 'running', project: 'space-game', pid: 4242, port: 50123, idleMs: 65_000, peakBytes: 1, crashes: 1 },
      procs: [{ name: 'blender.exe', pid: 4242 }],
    });
    expect((await gt.status()).blenderProcess).toEqual({
      state: 'running', project: 'space-game', pid: 4242, port: 50123, idleMs: 65_000, exe: null, crashes: 1, crashLog: false, fix: null,
    });
  });

  it('reports another Blender by image name and pid', async () => {
    const pc = fixturePc();
    const { gt } = tools(pc, { procs: [{ name: 'explorer.exe', pid: 1 }, { name: 'blender.exe', pid: 777 }] });
    expect((await gt.status()).blenderProcess).toMatchObject({ state: 'other', pid: 777, exe: 'blender.exe', fix: null });
  });

  it('reports crashing past the cap, with the crash log and the reset fix', async () => {
    const pc = fixturePc();
    fs.mkdirSync(path.join(pc.data, 'run', 'blender'), { recursive: true });
    fs.writeFileSync(path.join(pc.data, 'run', 'blender', 'last-crash.log'), 'exit code 3221225477');
    const { gt } = tools(pc, { blender: { state: 'stopped', crashes: 4, crashLog: 'x', lastPeakBytes: null } });
    expect((await gt.status()).blenderProcess).toMatchObject({ state: 'crashing', crashes: 4, crashLog: true, fix: 'blender-reset' });
    const { gt: calm } = tools(pc, { blender: { state: 'stopped', crashes: 3, crashLog: 'x', lastPeakBytes: null } });
    expect((await calm.status()).blenderProcess).toMatchObject({ state: 'stopped', crashes: 3, crashLog: true, fix: null });
  });
});

describe('game tools detection: Roblox Studio', () => {
  it('walks the checks in order: mcp.bat, StudioMCP.exe, the setting, the process', async () => {
    const none = fixturePc({ studio: false });
    expect((await tools(none).gt.status()).studio).toMatchObject({ ok: false, reason: 'no-mcp-bat', mcpBat: false, setting: 'missing', verified: false });

    const pc = fixturePc();
    expect((await tools(pc).gt.status()).studio).toEqual({
      ok: false, reason: 'setting-off', mcpBat: true, studioMcp: true, setting: 'off', running: false, verified: false, fix: 'studio-mcp-setting',
    });
    fs.writeFileSync(pc.settingsFile, SETTINGS.replace('"enabled": false\n    }\n}', '"enabled": true\n    }\n}'));
    expect((await tools(pc).gt.status()).studio).toMatchObject({ reason: 'not-running', setting: 'on', fix: null });
    expect((await tools(pc, { procs: [{ name: STUDIO_PROCESS, pid: 9 }] }).gt.status()).studio).toMatchObject({ ok: true, reason: 'ready', running: true });
  });

  it('finds StudioMCP.exe beside the registry ContentFolder, as mcp.bat does', async () => {
    const pc = fixturePc();
    const v = path.join(pc.roblox, 'Versions');
    fs.rmSync(v, { recursive: true });
    const { gt, regCalls } = tools(pc, { registry: path.join(pc.root, 'elsewhere', 'content') + path.sep });
    expect((await gt.status()).studio).toMatchObject({ reason: 'no-studio-mcp', studioMcp: false });
    expect(regCalls).toEqual(['HKCU\\Software\\Roblox\\RobloxStudio ContentFolder']);
    fs.mkdirSync(path.join(pc.root, 'elsewhere'), { recursive: true });
    fs.writeFileSync(path.join(pc.root, 'elsewhere', 'StudioMCP.exe'), '');
    expect((await gt.status()).studio).toMatchObject({ reason: 'setting-off', studioMcp: true });
  });

  it('reports setting-unknown when the file does not parse or lacks the key', async () => {
    expect((await tools(fixturePc({ setting: '{ not json' })).gt.status()).studio).toMatchObject({ reason: 'setting-unknown', setting: 'unknown', fix: null });
    expect((await tools(fixturePc({ setting: '{"integrations":{}}' })).gt.status()).studio).toMatchObject({ reason: 'setting-unknown', setting: 'unknown' });
    expect((await tools(fixturePc({ setting: null })).gt.status()).studio).toMatchObject({ reason: 'setting-unknown', setting: 'missing' });
  });
});

describe("NEGATIVE: detection never touches the owner's Blender config or writes anything", () => {
  it('reads nothing under %APPDATA%\\Blender Foundation and writes no file', async () => {
    const pc = fixturePc({ uvOnPath: true });
    installBlenderMcp(pc.data);
    const { gt, rec } = tools(pc, { procs: [{ name: 'blender.exe', pid: 5 }] });
    await gt.status();
    expect(rec.calls.length).toBeGreaterThan(5);
    expect(rec.calls.filter((c) => c.p.startsWith(pc.appData))).toEqual([]);
    expect(rec.calls.filter((c) => !['existsSync', 'readdirSync', 'readFileSync'].includes(c.op))).toEqual([]);
    expect(fs.readFileSync(path.join(pc.ownerAddons, 'blender_mcp_addon.py'), 'utf8')).toBe('# v1.8');
  });
});

describe('parseTasklistAll', () => {
  it('reads every row of tasklist /FO CSV /NH', () => {
    expect(parseTasklistAll('"System Idle Process","0","Services","0","8 K"\r\n"RobloxStudioBeta.exe","812","Console","1","900,000 K"\r\nINFO: x\r\n'))
      .toEqual([{ name: 'System Idle Process', pid: 0 }, { name: 'RobloxStudioBeta.exe', pid: 812 }]);
  });
});
