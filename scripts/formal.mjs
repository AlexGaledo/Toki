#!/usr/bin/env node
// Model-checks docs/formal/*.tla with TLC. Each <Spec>.cfg must pass; each <Spec>Broken.cfg must FAIL,
// which proves the invariants actually catch the bug they were written for.
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const VERSION = '1.7.4';
const SHA256 = '936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88';
const dir = join(import.meta.dirname, '..', 'docs', 'formal');
const cache = join(homedir(), '.cache', 'toki');
const jar = join(cache, `tla2tools-${VERSION}.jar`);

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
if (!existsSync(jar) || sha(jar) !== SHA256) {
  mkdirSync(cache, { recursive: true });
  const res = await fetch(`https://github.com/tlaplus/tlaplus/releases/download/v${VERSION}/tla2tools.jar`);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  writeFileSync(jar, Buffer.from(await res.arrayBuffer()));
  if (sha(jar) !== SHA256) throw new Error('tla2tools.jar checksum mismatch');
}
execFileSync('java', ['-version'], { stdio: 'ignore' });

let failed = 0;
for (const cfg of readdirSync(dir).filter((f) => f.endsWith('.cfg')).sort()) {
  const expectFail = cfg.endsWith('Broken.cfg');
  const spec = cfg.replace(/(Broken)?\.cfg$/, '.tla');
  const r = spawnSync('java', ['-cp', jar, 'tlc2.TLC', '-config', cfg, '-workers', '1', '-cleanup', spec], { cwd: dir, encoding: 'utf8' });
  const out = r.stdout + r.stderr;
  const passed = r.status === 0 && out.includes('No error has been found');
  const caught = /Invariant \w+ is violated|Temporal properties were violated/.test(out);
  const ok = expectFail ? caught : passed;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${cfg}${expectFail ? ' (must be caught)' : ''}`);
  if (!ok) { failed++; console.log(out.split('\n').filter((l) => /Error|violated|Parse/.test(l)).slice(0, 10).join('\n')); }
}
process.exit(failed ? 1 : 0);
