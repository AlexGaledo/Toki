import { describe, expect, it } from 'vitest';
import type { GameToolsStatus } from '@pocketrocket/shared';
import { TEMPLATE_CHOICES, createInput, setupLines, templateBlocked } from './projectTemplates';

/** Blender and Toki's Blender MCP tools ready, Studio closed: the game team may be picked. */
function ready(): GameToolsStatus {
  return {
    supported: true,
    blender: { ok: true, reason: 'found', exe: 'C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe', version: '5.2.2', fix: null },
    uv: { ok: true, reason: 'system', path: 'C:\\x\\uv.exe', version: '0.11.15', pinned: '0.11.15', fix: null },
    blenderMcp: { ok: true, reason: 'installed', version: '2.3.1', addonSha256: 'ab', fix: null },
    blenderProcess: { state: 'stopped', project: null, pid: null, port: null, idleMs: null, exe: null, crashes: 0, crashLog: false, fix: null },
    studio: { ok: false, reason: 'not-running', mcpBat: true, studioMcp: true, setting: 'on', running: false, verified: false, fix: null },
  };
}
const game = (status: GameToolsStatus | null, error: string | null = null) => templateBlocked('game', { status, error });

describe('templateBlocked: the picker\'s disabled states', () => {
  it('lets the game team be picked once Blender and the Blender tools are ready, with Studio closed', () => {
    expect(game(ready())).toBeNull();
  });

  it('blocks the game team, with the reason, while Blender or the Blender tools are not ready', () => {
    expect(game({ ...ready(), blender: { ok: false, reason: 'not-installed', exe: null, version: null, fix: null } })).toBe('Install Blender in Settings › Game tools first.');
    expect(game({ ...ready(), blenderMcp: { ok: false, reason: 'not-installed', version: '2.3.1', addonSha256: null, fix: 'install-blender-mcp' } })).toBe('Install the Blender tools in Settings › Game tools first.');
    expect(game({ ...ready(), blenderMcp: { ok: false, reason: 'incomplete', version: '2.3.1', addonSha256: null, fix: 'install-blender-mcp' } })).toBe('Install the Blender tools in Settings › Game tools first.');
    expect(game({ ...ready(), blenderMcp: { ok: false, reason: 'addon-mismatch', version: '2.3.1', addonSha256: 'cd', fix: 'install-blender-mcp' } })).toBe('Reinstall the Blender tools in Settings › Game tools first.');
  });

  it('blocks it off a Windows PC hub, while loading, and when the status could not be read', () => {
    expect(game({ ...ready(), supported: false })).toBe('Game tools need the hub on a Windows PC.');
    expect(game(null)).toBe('Checking Blender…');
    expect(game(null, 'Forbidden')).toBe("Couldn't check Blender. Open Settings › Game tools to see why.");
  });

  it('never echoes the hub\'s error text', () => {
    expect(game(null, '<b>C:\\Users\\alex</b>')).not.toContain('alex');
  });

  it('never blocks None or the dev team, even with no game tools at all', () => {
    expect(templateBlocked('none', { status: null, error: 'down' })).toBeNull();
    expect(templateBlocked('dev', { status: { ...ready(), supported: false }, error: null })).toBeNull();
  });
});

describe('createInput', () => {
  it('sends the picked template, and no template for None', () => {
    expect(createInput('  Obby Run ', 'game')).toEqual({ name: 'Obby Run', template: 'game' });
    expect(createInput('Wika', 'dev')).toEqual({ name: 'Wika', template: 'dev' });
    expect(createInput('Notes', 'none')).toEqual({ name: 'Notes' });
  });
});

describe('TEMPLATE_CHOICES', () => {
  it('offers None, Dev team and Game team, each with one line on what it adds', () => {
    expect(TEMPLATE_CHOICES.map((t) => t.title)).toEqual(['None', 'Dev team', 'Game team']);
    for (const t of TEMPLATE_CHOICES) expect(t.adds).toMatch(/^[^\n]+\.$/);
  });
});

describe('setupLines: the `setup` reply in plain words', () => {
  it('reads the live reply (docs/verify/phase2-backend/live-create.txt) as two good lines', () => {
    expect(setupLines({ git: 'created', studio: 'added' })).toEqual([
      { ok: true, text: 'Git: the project folder now keeps a history, starting with a first commit.' },
      { ok: true, text: 'Roblox Studio: its tools are on in the game chat. They work while Studio is open.' },
    ]);
  });

  it('says what did not happen and what to do, for every other word', () => {
    expect(setupLines({ git: 'exists', studio: 'no-mcp-bat' })).toEqual([
      { ok: true, text: 'Git: the folder already kept a history, so Toki left it as it was.' },
      { ok: false, text: "Roblox Studio: not linked, because Studio's MCP launcher isn't on this PC. Install or update Studio, then check Settings › Game tools." },
    ]);
    const [git, studio] = setupLines({ git: 'failed', studio: 'failed' });
    expect(git?.ok).toBe(false);
    expect(git?.text).toContain('git is installed');
    expect(studio).toEqual({ ok: false, text: "Roblox Studio: couldn't add its tools to the game chat. Settings › Tools shows what is set up." });
    expect(setupLines({ git: 'created', studio: 'unsupported' })[1]?.ok).toBe(false);
  });
});
