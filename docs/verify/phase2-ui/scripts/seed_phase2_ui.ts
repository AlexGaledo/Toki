/**
 * Seeds the RUNNING throwaway verify-toki hub for the D2 and follow-up (c) evidence without a bot turn (no Claude quota).
 *
 * 1. A look-back, written the way BotRunner writes one (B9): a `mcp__blender__look` tool message is inserted running,
 *    then patched done with `attachments: [ref]`, where `ref` comes from the hub's own `storeLookBack` on the PNG the
 *    spike's headless Blender rendered (docs/verify/game-tools-spike/f2-look-camera-rendered.png). A `get_scene_info`
 *    step and the bot's reply are in the same turn. This process cannot send the hub's WS events, so the page shows
 *    the message from history; the live `message.update` path is covered by packages/web/src/store.lookBack.test.ts.
 * 2. An outside-tool approval card through the hub's own PermissionBroker.askOutsideMcp (B4), as phase1-ui did, with an
 *    `execute_luau` input whose `code` starts with a comment line. Nothing answers it, so it stays pending.
 *
 * Run from packages/hub, against the throwaway hub's data dir only (never 7788's):
 *   POCKETROCKET_DATA=<run>/data npx tsx ../../docs/verify/phase2-ui/scripts/seed_phase2_ui.ts <roomId> <artistBotId> <builderBotId>
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Db } from '../../../../packages/hub/src/db/db.js';
import { Repos } from '../../../../packages/hub/src/db/repos.js';
import { ApprovalStore } from '../../../../packages/hub/src/db/approvalStore.js';
import { PermissionBroker } from '../../../../packages/hub/src/permissions/PermissionBroker.js';
import { MediaStore } from '../../../../packages/hub/src/services/MediaStore.js';
import { storeLookBack } from '../../../../packages/hub/src/agent/lookBacks.js';
import type { ToolPayload } from '../../../../packages/shared/src/index.js';

const [roomId, artistId, builderId] = process.argv.slice(2);
const data = process.env.POCKETROCKET_DATA ?? '';
if (!roomId || !artistId || !builderId || !data) throw new Error('usage: POCKETROCKET_DATA=<dir> seed_phase2_ui.ts <roomId> <artistBotId> <builderBotId>');
const rel = path.relative(os.tmpdir(), path.resolve(data));
if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('refusing a data dir outside the temp folder: ' + data);

const db = new Db(path.join(data, 'pocketrocket.db'));
const repos = new Repos(db);
const room = repos.getRoom(roomId);
const artist = repos.getBot(artistId);
const builder = repos.getBot(builderId);
if (!room || !artist || !builder) throw new Error('no such room or bot');

// 1. The look-back.
const png = fs.readFileSync(path.resolve('../../docs/verify/game-tools-spike/f2-look-camera-rendered.png'));
const ref = storeLookBack(new MediaStore(path.join(data, 'media')), { mediaType: 'image/png', data: png.toString('base64') });
if (!ref) throw new Error('storeLookBack refused the picture');
const turnId = 'verify-d2';
const base = { roomId, authorType: 'bot' as const, authorId: artist.id, causeId: null, hop: 0, turnId };
const scene: ToolPayload = { toolUseId: 'v-scene', name: 'mcp__blender__get_scene_info', input: {}, output: 'Scene: 1 camera, 1 light, 1 mesh (Cube).', done: true };
repos.insertMessage({ ...base, kind: 'tool', text: '', payload: scene });
const look: ToolPayload = { toolUseId: 'v-look', name: 'mcp__blender__look', input: { view: 'camera', shading: 'rendered' }, done: false };
const msg = repos.insertMessage({ ...base, kind: 'tool', text: '', payload: look });
// BotRunner.onToolResult's patch for a game tool's picture: the CLI path is already gone from the text.
repos.updateMessage(msg.id, { payload: { ...look, output: 'Rendered the camera view with EEVEE (512x512).', done: true }, attachments: [ref] });
repos.insertMessage({ ...base, kind: 'text', text: 'The cube is in, lit from the left. Here is the camera view.', payload: null });
console.log('look-back', ref, 'on tool message', msg.id, '(' + png.length + ' bytes)');

// 2. The outside-tool approval card.
const code = [
  '-- Add a finish pad at the end of the obby',
  'local pad = Instance.new("Part")',
  'pad.Name = "FinishPad"',
  'pad.Size = Vector3.new(10, 1, 10)',
  'pad.Position = Vector3.new(130, 30, 0)',
  'pad.Anchored = true',
  'pad.BrickColor = BrickColor.new("Lime green")',
  'pad.Parent = workspace',
  'print("finish pad added")',
].join('\n');
const broker = new PermissionBroker(repos, { store: new ApprovalStore(db), bypass: () => false, globalReadOnly: () => false });
const ctx = { bot: builder, room, turnId: 'verify-c', hop: 0, causeId: 'verify-c', setState: () => undefined };
void broker.askOutsideMcp(ctx, 'roblox-studio', 'execute_luau', { code, studio_id: 'studio-1' }, new AbortController().signal);
const card = db.get("SELECT payload FROM messages WHERE room_id=? AND kind='approval' ORDER BY created_at DESC LIMIT 1", room.id);
const payload = JSON.parse(String(card?.payload ?? '{}'));
console.log('card toolName', payload.toolName, 'codeField', payload.codeField, 'input keys', Object.keys(payload.toolInput?.input ?? {}).join(','));
process.exit(0);
