/**
 * Phase 3 backend live proof (B10, B11, seed on demand): a throwaway hub on a random loopback port with a temp data dir.
 * From packages/hub, with POCKETROCKET_DATA set to a new folder under %TEMP% (DATA_DIR is read at import):
 *   POCKETROCKET_DATA=<tmp> npx tsx ../../docs/verify/phase3-backend/scripts/live_phase3.ts
 * The server's project list is a fixture: nothing is read from a real VPS. No bot turn runs, no Blender or Studio
 * starts. It never prints the hub token, the device token or the bot bearer.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import type { ServerEvent } from '../../../../packages/shared/src/index.js';
import { createHub } from '../../../../packages/hub/src/hub.js';
import { DATA_DIR } from '../../../../packages/hub/src/config.js';
import { events } from '../../../../packages/hub/src/events.js';

const TOKEN = crypto.randomBytes(24).toString('base64url');
// Fixture: what the desktop app would have read from the server hub's GET /api/projects through its tunnel.
const SERVER_FIXTURE = [
  { slug: 'obby-run', name: 'Obby Run' },
  { slug: 'fishing-sim', name: 'Fishing Sim' },
  { slug: 'kart-race', name: 'Kart Race' },
];

type Reply = { status: number; json: unknown };
function request(port: number, method: string, p: string, body?: unknown, token: string | null = TOKEN): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: '127.0.0.1:' + port, 'content-type': 'application/json' };
    if (token) headers.authorization = 'Bearer ' + token;
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json: unknown = raw;
        try { json = JSON.parse(raw); } catch { /* text */ }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
const show = (label: string, r: Reply) => console.log('### ' + label + ' -> HTTP ' + r.status + '\n' + JSON.stringify(r.json, null, 2) + '\n');
/** Local projects carry an absolute dir under the temp data dir; show it relative so the output has no user folder. */
const masked = (r: Reply): Reply => ({ ...r, json: JSON.parse(JSON.stringify(r.json).split(JSON.stringify(DATA_DIR).slice(1, -1)).join('<DATA>')) });

async function main() {
  console.log('data dir: a new folder under %TEMP% (' + (DATA_DIR.includes('Temp') ? 'yes' : 'NO') + ')');
  const seen: ServerEvent['type'][] = [];
  const off = events.onEvent((e) => { if (e.type === 'hosts.changed' || e.type === 'projects.changed') seen.push(e.type); });
  const hub = createHub({ port: 0, token: TOKEN, seedBots: true });
  const port = await hub.listen();
  console.log('throwaway hub on 127.0.0.1:' + port + ' (real startup, seedBots: true)\n');
  try {
    console.log('### bots after startup: ' + hub.repos.listBots().map((b) => '@' + b.handle).join(', ') + '\n');
    show('GET /api/usage, before any server is known (subscriptionNote only)', await request(port, 'GET', '/api/usage').then((r) => ({ ...r, json: { subscriptionNote: (r.json as { subscriptionNote?: string }).subscriptionNote ?? '(absent)' } })));

    show('POST /api/projects {"name":"PC Notes"} (a local project)', masked(await request(port, 'POST', '/api/projects', { name: 'PC Notes' })));
    show('PUT /api/hosts/server/projects {"connected":true,"projects":[3 fixture stubs]}', await request(port, 'PUT', '/api/hosts/server/projects', { connected: true, projects: SERVER_FIXTURE }));
    show('GET /api/projects', masked(await request(port, 'GET', '/api/projects')));

    show('PUT /api/hosts/server/projects {"connected":false} (tunnel dropped: stubs kept)', await request(port, 'PUT', '/api/hosts/server/projects', { connected: false }));
    const after = await request(port, 'GET', '/api/projects');
    show('GET /api/projects, server stubs only', { ...after, json: (after.json as { host: string }[]).filter((p) => p.host === 'server') });
    show('GET /api/usage, after (subscriptionNote only)', await request(port, 'GET', '/api/usage').then((r) => ({ ...r, json: { subscriptionNote: (r.json as { subscriptionNote?: string }).subscriptionNote ?? '(absent)' } })));

    // Refusals. Tokens are used, never printed.
    const minted = await request(port, 'POST', '/api/devices/pairing', {});
    const paired = await request(port, 'POST', '/api/devices/pair', { code: (minted.json as { code: string }).code, name: 'Verify phone' }, null);
    console.log('### paired a throwaway device -> HTTP ' + paired.status + ' (token not shown)\n');
    const device = (paired.json as { token: string }).token;
    show('PUT /api/hosts/server/projects with the paired device token', await request(port, 'PUT', '/api/hosts/server/projects', { connected: true, projects: [{ slug: 'from-phone', name: 'From Phone' }] }, device));
    show('GET /api/projects with the paired device token', await request(port, 'GET', '/api/projects', undefined, device));
    const bearer = hub.turns.registerTurn([]);
    show('PUT /api/hosts/server/projects with a bot\'s per-turn MCP bearer', await request(port, 'PUT', '/api/hosts/server/projects', { connected: true, projects: [{ slug: 'from-bot', name: 'From Bot' }] }, bearer));
    hub.turns.unregister(bearer);
    const many = Array.from({ length: 501 }, (_, i) => ({ slug: 'p-' + i, name: 'P ' + i }));
    show('PUT /api/hosts/server/projects with 501 stubs', await request(port, 'PUT', '/api/hosts/server/projects', { connected: true, projects: many }));
    show('PUT /api/hosts/server/projects with a bidi-override name', await request(port, 'PUT', '/api/hosts/server/projects', { connected: true, projects: [{ slug: 'x', name: 'evil‮gnp.exe' }] }));
    show('PUT /api/hosts/pc/projects (pc is this hub, not a remote host)', await request(port, 'PUT', '/api/hosts/pc/projects', { connected: true, projects: [] }));
    const final = await request(port, 'GET', '/api/projects');
    show('GET /api/projects after the refusals, server stubs only (unchanged)', { ...final, json: (final.json as { host: string; slug: string }[]).filter((p) => p.host === 'server').map((p) => p.slug) });

    const db = hub.repos.db;
    console.log('### SQLite');
    console.log('schema_version 331: ' + JSON.stringify(db.get("SELECT version, name FROM schema_version WHERE version=331")));
    console.log('remote_hosts: ' + JSON.stringify(db.all('SELECT host, connected FROM remote_hosts')));
    console.log('project_stubs: ' + JSON.stringify(db.all('SELECT host, slug, name FROM project_stubs ORDER BY slug')));
    console.log('projects (local): ' + JSON.stringify(db.all('SELECT slug, name FROM projects')));
    console.log('\n### events sent (hosts.changed / projects.changed, in order): ' + JSON.stringify(seen));
    console.log('### bots at the end: ' + hub.repos.listBots().map((b) => '@' + b.handle).join(', '));
  } finally {
    off();
    await hub.shutdown();
  }
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
