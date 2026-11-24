// I3: every PUT body the desktop shell's stub filter (hosts.rs `stubs_body`) makes from its test fixtures must pass
// the PC hub's own schema for `PUT /api/hosts/server/projects`. Run from packages/hub after
//   cargo test -j 2 stub_bodies_are_written   (in packages/desktop/src-tauri):
//   npx tsx ../../docs/verify/phase3-infra/scripts/stub_bodies_vs_schema.ts
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HostProjectsInputSchema, MAX_STUBS_PER_HOST } from '../../../../packages/shared/src/hosts.ts';

const dir = join(process.cwd(), '..', 'desktop', 'src-tauri', 'target', 'stub-bodies');
let failed = 0;
for (const f of readdirSync(dir).sort()) {
  const body = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  const r = HostProjectsInputSchema.safeParse(body);
  const n = body.projects?.length ?? '-';
  if (r.success) {
    // The hub trims names; the shell must already have sent them trimmed, so nothing changes in storage.
    const changed = (body.projects ?? []).filter((p: { name: string }, i: number) => r.data.projects![i]!.name !== p.name);
    console.log(`${f}: accepted (${n} stubs, max ${MAX_STUBS_PER_HOST})${changed.length ? `, but the hub re-trimmed ${changed.length}` : ''}`);
    if (changed.length) failed++;
    if (f === 'mixed.json') console.log('  ' + JSON.stringify(body.projects));
  } else {
    failed++;
    console.log(`${f}: REFUSED ${r.error.issues.map((i) => i.path.join('.') + ': ' + i.message).join('; ')}`);
  }
}
console.log(failed ? `${failed} body/bodies refused` : 'all bodies pass the hub schema');
process.exit(failed ? 1 : 0);
