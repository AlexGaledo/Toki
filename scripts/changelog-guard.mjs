#!/usr/bin/env node
// Usage: node scripts/changelog-guard.mjs <base CHANGELOG.md> <head CHANGELOG.md>
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export function releasedPart(text) {
  const t = text.replace(/\r\n/g, '\n');
  const m = /^## \[(?!Unreleased\])/m.exec(t);
  return m ? t.slice(m.index) : '';
}

export function checkChangelog(base, head) {
  const before = releasedPart(base);
  const after = head.replace(/\r\n/g, '\n');
  if (!before || after.includes(before)) return null;
  const lost = before.split('\n').filter((l) => /^#{2,3} /.test(l) && !after.includes(l));
  return [
    'CHANGELOG.md: released sections changed. Released entries are append-only; edit only the [Unreleased] section.',
    lost.length ? 'Headings missing or altered:\n  ' + lost.join('\n  ') : 'A released section was edited in place.',
    'If this came from a merge, resolve CHANGELOG.md by hand: keep both sides\' entries under [Unreleased], never script it.',
  ].join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [basePath, headPath] = process.argv.slice(2);
  if (!basePath || !headPath) {
    console.error('usage: changelog-guard.mjs <base> <head>');
    process.exit(2);
  }
  const problem = checkChangelog(fs.readFileSync(basePath, 'utf8'), fs.readFileSync(headPath, 'utf8'));
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
  console.log('CHANGELOG.md: released sections intact.');
}
