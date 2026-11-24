/* eslint-disable @typescript-eslint/no-explicit-any -- one-off verify drivers: they read whatever JSON the live hub replies with */
/**
 * Live end-to-end proof: a real bot turn in a game room drives Toki's headless Blender, and the look-back image lands
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

async function main() {
  if (!process.env.POCKETROCKET_DATA || !DATA_DIR.startsWith(path.resolve(process.env.TEMP ?? '/tmp'))) throw new Error('POCKETROCKET_DATA must be under %TEMP%');
  if (blenderPids() !== 0) throw new Error('another blender.exe is running; refusing (one Blender at a time)');
  console.log('data dir: ' + DATA_DIR);
  const hub = createHub({ port: 0, token: TOKEN, seedBots: true });
  const port = await hub.listen();
  console.log('throwaway hub on 127.0.0.1:' + port);
  try {
    for (const r of (await request(port, 'GET', '/api/routines')).json ?? []) {
      if (r.enabled) await request(port, 'PATCH', '/api/routines/' + encodeURIComponent(r.id), { enabled: false });
    }
    const st = await request(port, 'PUT', '/api/settings', { onboarded: true, userName: 'Verifier', approvals: 'bypass', defaultModel: HAIKU });
    console.log('### PUT /api/settings -> ' + st.status + ' approvals=' + st.json?.approvals);

    const fix = await request(port, 'POST', '/api/game-tools/fix/install-blender-mcp', {});
    console.log('### install-blender-mcp -> ' + fix.status + ' ' + fix.json?.result);

    await request(port, 'POST', '/api/bots', { name: 'Lead Engineer', handle: 'lead-engineer', title: 'Leads the team', description: 'Splits the work and reviews it.', avatar: 'compass' });
    const shipDir = path.join(DATA_DIR, 'skills', 'safe-shipping');
    fs.mkdirSync(shipDir, { recursive: true });
    fs.writeFileSync(path.join(shipDir, 'SKILL.md'), ['---', 'name: safe-shipping', 'description: Never push the default branch.', '---', '', '# Safe shipping', ''].join('\n'));
    hub.repos.upsertSkill({ name: 'safe-shipping', description: 'Never push the default branch.', path: shipDir, source: 'authored', reviewStatus: 'approved', createdByBot: null });
    const proj = await request(port, 'POST', '/api/projects', { name: 'Cube Test', template: 'game' });
    if (proj.status !== 200) throw new Error('project create failed: ' + JSON.stringify(proj.json));
    console.log('### POST /api/projects -> ' + proj.status + ' kind=' + proj.json?.project?.kind + ' setup=' + JSON.stringify(proj.json?.setup));
    const slug: string = proj.json.project.slug;
    const roomId: string = proj.json.room?.id ?? proj.json.project.roomId;
    const artist = proj.json.bots.find((b: any) => /artist/.test(b.handle));
    for (const b of proj.json.bots) await request(port, 'PATCH', '/api/bots/' + b.id, { model: HAIKU });
    console.log('artist: @' + artist.handle);

    const text = '@' + artist.handle + ' Add one red cube to the Blender scene, take one look-back with the look tool, then save with toki_save(). Keep it short.';
    const sent = await request(port, 'POST', '/api/rooms/' + roomId + '/messages', { text });
    console.log('### POST message -> ' + sent.status);

    let peakBlender = 0;
    const t0 = Date.now();
    let msgs: any[] = [];
    while (Date.now() - t0 < 8 * 60_000) {
      await sleep(5000);
      peakBlender = Math.max(peakBlender, blenderPids());
      msgs = (await request(port, 'GET', '/api/rooms/' + roomId + '/messages?limit=200')).json ?? [];
      const busy = (await request(port, 'GET', '/api/busy')).json;
      const artistSpoke = msgs.some((m: any) => m.authorId === artist.id && m.kind === 'text' && m.text);
      if (artistSpoke && busy && busy.running === 0 && busy.pendingLanes === 0 && busy.waitingRuns === 0) break;
    }
    console.log('### turn finished after ' + Math.round((Date.now() - t0) / 1000) + ' s; blender.exe seen: ' + peakBlender);

    const withImg = msgs.filter((m: any) => Array.isArray(m.attachments) && m.attachments.some((a: string) => a.startsWith('img:')));
    console.log('### messages with a look-back attachment: ' + withImg.length);
    for (const m of withImg) console.log('  ' + (m.payload?.name ?? m.kind ?? '?') + ' -> ' + m.attachments.join(','));
    const leaked = msgs.filter((m: any) => JSON.stringify(m).includes('[Image: source:'));
    console.log('### messages containing "[Image: source:": ' + leaked.length);
    console.log('### tool calls by the artist: ' + msgs.filter((m: any) => m.payload?.name).map((m: any) => m.payload.name).join(', '));
    const last = msgs.filter((m: any) => m.authorId === artist.id && m.text).slice(-1)[0];
    console.log('### artist said: ' + String(last?.text ?? '').slice(0, 400));

    if (withImg[0]) {
      const ref: string = withImg[0].attachments.find((a: string) => a.startsWith('img:'));
      const sha = ref.slice(4);
      const media = (function find(dir: string): string | null {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) { const r = find(p); if (r) return r; } else if (e.name.startsWith(sha)) return p;
        }
        return null;
      })(DATA_DIR);
      console.log('### media file: ' + (media ? path.relative(DATA_DIR, media) + ' (' + fs.statSync(media).size + ' B)' : 'not found'));
      if (media) fs.copyFileSync(media, path.join(process.cwd(), '..', '..', 'docs', 'verify', 'e2e', 'lookback' + path.extname(media || '.png')));
    }

    const gt = (await request(port, 'GET', '/api/game-tools')).json;
    console.log('### blenderProcess while hub up: ' + JSON.stringify(gt.blenderProcess));
    const projDir = path.join(DATA_DIR, 'projects', slug);
    const art = path.join(projDir, 'art');
    console.log('### art/: ' + fs.readdirSync(art).map((f) => f + ' (' + fs.statSync(path.join(art, f)).size + ' B)').join(', '));
    console.log('### git status --short:\n' + execFileSync('git', ['-C', projDir, 'status', '--short'], { encoding: 'utf8' }));
  } finally {
    await hub.shutdown();
    await sleep(3000);
    console.log('### after hub.close(): blender.exe running = ' + blenderPids());
  }
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
