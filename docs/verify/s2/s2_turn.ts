/* eslint-disable @typescript-eslint/no-explicit-any -- one-off verify drivers: they read whatever JSON the live hub replies with */
/**
 * S2 items 2-5 with Roblox Studio already open on a temp place: one real Haiku turn by the game room's builder under
 * `ask`, cards answered the way the web answers them (WebSocket `approval.decide` on /ws, the hub token as the web
 * sends it), then the Studio-open status and the setting fix refusing while Studio runs.
 * From packages/hub, with POCKETROCKET_DATA set to a new folder under %TEMP%:
 *   POCKETROCKET_DATA=<tmp> npx tsx ../../docs/verify/s2/s2_turn.ts
 * GameTools gets no env override, so it reads the real %LOCALAPPDATA%\Roblox. The hub token is never printed.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { createHub } from '../../../packages/hub/src/hub.js';
import { DATA_DIR } from '../../../packages/hub/src/config.js';

const TOKEN = crypto.randomBytes(24).toString('base64url');
const HAIKU = 'claude-haiku-4-5-20251001';
const OUT = path.resolve(process.cwd(), '..', '..', 'docs', 'verify', 's2');

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
const short = (s: unknown, n = 300) => String(s ?? '').replace(/\s+/g, ' ').slice(0, n);

async function main() {
  if (!process.env.POCKETROCKET_DATA || !DATA_DIR.startsWith(path.resolve(process.env.TEMP ?? '/tmp'))) throw new Error('POCKETROCKET_DATA must be under %TEMP%');
  console.log('data dir: ' + DATA_DIR);
  const hub = createHub({ port: 0, token: TOKEN, seedBots: true });
  const port = await hub.listen();
  console.log('throwaway hub on 127.0.0.1:' + port);
  let ws: WebSocket | null = null;
  try {
    for (const r of (await request(port, 'GET', '/api/routines')).json ?? []) {
      if (r.enabled) await request(port, 'PATCH', '/api/routines/' + encodeURIComponent(r.id), { enabled: false });
    }
    const st = await request(port, 'PUT', '/api/settings', { onboarded: true, userName: 'Verifier', approvals: 'ask', defaultModel: HAIKU });
    console.log('### PUT /api/settings -> ' + st.status + ' approvals=' + st.json?.approvals);

    const gt0 = await request(port, 'GET', '/api/game-tools');
    console.log('### GET /api/game-tools with Studio open -> ' + gt0.status);
    console.log(JSON.stringify(gt0.json?.studio, null, 2));

    await request(port, 'POST', '/api/bots', { name: 'Lead Engineer', handle: 'lead-engineer', title: 'Leads the team', description: 'Splits the work and reviews it.', avatar: 'compass' });
    const shipDir = path.join(DATA_DIR, 'skills', 'safe-shipping');
    fs.mkdirSync(shipDir, { recursive: true });
    fs.writeFileSync(path.join(shipDir, 'SKILL.md'), ['---', 'name: safe-shipping', 'description: Never push the default branch.', '---', '', '# Safe shipping', ''].join('\n'));
    hub.repos.upsertSkill({ name: 'safe-shipping', description: 'Never push the default branch.', path: shipDir, source: 'authored', reviewStatus: 'approved', createdByBot: null });
    const proj = await request(port, 'POST', '/api/projects', { name: 'Studio Test', template: 'game' });
    if (proj.status !== 200) throw new Error('project create failed: ' + JSON.stringify(proj.json));
    console.log('### POST /api/projects -> ' + proj.status + ' setup=' + JSON.stringify(proj.json?.setup));
    const roomId: string = proj.json.room?.id ?? proj.json.project.roomId;
    const builder = proj.json.bots.find((b: any) => /builder/.test(b.handle));
    if (!builder) throw new Error('no builder bot: ' + proj.json.bots.map((b: any) => b.handle).join(','));
    for (const b of proj.json.bots) await request(port, 'PATCH', '/api/bots/' + b.id, { model: HAIKU });
    console.log('builder: @' + builder.handle);
    const recipe = (await request(port, 'GET', '/api/mcp-servers')).json;
    const studioRecipe = (Array.isArray(recipe) ? recipe : recipe?.servers ?? []).find((s: any) => s.name === 'roblox-studio');
    console.log('### roblox-studio recipe: approve=' + studioRecipe?.approve + ' rooms=' + JSON.stringify(studioRecipe?.rooms) + ' readTools=' + JSON.stringify(studioRecipe?.readTools));

    // The web's own path for answering a card: the /ws socket, `approval.decide`.
    const cards: any[] = [];
    let alwaysGiven = false;
    ws = new WebSocket('ws://127.0.0.1:' + port + '/ws?token=' + encodeURIComponent(TOKEN));
    await new Promise<void>((resolve, reject) => { ws!.onopen = () => resolve(); ws!.onerror = () => reject(new Error('ws failed')); });
    ws.onmessage = (e) => {
      let ev: any;
      try { ev = JSON.parse(String(e.data)); } catch { return; }
      if (ev.type === 'error') console.log('### ws error: ' + short(ev.message) + ' context=' + ev.context);
      if (ev.type !== 'approval.request' || ev.roomId !== roomId) return;
      const a = ev.approval;
      const code = a.codeField ? a.toolInput?.[a.codeField] : undefined;
      const decision = !alwaysGiven && /execute_luau$/.test(a.toolName) ? 'always' : 'allow';
      if (decision === 'always') alwaysGiven = true;
      cards.push({ toolName: a.toolName, codeField: a.codeField ?? null, once: !!a.once, danger: a.danger, inputKeys: Object.keys(a.toolInput ?? {}), code: code ?? null, decision });
      console.log('### CARD ' + a.toolName + ' codeField=' + (a.codeField ?? '(none)') + ' once=' + !!a.once + ' inputKeys=' + JSON.stringify(Object.keys(a.toolInput ?? {})) + ' -> answering "' + decision + '"');
      if (code) console.log('    code (' + String(code).length + ' chars):\n' + String(code).split('\n').map((l) => '      | ' + l).join('\n'));
      ws!.send(JSON.stringify({ type: 'approval.decide', approvalId: a.approvalId, decision }));
    };

    const text = '@' + builder.handle + ' In Roblox Studio, step by step: 1) list_roblox_studios. 2) With execute_luau, create a red Part named TokiTest at position 0,5,0 in workspace. '
      + '3) With a second, separate execute_luau call, print workspace.TokiTest.Position and BrickColor. 4) inspect_instance on workspace.TokiTest. 5) screen_capture. 6) save_place. Keep the reply short.';
    const sent = await request(port, 'POST', '/api/rooms/' + roomId + '/messages', { text });
    console.log('### POST message -> ' + sent.status);

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
    console.log('### turn finished after ' + Math.round((Date.now() - t0) / 1000) + ' s');

    const tools = msgs.filter((m: any) => m.payload?.name);
    console.log('### tool calls, in order:');
    for (const m of tools) {
      console.log('  ' + m.payload.name + (m.attachments?.length ? '  attachments=' + m.attachments.join(',') : '') + '\n    input: ' + short(JSON.stringify(m.payload.input ?? m.payload.toolInput ?? ''), 400) + '\n    output: ' + short(m.payload.output ?? m.payload.result ?? m.text, 400));
    }
    const luau = tools.filter((m: any) => /execute_luau$/.test(m.payload.name)).length;
    const luauCards = cards.filter((c) => /execute_luau$/.test(c.toolName)).length;
    console.log('### execute_luau calls: ' + luau + '; execute_luau cards: ' + luauCards);
    console.log('### cards raised: ' + cards.length + ' -> ' + cards.map((c) => c.toolName + '=' + c.decision).join(', '));
    const approvals = hub.repos.db.all('SELECT tool_name, status FROM approvals WHERE room_id=? ORDER BY created_at', roomId);
    console.log('### approvals rows: ' + JSON.stringify(approvals));
    const audit = hub.repos.db.all("SELECT action, detail FROM audit_log WHERE action LIKE 'approval.%' ORDER BY id");
    console.log('### approval audit rows: ' + JSON.stringify(audit));
    const leaked = msgs.filter((m: any) => JSON.stringify(m).includes('[Image: source:'));
    console.log('### messages containing "[Image: source:": ' + leaked.length);
    const last = msgs.filter((m: any) => m.authorId === builder.id && m.kind === 'text' && m.text).slice(-1)[0];
    console.log('### builder said: ' + short(last?.text, 800));

    const withImg = tools.filter((m: any) => Array.isArray(m.attachments) && m.attachments.some((a: string) => a.startsWith('img:')));
    console.log('### tool messages with an img: attachment: ' + withImg.map((m: any) => m.payload.name).join(', '));
    if (withImg[0]) {
      const sha = withImg[0].attachments.find((a: string) => a.startsWith('img:')).slice(4);
      const media = (function find(dir: string): string | null {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) { const r = find(p); if (r) return r; } else if (e.name.startsWith(sha)) return p;
        }
        return null;
      })(DATA_DIR);
      console.log('### media file: ' + (media ? path.relative(DATA_DIR, media) + ' (' + fs.statSync(media).size + ' B)' : 'not found'));
      if (media) fs.copyFileSync(media, path.join(OUT, 'screen.png'));
    }
    fs.writeFileSync(path.join(OUT, 'cards.json'), JSON.stringify(cards, null, 2) + '\n');

    const gt1 = await request(port, 'GET', '/api/game-tools');
    console.log('### GET /api/game-tools after the turn -> ' + gt1.status + ' studio=' + JSON.stringify(gt1.json?.studio));
    const fix = await request(port, 'POST', '/api/game-tools/fix/studio-mcp-setting', {});
    console.log('### POST /api/game-tools/fix/studio-mcp-setting with Studio open -> ' + fix.status);
    console.log(JSON.stringify({ ok: fix.json?.ok, step: fix.json?.step, result: fix.json?.result, changed: fix.json?.changed }, null, 2));
  } finally {
    ws?.close();
    await hub.shutdown();
  }
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
