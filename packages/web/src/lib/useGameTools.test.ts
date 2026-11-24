import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

type Mod = typeof import('./useGameTools');
type Store = typeof import('../store')['useStore'];
let watchGameTools: Mod['watchGameTools'];
let useStore: Store;

beforeAll(async () => {
  // The store reads the window and storage on import.
  const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), clear: () => m.clear(), key: () => null, length: 0 }; };
  vi.stubGlobal('window', { innerWidth: 1280, matchMedia: () => ({ matches: false }), addEventListener: () => undefined, removeEventListener: () => undefined });
  vi.stubGlobal('localStorage', mem());
  vi.stubGlobal('sessionStorage', mem());
  ({ watchGameTools } = await import('./useGameTools'));
  ({ useStore } = await import('../store'));
  vi.unstubAllGlobals();
}, 60_000);
afterEach(() => vi.useRealTimers());

/** The same subscription the hook uses, on the real store. */
const onRev = (fn: () => void) => useStore.subscribe((s, prev) => { if (s.gameToolsRev !== prev.gameToolsRev) fn(); });

describe('game tools re-read (follow-up a)', () => {
  it('the hub\'s game-tools.changed event bumps the store\'s counter', () => {
    const before = useStore.getState().gameToolsRev;
    useStore.getState().applyEvent({ type: 'game-tools.changed' });
    expect(useStore.getState().gameToolsRev).toBe(before + 1);
  });

  it('re-reads on the event and on window focus, and never on a timer', () => {
    vi.useFakeTimers();
    const focus = new EventTarget();
    const reload = vi.fn();
    const stop = watchGameTools(reload, { onRev, focus: focus as unknown as Window });

    vi.advanceTimersByTime(5 * 60_000);
    expect(reload).not.toHaveBeenCalled();

    useStore.getState().applyEvent({ type: 'game-tools.changed' });
    expect(reload).toHaveBeenCalledTimes(1);
    focus.dispatchEvent(new Event('focus'));
    expect(reload).toHaveBeenCalledTimes(2);

    // An unrelated event does not re-read.
    useStore.getState().applyEvent({ type: 'skills.changed' });
    expect(reload).toHaveBeenCalledTimes(2);

    stop();
    useStore.getState().applyEvent({ type: 'game-tools.changed' });
    focus.dispatchEvent(new Event('focus'));
    expect(reload).toHaveBeenCalledTimes(2);
  });
});
