// I4: the Blender server script and its hashed requirements reach every place the hub runs from.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HUB_RESOURCES, copyHubResources } from './hub-resources.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HUB = path.join(ROOT, 'packages', 'hub');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hub-resources-'));

test('the hub source has both resources', () => {
  assert.deepEqual(HUB_RESOURCES.sort(), ['resources/blender/requirements.txt', 'resources/blender/toki_blender_server.py']);
  for (const rel of HUB_RESOURCES) assert.ok(fs.statSync(path.join(HUB, rel)).size > 0, rel);
});

test('copyHubResources puts both files into the build, byte for byte', () => {
  const build = tmp();
  try {
    copyHubResources(HUB, build);
    for (const rel of HUB_RESOURCES) {
      assert.ok(fs.readFileSync(path.join(build, rel)).equals(fs.readFileSync(path.join(HUB, rel))), rel);
    }
  } finally {
    fs.rmSync(build, { recursive: true, force: true });
  }
});

test('a missing resource fails the bundle instead of shipping without it', () => {
  const hub = tmp();
  const build = tmp();
  try {
    fs.mkdirSync(path.join(hub, 'resources', 'blender'), { recursive: true });
    fs.writeFileSync(path.join(hub, 'resources', 'blender', 'toki_blender_server.py'), 'print(1)\n');
    assert.throws(() => copyHubResources(hub, build), /requirements\.txt/);
    assert.equal(fs.existsSync(path.join(build, 'resources')), false);
  } finally {
    fs.rmSync(hub, { recursive: true, force: true });
    fs.rmSync(build, { recursive: true, force: true });
  }
});

test('build-hub.mjs copies the resources after it empties the build folder', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'build-hub.mjs'), 'utf8');
  const call = src.indexOf('copyHubResources(HUB, BUILD)');
  const cleanup = src.indexOf("entry !== 'node_modules' && entry !== 'package.json'");
  assert.ok(call > 0, 'build-hub.mjs never calls copyHubResources(HUB, BUILD)');
  assert.ok(cleanup > 0 && call > cleanup, 'the copy must run after the cleanup that deletes everything else');
});

test('Tauri ships packages/hub/build as <install>/hub, so the files sit at <HUB_DIR>/resources/blender', () => {
  const conf = JSON.parse(fs.readFileSync(path.join(ROOT, 'packages', 'desktop', 'src-tauri', 'tauri.conf.json'), 'utf8'));
  assert.equal(conf.bundle.resources['../../hub/build/'], 'hub/');
});

// GNU tar's --exclude matches any trailing run of path components, and `*` may cross `/`. An excluded folder
// takes everything under it, so every ancestor of the file is checked too.
function excludedByTar(pattern, rel) {
  const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
  const parts = rel.split('/');
  for (let end = 1; end <= parts.length; end++) {
    for (let start = 0; start < end; start++) if (re.test(parts.slice(start, end).join('/'))) return true;
  }
  return false;
}

test('scripts/deploy.sh ships the resources to the VPS, where the service runs from packages/hub', () => {
  const sh = fs.readFileSync(path.join(ROOT, 'scripts', 'deploy.sh'), 'utf8');
  const excludes = [...sh.matchAll(/--exclude=('([^']*)'|(\S+))/g)].map((m) => m[2] ?? m[3]);
  assert.ok(excludes.includes('node_modules') && excludes.includes('dist'), `parsed: ${excludes.join(' ')}`);
  for (const rel of HUB_RESOURCES) {
    const shipped = `packages/hub/${rel}`;
    for (const ex of excludes) assert.equal(excludedByTar(ex, shipped), false, `--exclude=${ex} drops ${shipped}`);
  }
  // Sanity check of the matcher itself.
  assert.equal(excludedByTar('packages/*/node_modules', 'packages/hub/node_modules/x/y.js'), true);
  assert.equal(excludedByTar('dist', 'packages/hub/dist/hub.mjs'), true);
  assert.equal(excludedByTar('resources', 'packages/hub/resources/blender/requirements.txt'), true);
  assert.equal(excludedByTar('packages/web/dist', 'packages/hub/resources/blender/requirements.txt'), false);
  const unit = fs.readFileSync(path.join(ROOT, 'deploy', 'pocketrocket.service'), 'utf8');
  assert.match(unit, /^WorkingDirectory=.*\/packages\/hub$/m);
});
