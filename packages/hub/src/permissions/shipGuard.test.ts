import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultBranchPushDenied, type GitInfo, type PrChecks } from './shipGuard.js';

const on = (branch: string | null, remoteDefault: string | null = null): GitInfo => ({ currentBranch: () => branch, defaultBranch: () => remoteDefault });
const denied = (cmd: string, info: GitInfo = on('feature')) => defaultBranchPushDenied(cmd, '/repo', info);

describe('pushing to the default branch', () => {
  it('is refused however the target is written', () => {
    for (const cmd of [
      'git push origin main',
      'git push origin master',
      'git push -u origin main',
      'git push --force origin main',
      'git push origin +main',
      'git push origin HEAD:main',
      'git push origin feature:refs/heads/main',
      'git push origin refs/heads/main',
      'git add -A && git commit -m x && git push origin main',
      'cd /repo && git push origin main',
      'git -C /repo push origin main',
      'git -c user.name=x push origin main',
      'FOO=1 git push origin main',
      '(cd /repo && git push origin main)',
      'git push --all',
      'git push --mirror origin',
    ]) expect(denied(cmd), cmd).not.toBeNull();
  });
  it('is refused when a bare push would land on it', () => {
    for (const cmd of ['git push', 'git push origin', 'git push -u origin HEAD', 'git push origin HEAD']) expect(denied(cmd, on('main')), cmd).not.toBeNull();
  });
  it('knows a default branch with another name', () => {
    expect(denied('git push origin develop', on('feature', 'develop'))).not.toBeNull();
    expect(denied('git push', on('develop', 'develop'))).not.toBeNull();
  });
  it('asks for a named branch when it cannot tell where a push would land', () => {
    expect(denied('git push', on(null))).toMatch(/Name it/);
    expect(denied('git push origin feature', on(null))).toBeNull();
  });
  it('is refused inside a wrapper it cannot read', () => {
    expect(denied('bash -c "git push origin main"')).toMatch(/plain command/);
    expect(denied('sudo git push')).toMatch(/plain command/);
  });
});

describe('merging a pull request', () => {
  const checks = (state: PrChecks, seen: string[][] = [], files: string[] | null = ['src/a.ts']): GitInfo =>
    ({ ...on('feature'), prChecks: (_dir, args) => { seen.push([...args]); return state; }, prFiles: () => files });

  it('reads the checks of exactly the pull request merged, however the repo is written', () => {
    const seen: string[][] = [];
    for (const cmd of ['gh pr merge 3 -R me/app', 'gh pr merge 3 --repo=me/app', 'gh pr merge 3 -Rme/app', 'gh pr merge 3 -R=me/app']) {
      expect(denied(cmd, checks('pass', seen)), cmd).toBeNull();
    }
    expect(seen).toEqual(Array(4).fill(['3', '--repo', 'me/app']));
  });
  it('refuses spellings and flags it does not know, two pull requests, and environment overrides', () => {
    for (const cmd of [
      'gh pr merge 3 --admin=true', 'gh pr merge 3 --admin', 'gh pr merge 3 --unknown', 'gh pr merge 3 4',
      'GH_REPO=other/app gh pr merge 3', 'gh -R other/app pr merge 3', 'bash -c "gh pr merge 3"',
      'gh pr merge', 'gh pr merge 3 -b "a; b"', 'gh pr merge $(echo 3)', 'gh pr merge 3 & gh pr merge 4', '{ gh pr merge 3; }',
      'cd ../other && gh pr merge 3', 'echo `gh pr merge 3`', 'gh pr merge 3\nrm -rf x', '/usr/bin/gh pr merge 3',
      'gh api -X PUT repos/me/app/pulls/3/merge', "gh api graphql -f query='mutation { mergePullRequest(input: {}) { clientMutationId } }'",
    ]) expect(denied(cmd, checks('pass')), cmd).not.toBeNull();
  });
  it('refuses a merge after a push or commit in the same command', () => {
    expect(denied('git push origin feature && gh pr merge 3', checks('pass'))).toMatch(/whole command/);
    expect(denied('git commit -am x; gh pr merge 3', checks('pass'))).toMatch(/whole command/);
  });
  it('refuses a pull request that changes CI, or whose changes cannot be read', () => {
    expect(denied('gh pr merge 3', checks('pass', [], ['src/a.ts', '.github/workflows/ci.yml']))).toMatch(/changes CI/);
    expect(denied('gh pr merge 3', checks('pass', [], null))).toMatch(/Could not read what/);
  });

  it('is allowed once its checks pass, asking gh about the same pull request and repo', () => {
    const seen: string[][] = [];
    expect(denied('gh pr merge 12 --squash --delete-branch', checks('pass', seen))).toBeNull();
    expect(denied('gh pr merge -R me/app --merge 7', checks('pass', seen))).toBeNull();
    expect(seen).toEqual([['12'], ['7', '--repo', 'me/app']]);
  });
  it('is refused while checks run, after they fail, without any, or when gh cannot tell', () => {
    expect(denied('gh pr merge 12', checks('pending'))).toMatch(/still running/);
    expect(denied('gh pr merge 12', checks('fail'))).toMatch(/failed/);
    expect(denied('gh pr merge 12', checks('none'))).toMatch(/no checks/);
    expect(denied('gh pr merge 12', checks('unknown'))).toMatch(/Could not read/);
  });
  it('never skips branch protection with --admin', () => {
    expect(denied('gh pr merge 12 --admin', checks('pass'))).toMatch(/--admin/);
  });
  it('leaves other gh pr commands alone', () => {
    expect(denied('gh pr create --fill', checks('fail'))).toBeNull();
  });
});

describe('ordinary work', () => {
  it('is left alone', () => {
    for (const cmd of [
      'git push origin feature',
      'git push -u origin fix/main-menu',
      'git push origin feature:feature',
      'git push',
      'git push origin HEAD',
      'git push -o ci.skip origin feature',
      'git status',
      'git commit -m "push to main later"',
      'git pull origin main',
      'git fetch origin main',
      'git checkout main',
      'grep -r "git push origin main" docs',
      'npm test',
    ]) expect(denied(cmd), cmd).toBeNull();
  });
});

describe('against a real repo', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-shipguard-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  const g = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-C', dir, ...a], { stdio: 'ignore' });
  g('init', '-q', '-b', 'main');
  g('commit', '-q', '--allow-empty', '-m', 'init');

  it('reads the checked out branch, and follows cd and -C to it', () => {
    expect(defaultBranchPushDenied('git push', dir)).not.toBeNull();
    expect(defaultBranchPushDenied('cd ' + dir.replaceAll('\\', '/') + ' && git push', os.tmpdir())).not.toBeNull();
    expect(defaultBranchPushDenied('git -C ' + dir.replaceAll('\\', '/') + ' push', os.tmpdir())).not.toBeNull();
    g('checkout', '-q', '-b', 'feature');
    expect(defaultBranchPushDenied('git push', dir)).toBeNull();
  });
  it('asks for a branch outside any repo', () => {
    expect(defaultBranchPushDenied('git push', path.join(dir, '.git', 'hooks', 'nowhere'))).toMatch(/Name it/);
  });
});

describe('a repo\'s protected branches (repos.json)', () => {
  const remotes: Record<string, string> = { origin: 'git@github.com:Org/app.git', fork: 'https://github.com/someone/fork.git' };
  const info: GitInfo = { currentBranch: () => 'feature', defaultBranch: () => null, remoteUrl: (_d, r) => remotes[r] ?? null };
  const extra = (remote: string) => (remote.toLowerCase().includes('org/app') ? ['staging', 'release/1.x'] : []);
  const d = (cmd: string, i: GitInfo = info) => defaultBranchPushDenied(cmd, '/repo', i, extra);

  it('blocks a push to a listed branch when origin is that repo, however it is spelled', () => {
    for (const cmd of [
      'git push origin staging',
      'git push -u origin staging',
      'git push --force origin +staging',
      'git push origin HEAD:staging',
      'git push origin feature:refs/heads/release/1.x',
      'git push origin :staging',
      'git push --delete origin staging',
      'git push https://github.com/Org/app staging',
      'git push ssh://git@github.com/Org/app.git staging',
    ]) expect(d(cmd), cmd).not.toBeNull();
    expect(d('git push', { ...info, currentBranch: () => 'staging' })).not.toBeNull();
  });
  it('leaves other branches, other remotes and the unlisted case alone', () => {
    expect(d('git push origin feature')).toBeNull();
    expect(d('git push origin staging-fix')).toBeNull();
    expect(d('git push fork staging')).toBeNull();
    expect(d('git push https://github.com/someone/fork staging')).toBeNull();
    expect(defaultBranchPushDenied('git push origin staging', '/repo', info)).toBeNull();
    expect(d('git push origin main')).not.toBeNull();
  });
});
