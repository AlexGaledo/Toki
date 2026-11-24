/**
 * Phase 1 backend live proof: a throwaway hub on a random loopback port with a temp data dir, on the owner's PC.
 * From packages/hub, with POCKETROCKET_DATA set to a new temp folder (DATA_DIR is read at import):
 *   POCKETROCKET_DATA=<tmp> npx tsx ../../docs/verify/phase1-backend/scripts/live_phase1.ts [--install]
 * It never prints the hub token. It never calls studio-mcp-setting (the owner's real AssistantSettings stay as they
 * are). --install runs install-uv and install-blender-mcp into the temp data dir.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { createHub } from '../../../../packages/hub/src/hub.js';
import { DATA_DIR } from '../../../../packages/hub/src/config.js';

const TOKEN = crypto.randomBytes(24).toString('base64url');
const install = process.argv.includes('--install');

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

const show = (label: string, r: { status: number; json: unknown; ms: number }) =>
  console.log('### ' + label + ' -> HTTP ' + r.status + ' in ' + (r.ms / 1000).toFixed(1) + ' s\n' + JSON.stringify(r.json, null, 2) + '\n');

async function main() {
  if (!process.env.POCKETROCKET_DATA || !DATA_DIR.startsWith(path.resolve(process.env.TEMP ?? process.env.TMP ?? '/tmp'))) {
    throw new Error('Set POCKETROCKET_DATA to a new folder under %TEMP% first (DATA_DIR is ' + DATA_DIR + ')');
  }
  console.log('data dir: ' + DATA_DIR);
  const hub = createHub({ port: 0, dbFile: path.join(DATA_DIR, 'hub.db'), token: TOKEN, skipBootstrap: true, seedBots: false });
  const port = await hub.listen();
  console.log('throwaway hub on 127.0.0.1:' + port + '\n');
  try {
    show('GET /api/game-tools', await request(port, 'GET', '/api/game-tools'));
    if (install) {
      show('POST /api/game-tools/fix/install-uv', await request(port, 'POST', '/api/game-tools/fix/install-uv', {}));
      show('POST /api/game-tools/fix/install-blender-mcp', await request(port, 'POST', '/api/game-tools/fix/install-blender-mcp', {}));
      const room = hub.repos.createRoom({ kind: 'group', name: 'Live Game', memberIds: [], coordinatorBotId: null });
      show('POST /api/game-tools/studio/setup', await request(port, 'POST', '/api/game-tools/studio/setup', { roomId: room.id }));
      show('POST /api/mcp-servers/roblox-studio/check', await request(port, 'POST', '/api/mcp-servers/roblox-studio/check', {}));
      show('GET /api/game-tools/blender/crash-log', await request(port, 'GET', '/api/game-tools/blender/crash-log'));
      show('GET /api/game-tools (after)', await request(port, 'GET', '/api/game-tools'));
      const audit = hub.repos.db.all("SELECT action, target, detail, actor_kind FROM audit_log WHERE action LIKE 'game_tools%' ORDER BY id");
      console.log('### audit rows\n' + JSON.stringify(audit, null, 2) + '\n');
      const mcpFile = path.join(DATA_DIR, 'mcp-servers.json');
      console.log('### ' + mcpFile + '\n' + fs.readFileSync(mcpFile, 'utf8'));
    }
  } finally {
    await hub.shutdown();
  }
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
