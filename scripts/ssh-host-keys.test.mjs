// node --test scripts/*.test.mjs  (also part of `pnpm test`)
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIRS = ['scripts', 'deploy', 'packages/desktop'];
const SELF = 'scripts/ssh-host-keys.test.mjs'; // names the setting in its fixtures

// `-o StrictHostKeyChecking=no`, `StrictHostKeyChecking no` (ssh_config) and its alias `off`.
const INSECURE = /StrictHostKeyChecking\s*[= ]\s*["']?(no|off)\b/i;

/**
 * Lines that name the insecure setting on purpose, as `"<file>: <trimmed line>"`: <reason>. Matching is on the
 * exact line, so moving or editing it means looking at it again.
 */
const ALLOW = {
  'packages/desktop/src-tauri/src/scan.rs: assert!(!trusted.iter().any(|a| a.eq_ignore_ascii_case("StrictHostKeyChecking=no")));':
    'a unit test asserting the scan never passes it',
  'scripts/ssh-host-keys.test.mjs: const bad = \'ssh -o StrictHostKeyChecking=no root@vps\';':
    'this test\'s own negative fixture',
};

/** `"<file>: <line>"` for every non-allowed line naming the insecure setting. */
export function insecureLines(file, text) {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => INSECURE.test(l))
    .map((l) => `${file}: ${l}`)
    .filter((k) => !(k in ALLOW));
}

describe('pr-infra.md: "Never use `StrictHostKeyChecking=no`, and never auto-accept a changed key."', () => {
  test(`no tracked file under ${DIRS.join(', ')} turns host-key checking off`, () => {
    const files = execFileSync('git', ['ls-files', '-z', '--', ...DIRS], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
    assert.ok(files.length > 0, 'git ls-files found nothing; run from a git checkout');
    const hits = [];
    for (const f of files) {
      const buf = fs.readFileSync(path.join(root, f));
      if (f === SELF || buf.includes(0)) continue; // its own fixtures; binaries
      hits.push(...insecureLines(f, buf.toString('utf8')));
    }
    assert.deepEqual(
      hits,
      [],
      `Host-key checking turned off:\n${hits.join('\n')}\n` +
        'Use `StrictHostKeyChecking=accept-new` (trust a new host once, refuse a changed key) or `yes` with a known_hosts ' +
        'file. A line that only names it to forbid it (a test) goes in ALLOW in scripts/ssh-host-keys.test.mjs.',
    );
  });

  test('the checker flags the setting in its usual spellings', () => {
    assert.equal(insecureLines('x.sh', 'ssh -o StrictHostKeyChecking=no root@vps').length, 1);
    assert.equal(insecureLines('x.sh', '  StrictHostKeyChecking off\n').length, 1);
    assert.equal(insecureLines('x.sh', 'ssh -o "StrictHostKeyChecking=No" host').length, 1);
    assert.deepEqual(insecureLines('x.sh', 'ssh -o StrictHostKeyChecking=accept-new host'), []);
  });
});
