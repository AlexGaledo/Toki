import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { checkChangelog } from './changelog-guard.mjs';

const KNOWN_MIXED = new Set([
  'packages/hub/test-fixtures/opencode/auth-list.txt',
  'packages/web/src/components/ProjectHeader.test.tsx',
  'packages/web/src/components/dialogs/SettingsDialog.tsx',
  'packages/web/src/components/settings/SecuritySection.tsx',
  'packages/web/src/components/ui.tsx',
]);

test('no file newly mixes CRLF and LF line endings', () => {
  const out = execFileSync('git', ['ls-files', '--eol'], { encoding: 'utf8' });
  const mixed = out.split('\n').filter((l) => l.startsWith('i/mixed')).map((l) => l.split('\t')[1]);
  const fresh = mixed.filter((f) => !KNOWN_MIXED.has(f));
  assert.deepEqual(fresh, [], 'These files now mix CRLF and LF. Keep each file\'s existing line endings: in Python open with newline="" and write back the endings you read; prefer the Edit tool over scripts.');
});

const BASE = '# Changelog\n\n## [Unreleased]\n\n### A\n- a\n\n## [1.0.0] - 2026-01-01\n\n### B\n- b\n\n### C\n- c\n';

test('changelog: editing Unreleased is fine', () => {
  assert.equal(checkChangelog(BASE, BASE.replace('- a\n', '- a\n- a2\n')), null);
});

test('changelog: cutting a release is fine', () => {
  assert.equal(checkChangelog(BASE, BASE.replace('## [Unreleased]\n', '## [Unreleased]\n\n## [1.1.0] - 2026-02-01\n')), null);
});

test('changelog: CRLF vs LF does not matter', () => {
  assert.equal(checkChangelog(BASE, BASE.replace(/\n/g, '\r\n')), null);
});

test('changelog: a lost released heading fails and names it', () => {
  const msg = checkChangelog(BASE, BASE.replace('### C\n- c\n', ''));
  assert.match(msg, /append-only/);
  assert.match(msg, /### C/);
});

test('changelog: collapsing released sections fails', () => {
  assert.notEqual(checkChangelog(BASE, BASE.replace('\n### C\n', '\n')), null);
});
