import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Db } from '../db/db.js';
import { Repos } from '../db/repos.js';
import { BLENDER_ARTIST_HANDLE, DATA_ENGINEER_HANDLE, LEAD_ENGINEER_HANDLE, ROBLOX_BUILDER_HANDLE, SUPPORT_HANDLE, seedDefaultBots, seedGameBots, supportSourceDirs } from './SeedBots.js';

function setup(withSource = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prc-seed-'));
  const root = path.join(dir, 'app');
  if (withSource) {
    fs.mkdirSync(path.join(root, 'packages', 'hub', 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'docs'));
    fs.mkdirSync(path.join(root, 'data'));
  }
  const repos = new Repos(new Db(':memory:'));
  const identities = new Map<string, string>();
  const memory = { ensureHome: () => undefined, writeIdentity: (id: string, text: string) => { identities.set(id, text); } };
  return { repos, root, memory, identities, opts: { root, dataDir: path.join(dir, 'data'), workspace: path.join(dir, 'ws') } };
}

describe('default bots', () => {
  it('creates Support and Data Engineer once, each with a DM', () => {
    const s = setup();
    expect(seedDefaultBots(s.repos, s.memory, s.opts).map((b) => b.handle)).toEqual([SUPPORT_HANDLE, DATA_ENGINEER_HANDLE]);
    expect(s.repos.listRooms().filter((r) => r.kind === 'dm')).toHaveLength(2);
    expect([...s.identities.values()].every((t) => t.split('\n').length > 2)).toBe(true);
    expect(seedDefaultBots(s.repos, s.memory, s.opts)).toEqual([]);
    expect(s.repos.listBots()).toHaveLength(2);
  });

  it('does not bring back a bot the user deleted', () => {
    const s = setup();
    const [support] = seedDefaultBots(s.repos, s.memory, s.opts);
    s.repos.deleteBot(support.id);
    expect(seedDefaultBots(s.repos, s.memory, s.opts)).toEqual([]);
    expect(s.repos.listBots().map((b) => b.handle)).toEqual([DATA_ENGINEER_HANDLE]);
  });

  it('skips an install with no source on disk', () => {
    const s = setup(false);
    expect(seedDefaultBots(s.repos, s.memory, s.opts)).toEqual([]);
  });

  it('gives each seeded bot its own icon', () => {
    const s = setup();
    const made = seedDefaultBots(s.repos, s.memory, s.opts);
    expect(Object.fromEntries(made.map((b) => [b.handle, b.avatar]))).toEqual({ [SUPPORT_HANDLE]: 'shield', [DATA_ENGINEER_HANDLE]: 'database' });
  });

  it('leaves a user bot with the same handle alone', () => {
    const s = setup();
    s.repos.createBot({ name: 'Mine', handle: SUPPORT_HANDLE, title: '', description: '', avatar: '', model: 'm', allowedTools: [], maxBudgetUsd: 1 });
    expect(seedDefaultBots(s.repos, s.memory, s.opts).map((b) => b.handle)).toEqual([DATA_ENGINEER_HANDLE]);
  });

  describe('the Data Engineer nightly routine', () => {
    const routines = (s: ReturnType<typeof setup>) => s.repos.listRoutines();
    const marker = (s: ReturnType<typeof setup>, name: string) => path.join(s.opts.dataDir, '.seeded-bots', name);

    it('is created once, enabled, in the bot DM, read-only and naming the workspace', () => {
      const s = setup();
      seedDefaultBots(s.repos, s.memory, s.opts);
      seedDefaultBots(s.repos, s.memory, s.opts);
      expect(routines(s)).toHaveLength(1);
      const [r] = routines(s);
      const bot = s.repos.listBots().find((b) => b.handle === DATA_ENGINEER_HANDLE)!;
      const room = s.repos.getRoom(r.roomId)!;
      expect(r).toMatchObject({ botId: bot.id, enabled: true, cron: '0 3 * * *', onceAt: null });
      expect(room.kind).toBe('dm');
      expect(room.memberIds).toEqual([bot.id]);
      expect(r.prompt).toContain('Nightly workspace check for ' + s.opts.workspace);
      expect(r.prompt).toContain('READ-ONLY');
      expect(r.prompt).toContain('NO_REPLY');
      expect(r.prompt).not.toContain('{{');
    });

    it('reaches a server whose bot was seeded before the routine existed', () => {
      const s = setup();
      seedDefaultBots(s.repos, s.memory, s.opts);
      s.repos.deleteRoutine(routines(s)[0].id);
      fs.rmSync(marker(s, DATA_ENGINEER_HANDLE + '.routine'));
      const bots = s.repos.listBots().length;
      expect(seedDefaultBots(s.repos, s.memory, s.opts)).toEqual([]);
      expect(routines(s)).toHaveLength(1);
      expect(s.repos.listBots()).toHaveLength(bots);
    });

    it('does not bring back a routine the owner deleted', () => {
      const s = setup();
      seedDefaultBots(s.repos, s.memory, s.opts);
      s.repos.deleteRoutine(routines(s)[0].id);
      seedDefaultBots(s.repos, s.memory, s.opts);
      expect(routines(s)).toEqual([]);
    });

    it('makes nothing for a bot the owner deleted, then or later', () => {
      const s = setup();
      seedDefaultBots(s.repos, s.memory, s.opts);
      const bot = s.repos.listBots().find((b) => b.handle === DATA_ENGINEER_HANDLE)!;
      s.repos.deleteRoutine(routines(s)[0].id);
      s.repos.deleteBot(bot.id);
      fs.rmSync(marker(s, DATA_ENGINEER_HANDLE + '.routine'));
      seedDefaultBots(s.repos, s.memory, s.opts);
      expect(routines(s)).toEqual([]);
      expect(fs.existsSync(marker(s, DATA_ENGINEER_HANDLE + '.routine'))).toBe(true);
    });

    it('does not recreate a DM the owner deleted', () => {
      const s = setup();
      seedDefaultBots(s.repos, s.memory, s.opts);
      const r = routines(s)[0];
      s.repos.deleteRoutine(r.id);
      s.repos.deleteRoom(r.roomId);
      fs.rmSync(marker(s, DATA_ENGINEER_HANDLE + '.routine'));
      const rooms = s.repos.listRooms().length;
      seedDefaultBots(s.repos, s.memory, s.opts);
      expect(routines(s)).toEqual([]);
      expect(s.repos.listRooms()).toHaveLength(rooms);
    });

    it('leaves a user bot on the same handle alone, on first seed and on upgrade', () => {
      const s = setup();
      const own = () => s.repos.createBot({ name: 'Data Engineer', handle: DATA_ENGINEER_HANDLE, title: '', description: '', avatar: '', model: 'm', allowedTools: [], maxBudgetUsd: 1 });
      const mine = own();
      s.repos.createRoom({ kind: 'dm', name: 'x', memberIds: [mine.id], coordinatorBotId: null });
      seedDefaultBots(s.repos, s.memory, s.opts);
      expect(routines(s)).toEqual([]);

      const u = setup();
      seedDefaultBots(u.repos, u.memory, u.opts);
      const seeded = u.repos.listBots().find((b) => b.handle === DATA_ENGINEER_HANDLE)!;
      u.repos.updateBot(seeded.id, { name: 'Mine' });
      u.repos.deleteRoutine(routines(u)[0].id);
      fs.rmSync(marker(u, DATA_ENGINEER_HANDLE + '.routine'));
      seedDefaultBots(u.repos, u.memory, u.opts);
      expect(routines(u)).toEqual([]);
    });

    it('skips an install with no source on disk', () => {
      const s = setup(false);
      seedDefaultBots(s.repos, s.memory, s.opts);
      expect(routines(s)).toEqual([]);
    });
  });

  it('never gives Support the data folder as a read root', () => {
    const s = setup();
    const dirs = supportSourceDirs(s.root);
    expect(dirs).toContain(path.join(s.root, 'docs'));
    expect(dirs).not.toContain(path.join(s.root, 'data'));
  });
});

describe('the game template source bots (B7)', () => {
  const gameOpts = (s: ReturnType<typeof setup>, platform: NodeJS.Platform = 'win32') => ({ dataDir: s.opts.dataDir, platform });

  it('creates @lead-engineer, @roblox-builder and @blender-artist once on a Windows hub, with no DM, and with their loop skills named', () => {
    const s = setup(false);
    const made = seedGameBots(s.repos, s.memory, gameOpts(s));
    expect(made.map((b) => b.handle)).toEqual([LEAD_ENGINEER_HANDLE, ROBLOX_BUILDER_HANDLE, BLENDER_ARTIST_HANDLE]);
    expect(s.repos.listRooms()).toEqual([]);
    expect(made[1]!.description).toContain('studio-loop');
    expect(made[2]!.description).toContain('blender-loop');
    expect(made[2]!.description).toContain('bpy.ops.wm');
    expect(seedGameBots(s.repos, s.memory, gameOpts(s))).toEqual([]);
    expect(s.repos.listBots()).toHaveLength(3);
  });

  it('NEGATIVE: seeds nothing on a hub that is not Windows, where game tools do not exist', () => {
    const s = setup();
    expect(seedGameBots(s.repos, s.memory, gameOpts(s, 'linux'))).toEqual([]);
    expect(s.repos.listBots()).toEqual([]);
  });

  it('does not bring back a deleted one, and leaves a user bot with the same handle alone', () => {
    const s = setup(false);
    s.repos.createBot({ name: 'Mine', handle: BLENDER_ARTIST_HANDLE, title: '', description: 'mine', avatar: '', model: 'm', allowedTools: [], maxBudgetUsd: 1 });
    s.repos.createBot({ name: 'My lead', handle: LEAD_ENGINEER_HANDLE, title: '', description: 'my lead', avatar: '', model: 'm', allowedTools: [], maxBudgetUsd: 1 });
    const [builder, ...rest] = seedGameBots(s.repos, s.memory, gameOpts(s));
    expect(builder!.handle).toBe(ROBLOX_BUILDER_HANDLE);
    expect(rest).toEqual([]);
    expect(s.repos.getBotByHandle(BLENDER_ARTIST_HANDLE)!.description).toBe('mine');
    expect(s.repos.getBotByHandle(LEAD_ENGINEER_HANDLE)!.description).toBe('my lead');
    s.repos.deleteBot(builder!.id);
    expect(seedGameBots(s.repos, s.memory, gameOpts(s))).toEqual([]);
  });
});
