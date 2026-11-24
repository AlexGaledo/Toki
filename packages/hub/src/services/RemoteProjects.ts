import type { HostProjectsInput, HostState, ProjectStub, RemoteHostId } from '@pocketrocket/shared';
import type { Db } from '../db/db.js';

/**
 * B10 (spec toki-local-first-gamedev, Phase 3): names of projects that live on another host. Nothing is migrated
 * (owner decision 6): a stub has no folder, members or room here.
 *
 * Only `api/projects.ts` reads or writes this, for the hub token. Bots never see stubs: nothing under agent/,
 * permissions/, mcp/ or providers/ may import it (remoteProjects.test.ts), so the prompt, the hub tools and the
 * project folder guard only ever know ProjectService's local projects.
 */
export class RemoteProjects {
  constructor(private deps: { db: Db; now?: () => number }) {}

  private now() { return (this.deps.now ?? Date.now)(); }

  /** Sets `connected`; with `projects`, replaces every stub of `host` in one transaction. */
  put(host: RemoteHostId, input: HostProjectsInput): HostState {
    const at = this.now();
    this.deps.db.tx(() => {
      this.deps.db.run(
        'INSERT INTO remote_hosts (host, connected, updated_at) VALUES (?,?,?) ON CONFLICT(host) DO UPDATE SET connected=excluded.connected, updated_at=excluded.updated_at',
        host, input.connected ? 1 : 0, at,
      );
      if (!input.projects) return;
      this.deps.db.run('DELETE FROM project_stubs WHERE host=?', host);
      for (const p of input.projects) {
        this.deps.db.run('INSERT INTO project_stubs (host, slug, name, seen_at) VALUES (?,?,?,?)', host, p.slug, p.name, at);
      }
    });
    return this.state(host)!;
  }

  state(host: RemoteHostId): HostState | null {
    const r = this.deps.db.get('SELECT connected, updated_at FROM remote_hosts WHERE host=?', host);
    if (!r) return null;
    const n = this.deps.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM project_stubs WHERE host=?', host)?.n ?? 0;
    return { host, connected: r.connected === 1, stubs: Number(n), updatedAt: Number(r.updated_at) };
  }

  /** B11: a host is known once the desktop app has told this hub about it. */
  known(host: RemoteHostId): boolean {
    return this.state(host) !== null;
  }

  list(): ProjectStub[] {
    return this.deps.db.all(
      'SELECT s.host, s.slug, s.name, s.seen_at, h.connected FROM project_stubs s JOIN remote_hosts h ON h.host = s.host ORDER BY s.name, s.slug',
    ).map((r) => ({
      host: r.host as RemoteHostId,
      slug: r.slug as string,
      name: r.name as string,
      seenAt: Number(r.seen_at),
      connected: r.connected === 1,
    }));
  }
}
