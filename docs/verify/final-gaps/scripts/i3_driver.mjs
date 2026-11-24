// I3 live: a PC bot turn kept running through a loss of the server link, on the owner's installed Toki.
// Toki must run with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9339 --remote-debugging-address=127.0.0.1
// and its window must be on the PC hub (127.0.0.1:7788).
//   node docs/verify/final-gaps/scripts/i3_driver.mjs probe   read-only: window URL, PC hub settings, counts
//   node docs/verify/final-gaps/scripts/i3_driver.mjs run     the test (one Haiku turn), then deletes its bot and DM
// Safety: the PC token is read only from the 127.0.0.1:7788 origin's sessionStorage and is never printed. Every hub call
// goes through `pc()`, Node http with the port fixed to 7788 and checked, never a page-relative fetch, so nothing can
// land on the server hub when the window is on 7790. Every write is logged with its target.
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import url from 'node:url';

const REPO = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const require = createRequire(path.join(REPO, 'package.json'));
const { chromium } = require(path.join(REPO, 'node_modules', '.pnpm', 'playwright-core@1.63.0-alph_366827a5428b9a0886a8dc7ca3b95a5e', 'node_modules', 'playwright-core'));

const PC_PORT = 7788;
const HAIKU = 'claude-haiku-4-5-20251001';
const HANDLE = 'i3-temp-counter';
const t0 = Date.now();
const ts = () => new Date().toISOString().slice(11, 23);
const log = (s) => console.log(ts() + ' ' + s);
const msOf = (v) => { const n = Number(v); return n < 1e12 ? n * 1000 : n; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cut = (u) => String(u).replace(/#.*/, '#<fragment>');
const writes = [];

let TOKEN = '';
function pc(method, p, body) {
  const port = PC_PORT;
  if (port !== 7788) throw new Error('refusing: not the PC hub');
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, agent: false, headers: { host: '127.0.0.1:' + port, authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = raw; try { json = JSON.parse(raw); } catch { /* text */ }
        if (method !== 'GET') { writes.push(method + ' http://127.0.0.1:' + port + p + ' -> ' + res.statusCode); log('WRITE ' + method + ' 127.0.0.1:' + port + p + ' -> ' + res.statusCode); }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

function tunnelSsh() {
  const ps = "Get-CimInstance Win32_Process -Filter \"Name='ssh.exe'\" | Where-Object { $_.CommandLine -like '*127.0.0.1:7790:*' -and (Get-Process -Id $_.ParentProcessId -ErrorAction SilentlyContinue).ProcessName -eq 'PocketRocket' } | ForEach-Object { $_.ProcessId }";
  return execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).split(/\s+/).filter(Boolean).map(Number);
}
function listeners(port) {
  const ps = 'Get-NetTCPConnection -State Listen -LocalPort ' + port + ' -ErrorAction SilentlyContinue | ForEach-Object { $_.LocalAddress + ":" + $_.LocalPort + " pid=" + $_.OwningProcess }';
  try { return execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim() || '(none)'; } catch { return '(none)'; }
}

async function page() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9339');
  const pages = browser.contexts().flatMap((c) => c.pages());
  const p = pages.find((x) => /^http:\/\/127\.0\.0\.1:(7788|7790)\//.test(x.url())) ?? pages[0];
  if (!p) throw new Error('no page');
  return { browser, p };
}

async function readPcToken(p) {
  if (!p.url().startsWith('http://127.0.0.1:7788/')) throw new Error('window is not on the PC hub: ' + cut(p.url()));
  const tok = await p.evaluate(() => sessionStorage.getItem('pocketrocket.token'));
  if (!/^[0-9a-f]{32}$/.test(tok ?? '')) throw new Error('no 32-hex token in the PC page');
  TOKEN = tok;
  const me = await pc('GET', '/api/settings');
  if (me.status !== 200) throw new Error('PC hub refused the token: ' + me.status);
  return me.json;
}

async function probe() {
  const { browser, p } = await page();
  log('window: ' + cut(p.url()));
  const s = await readPcToken(p);
  log('PC hub token: read from the 7788 page (32 hex, not printed)');
  log('PC hub settings: approvals=' + s.approvals + ' defaultModel=' + s.defaultModel + ' onboarded=' + s.onboarded);
  const bots = (await pc('GET', '/api/bots')).json, rooms = (await pc('GET', '/api/rooms')).json;
  log('PC hub bots=' + bots.length + ' rooms=' + rooms.length + ' handle ' + HANDLE + ' exists=' + bots.some((b) => b.handle === HANDLE));
  log('busy: ' + JSON.stringify((await pc('GET', '/api/busy')).json));
  log('tunnel ssh: ' + JSON.stringify(tunnelSsh()) + '; 7790 listeners: ' + listeners(7790));
  /* no browser.close(): this is the owner's app; exiting drops the CDP link */
}

async function run() {
  const { browser, p } = await page();
  log('# I3: a PC bot turn through a loss of the server link');
  log('window before: ' + cut(p.url()));
  const s = await readPcToken(p);
  log('PC hub token read from the 7788 page only (never printed). approvals=' + s.approvals);
  const bots0 = (await pc('GET', '/api/bots')).json, rooms0 = (await pc('GET', '/api/rooms')).json;
  log('PC hub before: bots=' + bots0.length + ' rooms=' + rooms0.length);
  if (bots0.some((b) => b.handle === HANDLE)) throw new Error('temp handle already exists');

  let bot = null, dm = null, ws = null;
  try {
    const b = await pc('POST', '/api/bots', { name: 'I3 Temp Counter', handle: HANDLE, title: 'Temporary', description: 'Temporary bot for a loss test. Deleted after.', model: HAIKU, maxBudgetUsd: 0.5, autoMemory: false });
    if (b.status !== 200) throw new Error('bot create: ' + JSON.stringify(b.json));
    bot = b.json;
    log('temp bot @' + bot.handle + ' model=' + bot.model);
    const r = await pc('POST', '/api/rooms', { kind: 'dm', name: 'I3 Temp Counter', memberIds: [bot.id] });
    if (r.status !== 200) throw new Error('dm create: ' + JSON.stringify(r.json));
    dm = r.json;

    // Cards in this DM only are answered as the web answers them: /ws on 7788, approval.decide.
    ws = new WebSocket('ws://127.0.0.1:' + PC_PORT + '/ws?token=' + encodeURIComponent(TOKEN));
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws')); });
    ws.onmessage = (e) => {
      let ev; try { ev = JSON.parse(String(e.data)); } catch { return; }
      if (ev.type !== 'approval.request' || ev.roomId !== dm.id) return;
      log('card on 7788: ' + ev.approval.toolName + ' -> allow (ws approval.decide to 127.0.0.1:7788)');
      writes.push('WS approval.decide ws://127.0.0.1:7788/ws ' + ev.approval.toolName);
      ws.send(JSON.stringify({ type: 'approval.decide', approvalId: ev.approval.approvalId, decision: 'allow' }));
    };

    // Open the server the way the tray's Open your server does (both call server::connect(Open::Home)).
    await p.evaluate(() => { window.open('/?openhost=server'); });
    const tOpen = Date.now();
    while (!p.url().startsWith('http://127.0.0.1:7790/') && Date.now() - tOpen < 60_000) await sleep(250);
    log('window on the server after ' + ((Date.now() - tOpen) / 1000).toFixed(1) + ' s: ' + cut(p.url()));
    if (!p.url().startsWith('http://127.0.0.1:7790/')) throw new Error('window did not reach the server');
    const pids = tunnelSsh();
    log('tunnel ssh pids: ' + JSON.stringify(pids) + '; 7790 listeners: ' + listeners(7790));
    if (pids.length !== 1) throw new Error('expected one tunnel ssh');

    const text = 'Count slowly from 1 to 20. Use one Bash command with sleep 2 between numbers, for example: for i in $(seq 1 20); do echo $i; sleep 2; done. Then reply with only the last number.';
    const sent = await pc('POST', '/api/rooms/' + dm.id + '/messages', { text });
    const tSent = Date.now();
    log('message sent to the DM on 7788 -> ' + sent.status);

    // Wait until Bash is running, then a few seconds into it.
    let tBash = 0;
    while (Date.now() - tSent < 90_000) {
      await sleep(1000);
      const msgs = (await pc('GET', '/api/rooms/' + dm.id + '/messages?limit=100')).json;
      if (Array.isArray(msgs) && msgs.some((m) => m.payload?.name === 'Bash')) { tBash = Date.now(); break; }
    }
    if (!tBash) throw new Error('Bash never started');
    log('Bash tool message seen ' + ((tBash - tSent) / 1000).toFixed(1) + ' s after send');
    await sleep(6000);
    const busyBefore = (await pc('GET', '/api/busy')).json;
    log('busy just before the kill: ' + JSON.stringify(busyBefore));
    execFileSync('taskkill', ['/PID', String(pids[0]), '/F'], { encoding: 'utf8' });
    const tKill = Date.now();
    log('KILLED the tunnel ssh pid ' + pids[0] + ' (the VPS hub was not touched)');

    while (!p.url().startsWith('http://127.0.0.1:7788/') && Date.now() - tKill < 60_000) await sleep(250);
    log('window back on the PC after ' + ((Date.now() - tKill) / 1000).toFixed(1) + ' s: ' + cut(p.url()));
    log('7790 listeners now: ' + listeners(7790));
    const busyAfter = (await pc('GET', '/api/busy')).json;
    log('busy right after the fallback: ' + JSON.stringify(busyAfter));

    let msgs = [];
    let replied = false;
    while (Date.now() - tKill < 180_000) {
      await sleep(2000);
      msgs = (await pc('GET', '/api/rooms/' + dm.id + '/messages?limit=100')).json;
      const busy = (await pc('GET', '/api/busy')).json;
      replied = msgs.some((m) => m.authorId === bot.id && m.kind === 'text' && m.text && msOf(m.createdAt) > tKill);
      if (replied && busy.running === 0 && busy.pendingLanes === 0) break;
    }
    const tDone = Date.now();
    log('turn finished ' + ((tDone - tKill) / 1000).toFixed(1) + ' s after the kill; ' + ((tDone - tSent) / 1000).toFixed(1) + ' s after send');
    log('## the DM on 7788, in order (times relative to the kill)');
    for (const m of msgs) {
      const rel = ((msOf(m.createdAt) - tKill) / 1000).toFixed(1);
      const who = m.authorId === bot.id ? '@' + HANDLE : m.authorId ?? 'owner';
      if (m.payload?.name) log('  [' + rel + ' s] tool ' + m.payload.name + ' input=' + JSON.stringify(m.payload.input ?? '').slice(0, 160) + ' output=' + JSON.stringify(String(m.payload.output ?? '')).slice(0, 200) + ' status=' + (m.payload.status ?? ''));
      else log('  [' + rel + ' s] ' + m.kind + ' ' + who + ': ' + String(m.text ?? '').replace(/\s+/g, ' ').slice(0, 200));
    }
    log('RESULT: ' + (replied ? 'the turn finished on the PC hub after the loss' : 'NO REPLY after the loss'));
  } finally {
    try { ws?.close(); } catch { /* closed */ }
    if (dm) await pc('DELETE', '/api/rooms/' + dm.id);
    if (bot) await pc('DELETE', '/api/bots/' + bot.id);
    const bots1 = (await pc('GET', '/api/bots')).json, rooms1 = (await pc('GET', '/api/rooms')).json;
    log('PC hub after cleanup: bots=' + bots1.length + ' rooms=' + rooms1.length + ' handle exists=' + bots1.some((b) => b.handle === HANDLE));
    log('## every write this run made (' + writes.length + '):');
    for (const w of writes) log('  ' + w);
    log('writes not to 127.0.0.1:7788: ' + writes.filter((w) => !w.includes('127.0.0.1:7788')).length);
    log('window at the end: ' + cut(p.url()) + '; elapsed ' + ((Date.now() - t0) / 1000).toFixed(0) + ' s');
    /* no browser.close(): this is the owner's app; exiting drops the CDP link */
  }
}

const cmd = process.argv[2];
(cmd === 'run' ? run() : probe()).then(() => process.exit(0), (e) => { console.error(ts() + ' ERROR ' + (e?.message ?? e)); process.exit(1); });
