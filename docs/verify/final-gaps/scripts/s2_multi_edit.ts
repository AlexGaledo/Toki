/* eslint-disable @typescript-eslint/no-explicit-any -- one-off verify drivers: they read whatever JSON the live hub replies with */
/**
 * S2: a `multi_edit` card from a real Studio turn. Roblox Studio must already be open on a temp place. Like
 * `../../s2/s2_turn.ts`: a throwaway in-process hub on a random loopback port, a fresh data dir under %TEMP%,
 * approvals `ask`, ONE Haiku turn by the game room's builder. Cards are answered the way the web answers them
 * (WebSocket `approval.decide` on /ws). While a `multi_edit` card is open, a headless Chromium loads this hub's own
 * web (POCKETROCKET_WEB_DIST) and saves a screenshot and ARIA snapshot of the card, then the card is answered.
 * From packages/hub, with POCKETROCKET_DATA and POCKETROCKET_WEB_DIST set:
 *   npx tsx ../../docs/verify/final-gaps/scripts/s2_multi_edit.ts <evidence-dir>
 * The hub token is never printed.
 */
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { createHub } from '../../../../packages/hub/src/hub.js';
import { DATA_DIR, WEB_DIST } from '../../../../packages/hub/src/config.js';

const TOKEN = crypto.randomBytes(24).toString('base64url');
const HAIKU = 'claude-haiku-4-5-20251001';
const OUT = path.resolve(process.argv[2] ?? '.');
const REPO = path.resolve(process.cwd(), '..', '..');
const require = createRequire(path.join(REPO, 'package.json'));
const { chromium } = require(path.join(REPO, 'node_modules', '.pnpm', 'playwright-core@1.63.0-alph_366827a5428b9a0886a8dc7ca3b95a5e', 'node_modules', 'playwright-core'));

function request(port: number, method: string, p: string, body?: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method, path: p, agent: false,
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
const short = (s: unknown, n = 300) => String(s ?? '').replace(/\s+/g, ' ').slice(0, n);
const ts = () => new Date().toTimeString().slice(0, 8);
const log = (s: string) => console.log(ts() + ' ' + s);
const freeMb = () => Math.round(os.freemem() / 1048576);

async function main() {
  if (!process.env.POCKETROCKET_DATA || !DATA_DIR.startsWith(path.resolve(process.env.TEMP ?? '/tmp'))) throw new Error('POCKETROCKET_DATA must be under %TEMP%');
  if (!fs.existsSync(path.join(WEB_DIST, 'index.html'))) throw new Error('POCKETROCKET_WEB_DIST has no index.html');
  fs.mkdirSync(OUT, { recursive: true });
  log('data dir: ' + DATA_DIR + '; web dist: ' + WEB_DIST);
  const hub = createHub({ port: 0, token: TOKEN, seedBots: true });
  const port = await hub.listen();
  log('throwaway hub on 127.0.0.1:' + port);
  let ws: WebSocket | null = null;
  let browser: any = null;
  try {
    for (const r of (await request(port, 'GET', '/api/routines')).json ?? []) {
      if (r.enabled) await request(port, 'PATCH', '/api/routines/' + encodeURIComponent(r.id), { enabled: false });
    }
    const st = await request(port, 'PUT', '/api/settings', { onboarded: true, userName: 'Verifier', approvals: 'ask', defaultModel: HAIKU });
    log('PUT /api/settings -> ' + st.status + ' approvals=' + st.json?.approvals);
    const gt0 = await request(port, 'GET', '/api/game-tools');
    log('GET /api/game-tools studio=' + JSON.stringify(gt0.json?.studio));

    const proj = await request(port, 'POST', '/api/projects', { name: 'Studio Edit', template: 'game' });
    if (proj.status !== 200) throw new Error('project create failed: ' + JSON.stringify(proj.json));
    log('POST /api/projects -> ' + proj.status + ' setup=' + JSON.stringify(proj.json?.setup));
    const roomId: string = proj.json.room?.id ?? proj.json.project.roomId;
    const slug: string = proj.json.project?.slug ?? proj.json.project?.id;
    const builder = proj.json.bots.find((b: any) => /builder/.test(b.handle));
    if (!builder) throw new Error('no builder bot');
    for (const b of proj.json.bots) await request(port, 'PATCH', '/api/bots/' + b.id, { model: HAIKU });
    log('builder: @' + builder.handle + '; project slug: ' + slug);

    // The headless page: this hub's own web, signed in with the token in the fragment (the web strips it at once).
    let page: any = null;
    async function openPage() {
      if (page) return page;
      log('free RAM before Chromium: ' + freeMb() + ' MB');
      if (freeMb() < 1000) { log("skipping the browser capture: under 1000 MB free"); return null; }
      browser = await chromium.launch({ headless: true });
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      page = await ctx.newPage();
      await page.goto('http://127.0.0.1:' + port + '/?project=' + encodeURIComponent(slug) + '#token=' + TOKEN, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      log('page: ' + page.url().replace(/#.*/, '#<fragment>'));
      return page;
    }

    const cards: any[] = [];
    let n = 0;
    ws = new WebSocket('ws://127.0.0.1:' + port + '/ws?token=' + encodeURIComponent(TOKEN));
    await new Promise<void>((resolve, reject) => { ws!.onopen = () => resolve(); ws!.onerror = () => reject(new Error('ws failed')); });
    ws.onmessage = async (e) => {
      let ev: any;
      try { ev = JSON.parse(String(e.data)); } catch { return; }
      if (ev.type !== 'approval.request' || ev.roomId !== roomId) return;
      const a = ev.approval;
      const k = ++n;
      cards.push({ n: k, toolName: a.toolName, codeField: a.codeField ?? null, once: !!a.once, danger: a.danger ?? null, toolInput: a.toolInput, decision: 'allow' });
      log('CARD ' + k + ' ' + a.toolName + ' codeField=' + (a.codeField ?? '(none)') + ' inputKeys=' + JSON.stringify(Object.keys(a.toolInput ?? {})));
      log('  toolInput: ' + JSON.stringify(a.toolInput));
      if (/multi_edit$/.test(a.toolName)) {
        try {
          const p = await openPage();
          if (p) {
            const label = 'edits for multi_edit';
            const region = p.getByRole('region', { name: label }).last();
            await region.waitFor({ timeout: 45_000 });
            await region.scrollIntoViewIfNeeded();
            await p.waitForTimeout(500);
            const code = await region.innerText();
            log('  rendered code region "' + label + '":\n' + code.split('\n').map((l: string) => '      | ' + l).join('\n'));
            const card = region.locator('xpath=ancestor::*[.//button[normalize-space()="Allow once"]][1]');
            const aria = await card.ariaSnapshot();
            fs.writeFileSync(path.join(OUT, 's2-multi-edit-card' + k + '.aria.yml'), '# throwaway hub 127.0.0.1:' + port + ', card ' + k + ' (' + a.toolName + '), ' + new Date().toISOString() + '\n' + aria + '\n');
            await card.screenshot({ path: path.join(OUT, 's2-multi-edit-card' + k + '.png') });
            await p.screenshot({ path: path.join(OUT, 's2-multi-edit-card' + k + '-page.png') });
            log('  saved s2-multi-edit-card' + k + '.png, -page.png and .aria.yml');
          }
        } catch (err) {
          log('  browser capture failed: ' + short((err as Error).message, 400));
        }
      }
      log('  -> approval.decide "allow" for card ' + k);
      ws!.send(JSON.stringify({ type: 'approval.decide', approvalId: a.approvalId, decision: 'allow' }));
    };

    const text = '@' + builder.handle + ' In Roblox Studio, step by step, nothing else: '
      + '1) list_roblox_studios. '
      + '2) With multi_edit, create a new Script at game.ServerScriptService.TokiEdit (className "Script", datamodel_type "Edit") whose content is exactly the one line: print("toki one") '
      + '3) With a second, separate multi_edit call on game.ServerScriptService.TokiEdit, change that line: old_string print("toki one") new_string print("toki two"). '
      + '4) script_read game.ServerScriptService.TokiEdit. Keep the reply to one line.';
    const sent = await request(port, 'POST', '/api/rooms/' + roomId + '/messages', { text });
    log('POST message -> ' + sent.status);

    const t0 = Date.now();
    let msgs: any[] = [];
    while (Date.now() - t0 < 8 * 60_000) {
      await sleep(4000);
      const j = (await request(port, 'GET', '/api/rooms/' + roomId + '/messages?limit=300')).json;
      msgs = Array.isArray(j) ? j : [];
      const busy = (await request(port, 'GET', '/api/busy')).json;
      const spoke = msgs.some((m: any) => m.authorId === builder.id && m.kind === 'text' && m.text);
      if (spoke && busy && busy.running === 0 && busy.pendingLanes === 0 && busy.waitingRuns === 0) break;
    }
    log('turn finished after ' + Math.round((Date.now() - t0) / 1000) + ' s');
    const tools = msgs.filter((m: any) => m.payload?.name);
    log('tool calls, in order:');
    for (const m of tools) {
      console.log('  ' + m.payload.name + '\n    input: ' + short(JSON.stringify(m.payload.input ?? m.payload.toolInput ?? ''), 600) + '\n    output: ' + short(m.payload.output ?? m.payload.result ?? m.text, 400));
    }
    log('cards raised: ' + cards.length + ' -> ' + cards.map((c) => c.toolName + '=' + c.decision).join(', '));
    const approvals = hub.repos.db.all('SELECT tool_name, status FROM approvals WHERE room_id=? ORDER BY created_at', roomId);
    log('approvals rows: ' + JSON.stringify(approvals));
    const last = msgs.filter((m: any) => m.authorId === builder.id && m.kind === 'text' && m.text).slice(-1)[0];
    log('builder said: ' + short(last?.text, 600));
    fs.writeFileSync(path.join(OUT, 's2-multi-edit-cards.json'), JSON.stringify(cards, null, 2) + '\n');
  } finally {
    ws?.close();
    if (browser) await browser.close().catch(() => {});
    await hub.shutdown();
  }
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
