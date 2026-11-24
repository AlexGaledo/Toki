import { describe, it, expect } from 'vitest';
import { Db } from '../db/db.js';
import { Repos } from '../db/repos.js';
import { UsageTracker } from '../services/UsageTracker.js';
import type { BotRunner, TurnRequest, TurnResult } from '../agent/BotRunner.js';
import { LEAD_NOTE, RoomRouter } from './RoomRouter.js';

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(cond()).toBe(true);
};

function setup(leadMode: boolean) {
  const repos = new Repos(new Db(':memory:'));
  const router = new RoomRouter(repos, new UsageTracker(repos));
  const bot = (h: string) => repos.createBot({ name: h, handle: h, title: '', description: '', avatar: '', model: 'm', allowedTools: [], maxBudgetUsd: 50 });
  const [ann, bob, cat] = [bot('ann'), bot('bob'), bot('cat')];
  const room = repos.createRoom({ kind: 'group', name: 'g', memberIds: [ann.id, bob.id, cat.id], coordinatorBotId: ann.id, leadMode });
  const reqs: TurnRequest[] = [];
  const replies: Record<string, string[]> = { ann: [], bob: [], cat: [] };
  router.runner = {
    runTurn: async (req: TurnRequest): Promise<TurnResult> => {
      reqs.push(req);
      const finalText = replies[req.bot.handle]?.shift() ?? '';
      if (finalText) repos.insertMessage({ roomId: req.room.id, authorType: 'bot', authorId: req.bot.id, kind: 'text', text: finalText, payload: null, causeId: req.causeId, hop: req.hop, turnId: null });
      return { ok: true, turnId: 't' + reqs.length, finalText, costUsd: 0 };
    },
  } as unknown as BotRunner;
  return { repos, router, room, ann, bob, cat, reqs, replies };
}

describe('lead mode', () => {
  it('is stored on the room and off by default', () => {
    const { repos, room } = setup(true);
    expect(repos.getRoom(room.id)!.leadMode).toBe(true);
    expect(repos.updateRoom(room.id, { name: 'x' })!.leadMode).toBe(true);
    expect(repos.updateRoom(room.id, { leadMode: false })!.leadMode).toBe(false);
    expect(repos.createRoom({ kind: 'group', name: 'h', memberIds: [], coordinatorBotId: null }).leadMode).toBe(false);
  });

  it('sends the owner\'s message only to the lead, even when it @mentions someone else', async () => {
    const { router, room, reqs } = setup(true);
    router.onUserMessage(room.id, '@bob fix the login page');
    await until(() => reqs.length === 1);
    await new Promise((r) => setTimeout(r, 30));
    expect(reqs.map((r) => r.bot.handle)).toEqual(['ann']);
    expect(reqs.map((r) => r.injected).join('')).toContain(LEAD_NOTE);
  });

  it('gives a worker only what is addressed to it, and routes what it passes on back to the lead', async () => {
    const { repos, router, room, cat, reqs, replies } = setup(true);
    const chatter = repos.insertMessage({ roomId: room.id, authorType: 'bot', authorId: cat.id, kind: 'text', text: 'cat chatter nobody asked bob about', payload: null, causeId: null, hop: 0, turnId: null });
    replies.ann = ['@bob fix the login redirect in src/auth.ts, then run the tests'];
    replies.bob = ['Done. @cat can you review it?'];
    router.onUserMessage(room.id, 'please fix login');
    await until(() => reqs.length === 3);
    await new Promise((r) => setTimeout(r, 30));
    expect(reqs.map((r) => r.bot.handle)).toEqual(['ann', 'bob', 'ann']);
    const [, bobTurn = '', annAgain = ''] = reqs.map((r) => r.injected);
    expect(bobTurn).toContain('fix the login redirect');
    expect(bobTurn).not.toContain(chatter.text);
    expect(bobTurn).not.toContain('please fix login');
    expect(bobTurn).toContain('@ann runs this room');
    expect(annAgain).toContain('@cat can you review it?');
  });

  it('changes nothing when off: mentions reach bots directly and everyone reads the room', async () => {
    const { repos, router, room, cat, reqs } = setup(false);
    repos.insertMessage({ roomId: room.id, authorType: 'bot', authorId: cat.id, kind: 'text', text: 'cat chatter', payload: null, causeId: null, hop: 0, turnId: null });
    router.onUserMessage(room.id, '@bob fix the login page');
    await until(() => reqs.length === 1);
    expect(reqs.map((r) => r.bot.handle)).toEqual(['bob']);
    expect(reqs.map((r) => r.injected).join('')).toContain('cat chatter');
  });
});
