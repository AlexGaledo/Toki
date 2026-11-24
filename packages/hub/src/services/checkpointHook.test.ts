import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { writeCheckpointHook } from './ProjectService.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@localhost', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });

function repo(withHook: boolean): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toki-hook-'));
  dirs.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  if (withHook) writeCheckpointHook(dir);
  fs.mkdirSync(path.join(dir, 'art'));
  fs.mkdirSync(path.join(dir, 'exports'));
  fs.writeFileSync(path.join(dir, 'art', 'game.blend'), 'BLENDER-v1');
  fs.writeFileSync(path.join(dir, 'exports', 'cone.fbx'), 'FBX');
  // What the bots did in the B8 A/B run: stage only the export, then commit.
  git(dir, 'add', 'exports/cone.fbx');
  git(dir, 'commit', '-q', '-m', 'checkpoint');
  return dir;
}

describe('game checkpoint hook (B8 A/B finding)', () => {
  it('a commit that staged only exports/ still carries art/<slug>.blend', () => {
    const dir = repo(true);
    expect(git(dir, 'ls-files').split('\n')).toEqual(expect.arrayContaining(['art/game.blend', 'exports/cone.fbx']));
  });

  it('a later scene change is in the next checkpoint too', () => {
    const dir = repo(true);
    fs.writeFileSync(path.join(dir, 'art', 'game.blend'), 'BLENDER-v2');
    fs.writeFileSync(path.join(dir, 'exports', 'cone.fbx'), 'FBX-2');
    git(dir, 'add', 'exports/cone.fbx');
    git(dir, 'commit', '-q', '-m', 'second');
    expect(git(dir, 'show', 'HEAD:art/game.blend')).toBe('BLENDER-v2');
  });

  it('without the hook the .blend is left out (the behaviour this fixes)', () => {
    const dir = repo(false);
    expect(git(dir, 'ls-files').split('\n')).not.toContain('art/game.blend');
  });

  it('stages only art/*.blend, nothing else the bot left unstaged', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toki-hook-'));
    dirs.push(dir);
    git(dir, 'init', '-q', '-b', 'main');
    writeCheckpointHook(dir);
    fs.mkdirSync(path.join(dir, 'art'));
    fs.writeFileSync(path.join(dir, 'art', 'game.blend'), 'B');
    fs.writeFileSync(path.join(dir, 'art', 'notes.txt'), 'scratch');
    fs.writeFileSync(path.join(dir, 'secret.env'), 'X=1');
    fs.writeFileSync(path.join(dir, 'readme.md'), 'r');
    git(dir, 'add', 'readme.md');
    git(dir, 'commit', '-q', '-m', 'c');
    expect(git(dir, 'ls-files').split('\n').filter(Boolean).sort()).toEqual(['art/game.blend', 'readme.md']);
  });
});
