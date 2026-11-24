import { beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

let html = '';

beforeAll(async () => {
  // ui.tsx reaches the store, which reads the window and storage on import.
  const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), clear: () => m.clear(), key: () => null, length: 0 }; };
  vi.stubGlobal('window', { innerWidth: 1280, matchMedia: () => ({ matches: false }), addEventListener: () => undefined, removeEventListener: () => undefined });
  vi.stubGlobal('localStorage', mem());
  vi.stubGlobal('sessionStorage', mem());
  const { RadioCard } = await import('./ui');
  html = renderToStaticMarkup(
    <RadioCard checked={false} disabled onSelect={() => undefined} title="Game team" note="Install the Blender tools in Settings › Game tools first.">
      Adds a lead, a Roblox builder and a Blender artist.
    </RadioCard>,
  );
  vi.unstubAllGlobals();
}, 60_000);

describe('RadioCard note (D3: a disabled option says why)', () => {
  it('keeps the reason at full strength while the rest of a disabled option is dimmed', () => {
    const note = /<div id="([^"]+)" class="([^"]*)">Install the Blender tools/.exec(html);
    expect(note?.[2]).not.toContain('opacity');
    expect(note?.[2]).toContain('text-fg');
    expect(html).toContain('opacity-60');
  });

  it('is read out as part of the option, after what it adds', () => {
    const describedBy = /aria-describedby="([^"]+)"/.exec(html)?.[1].split(' ') ?? [];
    const note = /<div id="([^"]+)" class="[^"]*">Install the Blender tools/.exec(html)?.[1];
    expect(describedBy).toHaveLength(2);
    expect(describedBy[1]).toBe(note);
    expect(html).toContain('aria-disabled="true"');
  });
});
