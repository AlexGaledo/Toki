// Mutates the multi_edit card's guarded lines one at a time (exact text), runs the named tests, restores the file.
// From the repo root: node docs/verify/final-gaps/scripts/multi_edit_mutations.mjs
import fs from 'node:fs';
import { execSync } from 'node:child_process';

const HUB = 'packages/hub/src/services/outsideMcp.ts';
const WEB = 'packages/web/src/lib/approvalCode.ts';
const HUB_TEST = { cwd: 'packages/hub', file: 'src/permissions/outsideMcpApproval.test.ts' };
const WEB_TEST = { cwd: 'packages/web', file: 'src/lib/approvalCode.test.ts' };
const M = [
  [HUB, HUB_TEST, "tool === 'multi_edit' &&", "tool === 'multi_edit_x' &&", 'never names edits'],
  [HUB, HUB_TEST, ' && input.edits.length > 0', '', 'an empty edits list names edits'],
  [HUB, HUB_TEST, 'input.edits.every(isTextEdit)', 'input.edits.some(isTextEdit)', 'one text edit is enough'],
  [HUB, HUB_TEST, "\n  && typeof (e as { new_string?: unknown }).new_string === 'string'", '', 'new_string type not checked'],
  [HUB, HUB_TEST, "input.edits.every(isTextEdit)) return 'edits';", "input.edits.every(isTextEdit)) return 'code';", 'names the wrong field'],
  [WEB, WEB_TEST, "typeof own[field] === 'string' ? own[field] : editsAsCode(own[field])", 'own[field]', 'edits not turned into code'],
  [WEB, WEB_TEST, '!Array.isArray(v) || v.length === 0', '!Array.isArray(v)', 'an empty list shows an empty code area'],
  [WEB, WEB_TEST, " || typeof e.new_string !== 'string'", '', 'new_string type not checked'],
  [WEB, WEB_TEST, "(e.replace_all === true ? ', every match' : '')", "''", 'replace_all hidden'],
  [WEB, WEB_TEST, "(s === '' ? [] : s.split('\\n').map((l) => mark + l))", "s.split('\\n').map((l) => mark + l)", 'empty old_string shows a "- " line'],
  [WEB, WEB_TEST, "...lines(e.old_string, '- '), ...lines(e.new_string, '+ ')", "...lines(e.new_string, '+ '), ...lines(e.old_string, '- ')", 'new before old'],
];
let caught = 0;
for (const [i, [file, t, from, to, what]] of M.entries()) {
  const orig = fs.readFileSync(file, 'utf8');
  if (orig.split(from).length !== 2) { console.log(`mutant ${i + 1}: TEXT NOT FOUND ONCE (${what})`); continue; }
  fs.writeFileSync(file, orig.replace(from, to));
  let out = '', failed = false;
  try { out = execSync(`npx vitest run ${t.file}`, { cwd: t.cwd, encoding: 'utf8', stdio: 'pipe' }); }
  catch (e) { failed = true; out = String(e.stdout ?? ''); }
  finally { fs.writeFileSync(file, orig); }
  const tests = (out.match(/Tests\s+[^\n]+/) ?? [''])[0].trim();
  if (failed) caught++;
  console.log(`mutant ${i + 1} ${failed ? 'CAUGHT ' : 'SURVIVED'} ${file.split('/').pop()}: ${what} | ${tests}`);
}
console.log(`\n${caught} of ${M.length} caught`);
