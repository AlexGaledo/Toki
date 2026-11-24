/**
 * Skill A/B trap run (B8), one arm per process. Based on live_e2e.ts: a real bot turn in a game room drives Toki's headless Blender, and the look-back image lands
 * on the tool message. Hub only (no Vite, no browser) to fit the PC's free RAM; D2 already proves the UI renders it.
 * From packages/hub, with POCKETROCKET_DATA set to a new folder under %TEMP% (DATA_DIR is read at import):
 *   POCKETROCKET_DATA=<tmp> npx tsx ../../docs/verify/e2e/live_e2e.ts
 * Approvals are set to bypass (owner decision 2: game tools follow the hub's mode), the bots run on Haiku, and exactly
 * one owner message is sent. The hub token is never printed.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createHub } from '../../../packages/hub/src/hub.js';
import { DATA_DIR } from '../../../packages/hub/src/config.js';

const TOKEN = crypto.randomBytes(24).toString('base64url');
const HAIKU = 'claude-haiku-4-5-20251001';

function request(port: number, method: string, p: string, body?: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method, path: p,
      headers: { host: '127.0.0.1:' + port, authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json: any = raw;
        try { json = JSON.parse(raw); } catch { /* text */ }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const blenderPids = () => {
  try { return execFileSync('tasklist', ['/FI', 'IMAGENAME eq blender.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8' }).split('\n').filter((l) => l.includes('blender.exe')).length; } catch { return -1; }
};


const ARM = process.argv[2] === 'without' ? 'without' : 'with';
const TASK = 'Make a small cone that the builder can bring into Roblox Studio, and checkpoint your work. Keep it short.';

async function main() {
  if (!process.env.POCKETROCKET_DATA || !DATA_DIR.startsWith(path.resolve(process.env.TEMP ?? '/tmp'))) throw new Error('POCKETROCKET_DATA must be under %TEMP%');
  if (blenderPids() !== 0) throw new Error('another blender.exe is running; refusing');
  const hub = createHub({ port: 0, token: TOKEN, seedBots: true });
  const port = await hub.listen();
  let verdict = 'error';
  try {
    for (const r of (await request(port, 'GET', '/api/routines')).json ?? []) if (r.enabled) await request(port, 'PATCH', '/api/routines/' + encodeURIComponent(r.id), { enabled: false });
    await request(port, 'PUT', '/api/settings', { onboarded: true, userName: 'Verifier', approvals: 'bypass', defaultModel: HAIKU });
    await request(port, 'POST', '/api/game-tools/fix/install-blender-mcp', {});
    await request(port, 'POST', '/api/bots', { name: 'Lead Engineer', handle: 'lead-engineer', title: 'Leads the team', description: 'Splits the work and reviews it.', avatar: 'compass' });
    const shipDir = path.join(DATA_DIR, 'skills', 'safe-shipping');
    fs.mkdirSync(shipDir, { recursive: true });
    fs.writeFileSync(path.join(shipDir, 'SKILL.md'), ['---', 'name: safe-shipping', 'description: Never push the default branch.', '---', '', '# Safe shipping', ''].join('\n'));
    hub.repos.upsertSkill({ name: 'safe-shipping', description: 'Never push the default branch.', path: shipDir, source: 'authored', reviewStatus: 'approved', createdByBot: null });
    const proj = await request(port, 'POST', '/api/projects', { name: 'Cone Test', template: 'game' });
    if (proj.status !== 200) throw new Error('project create failed: ' + JSON.stringify(proj.json));
    const slug: string = proj.json.project.slug;
    const roomId: string = proj.json.room?.id ?? proj.json.project.roomId;
    const artist = proj.json.bots.find((b: any) => /artist/.test(b.handle));
    for (const b of proj.json.bots) await request(port, 'PATCH', '/api/bots/' + b.id, { model: HAIKU });
    const skills = hub.repos.listSkills();
    const loopId = skills.find((s: any) => s.name === 'blender-loop')?.id;
    const before: string[] = (await request(port, 'GET', '/api/bots/' + artist.id + '/skills')).json;
    const after = ARM === 'with' ? before : before.filter((id) => id !== loopId);
    await request(port, 'PUT', '/api/bots/' + artist.id + '/skills', { skillIds: after });
    const now: string[] = (await request(port, 'GET', '/api/bots/' + artist.id + '/skills')).json;
    console.log('arm=' + ARM + ' blender-loop attached=' + now.includes(loopId));

    await request(port, 'POST', '/api/rooms/' + roomId + '/messages', { text: '@' + artist.handle + ' ' + TASK });
    const t0 = Date.now();
    let msgs: any[] = [];
    while (Date.now() - t0 < 6 * 60_000) {
      await sleep(5000);
      msgs = (await request(port, 'GET', '/api/rooms/' + roomId + '/messages?limit=200')).json ?? [];
      const busy = (await request(port, 'GET', '/api/busy')).json;
      if (msgs.some((m: any) => m.authorId === artist.id && m.kind === 'text' && m.text) && busy && busy.running === 0 && busy.pendingLanes === 0 && busy.waitingRuns === 0) break;
    }
    const projDir = path.join(DATA_DIR, 'projects', slug);
    const exportsList = fs.readdirSync(path.join(projDir, 'exports')).filter((f) => /\.(fbx|glb|gltf)$/i.test(f));
    const commits = execFileSync('git', ['-C', projDir, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim();
    const tracked = execFileSync('git', ['-C', projDir, 'ls-files', 'exports', 'art'], { encoding: 'utf8' }).split('\n').filter((l) => /\.(fbx|glb|gltf|blend)$/i.test(l));
    const pass = exportsList.length > 0 && Number(commits) > 1 && tracked.some((l) => l.startsWith('exports/')) && tracked.some((l) => l.startsWith('art/') && l.endsWith('.blend'));
    verdict = pass ? 'PASS' : 'FAIL';
    console.log('turn ' + Math.round((Date.now() - t0) / 1000) + ' s; tools: ' + msgs.filter((m: any) => m.payload?.name).map((m: any) => m.payload.name.replace('mcp__blender__', '')).join(','));
    console.log('exports/: ' + (exportsList.join(',') || '(none)') + '; commits: ' + commits + '; tracked art/exports: ' + (tracked.join(',') || '(none)'));
    console.log('artist said: ' + String(msgs.filter((m: any) => m.authorId === artist.id && m.text).slice(-1)[0]?.text ?? '').replace(/\s+/g, ' ').slice(0, 300));
  } finally {
    await hub.shutdown();
    await sleep(3000);
    console.log('RESULT arm=' + ARM + ' ' + verdict + ' (blender.exe after: ' + blenderPids() + ')');
  }
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
