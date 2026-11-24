#!/usr/bin/env node
// Ratchet for stricter TypeScript (noUncheckedIndexedAccess). Today's errors are frozen per file in
// scripts/ts-strict-baseline.json; a file may only go down. `--update` rewrites the baseline after a cleanup.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = join(import.meta.dirname, '..');
const baselineFile = join(root, 'scripts', 'ts-strict-baseline.json');
const FLAGS = ['--noUncheckedIndexedAccess'];

export function countErrors(output, pkg) {
  const counts = {};
  for (const line of output.split(/\r?\n/)) {
    const m = /^(.+?)\(\d+,\d+\): error TS\d+/.exec(line);
    if (!m) continue;
    const key = pkg + ':' + m[1].replaceAll('\\', '/');
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

// A missing tsc or missing dependencies must not read as "no new errors".
export function setupProblem(output, status) {
  if (/error TS2307: Cannot find module/.test(output)) return 'a dependency is missing (TS2307)';
  if (status !== 0 && !/error TS\d+/.test(output)) return 'tsc did not run (' + (output.trim().split(/\r?\n/)[0] || 'exit ' + status) + ')';
  return null;
}

export function compare(baseline, now) {
  const worse = [];
  const better = [];
  for (const [file, n] of Object.entries(now)) {
    const was = baseline[file] ?? 0;
    if (n > was) worse.push(`${file}: ${was} -> ${n}`);
  }
  for (const [file, was] of Object.entries(baseline)) {
    if ((now[file] ?? 0) < was) better.push(`${file}: ${was} -> ${now[file] ?? 0}`);
  }
  return { worse, better };
}

function run() {
  const now = {};
  for (const pkg of ['hub', 'web']) {
    const dir = join(root, 'packages', pkg);
    const tsc = join(dir, 'node_modules', 'typescript', 'bin', 'tsc');
    const r = spawnSync(process.execPath, [tsc, '--noEmit', '-p', 'tsconfig.json', ...FLAGS], { cwd: dir, encoding: 'utf8' });
    if (r.error) throw r.error;
    const out = r.stdout + r.stderr;
    const problem = setupProblem(out, r.status);
    if (problem) {
      console.error(`ts-strict could not typecheck ${pkg}: ${problem}. Run pnpm install first.`);
      return 2;
    }
    Object.assign(now, countErrors(out, pkg));
  }
  const total = Object.values(now).reduce((a, b) => a + b, 0);
  if (process.argv.includes('--update')) {
    const sorted = Object.fromEntries(Object.entries(now).sort(([a], [b]) => a.localeCompare(b)));
    writeFileSync(baselineFile, JSON.stringify(sorted, null, 2) + '\n');
    console.log(`baseline written: ${total} errors in ${Object.keys(now).length} files`);
    return 0;
  }
  const { worse, better } = compare(JSON.parse(readFileSync(baselineFile, 'utf8')), now);
  if (better.length) console.log(`Fewer strict-TS errors than the baseline; run \`pnpm ts-strict --update\` to lock it in:\n  ${better.join('\n  ')}`);
  if (worse.length) {
    console.error(`New noUncheckedIndexedAccess errors. Handle the undefined case of the index (arr[i], record[key]) instead of asserting with !:\n  ${worse.join('\n  ')}`);
    return 1;
  }
  console.log(`ok: ${total} frozen strict-TS errors, none new`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) process.exit(run());
