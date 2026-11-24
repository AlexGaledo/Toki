import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';
import { addSecret, redactValue } from '../providers/redact.js';
import { denyMessage } from '../permissions/messages.js';
import { routeByNeeds, type KeyRegistry } from './keyRegistry.js';

/** No UI or bot tool writes it, and a bot's file and shell tools are refused it. */
export const OUTSIDE_MCP_PATH = path.join(DATA_DIR, 'mcp-servers.json');

export const RESERVED = new Set(['pocketrocket', 'browser']);
export const NAME_RE = /^[a-z0-9](?:[a-z0-9-]|_(?!_)){0,31}$/;
export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const BARE_COMMANDS = new Set(['npx', 'node']);

/** `mode`: follows the hub's approval mode (game tools). The others ask under bypass too. */
export type OutsideMcpApprove = 'every-call' | 'writes' | 'none' | 'mode';

interface OutsideMcpBase {
  name: string;
  approve: OutsideMcpApprove;
  readTools: string[];
  needs: string[];
}
export interface OutsideMcpHttp extends OutsideMcpBase {
  kind: 'http';
  url: string;
  token: string | null;
}
export interface OutsideMcpStdio extends OutsideMcpBase {
  kind: 'stdio';
  command: string;
  args: string[];
  env: Record<string, string>;
}
export type OutsideMcpServer = OutsideMcpHttp | OutsideMcpStdio;

export function outsideMcpNeedsCard(server: Pick<OutsideMcpServer, 'approve' | 'readTools'>, tool: string): boolean {
  if (server.approve === 'none' || server.approve === 'mode') return false;
  if (server.approve === 'writes') return !server.readTools.includes(tool);
  return true;
}

/** Anything bigger is refused, never truncated: a hidden tail could carry the real payload. */
export const OUTSIDE_INPUT_CAP = 8000;

/** The input as a card shows it: secrets redacted, still an object. */
export function outsideCardInput(input: Record<string, unknown>): Record<string, unknown> {
  return redactValue(input ?? {}) as Record<string, unknown>;
}

export function outsideTooLarge(shown: Record<string, unknown>): string | null {
  const n = (JSON.stringify(shown) ?? '{}').length;
  return n > OUTSIDE_INPUT_CAP
    ? denyMessage('unavailable', { subject: 'this call', note: 'its input is too large to show for approval (' + n + ' chars)', alt: 'split it into smaller calls' })
    : null;
}

/** Owner rule: Toki's Blender is headless, so no `bpy.ops.wm.*` UI operators. A text check, not a wall. */
export const BLENDER_WM_MESSAGE =
  'Blender runs headless here, so bpy.ops.wm.* operators are refused. Use toki_save(); the file is opened for you.';
function blenderWmRefused(server: string, tool: string, input: Record<string, unknown>): boolean {
  return server === 'blender' && tool === 'execute_blender_code' && (JSON.stringify(input ?? {}) ?? '').includes('bpy.ops.wm.');
}

/** Servers whose calls go through the outside-tool hook. */
export function outsideMcpHooked(server: Pick<OutsideMcpServer, 'name' | 'approve'>): boolean {
  return server.approve !== 'none' || server.name === 'blender';
}

/**
 * What the PreToolUse hook does with an outside call. `allow`: runs with no card at all. `once`: the once-only
 * outside card. `pass`: the hook stays out, so bypass runs it and otherwise the normal tool card asks.
 * `bypass` must already be false on strict (routine, trigger, failover) turns.
 */
export type OutsideMcpStep = { kind: 'refuse'; message: string } | { kind: 'allow' } | { kind: 'once' } | { kind: 'pass' };
export function outsideMcpStep(
  server: Pick<OutsideMcpServer, 'name' | 'approve' | 'readTools'>,
  tool: string,
  input: Record<string, unknown>,
  o: { bypass: boolean },
): OutsideMcpStep {
  // In every mode, before any card.
  if (blenderWmRefused(server.name, tool, input)) return { kind: 'refuse', message: BLENDER_WM_MESSAGE };
  if (server.approve !== 'mode') return outsideMcpNeedsCard(server, tool) ? { kind: 'once' } : { kind: 'pass' };
  if (o.bypass) return { kind: 'pass' };
  if (server.readTools.includes(tool)) return { kind: 'allow' };
  const big = outsideTooLarge(outsideCardInput(input));
  return big ? { kind: 'refuse', message: big } : { kind: 'pass' };
}

/** Registers every key an outside server carries for redaction. */
export function registerOutsideMcpSecrets(servers: readonly OutsideMcpServer[]): void {
  for (const s of servers) {
    if (s.kind === 'http') addSecret(s.token);
    else for (const v of Object.values(s.env)) addSecret(v);
  }
}

export function stdioCommand(v: unknown): string | null {
  if (typeof v !== 'string' || !v || v !== v.trim()) return null;
  if (BARE_COMMANDS.has(v)) return v;
  return path.isAbsolute(v) ? v : null;
}

function strings(v: unknown): string[] | null {
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) return null;
  return v as string[];
}

function approveOf(v: unknown, fallback: OutsideMcpApprove): OutsideMcpApprove {
  if (v === undefined) return fallback;
  return v === 'writes' || v === 'none' || v === 'mode' ? v : 'every-call';
}

export function outsideMcpFor(handle: string, room: { id: string; name: string } | null, file: string = OUTSIDE_MCP_PATH): OutsideMcpServer[] {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const out: OutsideMcpServer[] = [];
  for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!NAME_RE.test(name) || RESERVED.has(name) || !v || typeof v !== 'object') continue;
    const s = v as {
      url?: unknown; token?: unknown; command?: unknown; args?: unknown; env?: unknown;
      tokenOrigin?: unknown; bots?: unknown; rooms?: unknown; approve?: unknown; readTools?: unknown; needs?: unknown;
    };
    const byBot = Array.isArray(s.bots) && s.bots.includes(handle);
    const byRoom = !!room && Array.isArray(s.rooms) && (s.rooms.includes(room.id) || s.rooms.includes(room.name));
    if (!byBot && !byRoom) continue;
    const readTools = strings(s.readTools) ?? [];
    const needs = strings(s.needs);
    if (!needs) continue;

    if (s.command !== undefined) {
      if (s.url !== undefined) continue;
      const command = stdioCommand(s.command);
      const args = strings(s.args);
      if (!command || !args) continue;
      const rawEnv = s.env ?? {};
      if (!rawEnv || typeof rawEnv !== 'object' || Array.isArray(rawEnv)) continue;
      const entries = Object.entries(rawEnv as Record<string, unknown>);
      if (!entries.every(([k, val]) => ENV_KEY_RE.test(k) && typeof val === 'string')) continue;
      const env = Object.fromEntries(entries) as Record<string, string>;
      out.push({ kind: 'stdio', name, command, args, env, approve: approveOf(s.approve, 'every-call'), readTools, needs });
      continue;
    }

    if (typeof s.url !== 'string') continue;
    let url: URL;
    try {
      url = new URL(s.url);
    } catch {
      continue;
    }
    // A key only ever travels over TLS, or to this machine.
    const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) continue;
    // A saved token is bound to its origin: a url edited to another origin must not carry it.
    if (typeof s.token === 'string' && s.token && typeof s.tokenOrigin === 'string' && s.tokenOrigin !== url.origin) {
      logOnce('[outside-mcp] not mounting "' + name + '": its token was saved for another origin than its url; re-save the token');
      continue;
    }
    out.push({
      kind: 'http', name, url: url.toString(), token: typeof s.token === 'string' && s.token ? s.token : null,
      approve: approveOf(s.approve, 'none'), readTools, needs,
    });
  }
  return out;
}

const logged = new Set<string>();
function logOnce(msg: string): void {
  if (logged.has(msg)) return;
  logged.add(msg);
  console.warn(msg);
}

export function vpsMountable(
  servers: readonly OutsideMcpServer[],
  registry: KeyRegistry,
  log: (msg: string) => void = logOnce,
): OutsideMcpServer[] {
  return servers.filter((s) => {
    if (!s.needs.length) return true;
    const r = routeByNeeds(registry, s.needs, false);
    if (r.place === 'vps') return true;
    log('[outside-mcp] not mounting "' + s.name + '" on this hub: ' + r.reason);
    return false;
  });
}
