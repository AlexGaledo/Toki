import type { PcEntry, PcEntryKind, PcSessionDetail, PcSessionSummary, PcSessionUpdatedEvent, PcStoredEntry } from '@pocketrocket/shared';

export type { PcEntry, PcEntryKind, PcSessionDetail, PcSessionSummary };
export type PcSeqEntry = PcStoredEntry;

export const PC_SESSION_PAGE = 50;
export const PC_ENTRY_PAGE = 200;

export interface PcSessionQuery { q?: string; repo?: string; before?: number; limit?: number }

export function listQuery(p: PcSessionQuery): string {
  const u = new URLSearchParams();
  if (p.repo) u.set('repo', p.repo);
  if (p.q?.trim()) u.set('q', p.q.trim());
  if (p.before !== undefined) u.set('before', String(p.before));
  u.set('limit', String(p.limit ?? PC_SESSION_PAGE));
  return '?' + u.toString();
}

export interface SessionNode { session: PcSessionSummary; children: PcSessionSummary[] }
export interface SessionGroup { key: string; label: string; lastAt: number; nodes: SessionNode[] }

export function groupLabelOf(s: PcSessionSummary): string {
  const fromRemote = s.repo?.remote?.replace(/[?#].*$/, '').replace(/\/+$/, '').replace(/\.git$/i, '').split(/[/:]/).pop();
  const fromCwd = s.cwd?.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
  return fromRemote || s.repo?.name || fromCwd || s.projectDir || 'Other';
}
/** Case-insensitive, as Windows paths are. */
export function groupKeyOf(s: PcSessionSummary): string {
  return groupLabelOf(s).toLowerCase();
}

export function activeSessions(list: PcSessionSummary[]): PcSessionSummary[] {
  const busy = (x: PcSessionSummary) => x.status === 'live' || (!!x.move && x.move.state !== 'local');
  const parents = new Set(list.filter((x) => x.parentId && busy(x)).map((x) => x.parentId as string));
  const keep = new Set(list.filter((x) => busy(x) || parents.has(x.id)).map((x) => x.id));
  return list.filter((x) => keep.has(x.id) || (!!x.parentId && keep.has(x.parentId)));
}

export function groupSessions(list: PcSessionSummary[]): SessionGroup[] {
  const ids = new Set(list.map((s) => s.id));
  const kids = new Map<string, PcSessionSummary[]>();
  const tops: PcSessionSummary[] = [];
  for (const s of list) {
    if (s.parentId && ids.has(s.parentId)) kids.set(s.parentId, [...(kids.get(s.parentId) ?? []), s]);
    else tops.push(s);
  }
  const groups = new Map<string, SessionGroup>();
  for (const s of tops) {
    const children = (kids.get(s.id) ?? []).sort((a, b) => b.lastAt - a.lastAt);
    const key = groupKeyOf(s);
    const g = groups.get(key) ?? { key, label: groupLabelOf(s), lastAt: 0, nodes: [] };
    g.nodes.push({ session: s, children });
    g.lastAt = Math.max(g.lastAt, s.lastAt, ...children.map((c) => c.lastAt));
    groups.set(key, g);
  }
  const out = [...groups.values()];
  for (const g of out) g.nodes.sort((a, b) => b.session.lastAt - a.session.lastAt);
  return out.sort((a, b) => b.lastAt - a.lastAt);
}

export function repoOptions(list: PcSessionSummary[]): string[] {
  return [...new Set(list.map((s) => s.repo?.name).filter((n): n is string => !!n))].sort((a, b) => a.localeCompare(b));
}

export function nextBefore(list: PcSessionSummary[], lastPageSize: number, limit = PC_SESSION_PAGE): number | null {
  if (lastPageSize < limit || list.length === 0) return null;
  return Math.min(...list.map((s) => s.lastAt));
}

export function mergeSessions(cur: PcSessionSummary[], incoming: PcSessionSummary[]): PcSessionSummary[] {
  const byId = new Map(cur.map((s) => [s.id, s]));
  for (const s of incoming) byId.set(s.id, s);
  return [...byId.values()].sort((a, b) => b.lastAt - a.lastAt);
}

export function sessionTitle(s: { title: string | null }): string {
  return s.title?.trim() || 'Untitled session';
}

export function relativeTime(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.round(m / 60);
  if (h < 24) return h + 'h ago';
  const d = Math.round(h / 24);
  if (d < 30) return d + 'd ago';
  return new Date(at).toLocaleDateString();
}

export function toolRowLabel(e: Pick<PcEntry, 'tool' | 'text' | 'kind'>): string {
  const name = e.tool || (e.kind === 'tool_result' ? 'result' : 'tool');
  const first = e.text.split('\n', 1)[0].trim();
  return first ? name + ' · ' + first : name;
}

export function mergeEntries(cur: PcSeqEntry[], incoming: PcSeqEntry[]): PcSeqEntry[] {
  const bySeq = new Map(cur.map((e) => [e.seq, e]));
  for (const e of incoming) bySeq.set(e.seq, e);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

export type PcSessionUpdated = PcSessionUpdatedEvent;
type Listener = (ev: PcSessionUpdated) => void;
const listeners = new Set<Listener>();

export function onPcSessionUpdated(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function dispatchPcSessionEvent(raw: unknown): boolean {
  const ev = raw as { type?: unknown; id?: unknown; lastAt?: unknown } | null;
  if (!ev || ev.type !== 'pc_session_updated' || typeof ev.id !== 'string') return false;
  const out: PcSessionUpdated = { type: 'pc_session_updated', id: ev.id, lastAt: typeof ev.lastAt === 'number' ? ev.lastAt : Date.now() };
  for (const fn of listeners) fn(out);
  return true;
}
