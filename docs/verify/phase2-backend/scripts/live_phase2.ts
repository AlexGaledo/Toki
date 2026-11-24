/**
 * Phase 2 backend live proof (B7, B8): a throwaway hub on a random loopback port with a temp data dir, on the owner's PC.
 * From packages/hub, with POCKETROCKET_DATA set to a new folder under %TEMP% (DATA_DIR is read at import):
 *   POCKETROCKET_DATA=<tmp> npx tsx ../../docs/verify/phase2-backend/scripts/live_phase2.ts
 * It runs the hub's real startup (built-in skills, seed bots), then creates a game project through POST /api/projects.
 * No bot turn runs (no quota), no Blender starts, Studio is not launched, and the owner's AssistantSettings are not
 * touched. It never prints the hub token.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { ServerEvent } from '../../../../packages/shared/src/index.js';
import { createHub } from '../../../../packages/hub/src/hub.js';
import { DATA_DIR } from '../../../../packages/hub/src/config.js';
import { events } from '../../../../packages/hub/src/events.js';

const TOKEN = crypto.randomBytes(24).toString('base64url');

function request(port: number, method: string, p: string, body?: unknown): Promise<{ status: number; json: unknown; ms: number }> {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method, path: p,
      headers: { host: '127.0.0.1:' + port, authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json: unknown = raw;
        try { json = JSON.parse(raw); } catch { /* text */ }
        resolve({ status: res.statusCode ?? 0, json, ms: Date.now() - t0 });
      });
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

/** Bot descriptions are long: show their first line and length so the reply stays readable. */
function trimBots(json: unknown): unknown {
  const j = json as { bots?: { description: string }[] };
  if (!j || !Array.isArray(j.bots)) return json;
  return { ...j, bots: j.bots.map((b) => ({ ...b, description: b.description.split('\n')[0] + ' [... ' + b.description.length + ' chars]' })) };
}
const show = (label: string, r: { status: number; json: unknown; ms: number }) =>
  console.log('### ' + label + ' -> HTTP ' + r.status + ' in ' + (r.ms / 1000).toFixed(2) + ' s\n' + JSON.stringify(trimBots(r.json), null, 2) + '\n');

function tree(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.name !== '.git').sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    out.push(prefix + e.name + (e.isDirectory() ? '/' : '  (' + fs.statSync(path.join(dir, e.name)).size + ' B)'));
    if (e.isDirectory()) out.push(...tree(path.join(dir, e.name), prefix + '  '));
  }
  return out;
}

async function main() {
  if (!process.env.POCKETROCKET_DATA || !DATA_DIR.startsWith(path.resolve(process.env.TEMP ?? process.env.TMP ?? '/tmp'))) {
    throw new Error('Set POCKETROCKET_DATA to a new folder under %TEMP% first (DATA_DIR is ' + DATA_DIR + ')');
  }
  console.log('data dir: ' + DATA_DIR);
  const seen: ServerEvent['type'][] = [];
  const off = events.onEvent((ev) => { if (ev.type === 'game-tools.changed' || ev.type === 'projects.changed') seen.push(ev.type); });
  // Real startup: ensureBuiltinSkills and the seed bots run as on the owner's hub.
  const hub = createHub({ port: 0, token: TOKEN, seedBots: true });
  const port = await hub.listen();
  console.log('throwaway hub on 127.0.0.1:' + port + '\n');
  try {
    const skills = hub.repos.listSkills().map((s) => s.name + ' (' + s.reviewStatus + ')');
    console.log('### skills in the pool after startup\n' + skills.join('\n') + '\n');
    console.log('### bots after startup\n' + hub.repos.listBots().map((b) => '@' + b.handle + ' - ' + b.title).join('\n') + '\n');

    // What the owner's hub already has and a fresh one does not: the lead source bot and the safe-shipping skill.
    show('POST /api/bots (the owner\'s @lead-engineer)', await request(port, 'POST', '/api/bots', {
      name: 'Lead Engineer', handle: 'lead-engineer', title: 'Leads the team', description: 'Splits the work and reviews it.', avatar: 'compass',
    }));
    const shipDir = path.join(DATA_DIR, 'skills', 'safe-shipping');
    fs.mkdirSync(shipDir, { recursive: true });
    fs.writeFileSync(path.join(shipDir, 'SKILL.md'), '---\nname: safe-shipping\ndescription: Never push the default branch.\n---\n\n# Safe shipping\n');
    hub.repos.upsertSkill({ name: 'safe-shipping', description: 'Never push the default branch.', path: shipDir, source: 'authored', reviewStatus: 'approved', createdByBot: null });

    const other = hub.repos.createRoom({ kind: 'group', name: 'Not a game', memberIds: [], coordinatorBotId: null });
    const made = await request(port, 'POST', '/api/projects', { name: 'Obby Run', template: 'game' });
    show('POST /api/projects {"name":"Obby Run","template":"game"}', made);
    const j = made.json as { project: { dir: string; slug: string }; room: { id: string } };
    show('POST /api/projects {"name":"Plain Notes","team":false} (control)', await request(port, 'POST', '/api/projects', { name: 'Plain Notes' }));

    console.log('### folder tree: ' + j.project.dir + '\n' + tree(j.project.dir).join('\n') + '\n');
    console.log('### .gitignore\n' + fs.readFileSync(path.join(j.project.dir, '.gitignore'), 'utf8'));
    console.log('### git log --stat\n' + execFileSync('git', ['log', '--stat', '--format=%h %an <%ae> %ad%n    %s'], { cwd: j.project.dir, encoding: 'utf8' }));
    console.log('### git status --short (empty = clean)\n' + execFileSync('git', ['status', '--short'], { cwd: j.project.dir, encoding: 'utf8' }) + '\n');

    const mcpFile = path.join(DATA_DIR, 'mcp-servers.json');
    console.log('### ' + mcpFile + '\n' + fs.readFileSync(mcpFile, 'utf8') + '\n');
    console.log('game room id:     ' + j.room.id + '\nother group room: ' + other.id + '\n');
    const rows = hub.repos.db.all("SELECT action, target, detail, actor_kind FROM audit_log WHERE action LIKE 'game_tools%' ORDER BY id");
    console.log('### audit rows\n' + JSON.stringify(rows, null, 2) + '\n');
    const kinds = hub.repos.db.all('SELECT slug, kind, template_version, room_id FROM projects ORDER BY slug');
    console.log('### projects table\n' + JSON.stringify(kinds, null, 2) + '\n');
    console.log('### events seen\n' + JSON.stringify(seen) + '\n');
    console.log('### TEMPLATE.md\n' + fs.readFileSync(path.join(j.project.dir, 'TEMPLATE.md'), 'utf8'));
  } finally {
    off();
    await hub.shutdown();
  }
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
