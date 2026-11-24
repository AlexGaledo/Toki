import { beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// The Radix dialog shell (portal, scroll lock) needs a DOM; a plain shell keeps SettingsDialog's own children in order.
vi.mock('../ui', async (orig) => ({
  ...(await orig<typeof import('../ui')>()),
  DialogShell: ({ children }: { children: React.ReactNode }) => <div role="dialog">{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogCloseButton: () => <button type="button" aria-label="Close" />,
}));
// useSyncExternalStore has no server snapshot here; the wide (side nav) layout is the one that had the trap.
vi.mock('../../lib/useMediaQuery', () => ({ useMediaQuery: () => true }));

let html = '';

beforeAll(async () => {
  // ui.tsx reaches the store, which reads the window and storage on import.
  const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), clear: () => m.clear(), key: () => null, length: 0 }; };
  vi.stubGlobal('window', { innerWidth: 1280, location: { hash: '', search: '', pathname: '/', origin: 'http://x' }, matchMedia: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }), addEventListener: () => undefined, removeEventListener: () => undefined });
  vi.stubGlobal('localStorage', mem());
  vi.stubGlobal('sessionStorage', mem());
  const { SettingsDialog } = await import('./SettingsDialog');
  html = renderToStaticMarkup(<SettingsDialog section="game-tools" onClose={() => undefined} />);
  vi.unstubAllGlobals();
}, 60_000);

describe('SettingsDialog: keyboard focus trap', () => {
  it('has one Close button, and it comes before the section tabs in the DOM', () => {
    // Radix gives the tablist itself tabIndex 0 and no tab a tab stop until one is focused. If the tablist is the
    // dialog's first tab stop, the focus trap never wraps Shift+Tab from the active section, so focus stays stuck
    // there (found in docs/verify/ui-gaps). A real control first gives the trap a first stop it can wrap from.
    const close = [...html.matchAll(/aria-label="Close"/g)].map((m) => m.index);
    const tablist = html.indexOf('role="tablist"');
    expect(tablist).toBeGreaterThan(0);
    expect(close).toHaveLength(1);
    expect(close[0]).toBeLessThan(tablist);
  });

  it('keeps that Close button visible at every width', () => {
    const tag = /<div class="([^"]*)"><button[^>]*aria-label="Close"/.exec(html)?.[1] ?? '';
    expect(tag.split(' ')).toEqual(expect.arrayContaining(['absolute', 'right-4', 'top-4']));
    expect(tag).not.toMatch(/(^|\s)(hidden|sm:hidden|max-sm:hidden)(\s|$)/);
  });
});
