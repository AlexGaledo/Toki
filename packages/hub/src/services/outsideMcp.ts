import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';
import { addSecret } from '../providers/redact.js';
import { routeByNeeds, type KeyRegistry } from './keyRegistry.js';

export const OUTSIDE_MCP_PATH = path.join(DATA_DIR, 'mcp-servers.json');

export const RESERVED = new Set(['pocketrocket', 'browser']);
export const NAME_RE = /^[a-z0-9](?:[a-z0-9-]|_(?!_)){0,31}$/;
export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const BARE_COMMANDS = new Set(['npx', 'node']);

export type OutsideMcpApprove = 'every-call' | 'writes' | 'none';

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
  if (server.approve === 'none') return false;
  if (server.approve === 'writes') return !server.readTools.includes(tool);
  return true;
}

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
  return v === 'writes' || v === 'none' ? v : 'every-call';
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
