import path from 'node:path';
import fs from 'node:fs';

const isWin = process.platform === 'win32';

function canon(p: string): string {
  const r = path.resolve(p).replace(/[\\/]+$/, '');
  return isWin ? r.toLowerCase() : r;
}
function real(p: string): string | null {
  try {
    return canon(fs.realpathSync.native(path.resolve(p)));
  } catch {
    return null;
  }
}
/** Does an entry exist at `p` (a dangling symlink counts: lstat succeeds where existsSync fails)? */
function present(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Normalize a caller-supplied path, or return null for shapes that can never be resolved safely
 * (audit 2026-09-09, B5). `path.resolve` alone is not enough on Windows:
 * - `~/x` would resolve to `<cwd>/~/x`, i.e. *inside* the workspace, while every tool that expands `~`
 *   itself reads the user's home. Always foreign.
 * - `\\?\C:\x` and `\\?\UNC\...` bypass Win32 path normalization entirely; strip the prefix or reject.
 * - `\\server\share` (UNC) is a remote path, never inside a local root.
 * - `C:foo` is *drive-relative*: it resolves against the per-drive working directory, which the hub does
 *   not control and cannot predict. Rejecting it is the only safe answer.
 */
function normalizeInput(p: string): string | null {
  let s = p.trim().replace(/^"(.*)"$/s, '$1').replace(/^'(.*)'$/s, '$1');
  if (!s) return null;
  if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) return null;
  if (isWin) {
    if (/^\\\\[?.]\\UNC\\/i.test(s)) return null;
    s = s.replace(/^\\\\[?.]\\/, '');
    if (/^[\\/]{2}/.test(s)) return null;
    if (/^[A-Za-z]:[^\\/]/.test(s)) return null;
  } else if (/^[\\/]{2}/.test(s) && s.startsWith('//')) {
    // POSIX `//host/share` is implementation-defined; treat it like a UNC path.
    return null;
  }
  return s;
}

function nearestExisting(abs: string): { dir: string; rest: string } | null {
  const parts: string[] = [];
  let cur = abs;
  for (let i = 0; i < 4096; i++) {
    if (present(cur)) return { dir: cur, rest: parts.reverse().join(path.sep) };
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    parts.push(path.basename(cur));
    cur = parent;
  }
  return null;
}

/**
 * True when `target` resolves inside (or equal to) one of `roots` by BOTH its lexical form and its realpath, so a
 * junction or symlink planted in the workspace cannot reach outside it.
 */
export function isInside(target: string, roots: string[], cwd?: string): boolean {
  const t = normalizeInput(target);
  if (t === null) return false;
  const abs = path.isAbsolute(t) ? t : path.resolve(cwd ?? process.cwd(), t);

  const rootSet = new Set<string>();
  for (const root of roots) {
    rootSet.add(canon(root));
    const rr = real(root);
    if (rr) rootSet.add(rr);
  }
  if (!rootSet.size) return false;
  const insideAny = (p: string): boolean => {
    const c = canon(p);
    for (const r of rootSet) if (c === r || c.startsWith(r + path.sep)) return true;
    return false;
  };

  if (!insideAny(abs)) return false;

  if (present(abs)) {
    const r = real(abs);
    return r !== null && insideAny(r);
  }
  const anc = nearestExisting(abs);
  if (!anc) return false;
  const rr = real(anc.dir);
  if (rr === null) return false;
  return insideAny(anc.rest ? path.join(rr, anc.rest) : rr);
}

const WILDCARD = /[*?[\]{}]/;

export function globPrefix(pattern: string): string | null {
  const m = WILDCARD.exec(pattern);
  const head = m ? pattern.slice(0, m.index) : pattern;
  if (!head) return null;
  const dir = /[\\/]$/.test(head) ? head.replace(/[\\/]+$/, '') : m ? path.dirname(head) : head;
  if (!dir || dir === '.') return null;
  return dir;
}

function looksLikeEscapingPath(s: string): boolean {
  return /(^|[\\/])\.\.([\\/]|$)/.test(s) || /^[\\/~]/.test(s) || /^[A-Za-z]:[\\/]/.test(s);
}

export function pathsFromInput(toolName: string, input: Record<string, unknown>): string[] {
  const keys = ['file_path', 'path', 'notebook_path', 'directory', 'cwd'];
  const out: string[] = [];
  for (const k of keys) {
    const v = input[k];
    if (typeof v === 'string' && v.length) out.push(v);
  }
  if (toolName === 'Glob' || toolName === 'Grep') {
    const g = input.glob;
    if (typeof g === 'string' && g.length) {
      const p = globPrefix(g);
      if (p) out.push(p);
    }
    const pat = input.pattern;
    if (typeof pat === 'string' && pat.length && (toolName === 'Glob' || looksLikeEscapingPath(pat))) {
      const p = globPrefix(pat);
      if (p) out.push(p);
    }
    if (!out.length) out.push('.');
  }
  return out;
}
