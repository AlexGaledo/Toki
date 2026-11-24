import { describe, expect, it, vi } from 'vitest';
import type { GameToolFix, GameToolsStatus } from '@pocketrocket/shared';
import { GAME_TOOL_FIXES } from '@pocketrocket/shared';
import { canRunFix, gameStrip, gameToolRows, runFix } from './gameTools';

/** This PC's live status (docs/verify/phase1-backend/live-status.txt), with overrides. */
type Over = { supported?: boolean } & { [K in Exclude<keyof GameToolsStatus, 'supported'>]?: Partial<GameToolsStatus[K]> };
function status(over: Over = {}): GameToolsStatus {
  const base: GameToolsStatus = {
    supported: true,
    blender: { ok: true, reason: 'found', exe: 'C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe', version: '5.2.2', fix: null },
    uv: { ok: true, reason: 'system', path: 'C:\\x\\uv.exe', version: '0.11.15', pinned: '0.11.15', fix: null },
    blenderMcp: { ok: false, reason: 'not-installed', version: '2.3.1', addonSha256: null, fix: 'install-blender-mcp' },
    blenderProcess: { state: 'stopped', project: null, pid: null, port: null, idleMs: null, exe: null, crashes: 0, crashLog: false, fix: null },
    studio: { ok: false, reason: 'not-running', mcpBat: true, studioMcp: true, setting: 'on', running: false, verified: false, fix: null },
  };
  return {
    supported: over.supported ?? base.supported,
    blender: { ...base.blender, ...over.blender } as GameToolsStatus['blender'],
    uv: { ...base.uv, ...over.uv } as GameToolsStatus['uv'],
    blenderMcp: { ...base.blenderMcp, ...over.blenderMcp } as GameToolsStatus['blenderMcp'],
    blenderProcess: { ...base.blenderProcess, ...over.blenderProcess } as GameToolsStatus['blenderProcess'],
    studio: { ...base.studio, ...over.studio } as GameToolsStatus['studio'],
  };
}
const row = (s: GameToolsStatus, id: string, studioLauncher = true) => {
  const r = gameToolRows(s, { studioLauncher }).find((x) => x.id === id);
  if (!r) throw new Error('no row ' + id);
  return r;
};
const studioOff = (running: boolean) => status({ studio: { reason: 'setting-off', setting: 'off', running, fix: 'studio-mcp-setting' } });

describe('gameToolRows: one action per item, from the `fix` field', () => {
  it('maps each fix word to its own button', () => {
    expect(row(status({ uv: { ok: false, reason: 'not-installed', path: null, version: null, fix: 'install-uv' } }), 'uv').action)
      .toEqual({ kind: 'fix', step: 'install-uv', label: 'Install uv' });
    expect(row(status(), 'blenderMcp').action).toEqual({ kind: 'fix', step: 'install-blender-mcp', label: 'Install Blender tools' });
    expect(row(status({ blenderProcess: { state: 'crashing', crashes: 4, crashLog: true, fix: 'blender-reset' } }), 'blender').action)
      .toEqual({ kind: 'fix', step: 'blender-reset', label: 'Try again' });
    expect(row(studioOff(false), 'studio').action).toEqual({ kind: 'fix', step: 'studio-mcp-setting', label: 'Turn on Studio MCP' });
  });

  it('offers no fix where `fix` is null', () => {
    const s = status({ blenderMcp: { ok: true, reason: 'installed', addonSha256: 'ab', fix: null } });
    for (const r of gameToolRows(s, { studioLauncher: false })) expect(r.action?.kind === 'fix').toBe(false);
  });

  it('links to blender.org when Blender is missing, and never offers to open Blender', () => {
    const r = row(status({ blender: { ok: false, reason: 'not-installed', exe: null, version: null } }), 'blender');
    expect(r.action).toEqual({ kind: 'link', href: 'https://www.blender.org/download/', label: 'Get Blender' });
    for (const st of ['stopped', 'running', 'other', 'crashing'] as const) {
      const all = gameToolRows(status({ blenderProcess: { state: st } }), { studioLauncher: true });
      expect(JSON.stringify(all)).not.toMatch(/Open Blender/i);
    }
  });

  it('asks for uv before the Blender tools', () => {
    const r = row(status({ uv: { ok: false, reason: 'not-installed', path: null, version: null, fix: 'install-uv' } }), 'blenderMcp');
    expect(r.action).toEqual({ kind: 'wait', label: 'Install Blender tools', why: 'Install uv first.' });
  });

  it('offers Open Studio only when the desktop shell can launch it', () => {
    expect(row(status(), 'studio', true).action).toEqual({ kind: 'open-studio', label: 'Open Studio' });
    expect(row(status(), 'studio', false).action).toBeNull();
  });

  it('marks Studio unverified while verified is false', () => {
    expect(row(status(), 'studio').unverified).toBe(true);
    expect(row(status({ studio: { verified: true } }), 'studio').unverified).toBe(false);
    expect(gameStrip(status())?.studio.text).toBe('Studio not open (unverified)');
    expect(gameStrip(status({ studio: { verified: true } }))?.studio.text).toBe('Studio not open');
  });

  it('puts every status in words, not only a colour', () => {
    for (const r of gameToolRows(studioOff(true), { studioLauncher: true })) expect(r.status.length).toBeGreaterThan(0);
  });
});

describe('never fixes Studio while it runs', () => {
  it('shows the Studio fix as waiting, with the reason, while Studio is open', () => {
    const r = row(studioOff(true), 'studio');
    expect(r.action?.kind).toBe('wait');
    expect(r.action && 'why' in r.action ? r.action.why : '').toMatch(/Close Roblox Studio first/);
  });

  it('canRunFix refuses studio-mcp-setting while running, even though `fix` names it', () => {
    expect(canRunFix(studioOff(true), 'studio-mcp-setting')).toBe(false);
    expect(canRunFix(studioOff(false), 'studio-mcp-setting')).toBe(true);
  });

  it('runFix re-reads the status and does not send the step when Studio has opened since', async () => {
    const fix = vi.fn(async (step: GameToolFix) => step);
    const r = await runFix('studio-mcp-setting', { status: async () => studioOff(true), fix });
    expect(fix).not.toHaveBeenCalled();
    expect(r.sent).toBe(false);
    const ok = await runFix('studio-mcp-setting', { status: async () => studioOff(false), fix });
    expect(fix).toHaveBeenCalledWith('studio-mcp-setting');
    expect(ok).toEqual({ sent: true, reply: 'studio-mcp-setting' });
  });

  it('canRunFix sends no step the status does not offer', () => {
    for (const step of GAME_TOOL_FIXES) expect(canRunFix(status({ blenderMcp: { ok: true, reason: 'installed', fix: null } }), step)).toBe(false);
    for (const step of GAME_TOOL_FIXES) expect(canRunFix({ ...studioOff(false), supported: false }, step)).toBe(false);
  });
});

describe('gameStrip', () => {
  it('reads like the spec: "Blender idle · Studio not open"', () => {
    const s = gameStrip(status({ blenderMcp: { ok: true, reason: 'installed', fix: null }, blenderProcess: { state: 'running', project: 'obby', idleMs: 3 * 60_000 } }));
    expect(s?.blender).toEqual({ tone: 'muted', text: 'Blender idle 3 min' });
    expect(s?.studio.text).toBe('Studio not open (unverified)');
    expect(s?.needsFix).toBe(false);
  });

  it('flags a missing piece for a fix', () => {
    expect(gameStrip(status())?.blender).toEqual({ tone: 'warn', text: 'Blender tools missing' });
    expect(gameStrip(status())?.needsFix).toBe(true);
  });

  it('hides on a hub that is not a Windows PC', () => {
    expect(gameStrip({ ...status(), supported: false })).toBeNull();
  });
});
