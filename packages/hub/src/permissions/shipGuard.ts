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
  /** Paths a pull request changes, from `gh pr diff <args> --name-only`; null when it cannot be read. */
  prFiles?: (dir: string, args: readonly string[]) => string[] | null;
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

const ghPrFiles = (dir: string, args: readonly string[]): string[] | null => {
  try {
    return execFileSync('gh', ['pr', 'diff', ...args, '--name-only'], { cwd: dir, encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] })
      .split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  } catch {
    return null;
  }
};

const MERGE_SWITCHES = new Set(['--merge', '-m', '--squash', '-s', '--rebase', '-r', '--delete-branch', '-d', '--auto', '--disable-auto']);
const MERGE_VALUE_FLAGS = new Set(['-b', '--body', '-F', '--body-file', '-t', '--subject', '-A', '--author-email', '--match-head-commit']);
const ONLY_FLAGS = 'Merge with plain flags only (--merge, --squash, --rebase, --delete-branch, --auto, a body or subject, -R owner/repo).';

/** Parses `gh pr merge` arguments strictly, so the checks read are for exactly the pull request merged. */
export function parseMergeArgs(args: readonly string[]): { pr: string | null; repo: string | null } | string {
  let pr: string | null = null;
  let repo: string | null = null;
  const rest = args[Symbol.iterator]();
  for (const arg of rest) {
    if (arg === '-R' || arg === '--repo') repo = rest.next().value ?? '';
    else if (arg.startsWith('--repo=')) repo = arg.slice('--repo='.length);
    else if (/^-R.+/.test(arg)) repo = arg.slice(2).replace(/^=/, '');
    else if (MERGE_SWITCHES.has(arg)) continue;
    else if (MERGE_VALUE_FLAGS.has(arg)) rest.next();
    else if ([...MERGE_VALUE_FLAGS].some((f) => f.startsWith('--') && arg.startsWith(f + '='))) continue;
    else if (arg.startsWith('-')) return arg.startsWith('--admin') ? 'Merging with --admin skips branch protection, so it is left to the owner.' : ONLY_FLAGS;
    else if (pr === null) pr = arg;
    else return 'Name one pull request to merge.';
  }
  if (repo === '') return 'Name the repo after -R.';
  if (pr === null) return 'Name the pull request to merge: gh pr merge <number>.';
  return { pr, repo };
}

/**
 * Bots may merge their own pull request, but only once its checks have passed, never past branch protection, and
 * never one that changes the CI that decides whether it passed.
 */
function mergeDenied(args: readonly string[], dir: string, info: GitInfo): string | null {
  const parsed = parseMergeArgs(args);
  if (typeof parsed === 'string') return parsed;
  const select = [...(parsed.pr ? [parsed.pr] : []), ...(parsed.repo ? ['--repo', parsed.repo] : [])];
  const files = (info.prFiles ?? ghPrFiles)(dir, select);
  if (files === null) return 'Could not read what this pull request changes (gh pr diff failed). Merge only once you can.';
  if (files.some((f) => f.startsWith('.github/workflows/') || f.startsWith('.github/actions/'))) {
    return 'This pull request changes CI itself, so its checks cannot vouch for it. Ask the owner to merge it.';
  }
  switch ((info.prChecks ?? ghPrChecks)(dir, select)) {
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

// Fail closed: any mention of gh with pr and merge, in any position or nesting, must be the whole command and plain.
const MENTIONS_PR_MERGE = /\bgh(?:\.exe)?\b[\s\S]*\bpr\b[\s\S]*\bmerge\b/;
const API_MERGE = /\bgh(?:\.exe)?\b[\s\S]*\bapi\b[\s\S]*(?:\/merge\b|mergePullRequest|enablePullRequestAutoMerge)/i;
const PLAIN_PR_MERGE = /^gh pr merge((?: +[\w./:=@-]+)+)$/;

function prMergeDenied(command: string, cwd: string, info: GitInfo): string | null {
  const plain = PLAIN_PR_MERGE.exec(command.trim());
  if (!plain?.[1]) return 'Run gh pr merge <number> as the whole command, with plain arguments (no quotes, variables or other commands around it), so it can be checked.';
  return mergeDenied(plain[1].trim().split(/ +/), cwd, info);
}

export function defaultBranchPushDenied(command: string, cwd: string, info: GitInfo = realGit, extraProtected?: (remote: string) => readonly string[]): string | null {
  if (API_MERGE.test(command)) return 'Merging through gh api is left to the owner. Use gh pr merge <number> once its checks pass.';
  if (MENTIONS_PR_MERGE.test(command)) return prMergeDenied(command, cwd, info);
  let dir = cwd;
  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    const tokens = segment.trim().split(/\s+/).map(clean).filter(Boolean);
    while (tokens[0] && /^\w+=/.test(tokens[0])) tokens.shift();
    if (!tokens.length) continue;
    const [head = ''] = tokens;

    if (tokens[0] === 'cd' && tokens[1]) { dir = path.resolve(dir, tokens[1]); continue; }
    if (WRAPPERS.has(head) && /\bgit\b.*\bpush\b/.test(segment)) return 'Run git push as a plain command, not inside ' + head + ', so it can be checked.';
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
