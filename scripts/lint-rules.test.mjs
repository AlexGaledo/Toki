// Proves every custom lint rule in eslint.config.js fires, on the files it is meant for, with a message that names
// the fix. Run: node --test scripts/lint-rules.test.mjs (also part of `pnpm test`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

const root = fileURLToPath(new URL('..', import.meta.url));
const eslint = new ESLint({ cwd: root });

/** Lint `code` as if it lived at `filePath` (repo-relative; the file need not exist). */
async function lint(filePath, code) {
  const [res] = await eslint.lintText(code, { filePath });
  assert.ok(res, `nothing linted for ${filePath}: is it ignored by eslint.config.js?`);
  const fatal = res.messages.filter((m) => m.fatal);
  assert.deepEqual(fatal, [], `parse error in the probe for ${filePath}`);
  return res.messages;
}
const only = (msgs, ruleId) => msgs.filter((m) => m.ruleId === ruleId);
function expectOne(msgs, ruleId, ...needles) {
  const hits = only(msgs, ruleId);
  assert.equal(hits.length, 1, `expected one ${ruleId}, got: ${JSON.stringify(msgs.map((m) => [m.ruleId, m.message]))}`);
  for (const n of needles) assert.ok(hits[0].message.includes(n), `${ruleId} message should name "${n}": ${hits[0].message}`);
}

const HUB = 'packages/hub/src/__probe__.ts';
const WEB = 'packages/web/src/components/__probe__.tsx';
const SHARED = 'packages/shared/src/__probe__.ts';

test('hub: console.error points at logError in providers/redact.ts', async () => {
  const msgs = await lint(HUB, 'export function f(e: unknown) { console.error("boom", e); }\n');
  expectOne(msgs, 'no-restricted-properties', 'logError', 'packages/hub/src/providers/redact.ts', 'redacts secrets');
});

test('hub: tests and redact.ts itself may use console.error', async () => {
  for (const file of ['packages/hub/src/__probe__.test.ts', 'packages/hub/src/providers/redact.ts']) {
    const msgs = await lint(file, 'export function f(e: unknown) { console.error("boom", e); }\n');
    assert.deepEqual(only(msgs, 'no-restricted-properties'), [], file);
  }
});

test('web: confirm/alert/prompt name the in-app primitives', async () => {
  expectOne(await lint(WEB, 'export const ok = confirm("Delete?");\n'), 'no-restricted-globals', 'confirmAction()', 'ui.tsx');
  expectOne(await lint(WEB, 'export const ok = window.confirm("Delete?");\n'), 'no-restricted-properties', 'confirmAction()');
  expectOne(await lint(WEB, 'alert("hi");\n'), 'no-restricted-globals', 'Banner');
  expectOne(await lint(WEB, 'export const v = prompt("name?");\n'), 'no-restricted-globals', 'Dialog', 'Input');
});

test('web: only the Radix packages already in package.json', async () => {
  expectOne(await lint(WEB, "import * as A from '@radix-ui/react-accordion';\nexport { A };\n"), 'no-restricted-imports', '@radix-ui/react-dialog', 'ui.tsx');
  const ok = await lint(WEB, "import * as D from '@radix-ui/react-dialog';\nexport { D };\n");
  assert.deepEqual(only(ok, 'no-restricted-imports'), []);
});

test('web: icons come from lucide-react only', async () => {
  for (const src of ['react-icons/fa', '@heroicons/react/24/solid', '@radix-ui/react-icons']) {
    expectOne(await lint(WEB, `import { X } from '${src}';\nexport { X };\n`), 'no-restricted-imports', 'lucide-react');
  }
  const ok = await lint(WEB, "import { X } from 'lucide-react';\nexport { X };\n");
  assert.deepEqual(only(ok, 'no-restricted-imports'), []);
});

test('boundaries: web and shared never import the hub; shared never imports web', async () => {
  for (const [file, src] of [
    [WEB, '../../../hub/src/db/schema'],
    [WEB, '@pocketrocket/hub'],
    [SHARED, '../../hub/src/config'],
    [SHARED, '@pocketrocket/hub/src/x'],
  ]) {
    expectOne(await lint(file, `import { x } from '${src}';\nexport { x };\n`), 'no-restricted-imports', '@pocketrocket/shared');
  }
  for (const src of ['../../web/src/store', '@pocketrocket/web']) {
    expectOne(await lint(SHARED, `import { x } from '${src}';\nexport { x };\n`), 'no-restricted-imports', 'packages/shared');
  }
  const ok = await lint(WEB, "import { x } from '@pocketrocket/shared';\nexport { x };\n");
  assert.deepEqual(only(ok, 'no-restricted-imports'), []);
});

test('empty catch: handle or log', async () => {
  for (const file of [HUB, WEB, SHARED]) {
    expectOne(await lint(file, 'export function f() { try { JSON.parse("x"); } catch { } }\n'), 'local/no-empty-catch', 'handle or log the error', 'hides failures');
  }
  const ok = await lint(HUB, 'export function f() { try { JSON.parse("x"); } catch { /* not JSON: keep the raw text */ } }\n');
  assert.deepEqual(only(ok, 'local/no-empty-catch'), []);
});

test('web: setTimeout outside tests asks for the real fix', async () => {
  expectOne(await lint(WEB, 'setTimeout(() => {}, 100);\n'), 'no-restricted-syntax', 'fix the cause', 'suppress with a reason');
  expectOne(await lint(WEB, 'window.setTimeout(() => {}, 100);\n'), 'no-restricted-syntax', 'fix the cause');
  const inTest = await lint('packages/web/src/components/__probe__.test.tsx', 'setTimeout(() => {}, 100);\n');
  assert.deepEqual(only(inTest, 'no-restricted-syntax'), []);
  const inHub = await lint(HUB, 'setTimeout(() => {}, 100);\n');
  assert.deepEqual(only(inHub, 'no-restricted-syntax'), []);
});

test('inline disables need a reason, and stale ones fail', async () => {
  const bare = await lint(WEB, '// eslint-disable-next-line no-restricted-syntax\nsetTimeout(() => {}, 100);\n');
  assert.equal(only(bare, '@eslint-community/eslint-comments/require-description').length, 1);
  const reasoned = await lint(WEB, '// eslint-disable-next-line no-restricted-syntax -- debounce the resize burst\nsetTimeout(() => {}, 100);\n');
  assert.deepEqual(reasoned.filter((m) => m.severity === 2), []);
  const stale = await lint(WEB, '// eslint-disable-next-line no-restricted-syntax -- nothing to disable\nexport const a = 1;\n');
  assert.ok(stale.some((m) => m.ruleId === null && /Unused eslint-disable/.test(m.message)), JSON.stringify(stale));
});

test('web: react-hooks rules are on', async () => {
  const msgs = await lint(WEB, "import { useState } from 'react';\nexport function C({ a }: { a: boolean }) { if (a) { useState(0); } return null; }\n");
  assert.equal(only(msgs, 'react-hooks/rules-of-hooks').length, 1);
});
