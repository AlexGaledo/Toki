import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { GAME_TOOL_FIXES, type GameToolFix, type GameToolFixResult, type GameToolsStudio } from '@pocketrocket/shared';
import { readBody } from './body.js';
import { principalOf } from './guard.js';
import type { Db } from '../db/db.js';
import type { Repos } from '../db/repos.js';
import { actorOf, recordAudit } from '../services/AuditLog.js';
import type { FixOutcome, GameTools } from '../services/gameTools.js';
import { McpStoreError, type McpServerStore, type McpServerView } from '../services/outsideMcpStore.js';
import { logError, redact } from '../providers/redact.js';

/** The Studio recipe's name in mcp-servers.json. */
export const STUDIO_SERVER = 'roblox-studio';
/** Studio's read-only tools (`readOnlyHint`): under `ask` they run with no card (approve: 'mode'). */
export const STUDIO_READ_TOOLS = [
  'search_game_tree', 'script_search', 'script_read', 'script_grep', 'inspect_instance', 'get_console_output', 'get_studio_state',
  'screen_capture', 'list_roblox_studios', 'list_skills', 'skill', 'wait_job_finished', 'search_asset', 'http_get',
];

/** B5: what a Studio recipe check adds once its command is found. Fixed words only. */
export function studioCheckWord(s: GameToolsStudio): string | null {
  if (s.reason === 'unsupported' || !s.mcpBat || !s.studioMcp) return 'command-missing';
  if (s.setting === 'off') return 'setting-off';
  if (!s.running) return 'studio-not-open';
  return null;
}

// Strict: a field the route does not know is refused, so nothing in a request can become a command, argument or env.
const FixBody = z.object({}).strict();
const StudioSetupBody = z.object({ roomId: z.string().min(1).max(100) }).strict();

const AUDIT: Record<GameToolFix, string> = {
  'install-uv': 'game_tools.uv_installed',
  'install-blender-mcp': 'game_tools.blender_mcp_installed',
  'blender-reset': 'game_tools.blender_reset',
  'studio-mcp-setting': 'game_tools.studio_mcp_enabled',
};

const send = (res: ServerResponse, status: number, body: unknown): true => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
  return true;
};

/**
 * Settings › Game tools (spec toki-local-first-gamedev §2, B2). Hub token only: a paired device, the PC runner and a
 * bot's MCP bearer never get here. No password sign-in (owner decision 3). Every step is fixed in the hub; the only
 * request input anywhere is a room id, which goes into the recipe's `rooms` list. Every write is audited.
 */
export function createGameToolsApi(deps: {
  tools: GameTools;
  blender: { resetCrashes(): void };
  store: McpServerStore;
  repos: Pick<Repos, 'getRoom'>;
  db: Db;
  /** For the Studio recipe's `cmd.exe`. */
  env?: NodeJS.ProcessEnv;
}) {
  const { tools, store, repos, db } = deps;
  let running: GameToolFix | null = null;
  const dataDir = path.dirname(tools.toolsDir);
  /** `tools/uv/0.11.15` for Toki's own folders, the file name for anything else. */
  const label = (p: string) => {
    const r = path.relative(dataDir, p);
    return r && !r.startsWith('..') && !path.isAbsolute(r) ? r.split(path.sep).join('/') : path.basename(p);
  };

  async function fix(step: GameToolFix): Promise<FixOutcome> {
    if (step === 'install-uv') return tools.installUv();
    if (step === 'install-blender-mcp') return tools.installBlenderMcp();
    if (step === 'studio-mcp-setting') return tools.enableStudioMcp();
    deps.blender.resetCrashes();
    return { ok: true, result: 'reset', changed: [] };
  }

  function studioRecipe(roomId: string): McpServerView {
    const env = deps.env ?? process.env;
    const command = path.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe');
    const fixed = { command, args: ['/d', '/c', tools.mcpBat], approve: 'mode' as const, readTools: [...STUDIO_READ_TOOLS] };
    const cur = store.list().find((s) => s.name === STUDIO_SERVER);
    if (!cur) return store.add({ name: STUDIO_SERVER, ...fixed, rooms: [roomId] });
    return store.patch(STUDIO_SERVER, { ...fixed, rooms: [...new Set([...cur.rooms, roomId])] });
  }

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/api/game-tools' && !url.pathname.startsWith('/api/game-tools/')) return false;
    const method = req.method ?? 'GET';
    const actor = actorOf(req);
    if (principalOf(req)?.kind !== 'hub' || !actor) return send(res, 403, { error: 'Game tools are set up from the desktop app only' });
    const parts = url.pathname.replace(/^\/api\/game-tools\/?/, '').replace(/\/$/, '').split('/').filter(Boolean);

    let body: unknown = {};
    if (method === 'POST') {
      const buf = await readBody(req);
      if (buf === null) return send(res, 413, { error: 'Request body too large (max 1 MB)' });
      try { body = buf.length ? JSON.parse(buf.toString('utf8')) : {}; } catch { return send(res, 400, { error: 'Invalid JSON' }); }
    }

    try {
      if (method === 'GET' && parts.length === 0) return send(res, 200, await tools.status());
      if (method === 'GET' && parts.length === 2 && parts[0] === 'blender' && parts[1] === 'crash-log') {
        const log = tools.crashLog();
        return send(res, 200, { log: log === null ? null : redact(log) });
      }

      if (method === 'POST' && parts.length === 2 && parts[0] === 'fix') {
        const step = GAME_TOOL_FIXES.find((s) => s === parts[1]);
        if (!step) return send(res, 404, { error: 'No such step' });
        if (!FixBody.safeParse(body).success) return send(res, 400, { error: 'This step takes no input' });
        if (running) return send(res, 409, { error: 'Another game tools step is running', result: 'busy' });
        running = step;
        let out: FixOutcome;
        try {
          out = await fix(step);
        } finally {
          running = null;
        }
        if (out.ok && (out.changed.length || step === 'blender-reset')) {
          recordAudit(db, actor, AUDIT[step], out.changed.map(label).join(', ') || null, out.detail ?? null);
        } else if (!out.ok) {
          recordAudit(db, actor, 'game_tools.fix_failed', step, out.result);
        }
        const reply: GameToolFixResult = { ok: out.ok, step, result: out.result, changed: out.changed, status: await tools.status() };
        return send(res, out.ok ? 200 : 409, out.detail && !out.ok ? { ...reply, detail: out.detail } : reply);
      }

      if (method === 'POST' && parts.length === 2 && parts[0] === 'studio' && parts[1] === 'setup') {
        const p = StudioSetupBody.safeParse(body);
        if (!p.success) return send(res, 400, { error: 'Send only roomId' });
        const room = repos.getRoom(p.data.roomId);
        if (!room) return send(res, 404, { error: 'No such room' });
        if (room.kind !== 'group') return send(res, 400, { error: 'Studio is set up for a group room' });
        const studio = (await tools.status()).studio;
        if (studio.reason === 'unsupported' || studio.reason === 'no-mcp-bat') {
          return send(res, 409, { error: 'Roblox Studio\'s MCP launcher was not found on this PC', result: studio.reason });
        }
        const server = studioRecipe(room.id);
        recordAudit(db, actor, 'game_tools.studio_setup', room.id, STUDIO_SERVER);
        return send(res, 200, { server });
      }

      return send(res, 404, { error: 'No such route' });
    } catch (e) {
      if (e instanceof McpStoreError) return send(res, e.status, { error: e.message });
      logError('[api/game-tools]', e);
      return send(res, 500, { error: 'Game tools step failed' });
    }
  };
}
