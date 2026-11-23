import fs from 'node:fs';
import path from 'node:path';
import { botHome } from '../config.js';
import { events } from '../events.js';
import { isInside } from '../permissions/pathRules.js';

/**
 * Hard ceiling on a bot's memory.md.
 *
 * Memory is injected into the system prompt on *every* turn, and the prompt tells bots to record
 * anything durable they learn — so an append-happy bot would otherwise grow the file forever and
 * make every later turn more expensive. 8 KB is roughly 2k tokens: room for a page of real notes,
 * small enough that memory never becomes the dominant cost of a turn.
 */
export const MAX_MEMORY_BYTES = 8 * 1024;

export const TRIM_NOTE = '<!-- older notes were trimmed to keep this file small -->';

export function capMemory(text: string, limit: number = MAX_MEMORY_BYTES): { text: string; trimmed: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= limit) return { text, trimmed: false };

  const lines = text.split('\n');
  const budget = limit - Buffer.byteLength(TRIM_NOTE + '\n', 'utf8');
  const kept: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const cost = Buffer.byteLength(lines[i] + '\n', 'utf8');
    if (used + cost > budget) break;
    kept.unshift(lines[i]);
    used += cost;
  }
  if (!kept.length) kept.push(Buffer.from(lines[lines.length - 1], 'utf8').subarray(-budget).toString('utf8'));

  return { text: TRIM_NOTE + '\n' + kept.join('\n'), trimmed: true };
}

export class MemoryService {
  file(botId: string) {
    return path.join(botHome(botId), 'memory.md');
  }
  identityFile(botId: string) {
    return path.join(botHome(botId), 'CLAUDE.md');
  }
  ensureHome(botId: string) {
    fs.mkdirSync(botHome(botId), { recursive: true });
  }
  removeHome(botId: string) {
    fs.rmSync(botHome(botId), { recursive: true, force: true });
  }
  read(botId: string): string {
    try {
      return fs.readFileSync(this.file(botId), 'utf8');
    } catch {
      return '';
    }
  }
  readIdentity(botId: string): string {
    try {
      return fs.readFileSync(this.identityFile(botId), 'utf8');
    } catch {
      return '';
    }
  }
  writeIdentity(botId: string, text: string) {
    this.ensureHome(botId);
    fs.writeFileSync(this.identityFile(botId), text);
  }
  write(botId: string, text: string): boolean {
    const capped = capMemory(text);
    this.ensureHome(botId);
    fs.writeFileSync(this.file(botId), capped.text);
    events.emitEvent({ type: 'memory.updated', botId, text: capped.text });
    return capped.trimmed;
  }
  backupFile(botId: string) {
    return this.file(botId) + '.bak';
  }
  backup(botId: string, text: string) {
    this.ensureHome(botId);
    fs.writeFileSync(this.backupFile(botId), text);
  }
  append(botId: string, text: string): boolean {
    const cur = this.read(botId);
    return this.write(botId, (cur ? cur.replace(/\s+$/, '') + '\n' : '') + text.trim() + '\n');
  }
  patch(botId: string, find: string, replace: string): boolean {
    const cur = this.read(botId);
    if (!cur.includes(find)) return false;
    this.write(botId, cur.replace(find, replace));
    return true;
  }

  voiceFile(botId: string) {
    return path.join(botHome(botId), 'voice.md');
  }
  readVoice(botId: string): string {
    try {
      return fs.readFileSync(this.voiceFile(botId), 'utf8');
    } catch {
      return '';
    }
  }
  writeVoice(botId: string, text: string): boolean {
    const capped = capMemory(text, MAX_VOICE_BYTES);
    this.ensureHome(botId);
    fs.writeFileSync(this.voiceFile(botId), capped.text);
    events.emitEvent({ type: 'voice.updated', botId });
    return capped.trimmed;
  }

  notesDir(botId: string) {
    return path.join(botHome(botId), 'notes');
  }
  listNotes(botId: string): { name: string; bytes: number; mtime: number }[] {
    const dir = this.notesDir(botId);
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith('.md'));
    } catch {
      return [];
    }
    const out: { name: string; bytes: number; mtime: number }[] = [];
    for (const name of names) {
      try {
        const st = fs.lstatSync(path.join(dir, name));
        if (st.isFile()) out.push({ name, bytes: st.size, mtime: st.mtimeMs });
      } catch {
        /* vanished */
      }
    }
    return out.sort((a, b) => b.mtime - a.mtime).slice(0, MAX_NOTE_FILES);
  }
  writeNote(botId: string, title: string, text: string, mode: 'replace' | 'append' = 'replace'): { file: string; trimmed: boolean } {
    const dir = this.notesDir(botId);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, noteSlug(title) + '.md');
    if (!isInside(file, [dir])) throw new Error('Invalid note title');
    const exists = fs.existsSync(file);
    if (!exists && this.listNotes(botId).length >= MAX_NOTE_FILES) {
      throw new Error('Notes folder is full (' + MAX_NOTE_FILES + ' notes); merge or delete some first');
    }
    let body = mode === 'append' && exists
      ? fs.readFileSync(file, 'utf8').replace(/\s+$/, '') + '\n\n' + text.trim() + '\n'
      : text.trim() + '\n';
    let trimmed = false;
    if (Buffer.byteLength(body, 'utf8') > MAX_NOTE_BYTES) {
      body = Buffer.from(body, 'utf8').subarray(0, MAX_NOTE_BYTES).toString('utf8');
      trimmed = true;
    }
    fs.writeFileSync(file, body);
    return { file, trimmed };
  }
  searchNotes(botId: string, query: string, limit = 8, tag?: string): NoteHit[] {
    const terms = [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((t) => t.length >= 2))].slice(0, 12);
    const wantTag = tag?.trim().toLowerCase().replace(/^#/, '');
    if (!terms.length && !wantTag) return [];
    const dir = this.notesDir(botId);
    const hits: NoteHit[] = [];
    for (const n of this.listNotes(botId)) {
      let body = '';
      try {
        body = fs.readFileSync(path.join(dir, n.name), 'utf8').slice(0, MAX_NOTE_BYTES);
      } catch {
        continue;
      }
      if (wantTag && !noteTags(body).includes(wantTag)) continue;
      const lower = body.toLowerCase();
      const name = n.name.toLowerCase();
      if (!terms.every((t) => lower.includes(t) || name.includes(t))) continue;
      let score = 0;
      for (const t of terms) {
        score += lower.split(t).length - 1;
        if (name.includes(t)) score += 5;
      }
      const lines = body
        .split('\n')
        .filter((l) => terms.some((t) => l.toLowerCase().includes(t)))
        .slice(0, 3)
        .map((l) => l.trim().slice(0, 200));
      hits.push({ file: path.join(dir, n.name), name: n.name, score, lines });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(limit, 20)));
  }
}

export const MAX_VOICE_BYTES = 1024;
export const MAX_NOTE_BYTES = 32 * 1024;
export const MAX_NOTE_FILES = 500;

export interface NoteHit {
  file: string;
  name: string;
  score: number;
  lines: string[];
}

export function noteTags(body: string): string[] {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(body);
  if (!m) return [];
  const line = /^tags:[ \t]*(.*)$/im.exec(m[1]);
  if (!line) return [];
  return [...new Set(line[1].replace(/^\[|\]$/g, '').split(',').map((t) => t.trim().toLowerCase().replace(/^#/, '')).filter((t) => /^[\p{L}\p{N}_-]{1,32}$/u.test(t)))].slice(0, 10);
}

export function noteSlug(title: string): string {
  const s = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return s || 'note';
}
