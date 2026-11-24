import { beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

type Parts = typeof import('./parts');
type Section = typeof import('./McpServersSection');
let maskHome: Parts['maskHome'];
let ServerTarget: Section['ServerTarget'];

beforeAll(async () => {
  // These modules reach the store, which reads the window and storage on import.
  const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), clear: () => m.clear(), key: () => null, length: 0 }; };
  vi.stubGlobal('window', { innerWidth: 1280, matchMedia: () => ({ matches: false }), addEventListener: () => undefined, removeEventListener: () => undefined });
  vi.stubGlobal('localStorage', mem());
  vi.stubGlobal('sessionStorage', mem());
  ({ maskHome } = await import('./parts'));
  ({ ServerTarget } = await import('./McpServersSection'));
  vi.unstubAllGlobals();
}, 60_000);

/** The Studio recipe as Settings › Tools lists it (spec §2, "Studio recipe"). */
const STUDIO = { name: 'roblox-studio', kind: 'stdio' as const, command: 'C:\\Windows\\System32\\cmd.exe', args: ['/d', '/c', 'C:\\Users\\alex\\AppData\\Local\\Roblox\\mcp.bat'] };

describe('maskHome (follow-up b)', () => {
  it('folds every home folder in a command line to ~, wherever it sits', () => {
    expect(maskHome('C:\\Windows\\System32\\cmd.exe /d /c C:\\Users\\alex\\AppData\\Local\\Roblox\\mcp.bat'))
      .toBe('C:\\Windows\\System32\\cmd.exe /d /c ~\\AppData\\Local\\Roblox\\mcp.bat');
    expect(maskHome('node /home/sam/a.js --out /Users/kim/x c:\\users\\Al\\y')).toBe('node ~/a.js --out ~/x ~\\y');
    expect(maskHome('npx -y @scope/server')).toBe('npx -y @scope/server');
  });

  it('masks a drive letter in either case and forward slashes', () => {
    expect(maskHome('d:/Users/alex/tools/x.exe')).toBe('~/tools/x.exe');
  });
});

describe('ServerTarget in Settings › Tools', () => {
  it('never shows the user folder in plain sight', () => {
    const html = renderToStaticMarkup(<ServerTarget server={STUDIO} />);
    expect(html).not.toContain('alex');
    expect(html).toContain('~\\AppData\\Local\\Roblox\\mcp.bat');
    expect(html).toContain('aria-label="Show the full roblox-studio command"');
  });

  it('shows a command with no home folder as it is, with no reveal button', () => {
    const html = renderToStaticMarkup(<ServerTarget server={{ name: 'fs', kind: 'stdio', command: 'npx', args: ['-y', 'server'] }} />);
    expect(html).toBe('npx -y server');
  });

  it('shows a web address as it is', () => {
    expect(renderToStaticMarkup(<ServerTarget server={{ name: 'w', kind: 'http', url: 'https://mcp.example/x' }} />)).toBe('https://mcp.example/x');
  });
});
