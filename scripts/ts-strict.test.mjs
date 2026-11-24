import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compare, countErrors } from './ts-strict.mjs';

test('counts errors per file and normalises Windows paths', () => {
  const out = [
    "src/a.ts(3,5): error TS2532: Object is possibly 'undefined'.",
    'src\\b.ts(1,1): error TS18048: x is possibly undefined.',
    "src/a.ts(9,2): error TS2532: Object is possibly 'undefined'.",
    'Found 3 errors.',
  ].join('\r\n');
  assert.deepEqual(countErrors(out, 'hub'), { 'hub:src/a.ts': 2, 'hub:src/b.ts': 1 });
});

test('fails only when a file gets worse, and reports files that improved', () => {
  const { worse, better } = compare({ 'hub:a.ts': 2, 'hub:b.ts': 1 }, { 'hub:a.ts': 3, 'web:c.ts': 0 });
  assert.deepEqual(worse, ['hub:a.ts: 2 -> 3']);
  assert.deepEqual(better, ['hub:b.ts: 1 -> 0']);
  assert.deepEqual(compare({ 'hub:a.ts': 2 }, { 'hub:new.ts': 1 }).worse, ['hub:new.ts: 0 -> 1']);
});
