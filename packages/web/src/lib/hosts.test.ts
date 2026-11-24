import { describe, expect, it } from 'vitest';
import type { ProjectStub } from '@pocketrocket/shared';
import {
  desktopCall, hostTag, isStub, openStubAction, projectDeepLink, projectKey, promptStep, showHostTags, splitProjects, withoutProjectParam,
  type ServerPrompt,
} from './hosts';

const local = (slug: string) => ({ slug, name: slug, dir: 'C:/data/projects/' + slug, memberIds: ['b1'], roomId: 'r-' + slug, templateVersion: null, createdAt: 1, host: 'pc' as const });
const stub = (slug: string, connected = false): ProjectStub => ({ host: 'server', slug, name: 'Server ' + slug, seenAt: 5, connected });
const caps = (...c: string[]) => (cap: string) => c.includes(cap);
const ORIGIN = 'http://127.0.0.1:7788';

describe('splitProjects (GET /api/projects is mixed)', () => {
  it('keeps a stub out of the local list even when its slug clashes with a local project', () => {
    const { local: mine, stubs } = splitProjects([local('wika'), stub('wika'), stub('arena', true)]);
    expect(mine.map((p) => p.slug)).toEqual(['wika']);
    expect(mine[0]).not.toHaveProperty('host');
    expect(mine[0]?.dir).toBe('C:/data/projects/wika');
    expect(stubs.map((s) => s.slug)).toEqual(['wika', 'arena']);
  });

  it('reads an older hub (no host field) as all local', () => {
    const { host: _drop, ...old } = local('notes');
    expect(splitProjects([old])).toEqual({ local: [old], stubs: [] });
  });

  it('drops unknown hosts, rows without a slug, and a body that is not a list', () => {
    expect(splitProjects([{ ...stub('x'), host: 'crm' }, { host: 'server' }, null, 7])).toEqual({ local: [], stubs: [] });
    expect(splitProjects({ error: 'nope' })).toEqual({ local: [], stubs: [] });
  });

  it('isStub is true only for another host', () => {
    expect(isStub(stub('a'))).toBe(true);
    expect(isStub(local('a'))).toBe(false);
    expect(isStub({})).toBe(false);
  });
});

describe('projectKey', () => {
  it('is host plus slug, so the same slug on two hosts is two items', () => {
    expect(projectKey(local('wika'))).toBe('pc:wika');
    expect(projectKey(stub('wika'))).toBe('server:wika');
    expect(projectKey({ slug: 'wika' })).toBe('pc:wika');
    expect(new Set([local('wika'), stub('wika')].map(projectKey)).size).toBe(2);
  });
});

describe('host tags', () => {
  it('say This PC and Server in words on the PC page', () => {
    expect(hostTag(local('a'), 'pc')).toBe('This PC');
    expect(hostTag(stub('a'), 'pc')).toBe('Server');
  });

  it("call the server page's own projects Server", () => {
    expect(hostTag(local('a'), 'server')).toBe('Server');
  });

  it('show once a second host is known, or on the server page', () => {
    expect(showHostTags(0, 'pc')).toBe(false);
    expect(showHostTags(1, 'pc')).toBe(true);
    expect(showHostTags(0, 'server')).toBe(true);
  });
});

describe('the project=<slug> deep link', () => {
  it('takes a real slug', () => {
    expect(projectDeepLink('?desktop=1&caps=hosts&host=server&project=obby-run')).toBe('obby-run');
  });

  it('takes nothing else', () => {
    for (const q of ['', '?project=', '?project=..%2Fx', '?project=a/b', '?project=Obby', '?project=a--b', '?project=-a', '?project=' + 'a'.repeat(41), '?project=a%20b', '?project=server:a']) {
      expect(projectDeepLink(q), q).toBeNull();
    }
  });

  it('is stripped without touching the other parameters', () => {
    expect(withoutProjectParam('?desktop=1&caps=hosts&host=server&project=obby-run')).toBe('?desktop=1&caps=hosts&host=server');
    expect(withoutProjectParam('?project=obby-run')).toBe('');
  });
});

describe('the desktop calls (docs/verify/phase3-infra, "Exact web calls for D4")', () => {
  it('are one parameter on /, encoded, with no fragment', () => {
    expect(desktopCall.openFolder(ORIGIN, 'wika')).toBe(ORIGIN + '/?openfolder=wika');
    expect(desktopCall.openServerProject(ORIGIN, 'obby-run')).toBe(ORIGIN + '/?openproject=server:obby-run');
    expect(desktopCall.backToPc(ORIGIN)).toBe(ORIGIN + '/?openhost=pc');
    expect(desktopCall.openFolder(ORIGIN, 'a&token=x')).toBe(ORIGIN + '/?openfolder=a%26token%3Dx');
  });
});

describe('opening a stub, gated on the desktop caps', () => {
  it('calls the desktop app straight away when the server is connected and the shell has hosts', () => {
    expect(openStubAction(stub('a', true), caps('hosts'), ORIGIN)).toEqual({ kind: 'call', url: ORIGIN + '/?openproject=server:a' });
  });

  it('asks to connect when the server is offline', () => {
    expect(openStubAction(stub('a', false), caps('hosts', 'server'), ORIGIN)).toEqual({ kind: 'prompt', phase: 'ask' });
  });

  it('outside the desktop app (no hosts cap) says to open it there, connected or not', () => {
    expect(openStubAction(stub('a', true), caps(), ORIGIN)).toEqual({ kind: 'prompt', phase: 'elsewhere' });
    expect(openStubAction(stub('a', false), caps('server', 'openfolder'), ORIGIN)).toEqual({ kind: 'prompt', phase: 'elsewhere' });
  });
});

describe('the connect prompt', () => {
  const s = stub('obby');
  const ask: ServerPrompt = promptStep(null, { type: 'open', stub: s, phase: 'ask' });

  it('opens asking, and Connect turns it to working', () => {
    expect(ask).toEqual({ stub: s, phase: 'ask' });
    expect(promptStep(ask, { type: 'connect' })).toEqual({ stub: s, phase: 'working' });
  });

  it('ends working as failed when hosts.changed reads the host offline', () => {
    const working = promptStep(ask, { type: 'connect' });
    expect(promptStep(working, { type: 'hosts', stubs: [stub('obby', false), stub('arena', false)] })).toEqual({ stub: s, phase: 'failed' });
    expect(promptStep(working, { type: 'hosts', stubs: [] })).toEqual({ stub: s, phase: 'failed' });
  });

  it('keeps working while the host reads connected (the shell is about to navigate)', () => {
    const working = promptStep(ask, { type: 'connect' });
    expect(promptStep(working, { type: 'hosts', stubs: [stub('arena', true)] })).toBe(working);
  });

  it('ignores hosts.changed unless it is working', () => {
    expect(promptStep(ask, { type: 'hosts', stubs: [] })).toBe(ask);
    expect(promptStep(null, { type: 'hosts', stubs: [] })).toBeNull();
  });

  it('tries again from failed, but never connects from elsewhere or twice', () => {
    const failed: ServerPrompt = { stub: s, phase: 'failed' };
    expect(promptStep(failed, { type: 'connect' })).toEqual({ stub: s, phase: 'working' });
    const elsewhere: ServerPrompt = { stub: s, phase: 'elsewhere' };
    expect(promptStep(elsewhere, { type: 'connect' })).toBe(elsewhere);
    const working: ServerPrompt = { stub: s, phase: 'working' };
    expect(promptStep(working, { type: 'connect' })).toBe(working);
  });

  it('closes from any phase', () => {
    for (const phase of ['ask', 'working', 'failed', 'elsewhere'] as const) expect(promptStep({ stub: s, phase }, { type: 'close' })).toBeNull();
  });
});
