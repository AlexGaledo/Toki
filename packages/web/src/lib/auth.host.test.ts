import { afterEach, describe, expect, it, vi } from 'vitest';

// D4: "Back to this PC" shows on the server hub's page, which the shell opens with `host=server` (I3).
function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; }, clear: () => m.clear(), getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null, removeItem: (k) => void m.delete(k), setItem: (k, v) => void m.set(k, String(v)),
  };
}

async function boot(search: string, session: Storage = memoryStorage()) {
  vi.resetModules();
  vi.stubGlobal('location', { search, hash: '', pathname: '/' });
  vi.stubGlobal('history', { replaceState: () => undefined });
  vi.stubGlobal('localStorage', memoryStorage());
  vi.stubGlobal('sessionStorage', session);
  return import('./auth');
}

afterEach(() => vi.unstubAllGlobals());

describe('desktopHost', () => {
  it('is server only on the page the shell opened with host=server', async () => {
    const a = await boot('?desktop=1&caps=hosts&host=server&project=x');
    expect(a.desktopHost()).toBe('server');
    expect(a.desktopCan('hosts')).toBe(true);
  });

  it('is pc on the PC hub page, for any other host value, and outside the desktop app', async () => {
    expect((await boot('?desktop=1&caps=hosts')).desktopHost()).toBe('pc');
    expect((await boot('?desktop=1&caps=hosts&host=crm')).desktopHost()).toBe('pc');
    expect((await boot('?host=server')).desktopHost()).toBe('pc');
  });

  it('ignores a stale host key once the tab is not in desktop mode', async () => {
    const session = memoryStorage();
    session.setItem('pocketrocket.desktopHost', 'server');
    expect((await boot('', session)).desktopHost()).toBe('pc');
  });
});
