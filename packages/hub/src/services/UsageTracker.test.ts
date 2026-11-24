import { describe, it, expect } from 'vitest';
import { Db } from '../db/db.js';
import { Repos } from '../db/repos.js';
import { SHARED_SUBSCRIPTION_NOTE } from '@pocketrocket/shared';
import { UsageTracker } from './UsageTracker.js';

function setup() {
  const repos = new Repos(new Db(':memory:'));
  const bot = repos.createBot({ name: 'A', handle: 'a', title: '', description: '', avatar: '', model: 'm', allowedTools: [], maxBudgetUsd: 1 });
  const room = repos.createRoom({ kind: 'dm', name: 'A', memberIds: [bot.id], coordinatorBotId: null });
  return { repos, bot, room };
}

const usage = { costUsd: 3, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, modelUsage: null, durationMs: 1 };

describe('UsageTracker daily alert', () => {
  it('stays silent below the threshold', () => {
    const { repos, bot, room } = setup();
    const tracker = new UsageTracker(repos, { alertThresholdUsd: () => 5 });
    tracker.record(bot.id, room.id, 't1', null, usage);
    expect(repos.listMessages(room.id).some((m) => m.kind === 'system')).toBe(false);
  });

  it('posts once a bot crosses the threshold in a rolling day, then stays quiet until it rolls over', () => {
    const { repos, bot, room } = setup();
    const tracker = new UsageTracker(repos, { alertThresholdUsd: () => 5 });
    tracker.record(bot.id, room.id, 't1', null, usage);
    tracker.record(bot.id, room.id, 't2', null, usage);
    const alerts = repos.listMessages(room.id).filter((m) => m.kind === 'system');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].text).toContain('@a has spent $6.00 in the last 24h');
    tracker.record(bot.id, room.id, 't3', null, usage);
    expect(repos.listMessages(room.id).filter((m) => m.kind === 'system')).toHaveLength(1);
  });

  it('never alerts when the threshold is 0 (off)', () => {
    const { repos, bot, room } = setup();
    const tracker = new UsageTracker(repos, { alertThresholdUsd: () => 0 });
    tracker.record(bot.id, room.id, 't1', null, { ...usage, costUsd: 999 });
    expect(repos.listMessages(room.id).some((m) => m.kind === 'system')).toBe(false);
  });
});

describe('UsageTracker shared-subscription note (B11)', () => {
  it('says both hubs spend from one subscription once a server host is known', () => {
    const { repos } = setup();
    let known = false;
    const tracker = new UsageTracker(repos, { serverHostKnown: () => known });
    expect(tracker.subscriptionNote()).toBeNull();
    known = true;
    expect(tracker.subscriptionNote()).toBe(SHARED_SUBSCRIPTION_NOTE);
    expect(tracker.subscriptionNote()).toMatch(/same Claude subscription/);
  });

  it('NEGATIVE: says nothing on a hub that was never told about a server', () => {
    const { repos } = setup();
    expect(new UsageTracker(repos).subscriptionNote()).toBeNull();
  });
});
