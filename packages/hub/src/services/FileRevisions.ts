import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/db.js';

export type RootKind = 'room' | 'project' | 'dm';
export interface FileRoot {
  kind: RootKind;
  key: string;
  dir: string;
}

export type AuthorKind = 'owner' | 'owner-cc' | 'bot' | 'persona' | 'offload';
export interface RevisionAuthor {
  kind: AuthorKind;
  id: string | null;
  label: string;
  machine: 'vps' | 'pc';
  sessionId?: string | null;
  roomId?: string | null;
  sources?: string[];
  tool?: string;
}

export interface Revision {
  rev: number;
  hash: string | null;
  size: number;
  author: { kind: AuthorKind; id: string | null; label: string; machine: string; sessionId: string | null; roomId: string | null };
  sources: string[];
  tool: string | null;
  at: number;
}

export type WriteResult =
  | { ok: true; hash: string; rev: number }
  | { ok: false; current: { hash: string | null; text: string | null; rev: Revision | null } };

export const DECISIONS_FILE = 'decisions.md';
const KEEP_CONTENT_BYTES = 256 * 1024;
const DECISION_HEADING = /^## (D-\d{4,})\b/gm;

export function hashBytes(buf: Buffer | string): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function relIn(root: FileRoot, abs: string): string | null {
  const rel = path.relative(path.resolve(root.dir), path.resolve(abs));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

function readOrNull(abs: string): Buffer | null {
  try {
    const st = fs.statSync(abs);
    return st.isFile() ? fs.readFileSync(abs) : null;
  } catch {
    return null;
  }
}

function keepable(buf: Buffer): string | null {
  if (buf.length > KEEP_CONTENT_BYTES || buf.includes(0)) return null;
  return buf.toString('utf8');
}

export class FileRevisions {
  constructor(private db: Db, private now: () => number = Date.now) {}

  private toRevision(r: Record<string, unknown>): Revision {
    let sources: string[] = [];
    try { sources = r.sources ? (JSON.parse(r.sources as string) as string[]) : []; } catch { /* old or hand-edited row */ }
    return {
      rev: r.rev as number,
      hash: (r.hash as string) ?? null,
      size: (r.size as number) ?? 0,
      author: {
        kind: r.author_kind as AuthorKind,
        id: (r.author_id as string) ?? null,
        label: (r.author_label as string) ?? '',
        machine: r.machine as string,
        sessionId: (r.session_id as string) ?? null,
        roomId: (r.room_id as string) ?? null,
      },
      sources,
      tool: (r.tool as string) ?? null,
      at: r.created_at as number,
    };
  }

  latest(root: FileRoot, rel: string): Revision | null {
    const r = this.db.get<Record<string, unknown>>(
      'SELECT * FROM file_revisions WHERE root_kind = ? AND root_key = ? AND path = ? ORDER BY rev DESC LIMIT 1',
      root.kind, root.key, rel,
    );
    return r ? this.toRevision(r) : null;
  }

  history(root: FileRoot, rel: string, limit = 20): Revision[] {
    return this.db
      .all<Record<string, unknown>>(
        'SELECT * FROM file_revisions WHERE root_kind = ? AND root_key = ? AND path = ? ORDER BY rev DESC LIMIT ?',
        root.kind, root.key, rel, Math.max(1, Math.min(200, limit)),
      )
      .map((r) => this.toRevision(r));
  }

  contentAt(root: FileRoot, rel: string, rev: number): string | null {
    const r = this.db.get<{ content: string | null }>(
      'SELECT content FROM file_revisions WHERE root_kind = ? AND root_key = ? AND path = ? AND rev = ?',
      root.kind, root.key, rel, rev,
    );
    return r?.content ?? null;
  }

  record(root: FileRoot, rel: string, author: RevisionAuthor): Revision | null {
    const buf = readOrNull(path.join(root.dir, rel));
    const hash = buf ? hashBytes(buf) : null;
    const last = this.latest(root, rel);
    if (last ? last.hash === hash : hash === null) return null;
    const rev = (last?.rev ?? 0) + 1;
    this.db.run(
      `INSERT INTO file_revisions (root_kind, root_key, path, rev, hash, size, content, author_kind, author_id, author_label,
         machine, session_id, room_id, sources, tool, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      root.kind, root.key, rel, rev, hash, buf?.length ?? 0, buf ? keepable(buf) : null,
      author.kind, author.id, author.label, author.machine, author.sessionId ?? null, author.roomId ?? null,
      author.sources?.length ? JSON.stringify(author.sources) : null, author.tool ?? null, this.now(),
    );
    return this.latest(root, rel);
  }

  readText(root: FileRoot, rel: string): { text: string | null; hash: string | null; rev: Revision | null } {
    const buf = readOrNull(path.join(root.dir, rel));
    return { text: buf ? buf.toString('utf8') : null, hash: buf ? hashBytes(buf) : null, rev: this.latest(root, rel) };
  }

  writeText(root: FileRoot, rel: string, text: string, base: string | null, author: RevisionAuthor): WriteResult {
    if (path.posix.basename(rel).toLowerCase() === DECISIONS_FILE) {
      throw new FileRevisionError(409, DECISIONS_FILE + ' is append-only. Add a decision with log_decision instead.');
    }
    const abs = path.join(root.dir, rel);
    const cur = readOrNull(abs);
    const curHash = cur ? hashBytes(cur) : null;
    if (curHash !== base) return { ok: false, current: { hash: curHash, text: cur ? cur.toString('utf8') : null, rev: this.latest(root, rel) } };
    if (cur && this.latest(root, rel)?.hash !== curHash) this.record(root, rel, { kind: 'owner', id: null, label: 'unknown', machine: 'vps', tool: 'outside the hub' });
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const tmp = abs + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
    fs.writeFileSync(tmp, text, { flag: 'wx' });
    fs.renameSync(tmp, abs);
    const r = this.record(root, rel, { ...author, tool: author.tool ?? 'write_text' });
    const hash = hashBytes(Buffer.from(text, 'utf8'));
    return { ok: true, hash, rev: r?.rev ?? this.latest(root, rel)?.rev ?? 0 };
  }

  appendDecision(root: FileRoot, a: { title: string; text: string; supersedes?: string[] }, author: RevisionAuthor): { id: string; rev: number } {
    const abs = path.join(root.dir, DECISIONS_FILE);
    const cur = readOrNull(abs)?.toString('utf8') ?? '';
    const known = new Set([...cur.matchAll(DECISION_HEADING)].map((m) => m[1]));
    for (const s of a.supersedes ?? []) {
      if (!known.has(s)) throw new FileRevisionError(400, 'No decision ' + s + ' in ' + DECISIONS_FILE + ' to supersede');
    }
    const n = [...known].reduce((max, id) => Math.max(max, Number(id.slice(2))), 0) + 1;
    const id = 'D-' + String(n).padStart(4, '0');
    const when = new Date(this.now()).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
    const title = a.title.replace(/\s+/g, ' ').trim();
    const lines = [
      '## ' + id + ' · ' + title,
      '',
      '_' + when + ' · ' + author.label + ' (' + author.machine + ')' + (a.supersedes?.length ? ' · supersedes ' + a.supersedes.join(', ') : '') + '_',
      '',
      a.text.trim(),
    ];
    if (author.sources?.length) lines.push('', 'Sources: ' + author.sources.join(', '));
    const head = cur ? '' : '# Decisions\n\nAppend-only. Add one with `log_decision`; to change a decision, add a new one that supersedes it.\n\n';
    const sep = cur && !cur.endsWith('\n\n') ? (cur.endsWith('\n') ? '\n' : '\n\n') : '';
    const last = this.latest(root, DECISIONS_FILE);
    if (cur && last?.hash !== hashBytes(cur)) this.record(root, DECISIONS_FILE, { kind: 'owner', id: null, label: 'unknown', machine: 'vps', tool: 'outside the hub' });
    fs.mkdirSync(root.dir, { recursive: true });
    fs.appendFileSync(abs, head + sep + lines.join('\n') + '\n');
    const r = this.record(root, DECISIONS_FILE, { ...author, tool: 'log_decision' });
    return { id, rev: r?.rev ?? 0 };
  }
}

export class FileRevisionError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function decisionsWriteDenied(toolName: string, input: Record<string, unknown>, cwd: string, roots: FileRoot[]): string | null {
  const why = DECISIONS_FILE + ' is append-only and keeps every decision as it was made. Use log_decision to add one; to change one, log a new decision that supersedes it.';
  if (toolName === 'Bash') {
    const cmd = String(input.command ?? '');
    if (!/decisions\.md/i.test(cmd)) return null;
    const writes = [
      />>?\s*['"]?[^\s'"|;&]*decisions\.md/i,
      /\b(tee|mv|rm|cp|truncate|dd|ln)\b[^|;&]*decisions\.md/i,
      /\b(sed|perl)\b[^|;&]*\s-i[^|;&]*decisions\.md/i,
      /\b(Set-Content|Add-Content|Out-File|Remove-Item|Move-Item|Copy-Item)\b[^|;&]*decisions\.md/i,
    ];
    return writes.some((re) => re.test(cmd)) ? why : null;
  }
  const p = input.file_path ?? input.notebook_path ?? input.path;
  if (typeof p !== 'string' || !p) return null;
  const abs = path.resolve(cwd, p);
  if (path.basename(abs).toLowerCase() !== DECISIONS_FILE) return null;
  return roots.some((r) => relIn(r, abs) !== null) ? why : null;
}
