import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { HostProjectsInputSchema, ProjectNameSchema, REMOTE_HOST_IDS, TEAM_TEMPLATE_IDS, type GameProjectSetup, type RemoteHostId } from '@pocketrocket/shared';
import { events } from '../events.js';
import { readBody } from './body.js';
import { principalOf } from './guard.js';
import type { Repos } from '../db/repos.js';
import type { Db } from '../db/db.js';
import { actorOf, recordAudit, type AuditActor } from '../services/AuditLog.js';
import { ProjectError, type ProjectService } from '../services/ProjectService.js';
import { logError } from '../providers/redact.js';
import type { RemoteProjects } from '../services/RemoteProjects.js';

const CreateInput = z.object({
  name: ProjectNameSchema, team: z.boolean().optional(), template: z.enum(TEAM_TEMPLATE_IDS).optional(),
  memberIds: z.array(z.string()).max(100).optional(),
});
const MembersInput = z.object({ memberIds: z.array(z.string()).max(100) });
const RoomLinkInput = z.object({ roomId: z.string().min(1).nullable() });

const send = (res: ServerResponse, status: number, body: unknown): true => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
  return true;
};

/** Human-only: only the owner decides which bots work in which folder. */
export function createProjectsApi(deps: {
  projects: ProjectService; repos: Repos; db?: Db;
  /** B7: writes the Studio recipe for a new game room (hub-token callers only). Returns a fixed word. */
  studioForRoom?: (roomId: string, actor: AuditActor) => Promise<GameProjectSetup['studio']>;
  /** B10: other hosts' project stubs. Listed by GET /api/projects, written by PUT /api/hosts/:host/projects. */
  remote?: RemoteProjects;
}) {
  const { projects, repos, db, remote } = deps;
  const changed = () => events.emitEvent({ type: 'projects.changed' });

  /**
   * B10: `PUT /api/hosts/:host/projects`, from the desktop app only. The hub token, never a password session, a paired
   * device or a bot: stubs decide what the owner sees as his other host's projects.
   */
  async function handleHosts(req: IncomingMessage, res: ServerResponse, url: URL, method: string): Promise<boolean> {
    const m = /^\/api\/hosts\/([^/]+)\/projects\/?$/.exec(url.pathname);
    if (!m || !remote) return send(res, 404, { error: 'Not found' });
    if (method !== 'PUT') return send(res, 405, { error: 'Method not allowed' });
    const p = principalOf(req);
    if (p?.kind !== 'hub' || p.sessionId) return send(res, 403, { error: 'Only the desktop app updates other hosts' });
    const host = decodeURIComponent(m[1]!);
    if (!(REMOTE_HOST_IDS as readonly string[]).includes(host)) return send(res, 400, { error: 'Unknown host: use ' + REMOTE_HOST_IDS.join(', ') });
    const buf = await readBody(req);
    if (buf === null) return send(res, 413, { error: 'Request body too large (max 1 MB)' });
    let body: unknown;
    try { body = buf.length ? JSON.parse(buf.toString('utf8')) : {}; } catch { return send(res, 400, { error: 'Invalid JSON' }); }
    const parsed = HostProjectsInputSchema.safeParse(body);
    if (!parsed.success) return send(res, 400, { error: parsed.error.issues.slice(0, 5).map((i) => i.path.join('.') + ': ' + i.message).join('; ') });
    const state = remote.put(host as RemoteHostId, parsed.data);
    events.emitEvent({ type: 'hosts.changed' });
    return send(res, 200, state);
  }
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';
    if (url.pathname.startsWith('/api/hosts/')) return handleHosts(req, res, url, method);
    if (url.pathname !== '/api/projects' && !url.pathname.startsWith('/api/projects/')) return false;
    const parts = url.pathname.replace(/^\/api\/projects\/?/, '').replace(/\/$/, '').split('/').filter(Boolean).map(decodeURIComponent);
    let body: unknown;
    if (method === 'POST' || method === 'PUT') {
      const buf = await readBody(req);
      if (buf === null) return send(res, 413, { error: 'Request body too large (max 1 MB)' });
      try { body = buf.length ? JSON.parse(buf.toString('utf8')) : {}; } catch { return send(res, 400, { error: 'Invalid JSON' }); }
    }
    try {
      if (parts.length === 0) {
        if (method === 'GET') return send(res, 200, [...projects.list().map((p) => ({ ...p, host: 'pc' as const })), ...(remote?.list() ?? [])]);
        if (method === 'POST') {
          const p = CreateInput.safeParse(body);
          if (!p.success) return send(res, 400, { error: p.error.issues.map((i) => i.path.join('.') + ': ' + i.message).join('; ') });
          const made = projects.create(p.data);
          if (made.bots.length) events.emitEvent({ type: 'bots.changed', bots: repos.listBots() });
          if (made.room) events.emitEvent({ type: 'rooms.changed', rooms: repos.listRooms() });
          changed();
          if (made.project.kind !== 'game') return send(res, 200, made);
          // Like /api/game-tools: the hub token only, so a paired device never writes mcp-servers.json.
          const actor = principalOf(req)?.kind === 'hub' ? actorOf(req) : null;
          const setup: GameProjectSetup = {
            git: await projects.initRepo(made.project.slug),
            studio: made.room && actor && deps.studioForRoom ? await deps.studioForRoom(made.room.id, actor).catch((e: unknown) => {
              logError('[projects api] studio recipe', e);
              return 'failed' as const;
            }) : 'failed',
          };
          return send(res, 200, { ...made, setup });
        }
      }
      const [slug, action] = parts;
      if (parts.length === 1 && method === 'DELETE') { projects.remove(slug); changed(); return send(res, 200, { ok: true }); }
      if (parts.length === 2 && action === 'members' && method === 'PUT') {
        const p = MembersInput.safeParse(body);
        if (!p.success) return send(res, 400, { error: p.error.issues.map((i) => i.path.join('.') + ': ' + i.message).join('; ') });
        projects.setMembers(slug, p.data.memberIds);
        changed();
        return send(res, 200, projects.need(slug));
      }
      if (parts.length === 2 && action === 'room' && method === 'PUT') {
        const p = RoomLinkInput.safeParse(body);
        if (!p.success) return send(res, 400, { error: p.error.issues.map((i) => i.path.join('.') + ': ' + i.message).join('; ') });
        projects.setRoom(slug, p.data.roomId);
        changed();
        return send(res, 200, projects.need(slug));
      }
      if (parts.length === 2 && action === 'search' && method === 'GET') {
        projects.need(slug);
        const q = url.searchParams.get('q') ?? '';
        if (!q.trim()) return send(res, 400, { error: 'q is required' });
        return send(res, 200, projects.search([slug], q, { includeArchived: url.searchParams.get('archived') === '1', limit: 10 }));
      }
      if (parts.length === 2 && action === 'lint' && method === 'GET') return send(res, 200, projects.lint(slug));
      if (parts.length === 2 && action === 'repos' && method === 'GET') {
        projects.need(slug);
        return send(res, 200, projects.reposFile(slug));
      }
      if (parts.length === 2 && action === 'map' && method === 'GET') return send(res, 200, projects.map(slug));
      if (parts.length === 2 && action === 'overview' && method === 'GET') return send(res, 200, projects.overview(slug));
      if (parts.length === 2 && action === 'repos' && method === 'PUT') {
        const saved = projects.setRepos(slug, body);
        const actor = actorOf(req);
        if (db && actor) recordAudit(db, actor, 'project.repos.saved', slug, saved.repos.map((r) => r.name + ':' + r.sync + (r.client ? ':client' : '')).join(', ').slice(0, 300));
        return send(res, 200, saved);
      }
      return send(res, 404, { error: 'Not found' });
    } catch (e) {
      if (e instanceof ProjectError) return send(res, e.status, { error: e.message });
      logError('[projects api]', e);
      return send(res, 500, { error: 'Internal error' });
    }
  };
}
