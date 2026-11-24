/**
 * Live status events + non-game room check. Based on live_e2e.ts: a real bot turn in a game room drives Toki's headless Blender, and the look-back image lands
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
import { events } from '../../../packages/hub/src/events.js';

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



async function waitIdle(port: number, roomId: string, botId: string, maxMs: number) {
  const t0 = Date.now();
  let msgs: any[] = [];
  while (Date.now() - t0 < maxMs) {
    await sleep(4000);
    { const j = (await request(port, 'GET', '/api/rooms/' + roomId + '/messages?limit=200')).json; msgs = Array.isArray(j) ? j : []; }
    const busy = (await request(port, 'GET', '/api/busy')).json;
    if (msgs.some((m: any) => m.authorId === botId && m.kind === 'text' && m.text) && busy && busy.running === 0 && busy.pendingLanes === 0 && busy.waitingRuns === 0) break;
  }
  return msgs;
}

async function main() {
  if (!process.env.POCKETROCKET_DATA || !DATA_DIR.startsWith(path.resolve(process.env.TEMP ?? '/tmp'))) throw new Error('POCKETROCKET_DATA must be under %TEMP%');
  if (blenderPids() !== 0) throw new Error('another blender.exe is running; refusing');
  const seen: { t: number; type: string; state?: string }[] = [];
  const hub = createHub({ port: 0, token: TOKEN, seedBots: true });
  const port = await hub.listen();
  const t0 = Date.now();
  let gt: any = null;
  const off = events.onEvent((ev: any) => { if (ev.type === 'game-tools.changed') seen.push({ t: Math.round((Date.now() - t0) / 1000), type: ev.type }); });
  try {
    for (const r of (await request(port, 'GET', '/api/routines')).json ?? []) if (r.enabled) await request(port, 'PATCH', '/api/routines/' + encodeURIComponent(r.id), { enabled: false });
    await request(port, 'PUT', '/api/settings', { onboarded: true, userName: 'Verifier', approvals: 'bypass', defaultModel: HAIKU });
    await request(port, 'POST', '/api/game-tools/fix/install-blender-mcp', {});
    await request(port, 'POST', '/api/bots', { name: 'Lead Engineer', handle: 'lead-engineer', title: 'Leads the team', description: 'Splits the work and reviews it.', avatar: 'compass' });
    const shipDir = path.join(DATA_DIR, 'skills', 'safe-shipping');
    fs.mkdirSync(shipDir, { recursive: true });
    fs.writeFileSync(path.join(shipDir, 'SKILL.md'), ['---', 'name: safe-shipping', 'description: Never push the default branch.', '---', '', '# Safe shipping', ''].join('\n'));
    hub.repos.upsertSkill({ name: 'safe-shipping', description: 'Never push the default branch.', path: shipDir, source: 'authored', reviewStatus: 'approved', createdByBot: null });
    const proj = await request(port, 'POST', '/api/projects', { name: 'Strip Test', template: 'game' });
    if (proj.status !== 200) throw new Error('project create failed: ' + JSON.stringify(proj.json));
    const roomId: string = proj.json.room?.id ?? proj.json.project.roomId;
    const artist = proj.json.bots.find((b: any) => /artist/.test(b.handle));
    for (const b of proj.json.bots) await request(port, 'PATCH', '/api/bots/' + b.id, { model: HAIKU });
    const mark = seen.length;
    console.log('### game-tools.changed events before any turn: ' + mark + ' (install + project setup)');

    // 1) A non-game room: a DM with the same artist bot. It must get no blender tools, and no Blender may start.
    const dm = await request(port, 'POST', '/api/rooms', { kind: 'dm', name: 'Artist DM', memberIds: [artist.id] });
    const dmId = dm.json.id; if (!dmId) throw new Error('DM create failed: ' + JSON.stringify(dm.json));
    await request(port, 'POST', '/api/rooms/' + dmId + '/messages', { text: 'Call the tool mcp__blender__get_scene_info now. If you do not have a tool by that name, reply exactly: NO BLENDER TOOLS.' });
    const dmMsgs = await waitIdle(port, dmId, artist.id, 3 * 60_000);
    const dmTools = dmMsgs.filter((m: any) => m.payload?.name).map((m: any) => m.payload.name);
    console.log('### DM (non-game room): tool calls = [' + dmTools.join(', ') + ']; blender.exe running = ' + blenderPids());
    console.log('### DM reply: ' + String(dmMsgs.filter((m: any) => m.authorId === artist.id && m.text).slice(-1)[0]?.text ?? '').replace(/\s+/g, ' ').slice(0, 200));
    gt = (await request(port, 'GET', '/api/game-tools')).json;
    console.log('### blenderProcess after the DM turn: state=' + gt.blenderProcess.state + ' project=' + gt.blenderProcess.project);
    console.log('### game-tools.changed events during the DM turn: ' + (seen.length - mark));

    // 2) The game room: Blender starts on the first call; the strip's event fires on start/ready and on stop.
    const m2 = seen.length;
    await request(port, 'POST', '/api/rooms/' + roomId + '/messages', { text: '@' + artist.handle + ' Call get_scene_info once and tell me how many objects there are. Nothing else.' });
    const gMsgs = await waitIdle(port, roomId, artist.id, 4 * 60_000);
    gt = (await request(port, 'GET', '/api/game-tools')).json;
    console.log('### game room: tool calls = [' + gMsgs.filter((m: any) => m.payload?.name).map((m: any) => m.payload.name).join(', ') + ']');
    console.log('### blenderProcess after the game turn: state=' + gt.blenderProcess.state + ' project=' + gt.blenderProcess.project);
    console.log('### game-tools.changed events while Blender started: ' + (seen.length - m2) + ' at s=' + seen.slice(m2).map((e) => e.t).join(','));
    const m3 = seen.length;
    await hub.shutdown();
    await sleep(3000);
    console.log('### game-tools.changed events on stop: ' + (seen.length - m3) + '; blender.exe running = ' + blenderPids());
  } finally {
    off();
  }
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
