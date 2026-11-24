import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectStub } from '@pocketrocket/shared';

// D4 in the store: the mixed project list, the connect prompt and the project=<slug> deep link, through the real store
// and the real api module, with fetch, window.open and the page URL faked.

function memoryStorage(init: Record<string, string> = {}): Storage {
  const m = new Map<string, string>(Object.entries(init));
  return {
    get length() { return m.size; }, clear: () => m.clear(), getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null, removeItem: (k) => void m.delete(k), setItem: (k, v) => void m.set(k, String(v)),
  };
}

const ORIGIN = 'http://127.0.0.1:7788';
const wika = { host: 'pc', slug: 'wika', name: 'Wika', dir: 'C:/data/projects/wika', memberIds: ['b1'], roomId: 'r-wika', templateVersion: null, createdAt: 1 };
const stub = (slug: string, connected: boolean): ProjectStub => ({ host: 'server', slug, name: 'Server ' + slug, seenAt: 5, connected });

let list: unknown[] = [];
let fetched: string[] = [];
let opened: string[] = [];
let replaced: string[] = [];

async function boot(search: string) {
  vi.resetModules();
  fetched = [];
  opened = [];
  replaced = [];
  const loc = { search, hash: '', pathname: '/', origin: ORIGIN };
  vi.stubGlobal('location', loc);
  vi.stubGlobal('history', { replaceState: (_s: unknown, _t: string, url: string) => { replaced.push(url); } });
  vi.stubGlobal('localStorage', memoryStorage({ 'pocketrocket.layout': 'toki' }));
  vi.stubGlobal('sessionStorage', memoryStorage());
  vi.stubGlobal('window', {
    innerWidth: 1440, location: loc, matchMedia: () => ({ matches: false }), addEventListener: () => undefined, removeEventListener: () => undefined,
    open: (url: string) => { opened.push(url); return null; },
  });
  vi.stubGlobal('document', { hasFocus: () => true, documentElement: { dataset: {} } });
  vi.stubGlobal('fetch', async (path: string) => {
    fetched.push(path);
    const body = path === '/api/projects' ? list : [];
    return { ok: true, status: 200, statusText: 'OK', json: async () => body };
  });
  const { useStore } = await import('./store');
  return useStore;
}

afterEach(() => vi.unstubAllGlobals());

const settle = () => new Promise((r) => setTimeout(r, 0));
const slugRoutes = () => fetched.filter((p) => p.startsWith('/api/projects/'));

describe('the mixed project list (a stub never reaches a slug route)', () => {
  it('keeps a stub whose slug clashes with a local project out of `projects`, and calls no /api/projects/:slug route for it', async () => {
    list = [wika, stub('wika', false), stub('arena', true)];
    const store = await boot('?desktop=1&caps=localcopy,openfolder,hosts,server');
    await store.getState().loadProjects();
    const s = store.getState();
    expect(s.projects.map((p) => p.slug)).toEqual(['wika']);
    expect(s.projects[0]?.dir).toBe('C:/data/projects/wika');
    expect(s.stubs.map((p) => p.host + ':' + p.slug)).toEqual(['server:wika', 'server:arena']);

    // Open both stubs, connect, and let hosts.changed re-read the list: still no slug route.
    s.openStub(s.stubs[0]!);
    store.getState().promptConnect();
    store.getState().applyEvent({ type: 'hosts.changed' });
    await settle();
    store.getState().openStub(store.getState().stubs[1]!);
    expect(slugRoutes()).toEqual([]);
  });

  it('splits a projects.changed event that carries the list, too', async () => {
    list = [];
    const store = await boot('');
    (store.getState().applyEvent as (e: unknown) => void)({ type: 'projects.changed', projects: [wika, stub('wika', false)] });
    expect(store.getState().projects.map((p) => p.slug)).toEqual(['wika']);
    expect(store.getState().stubs).toHaveLength(1);
  });
});

describe('opening a Server project', () => {
  it('connected, in the desktop app: the exact openproject call, no prompt', async () => {
    list = [stub('arena', true)];
    const store = await boot('?desktop=1&caps=hosts');
    await store.getState().loadProjects();
    store.getState().openStub(store.getState().stubs[0]!);
    expect(opened).toEqual([ORIGIN + '/?openproject=server:arena']);
    expect(store.getState().serverPrompt).toBeNull();
  });

  it('offline: asks first; Connect makes the same call and works until hosts.changed reads it offline', async () => {
    list = [stub('obby-run', false)];
    const store = await boot('?desktop=1&caps=hosts,server');
    await store.getState().loadProjects();
    store.getState().openStub(store.getState().stubs[0]!);
    expect(opened).toEqual([]);
    expect(store.getState().serverPrompt?.phase).toBe('ask');

    store.getState().promptConnect();
    expect(opened).toEqual([ORIGIN + '/?openproject=server:obby-run']);
    expect(store.getState().serverPrompt?.phase).toBe('working');

    // A second press while working makes no second call.
    store.getState().promptConnect();
    expect(opened).toHaveLength(1);

    // An unrelated re-read (rooms.changed) does not end it: only hosts.changed does.
    store.getState().applyEvent({ type: 'rooms.changed', rooms: [] });
    await settle();
    expect(store.getState().serverPrompt?.phase).toBe('working');

    store.getState().applyEvent({ type: 'hosts.changed' });
    await settle();
    expect(store.getState().serverPrompt?.phase).toBe('failed');

    store.getState().closePrompt();
    expect(store.getState().serverPrompt).toBeNull();
  });

  it('a hosts.changed that reads the server connected keeps it working (the shell navigates)', async () => {
    list = [stub('obby-run', false)];
    const store = await boot('?desktop=1&caps=hosts');
    await store.getState().loadProjects();
    store.getState().openStub(store.getState().stubs[0]!);
    store.getState().promptConnect();
    list = [stub('obby-run', true)];
    store.getState().applyEvent({ type: 'hosts.changed' });
    await settle();
    expect(store.getState().serverPrompt?.phase).toBe('working');
    expect(store.getState().stubs[0]?.connected).toBe(true);
  });

  it('outside the desktop app: the open-it-there note, and Connect never calls anything', async () => {
    list = [stub('arena', true)];
    const store = await boot('');
    await store.getState().loadProjects();
    store.getState().openStub(store.getState().stubs[0]!);
    expect(store.getState().serverPrompt?.phase).toBe('elsewhere');
    store.getState().promptConnect();
    expect(opened).toEqual([]);
    expect(store.getState().serverPrompt?.phase).toBe('elsewhere');
  });

  it('caps without hosts (an older shell) count as outside', async () => {
    list = [stub('arena', true)];
    const store = await boot('?desktop=1&caps=localcopy,openfolder');
    await store.getState().loadProjects();
    store.getState().openStub(store.getState().stubs[0]!);
    expect(opened).toEqual([]);
    expect(store.getState().serverPrompt?.phase).toBe('elsewhere');
  });
});

describe('the project=<slug> deep link', () => {
  it('opens that project once the list arrives and strips only project from the URL', async () => {
    list = [wika];
    const store = await boot('?desktop=1&caps=hosts&host=server&project=wika');
    expect(store.getState().pendingProject).toBe('wika');
    await store.getState().loadProjects();
    expect(store.getState().activeRoomId).toBe('r-wika');
    expect(store.getState().pendingProject).toBeNull();
    expect(replaced).toEqual(['/?desktop=1&caps=hosts&host=server']);

    // Only once: a later re-read does not pull the user back.
    store.getState().setActiveRoom('r-other');
    await store.getState().loadProjects();
    expect(store.getState().activeRoomId).toBe('r-other');
  });

  it('never opens a stub of the same slug, and says so when the slug is not on this hub', async () => {
    list = [stub('wika', true)];
    const store = await boot('?project=wika');
    await store.getState().loadProjects();
    expect(store.getState().activeRoomId).not.toBe('r-wika');
    expect(opened).toEqual([]);
    expect(store.getState().toasts.map((t) => t.text)).toContain("That project isn't on this hub.");
  });

  it('ignores a value that is not a slug', async () => {
    list = [wika];
    const store = await boot('?project=..%2Fwika');
    expect(store.getState().pendingProject).toBeNull();
  });
});
