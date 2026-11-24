import type { IncomingMessage } from 'node:http';
import type { AuditEntry } from '@pocketrocket/shared';
import type { Db } from '../db/db.js';
import { clientIp, principalOf } from '../api/guard.js';
import { logError } from '../providers/redact.js';

const MAX_ROWS = 100_000;
const MAX_FIELD = 300;

export interface AuditActor {
  kind: AuditEntry['actorKind'];
  id: string | null;
  ip?: string | null;
}

const clip = (s: string | null | undefined) => (s ? s.slice(0, MAX_FIELD) : null);

/**
 * Appends one row. Callers pass labels and ids only, never request bodies, so no secret lands here. Never throws:
 * it runs after the change is made, and a failed log write must not turn that change into an error.
 */
export function recordAudit(db: Db, actor: AuditActor, action: string, target: string | null = null, detail: string | null = null): void {
  try {
    const r = db.run(
      'INSERT INTO audit_log (at, actor_kind, actor_id, action, target, detail, ip) VALUES (?,?,?,?,?,?,?)',
      Date.now(), actor.kind, actor.id, clip(action), clip(target), clip(detail), actor.ip ?? null,
    );
    if (Number(r.lastInsertRowid) % 1000 === 0) db.run('DELETE FROM audit_log WHERE id <= ?', Number(r.lastInsertRowid) - MAX_ROWS);
  } catch (e) {
    logError('[audit]', e);
  }
}

export function listAudit(db: Db, opts: { limit?: number; before?: number } = {}): AuditEntry[] {
  const limit = Math.min(Math.max(1, opts.limit ?? 100), 500);
  const rows = opts.before
    ? db.all('SELECT * FROM audit_log WHERE id < ? ORDER BY id DESC LIMIT ?', opts.before, limit)
    : db.all('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?', limit);
  return rows.map((r) => ({
    id: r.id as number,
    at: r.at as number,
    actorKind: r.actor_kind as AuditEntry['actorKind'],
    actorId: (r.actor_id as string) ?? null,
    action: r.action as string,
    target: (r.target as string) ?? null,
    detail: (r.detail as string) ?? null,
    ip: (r.ip as string) ?? null,
  }));
}

export function actorOf(req: IncomingMessage): AuditActor | null {
  const p = principalOf(req);
  if (!p) return null;
  const ip = clientIp(req);
  if (p.kind === 'device') return { kind: 'device', id: p.deviceId, ip };
  if (p.kind === 'runner') return null;
  return p.sessionId ? { kind: 'session', id: p.userId ?? null, ip } : { kind: 'hub-token', id: p.userId ?? null, ip };
}

const NOT_AUDITED = [
  /^\/api\/rooms\/[^/]+\/messages$/,
  /^\/api\/media(\/|$)/,
  /^\/api\/screen\/ticket$/,
  /^\/api\/computers\/[^/]+\/wake$/,
  /^\/api\/computers\/warm$/,
  /^\/api\/push(\/|$)/,
  /^\/api\/auth(\/|$)/,
  /^\/api\/settings$/,
  /^\/api\/rooms\/[^/]+\/files(\/|$)/,
  /^\/api\/pc-runner(\/|$)/,
  // Game tools write their own rows, naming the step and what it changed.
  /^\/api\/game-tools(\/|$)/,
];

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function auditAction(method: string, pathname: string): { action: string; target: string | null } {
  const [resource = 'api', id, ...sub] = pathname.replace(/^\/api\//, '').replace(/\/+$/, '').split('/');
  const name = resource.replace(/s$/, '');
  const verb = method === 'DELETE' ? 'deleted' : method === 'POST' ? (id ? 'changed' : 'created') : 'updated';
  return { action: [name, ...sub.filter((s) => /^[a-z][a-z_-]*$/.test(s)), verb].join('.'), target: id ?? null };
}

export function auditRequest(db: Db, req: IncomingMessage, method: string, pathname: string, status: number): void {
  if (status >= 400 || !MUTATING.has(method) || !pathname.startsWith('/api/')) return;
  if (NOT_AUDITED.some((re) => re.test(pathname))) return;
  const actor = actorOf(req);
  if (!actor) return;
  const { action, target } = auditAction(method, pathname);
  recordAudit(db, actor, action, target);
}
