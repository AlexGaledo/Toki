// Runs deploy/room-repo-sync.sh against fake project repos cloned from a local origin.
// Needs bash and git; skips itself when either is missing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'deploy', 'room-repo-sync.sh')
const haveBash = spawnSync('bash', ['--version'], { stdio: 'ignore' }).status === 0
const haveGit = spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0
const posix = (p) => (process.platform === 'win32' ? spawnSync('cygpath', ['-u', p], { encoding: 'utf8' }).stdout.trim() : p)

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-c', 'init.defaultBranch=main', '-c', 'core.autocrlf=false', ...args], { cwd, env: ENV, encoding: 'utf8' })
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}
const commit = (cwd, msg) => {
  appendFileSync(join(cwd, 'log.txt'), `${msg}\n`)
  git(cwd, 'add', '.')
  git(cwd, 'commit', '-q', '-m', msg)
}

function setup() {
  const tmp = mkdtempSync(join(tmpdir(), 'room-sync-'))
  const origin = join(tmp, 'origin')
  mkdirSync(origin)
  git(origin, 'init', '-q')
  commit(origin, 'one')
  const projects = join(tmp, 'projects')
  const clone = (name) => {
    const dir = join(projects, 'p', 'repos', name)
    mkdirSync(dirname(dir), { recursive: true })
    git(tmp, 'clone', '-q', origin, dir)
    return dir
  }
  const repos = { behind: clone('behind'), dirty: clone('dirty'), ahead: clone('ahead'), wip: clone('wip') }
  writeFileSync(join(repos.dirty, 'log.txt'), 'edited\n')
  commit(repos.ahead, 'local only')
  git(repos.wip, 'checkout', '-q', '-b', 'wip/x')
  const noHead = join(projects, 'q', 'repos', 'nohead')
  mkdirSync(noHead, { recursive: true })
  git(noHead, 'init', '-q')
  commit(origin, 'two')
  commit(origin, 'three')
  return { tmp, origin, projects, repos }
}

const run = (projects, extra = {}) =>
  spawnSync('bash', [posix(script)], { env: { ...ENV, ROOM_REPOS_ROOT: posix(projects), ...extra }, encoding: 'utf8' })

test('fast-forwards only clean repos on the default branch with no local commits', { skip: !(haveBash && haveGit) }, () => {
  const { tmp, origin, projects, repos } = setup()
  try {
    const r = run(projects)
    assert.equal(r.status, 0, r.stderr)
    const head = git(origin, 'rev-parse', 'HEAD')
    assert.equal(git(repos.behind, 'rev-parse', 'HEAD'), head)
    assert.match(r.stdout, /updated p\/repos\/behind: 2 commits/)
    assert.match(r.stdout, /skip p\/repos\/dirty: uncommitted changes/)
    assert.equal(git(repos.dirty, 'status', '--porcelain'), 'M log.txt')
    assert.match(r.stdout, /skip p\/repos\/ahead: 1 local commits/)
    assert.equal(git(repos.ahead, 'log', '-1', '--format=%s'), 'local only')
    assert.match(r.stdout, /skip p\/repos\/wip: on wip\/x/)
    assert.equal(git(repos.wip, 'rev-parse', '--abbrev-ref', 'HEAD'), 'wip/x')
    assert.match(r.stdout, /skip q\/repos\/nohead: no origin\/HEAD/)

    const again = run(projects)
    assert.match(again.stdout, /ok p\/repos\/behind: current/)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('DRY_RUN=1 reports without moving anything', { skip: !(haveBash && haveGit) }, () => {
  const { tmp, projects, repos } = setup()
  try {
    const before = git(repos.behind, 'rev-parse', 'HEAD')
    const r = run(projects, { DRY_RUN: '1' })
    assert.match(r.stdout, /would update p\/repos\/behind: 2 behind origin\/main/)
    assert.equal(git(repos.behind, 'rev-parse', 'HEAD'), before)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
