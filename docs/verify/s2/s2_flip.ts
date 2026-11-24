/**
 * S2 item 1: Toki's `studio-mcp-setting` step on the owner's REAL AssistantSettings file, with Studio closed.
 * The throwaway hub's GameTools gets no `env` override, so it reads `process.env.LOCALAPPDATA` (services/gameTools.ts
 * `robloxDir`), i.e. the real %LOCALAPPDATA%\Roblox. Everything else (DB, mcp-servers.json) is in the temp data dir.
 * From packages/hub:  POCKETROCKET_DATA=<new %TEMP% folder> npx tsx ../../docs/verify/s2/s2_flip.ts
 * The hub token is never printed.
 */
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { createHub } from '../../../packages/hub/src/hub.js';
import { DATA_DIR } from '../../../packages/hub/src/config.js';

const TOKEN = crypto.randomBytes(24).toString('base64url');

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

async function main() {
  if (!process.env.POCKETROCKET_DATA || !DATA_DIR.startsWith(path.resolve(process.env.TEMP ?? '/tmp'))) throw new Error('POCKETROCKET_DATA must be under %TEMP%');
  console.log('data dir: ' + DATA_DIR);
  console.log('LOCALAPPDATA the hub reads: ' + process.env.LOCALAPPDATA);
  const hub = createHub({ port: 0, token: TOKEN, seedBots: true });
  const port = await hub.listen();
  console.log('throwaway hub on 127.0.0.1:' + port);
  try {
    const before = await request(port, 'GET', '/api/game-tools');
    console.log('### GET /api/game-tools (before) -> ' + before.status + '\nstudio: ' + JSON.stringify(before.json?.studio));
    const fix = await request(port, 'POST', '/api/game-tools/fix/studio-mcp-setting', {});
    console.log('### POST /api/game-tools/fix/studio-mcp-setting -> ' + fix.status);
    console.log(JSON.stringify({ ok: fix.json?.ok, step: fix.json?.step, result: fix.json?.result, changed: fix.json?.changed, detail: fix.json?.detail, studio: fix.json?.status?.studio }, null, 2));
    const after = await request(port, 'GET', '/api/game-tools');
    console.log('### GET /api/game-tools (after) -> ' + after.status + '\nstudio: ' + JSON.stringify(after.json?.studio));
    const audit = hub.repos.db.all("SELECT action, target, detail FROM audit_log WHERE action LIKE 'game_tools.%' ORDER BY id");
    console.log('### audit rows: ' + JSON.stringify(audit));
  } finally {
    await hub.shutdown();
  }
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
