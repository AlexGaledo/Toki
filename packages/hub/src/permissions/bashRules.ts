import path from 'node:path';
import { deleteGate } from './deleteGate.js';
import { isInside } from './pathRules.js';

export type BashVerdict = { verdict: 'allow' | 'ask'; danger: boolean; reason: string };

const READ_ONLY = new Set([
  'ls', 'dir', 'cat', 'type', 'head', 'tail', 'grep', 'rg', 'pwd', 'echo', 'wc', 'sort', 'uniq', 'tree',
]);
const READERS = new Set(['ls', 'dir', 'cat', 'type', 'head', 'tail', 'grep', 'rg', 'wc']);
const GIT_READ_ONLY = new Set(['status', 'log', 'diff']);
const EXEC_OPTS: Record<string, string[]> = {
  rg: ['pre', 'pre-glob'],
  sort: ['compress-program'],
  git: ['ext-diff', 'textconv'],
};
const WRITE_OPTS: Record<string, string[]> = {
  sort: ['output'],
  git: ['output'],
  tree: ['output'],
};
const WRITE_SHORT: Record<string, string> = { sort: 'o', tree: 'o' };

function namesOpt(tok: string, opts: string[] | undefined): boolean {
  if (!opts || !tok.startsWith('--')) return false;
  const name = tok.slice(2).split('=')[0];
  return !!name && opts.some((o) => o.startsWith(name));
}

const ENV_DUMPERS = new Set(['env', 'printenv', 'set', 'export', 'Get-ChildItem env:', 'gci']);

const INTERPRETERS = new Set([
  'node', 'nodejs', 'tsx', 'ts-node', 'deno', 'bun', 'bunx', 'python', 'python2', 'python3', 'py', 'ruby',
  'perl', 'php', 'awk', 'gawk', 'mawk', 'sed', 'xargs', 'find', 'eval', 'source', '.', 'sh', 'bash', 'zsh',
  'dash', 'ksh', 'fish', 'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe', 'npx', 'pnpx',
  'npm', 'pnpm', 'yarn', 'make', 'cargo', 'go', 'dotnet', 'java', 'docker', 'ssh', 'Invoke-Expression', 'iex',
]);

const DANGER: RegExp[] = [
  /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*|--recursive)\b/,
  /Remove-Item\b[^|;&]*-Recurse/i,
  /\bdel\s+\/[sq]/i,
  /\brmdir\s+\/s/i,
  /\bformat\b/i,
  /\bshutdown\b/i,
  /\breg\s+(add|delete)\b/i,
  /\bdiskpart\b/i,
  /\bgit\s+push\b/i,
  /\bgit\s+reset\s+--hard/i,
  /\bgit\s+clean\s+-[a-zA-Z]*f/i,
  /\bgit\s+checkout\s+--\s/i,
  /\b(curl|wget|iwr|Invoke-WebRequest)\b[^|]*\|\s*(sh|bash|zsh|iex|Invoke-Expression|powershell|pwsh)\b/i,
  /\bnpm\s+publish\b/i,
  /\bsudo\b/,
  /\bchmod\s+-R\s+777/,
  /\bmkfs\b/,
];

export function segments(cmd: string): string[] {
  return cmd
    .split(/\s*(?:&&|\|\||;|\|)\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function tokenize(seg: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let has = false;
  for (const ch of seg) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur || has) out.push(cur);
      cur = '';
      has = false;
      continue;
    }
    cur += ch;
  }
  if (cur || has) out.push(cur);
  return out;
}

function redirectTarget(tok: string, next: string | undefined): { target: string | null; consumesNext: boolean } | null {
  const m = /^(\d*)(>>|>|<)(.*)$/.exec(tok);
  if (!m) return null;
  const rest = m[3];
  if (rest.startsWith('&')) return { target: null, consumesNext: false };
  if (rest) return { target: rest, consumesNext: false };
  return { target: next ?? null, consumesNext: true };
}

const isFlag = (t: string) => t.startsWith('-') && t !== '-';

function baseName(cmd: string): string {
  const b = path.basename(cmd.replace(/\\/g, '/'));
  return process.platform === 'win32' ? b.replace(/\.(exe|cmd|bat|ps1)$/i, '') : b;
}

export function classifyBash(cmd: string, allowedRoots: string[] = [], opts: { readOnlyRoots?: string[] } = {}): BashVerdict {
  for (const d of DANGER) if (d.test(cmd)) return { verdict: 'ask', danger: true, reason: 'Dangerous pattern: ' + d.source };

  const segs = segments(cmd);
  if (!segs.length) return { verdict: 'ask', danger: false, reason: 'Empty command' };
  const del = deleteGate(cmd, allowedRoots[0] ?? process.cwd());
  if (del) return { verdict: 'ask', ...del };
  if (!allowedRoots.length) return { verdict: 'ask', danger: false, reason: 'No workspace roots configured' };

  let cwd = allowedRoots[0];
  const outside = (p: string) => !isInside(p, allowedRoots, cwd);
  const readOnly = opts.readOnlyRoots ?? [];
  const readable = (p: string) => readOnly.length > 0 && isInside(p, [...allowedRoots, ...readOnly], cwd);

  for (const seg of segs) {
    const toks = tokenize(seg);
    if (!toks.length) continue;

    const args: string[] = [];
    let redirected = false;
    for (let i = 0; i < toks.length; i++) {
      const r = redirectTarget(toks[i], toks[i + 1]);
      if (!r) {
        args.push(toks[i]);
        continue;
      }
      if (r.consumesNext) i++;
      if (r.target === '/dev/null') continue;
      redirected = true;
      if (r.target && outside(r.target)) {
        return { verdict: 'ask', danger: false, reason: 'Writes outside workspace: ' + r.target };
      }
    }
    if (!args.length) continue;

    const cmdName = baseName(args[0]);
    const rest = args.slice(1);

    if (cmdName === 'cd') {
      const target = rest.find((t) => !isFlag(t));
      if (!target) continue;
      if (outside(target) && !readable(target)) return { verdict: 'ask', danger: false, reason: 'cd outside workspace: ' + target };
      cwd = path.resolve(cwd, target);
      continue;
    }

    if (ENV_DUMPERS.has(cmdName) || ENV_DUMPERS.has(args[0])) {
      return { verdict: 'ask', danger: false, reason: 'Reads the process environment: ' + cmdName };
    }
    if (INTERPRETERS.has(cmdName) || INTERPRETERS.has(args[0])) {
      return { verdict: 'ask', danger: false, reason: 'Can execute arbitrary code: ' + cmdName };
    }
    if (cmdName === 'git') {
      const subAt = rest.findIndex((t) => !isFlag(t));
      const sub = subAt < 0 ? undefined : rest[subAt];
      if (!sub || !GIT_READ_ONLY.has(sub)) {
        return { verdict: 'ask', danger: false, reason: 'git ' + (sub ?? '(no subcommand)') + ' is not read-only' };
      }
      const globals = rest.slice(0, subAt).filter((t) => t !== '--no-pager' && t !== '-P');
      if (globals.length) return { verdict: 'ask', danger: false, reason: 'git global option: ' + globals[0] };
    } else if (!READ_ONLY.has(cmdName)) {
      return { verdict: 'ask', danger: false, reason: 'Not on allowlist: ' + seg.slice(0, 60) };
    }
    for (const t of rest) {
      if (namesOpt(t, EXEC_OPTS[cmdName])) {
        return { verdict: 'ask', danger: false, reason: 'Can execute arbitrary code: ' + cmdName + ' ' + t.split('=')[0] };
      }
      const short = WRITE_SHORT[cmdName];
      if (namesOpt(t, WRITE_OPTS[cmdName]) || (short && /^-[a-zA-Z]+/.test(t) && t.slice(1).includes(short))) {
        return { verdict: 'ask', danger: false, reason: cmdName + ' writes a file: ' + t };
      }
    }
    if (cmdName === 'echo' && redirected) {
      return { verdict: 'ask', danger: false, reason: 'echo writes to a file' };
    }

    for (const raw of rest) {
      const eq = raw.startsWith('--') ? raw.indexOf('=') : -1;
      if (eq < 0 && isFlag(raw)) continue;
      const t = eq > 0 ? raw.slice(eq + 1) : raw;
      if (eq > 0 && !/[\\/]|^[.~]/.test(t)) continue;
      if (outside(t) && !(READERS.has(cmdName) && readable(t))) {
        return { verdict: 'ask', danger: false, reason: 'References path outside workspace: ' + t };
      }
    }
  }
  return { verdict: 'allow', danger: false, reason: 'Allowlisted' };
}

export function bashWritesReadOnly(cmd: string, cwd: string, readOnlyRoots: string[]): string | null {
  if (!readOnlyRoots.length) return null;
  const inRo = (p: string) => isInside(p, readOnlyRoots, cwd);
  const norm = (s: string) => {
    const t = s.replace(/\\/g, '/');
    return process.platform === 'win32' ? t.toLowerCase() : t;
  };
  const roNames = readOnlyRoots.map((r) => norm(path.resolve(r)));
  for (const seg of segments(cmd)) {
    const toks = tokenize(seg);
    const args: string[] = [];
    for (let i = 0; i < toks.length; i++) {
      const m = /^(\d*)(>>|>|<)(.*)$/.exec(toks[i]);
      if (!m) {
        args.push(toks[i]);
        continue;
      }
      const target = m[3] || toks[i + 1];
      if (!m[3]) i++;
      if (m[2] !== '<' && target && !target.startsWith('&') && inRo(target)) return target;
    }
    if (!args.length) continue;
    const name = baseName(args[0]);
    const rest = args.slice(1);
    if (name === 'cd') {
      const target = rest.find((t) => !isFlag(t));
      if (target) cwd = path.resolve(cwd, target);
      continue;
    }
    const opts = rest.filter((t) => namesOpt(t, EXEC_OPTS[name]) || namesOpt(t, WRITE_OPTS[name]));
    const gitRead = name === 'git' && GIT_READ_ONLY.has(rest.find((t) => !isFlag(t)) ?? '');
    if ((READERS.has(name) || gitRead) && !opts.length) continue;
    if (inRo(cwd)) return cwd;
    for (const raw of rest) {
      const eq = raw.startsWith('--') ? raw.indexOf('=') : -1;
      const t = eq > 0 ? raw.slice(eq + 1) : raw;
      if ((eq > 0 || !isFlag(t)) && t && inRo(t)) return t;
    }
    const s = norm(seg);
    const hit = roNames.find((r) => s.includes(r));
    if (hit) return hit;
  }
  return null;
}
