import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { normaliseRemote } from '@pocketrocket/shared';

export const SHIP_GUARD_SKILL = 'safe-shipping';

const ALWAYS_PROTECTED = new Set(['main', 'master']);
const PUSH_VALUE_FLAGS = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec']);
const WRAPPERS = new Set(['bash', 'sh', 'zsh', 'eval', 'xargs', 'env', 'sudo', 'nohup', 'time']);

export interface GitInfo {
  currentBranch: (dir: string) => string | null;
  defaultBranch: (dir: string) => string | null;
  remoteUrl?: (dir: string, remote: string) => string | null;
  /** State of a pull request's checks, from `gh pr checks <args>` run in dir. */
  prChecks?: (dir: string, args: readonly string[]) => PrChecks;
}

export type PrChecks = 'pass' | 'pending' | 'fail' | 'none' | 'unknown';

const ghPrChecks = (dir: string, args: readonly string[]): PrChecks => {
  try {
    execFileSync('gh', ['pr', 'checks', ...args], { cwd: dir, encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] });
    return 'pass';
  } catch (e) {
    const err = e as { status?: number | null; stderr?: string; stdout?: string };
    if (err.status === 8) return 'pending';
    if (/no checks reported/i.test((err.stderr ?? '') + (err.stdout ?? ''))) return 'none';
    return err.status === 1 ? 'fail' : 'unknown';
  }
};

const MERGE_SELECTOR_FLAGS = new Set(['-R', '--repo']);
const MERGE_VALUE_FLAGS = new Set(['-b', '--body', '-F', '--body-file', '-t', '--subject', '-A', '--author-email', '--match-head-commit']);

/** Bots may merge their own pull request, but only once its checks have passed, and never past branch protection. */
function mergeDenied(args: readonly string[], dir: string, info: GitInfo): string | null {
  if (args.some((a) => a === '--admin')) return 'Merging with --admin skips branch protection, so it is left to the owner.';
  let pr: string | null = null;
  const repo: string[] = [];
  const rest = args[Symbol.iterator]();
  for (const arg of rest) {
    if (MERGE_SELECTOR_FLAGS.has(arg)) repo.push('--repo', rest.next().value ?? '');
    else if (arg.startsWith('--repo=')) repo.push(arg);
    else if (!arg.startsWith('-') && pr === null) pr = arg;
    else if (MERGE_VALUE_FLAGS.has(arg)) rest.next();
  }
  switch ((info.prChecks ?? ghPrChecks)(dir, [...(pr ? [pr] : []), ...repo])) {
    case 'pass': return null;
    case 'pending': return 'The checks on this pull request are still running. Wait with gh pr checks --watch, then merge.';
    case 'fail': return 'The checks on this pull request failed. Fix them, push, and merge once they pass.';
    case 'none': return 'This pull request has no checks, so nothing proves it works. Add a CI check, or ask the owner to merge it.';
    default: return 'Could not read the checks on this pull request (gh pr checks failed). Merge only once they pass.';
  }
}

const git = (dir: string, ...args: string[]): string | null => {
  try {
    return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
};
const realGit: GitInfo = {
  currentBranch: (dir) => git(dir, 'symbolic-ref', '--short', 'HEAD'),
  defaultBranch: (dir) => git(dir, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD')?.replace(/^origin\//, '') ?? null,
  remoteUrl: (dir, remote) => (/^[\w.-]+$/.test(remote) ? git(dir, 'remote', 'get-url', remote) : null),
};

const clean = (t: string) => t.replace(/^['"(]+|['")]+$/g, '');
const REFUSED = 'Pushing to the default branch is blocked for this bot. Push a branch, open a pull request, and merge it once its checks pass.';

export function defaultBranchPushDenied(command: string, cwd: string, info: GitInfo = realGit, extraProtected?: (remote: string) => readonly string[]): string | null {
  let dir = cwd;
  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    const tokens = segment.trim().split(/\s+/).map(clean).filter(Boolean);
    while (tokens[0] && /^\w+=/.test(tokens[0])) tokens.shift();
    if (!tokens.length) continue;

    if (tokens[0] === 'cd' && tokens[1]) { dir = path.resolve(dir, tokens[1]); continue; }
    if (tokens[0] === 'gh' && tokens[1] === 'pr' && tokens[2] === 'merge') {
      const why = mergeDenied(tokens.slice(3), dir, info);
      if (why) return why;
      continue;
    }
    if (WRAPPERS.has(tokens[0]) && /\bgit\b.*\bpush\b/.test(segment)) return 'Run git push as a plain command, not inside ' + tokens[0] + ', so it can be checked.';
    if (tokens[0] !== 'git') continue;

    let i = 1;
    let at = dir;
    while (i < tokens.length && tokens[i].startsWith('-')) {
      if (tokens[i] === '-C') { at = path.resolve(dir, tokens[i + 1] ?? '.'); i += 2; }
      else if (tokens[i] === '-c' || tokens[i] === '--git-dir' || tokens[i] === '--work-tree') i += 2;
      else i += 1;
    }
    if (tokens[i] !== 'push') continue;

    const args = tokens.slice(i + 1);
    const positional: string[] = [];
    for (let a = 0; a < args.length; a++) {
      if (args[a] === '--all' || args[a] === '--mirror') return REFUSED;
      if (PUSH_VALUE_FLAGS.has(args[a])) { a += 1; continue; }
      if (!args[a].startsWith('-')) positional.push(args[a]);
    }

    const current = info.currentBranch(at);
    const protectedNames = new Set(ALWAYS_PROTECTED);
    const remoteDefault = info.defaultBranch(at);
    if (remoteDefault) protectedNames.add(remoteDefault);
    if (extraProtected) {
      const named = positional[0];
      const url = named && normaliseRemote(named) ? named : info.remoteUrl?.(at, named ?? 'origin') ?? null;
      for (const b of url ? extraProtected(url) : []) protectedNames.add(b);
    }

    const refs = positional.slice(1);
    if (!refs.length) {
      if (current === null) return 'Could not tell which branch this would push. Name it: git push origin <branch>.';
      if (protectedNames.has(current)) return REFUSED;
      continue;
    }
    for (const ref of refs) {
      const spec = ref.replace(/^\+/, '');
      let target = spec.includes(':') ? spec.slice(spec.indexOf(':') + 1) : spec;
      target = target.replace(/^refs\/heads\//, '');
      if (target === 'HEAD') {
        if (current === null) return 'Could not tell which branch this would push. Name it: git push origin <branch>.';
        target = current;
      }
      if (protectedNames.has(target)) return REFUSED;
    }
  }
  return null;
}
