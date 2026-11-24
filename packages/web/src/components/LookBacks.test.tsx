import { beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const item = { messageId: 'm1', ref: 'img:' + 'a'.repeat(64), alt: 'Look-back from blender: look' };
let html = '';

beforeAll(async () => {
  // ui.tsx reaches the store, which reads the window and storage on import.
  const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), clear: () => m.clear(), key: () => null, length: 0 }; };
  vi.stubGlobal('window', { innerWidth: 1280, matchMedia: () => ({ matches: false }), addEventListener: () => undefined, removeEventListener: () => undefined });
  vi.stubGlobal('localStorage', mem());
  vi.stubGlobal('sessionStorage', mem());
  const { LookBacks } = await import('./LookBacks');
  // On the server the picture's blob URL is never loaded, so this is the box shown while it loads.
  html = renderToStaticMarkup(<LookBacks items={[item]} />);
  vi.unstubAllGlobals();
}, 60_000);

describe('LookBacks', () => {
  it('reserves the thumbnail size before the picture loads, so nothing shifts', () => {
    const box = /<div class="([^"]*)" role="img"/.exec(html)?.[1] ?? '';
    expect(box.split(' ')).toEqual(expect.arrayContaining(['h-24', 'w-32', 'shrink-0']));
  });

  it('names the loading box from the tool, not the picture', () => {
    expect(html).toContain('aria-label="Look-back from blender: look (loading)"');
  });

  it('wraps so it fits a narrow chat', () => {
    expect(html).toMatch(/class="[^"]*flex-wrap[^"]*"/);
  });
});
