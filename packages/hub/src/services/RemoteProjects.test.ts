import { describe, expect, it } from 'vitest';
import { Db } from '../db/db.js';
import { RemoteProjects } from './RemoteProjects.js';

describe('RemoteProjects (B10)', () => {
  const make = () => {
    let t = 1000;
    const db = new Db(':memory:');
    return { db, remote: new RemoteProjects({ db, now: () => t }), tick: () => (t += 1000) };
  };

  it('knows no host until the desktop app says something about it', () => {
    const { remote } = make();
    expect(remote.known('server')).toBe(false);
    expect(remote.state('server')).toBeNull();
    expect(remote.list()).toEqual([]);
  });

  it('replaces the whole list, stamps seenAt, and keeps it when only connected changes', () => {
    const { remote, tick } = make();
    remote.put('server', { connected: true, projects: [{ slug: 'b', name: 'B' }, { slug: 'a', name: 'A' }] });
    expect(remote.list()).toEqual([
      { host: 'server', slug: 'a', name: 'A', seenAt: 1000, connected: true },
      { host: 'server', slug: 'b', name: 'B', seenAt: 1000, connected: true },
    ]);
    tick();
    expect(remote.put('server', { connected: false })).toEqual({ host: 'server', connected: false, stubs: 2, updatedAt: 2000 });
    expect(remote.list().map((p) => [p.slug, p.seenAt, p.connected])).toEqual([['a', 1000, false], ['b', 1000, false]]);
    tick();
    remote.put('server', { connected: true, projects: [{ slug: 'c', name: 'C' }] });
    expect(remote.list().map((p) => [p.slug, p.seenAt])).toEqual([['c', 3000]]);
    expect(remote.known('server')).toBe(true);
  });

  it('an empty list clears the stubs but the host stays known', () => {
    const { remote } = make();
    remote.put('server', { connected: true, projects: [{ slug: 'a', name: 'A' }] });
    remote.put('server', { connected: true, projects: [] });
    expect(remote.list()).toEqual([]);
    expect(remote.known('server')).toBe(true);
  });

  it('NEGATIVE: a failed write leaves the old list (one transaction)', () => {
    const { remote } = make();
    remote.put('server', { connected: true, projects: [{ slug: 'keep', name: 'Keep' }] });
    expect(() => remote.put('server', { connected: false, projects: [{ slug: 'x', name: 'X' }, { slug: 'x', name: 'Twice' }] })).toThrow();
    expect(remote.list().map((p) => [p.slug, p.connected])).toEqual([['keep', true]]);
  });
});
