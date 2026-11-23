// Unit tests for scripts/control-toki.mjs: argument parsing, port picking and the throwaway-root guard.
// No browser, hub or network beyond binding 127.0.0.1, so they run in CI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  parseArgs, pickFreePorts, freePort, assertThrowawayRoot, defaultRoot, buildHubEnv, evidencePath,
  redactToken, redactSecrets, unmangleMsysPath, parseScope, stamp,
} from './control-toki.mjs';

test('parseArgs: command, positionals, valued and boolean flags', () => {
  assert.deepEqual(parseArgs(['click', '--role', 'button', '--name', 'New group chat', '--exact']), {
    cmd: 'click', positional: [], flags: { role: 'button', name: 'New group chat', exact: true },
  });
  assert.deepEqual(parseArgs(['api', 'POST', '/api/rooms', '{"a":1}']), { cmd: 'api', positional: ['POST', '/api/rooms', '{"a":1}'], flags: {} });
  assert.deepEqual(parseArgs(['fill', '--value=a=b', '--nth', '1']).flags, { value: 'a=b', nth: '1' });
  assert.deepEqual(parseArgs(['screenshot', 'x.png', '--full']), { cmd: 'screenshot', positional: ['x.png'], flags: { full: true } });
  assert.equal(parseArgs([]).cmd, 'help');
});

test('parseArgs: boolean flags never swallow the next word, valued flags demand one', () => {
  assert.deepEqual(parseArgs(['launch', '--headed', 'extra']), { cmd: 'launch', positional: ['extra'], flags: { headed: true } });
  assert.throws(() => parseArgs(['fill', '--value']), /--value needs a value/);
  assert.throws(() => parseArgs(['fill', '--name', '--exact']), /--name needs a value/);
  assert.deepEqual(parseArgs(['api', 'GET', '--', '--odd']).positional, ['GET', '--odd']);
});

test('pickFreePorts: distinct, bindable on loopback, avoids the dev defaults', async () => {
  const ports = await pickFreePorts(4);
  assert.equal(ports.length, 4);
  assert.equal(new Set(ports).size, 4);
  for (const p of ports) {
    assert.ok(![7788, 7789, 5173, 9222].includes(p));
    await new Promise((resolve, reject) => {
      const s = net.createServer().once('error', reject);
      s.listen(p, '127.0.0.1', () => s.close(resolve));
    });
  }
});

test('freePort: never returns a port that is in use', async () => {
  const held = net.createServer();
  await new Promise((r) => held.listen(0, '127.0.0.1', r));
  const busy = held.address().port;
  try {
    for (let i = 0; i < 5; i++) assert.notEqual(await freePort(), busy);
  } finally {
    held.close();
  }
});

test('assertThrowawayRoot: only strict subfolders of tmp, never a real data dir or the repo', () => {
  const tmp = path.join(os.tmpdir(), 'ct-test-tmp');
  const repoRoot = path.join(os.tmpdir(), 'ct-test-tmp', 'repo');
  const env = {};
  assert.equal(assertThrowawayRoot(path.join(tmp, 'run1'), { tmp, env, repoRoot }), path.join(tmp, 'run1'));
  assert.throws(() => assertThrowawayRoot(tmp, { tmp, env, repoRoot }), /inside/);
  assert.throws(() => assertThrowawayRoot(path.join(os.homedir(), 'toki'), { tmp, env, repoRoot }), /inside/);
  assert.throws(() => assertThrowawayRoot(path.join(repoRoot, 'data', 'x'), { tmp, env, repoRoot }), /overlaps/);
  assert.throws(() => assertThrowawayRoot(path.join(tmp, 'real'), { tmp, env: { POCKETROCKET_DATA: path.join(tmp, 'real', 'data') }, repoRoot }), /overlaps/);
  assert.throws(() => assertThrowawayRoot(path.join(tmp, 'x', '..', '..', 'escape'), { tmp, env, repoRoot }), /inside/);
});

test('defaultRoot: per checkout under tmp, overridable', () => {
  const a = defaultRoot({}, '/t', '/repo/a');
  const b = defaultRoot({}, '/t', '/repo/b');
  assert.notEqual(a, b);
  assert.match(path.basename(a), /^toki-verify-[0-9a-f]{8}$/);
  assert.equal(defaultRoot({ TOKI_VERIFY_ROOT: '/t/mine' }, '/t', '/repo/a'), path.resolve('/t/mine'));
});

test('buildHubEnv: drops inherited data/token/port/.env settings and sets the run values', () => {
  const env = buildHubEnv(
    { PATH: 'p', POCKETROCKET_DATA: '/real', POCKETROCKET_TOKEN: 'x', POCKETROCKET_BYPASS_PERMISSIONS: '1', PORT: '7788', HUB_URL: 'http://vps', SCREEN_URL: 'http://vps', DOTENV_CONFIG_OVERRIDE: 'true' },
    { dataDir: '/tmp/r/data', port: 5001, workspacePort: 5002, token: 't', dotenvPath: '/tmp/r/no.env' },
  );
  assert.equal(env.PATH, 'p');
  assert.equal(env.POCKETROCKET_DATA, '/tmp/r/data');
  assert.equal(env.POCKETROCKET_TOKEN, 't');
  assert.equal(env.PORT, '5001');
  assert.equal(env.WORKSPACE_WEB_PORT, '5002');
  assert.equal(env.DOTENV_CONFIG_PATH, '/tmp/r/no.env');
  for (const k of ['POCKETROCKET_BYPASS_PERMISSIONS', 'HUB_URL', 'SCREEN_URL', 'DOTENV_CONFIG_OVERRIDE', 'POCKETROCKET_WEB_DIST']) assert.equal(env[k], undefined, k);
});

test('evidence paths, scopes, stamps', () => {
  assert.equal(evidencePath('/e', 'a/b.png'), path.join('/e', 'a/b.png'));
  assert.equal(evidencePath('/e', path.resolve('/abs.png')), path.resolve('/abs.png'));
  assert.deepEqual(parseScope('tabpanel:Skills'), { role: 'tabpanel', name: 'Skills' });
  assert.deepEqual(parseScope('dialog:Delete: are you sure?'), { role: 'dialog', name: 'Delete: are you sure?' });
  assert.equal(parseScope(undefined), null);
  assert.throws(() => parseScope('Skills'), /role:name/);
  assert.match(stamp(new Date(2026, 10, 24, 1, 2, 3)), /^20261124-010203$/);
});

test('redaction: the hub token and secret-looking JSON fields never print', () => {
  const tok = 'a'.repeat(32);
  assert.equal(redactToken('http://127.0.0.1:1/#token=' + tok, tok), 'http://127.0.0.1:1/#token=<redacted>');
  assert.equal(redactToken('Bearer ' + tok, tok), 'Bearer <token>');
  assert.equal(redactSecrets('{"token": "x\\"y", "deviceToken":"q", "name":"ok", "tokenCount": 3}'), '{"token": "<redacted>", "deviceToken":"<redacted>", "name":"ok", "tokenCount": 3}');
});

test('unmangleMsysPath: undoes Git Bash path conversion only', () => {
  assert.equal(unmangleMsysPath('C:/Program Files/Git/api/rooms'), '/api/rooms');
  assert.equal(unmangleMsysPath('C:\\Program Files\\Git\\api\\rooms'), '/api/rooms');
  assert.equal(unmangleMsysPath('C:/Program Files/Git/'), '/');
  assert.equal(unmangleMsysPath('/api/rooms'), '/api/rooms');
  assert.equal(unmangleMsysPath('C:/Users/me/shot.png'), 'C:/Users/me/shot.png');
});
