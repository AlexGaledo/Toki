import { beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ProjectStub } from '@pocketrocket/shared';
import type { ProjectInfo } from '../../lib/api';

// D4 in Settings › Projects: host tags in words, and a Server project card that is a name only.
const state: Record<string, unknown> = { bots: [], openStub: () => undefined, stubs: [] };
let caps: string[] = [];
vi.mock('../../store', () => ({ useStore: (sel: (s: Record<string, unknown>) => unknown) => sel(state) }));
vi.mock('../../lib/newLayout', () => ({ useNewLayout: () => true }));
vi.mock('../../lib/auth', () => ({ desktopCan: (c: string) => caps.includes(c), desktopHost: () => 'pc' }));

let ProjectCard: typeof import('./ProjectsSection').ProjectCard;
let StubCard: typeof import('./ProjectsSection').StubCard;
beforeAll(async () => {
  ({ ProjectCard, StubCard } = await import('./ProjectsSection'));
}, 60000);

const project: ProjectInfo = { slug: 'wika', name: 'Wika', dir: 'C:/data/projects/wika', memberIds: [], roomId: 'r1', templateVersion: null, createdAt: 0 };
const stub: ProjectStub = { host: 'server', slug: 'wika', name: 'Wika', seenAt: 0, connected: false };
const card = (tag: string | null) => renderToStaticMarkup(<ProjectCard project={project} tag={tag} onChanged={() => undefined} onError={() => undefined} />);

describe('a PC project card', () => {
  it('shows its host tag in words', () => {
    expect(card('This PC')).toContain('>This PC<');
    expect(card(null)).not.toContain('This PC');
  });
});

describe('a Server project card', () => {
  it('is tagged Server, says it is offline, and has no folder, members or repos', () => {
    caps = ['openfolder', 'hosts'];
    const html = renderToStaticMarkup(<StubCard stub={stub} tag="Server" />);
    expect(html).toContain('>Server<');
    expect(html).toContain('which is offline');
    expect(html).toContain('aria-label="Open Wika on your server"');
    expect(html).not.toContain('Open folder');
    expect(html).not.toContain('access');
    expect(html).not.toContain('Repos');
  });
});
