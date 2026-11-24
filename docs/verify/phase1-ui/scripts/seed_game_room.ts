/**
 * Seeds a throwaway hub for the D1/D5 screenshots without a bot turn (no Claude quota):
 *  1. marks one project `kind = 'game'` (B7's template is not built yet; no route sets it), and
 *  2. raises a real outside-tool card through the hub's own PermissionBroker.askOutsideMcp (B4's path), with a
 *     ~3 KB execute_luau input, so the payload is exactly what the hub emits, codeField included.
 * Run from packages/hub, against the RUNNING throwaway hub's data dir only (never 7788's):
 *   POCKETROCKET_DATA=<run>/data npx tsx ../../docs/verify/phase1-ui/scripts/seed_game_room.ts <slug> <roomId> <botId>
 */
import path from 'node:path';
import os from 'node:os';
import { Db } from '../../../../packages/hub/src/db/db.js';
import { Repos } from '../../../../packages/hub/src/db/repos.js';
import { ApprovalStore } from '../../../../packages/hub/src/db/approvalStore.js';
import { PermissionBroker } from '../../../../packages/hub/src/permissions/PermissionBroker.js';

const [slug, roomId, botId] = process.argv.slice(2);
const data = process.env.POCKETROCKET_DATA ?? '';
if (!slug || !roomId || !botId || !data) throw new Error('usage: POCKETROCKET_DATA=<dir> seed_game_room.ts <slug> <roomId> <botId>');
const rel = path.relative(os.tmpdir(), path.resolve(data));
if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('refusing a data dir outside the temp folder: ' + data);

const db = new Db(path.join(data, 'pocketrocket.db'));
const repos = new Repos(db);
db.run("UPDATE projects SET kind='game' WHERE slug=?", slug);
console.log('project', slug, 'kind =', db.get('SELECT kind FROM projects WHERE slug=?', slug)?.kind);

const bot = repos.getBot(botId);
const room = repos.getRoom(roomId);
if (!bot || !room) throw new Error('no such bot or room');

const lines = [
  '-- Build a checkpoint obby: 12 platforms, a spawn and a finish pad',
  'local Workspace = game:GetService("Workspace")',
  'local folder = Instance.new("Folder")',
  'folder.Name = "Obby"',
  'folder.Parent = Workspace',
  '',
];
for (let i = 1; i <= 12; i++) {
  lines.push(
    'do',
    '\tlocal p = Instance.new("Part")',
    '\tp.Name = "Platform' + i + '"',
    '\tp.Size = Vector3.new(8, 1, 8)',
    '\tp.Position = Vector3.new(' + i * 10 + ', ' + (4 + i * 2) + ', 0)',
    '\tp.Anchored = true',
    '\tp.BrickColor = BrickColor.new(' + (i % 2 ? '"Bright blue"' : '"Bright yellow"') + ')',
    '\tp.Parent = folder',
    'end',
  );
}
lines.push('', 'print("built", #folder:GetChildren(), "platforms") -- TAIL_LUAU_3K_OK');
const code = lines.join('\n');
console.log('code chars', code.length, 'lines', lines.length);

const broker = new PermissionBroker(repos, { store: new ApprovalStore(db), bypass: () => false, globalReadOnly: () => false });
const ctx = { bot, room, turnId: 'verify-d5', hop: 0, causeId: 'verify-d5', setState: () => undefined };
// The card is written before the broker waits for an answer; nothing here answers it, so it stays pending.
void broker.askOutsideMcp(ctx, 'roblox-studio', 'execute_luau', { code, studio_id: 'studio-1' }, new AbortController().signal);
const card = db.get("SELECT payload FROM messages WHERE room_id=? AND kind='approval' ORDER BY created_at DESC LIMIT 1", room.id);
const payload = JSON.parse(String(card?.payload ?? '{}'));
console.log('card toolName', payload.toolName, 'codeField', payload.codeField, 'input keys', Object.keys(payload.toolInput?.input ?? {}).join(','));
process.exit(0);
