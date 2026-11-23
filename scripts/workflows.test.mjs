// node --test scripts/*.test.mjs  (also part of `pnpm test`)
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOWS = path.join(root, '.github', 'workflows');

const PINNED = /^[\w.-]+\/[\w.-]+(\/[\w./-]+)?@[0-9a-f]{40}$/;

/** Problems in one workflow's text: unpinned `uses:` and a missing top-level `permissions:`. */
export function workflowProblems(name, text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  lines.forEach((line, i) => {
    const m = /^\s*(?:-\s+)?uses:\s*['"]?([^'"\s#]+)/.exec(line);
    if (!m) return;
    const ref = m[1];
    if (ref.startsWith('./')) return; // a local action is part of this commit
    if (!PINNED.test(ref)) {
      out.push(`${name}:${i + 1} uses "${ref}": pin it to a full commit SHA, \`owner/repo@<40-hex sha> # vX.Y.Z\``);
    }
  });
  if (!lines.some((l) => /^permissions:/.test(l))) {
    out.push(`${name}: no top-level \`permissions:\`; add one (start from \`permissions: { contents: read }\`) and widen per job`);
  }
  return out;
}

describe('docs/PRODUCTION-CHECKLIST.md: "CI: top-level `permissions: contents: read`, every third-party action SHA-pinned"', () => {
  const files = fs.readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f));

  test('there are workflows to check', () => {
    assert.ok(files.length > 0, `no workflows found in ${WORKFLOWS}`);
  });

  for (const f of files) {
    test(`.github/workflows/${f}`, () => {
      const problems = workflowProblems(f, fs.readFileSync(path.join(WORKFLOWS, f), 'utf8'));
      assert.deepEqual(problems, [], problems.join('\n'));
    });
  }

  test('the checker flags a tag, a branch and a missing permissions block', () => {
    const bad = 'on: push\njobs:\n  a:\n    steps:\n      - uses: actions/checkout@v4\n      - uses: org/x/sub@main\n      - uses: ./local\n';
    const out = workflowProblems('bad.yml', bad);
    assert.equal(out.length, 3, out.join('\n'));
    assert.match(out[0], /actions\/checkout@v4/);
    assert.match(out[1], /org\/x\/sub@main/);
    assert.match(out[2], /permissions/);
    const good = 'permissions:\n  contents: read\njobs:\n  a:\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n';
    assert.deepEqual(workflowProblems('good.yml', good), []);
  });
});
