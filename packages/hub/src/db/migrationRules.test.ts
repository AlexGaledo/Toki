import { describe, it, expect } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Db, type Migration } from './db.js';
import { MIGRATIONS } from './migrations.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_TS = path.join(here, 'migrations.ts');
const SUPABASE_DIR = path.resolve(here, '../../../../supabase/migrations');

function blockOf(version: number): [number, number] {
  return version < 10 ? [1, 9] : [Math.floor(version / 10) * 10, Math.floor(version / 10) * 10 + 9];
}

const DESTRUCTIVE = /\bDROP\s+(TABLE|COLUMN)\b|\bRENAME\b/i;

function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
}

function registeredBlocks(src: string): { lo: number; hi: number; versions: number[] }[] {
  const parts = code(src).split(/registerMigrations\(\s*\[/).slice(1);
  return parts.map((p) => {
    const [, lo, hi] = /^\s*(\d+)\s*,\s*(\d+)\s*\]/.exec(p) ?? [];
    return { lo: Number(lo), hi: Number(hi), versions: [...p.matchAll(/\bversion:\s*(\d+)/g)].map((m) => Number(m[1])) };
  });
}

function blockProblems(blocks: { lo: number; hi: number; versions: number[] }[]): string[] {
  const out: string[] = [];
  const seenBlocks = new Set<string>();
  const seenVersions = new Set<number>();
  for (const { lo, hi, versions } of blocks) {
    const [blo, bhi] = blockOf(lo);
    if (lo !== blo || hi !== bhi) out.push(`block [${lo}, ${hi}] is not a phase block; use [${blo}, ${bhi}] (P0 1-9, then ten-wide blocks 10-19, 20-29, ...)`);
    const key = `${lo}-${hi}`;
    if (seenBlocks.has(key)) out.push(`block [${lo}, ${hi}] is registered twice; append to the existing call or take the next free block`);
    seenBlocks.add(key);
    versions.forEach((v, i) => {
      if (v < lo || v > hi) out.push(`migration ${v} is outside its block [${lo}, ${hi}]`);
      if (seenVersions.has(v)) out.push(`migration ${v} is registered twice; take the next free version in your block`);
      seenVersions.add(v);
      if (i > 0 && v <= versions[i - 1]) out.push(`migration ${v} is listed after ${versions[i - 1]}; keep versions ascending inside a block`);
    });
  }
  return out;
}

function executedSql(migrations: readonly Migration[]): { version: number; sql: string }[] {
  const seen: { version: number; sql: string }[] = [];
  const spied = migrations.map((m) => ({
    ...m,
    up: (raw: DatabaseSync) => {
      const proxy = new Proxy(raw, {
        get(target, prop) {
          const v = Reflect.get(target, prop, target);
          if ((prop === 'exec' || prop === 'prepare') && typeof v === 'function') {
            return (sql: string, ...rest: unknown[]) => {
              seen.push({ version: m.version, sql });
              return (v as (...a: unknown[]) => unknown).call(target, sql, ...rest);
            };
          }
          return typeof v === 'function' ? v.bind(target) : v;
        },
      });
      m.up(proxy);
    },
  }));
  new Db(':memory:', spied).raw.close();
  return seen;
}

const FIX =
  'Migrations are additive only (pr-backend.md). Add a new table or column and stop reading the old one; ' +
  'never DROP TABLE, DROP COLUMN or RENAME, and never edit a migration that has shipped.';

describe('pr-backend.md: "register additive migrations in your phase\'s block with `registerMigrations` (P0 1–9 … P9 90–99 …). Never drop or rename."', () => {
  const src = fs.readFileSync(MIGRATIONS_TS, 'utf8');

  it('registered migration ids are unique and ascending', () => {
    const versions = MIGRATIONS.map((m) => m.version);
    expect(new Set(versions).size, 'a migration version is registered twice; take the next free version in your block').toBe(versions.length);
    expect(versions, 'MIGRATIONS is not in ascending version order').toEqual([...versions].sort((a, b) => a - b));
  });

  it('every migration sits in its phase block (P0 1-9, then ten-wide blocks)', () => {
    const blocks = registeredBlocks(src);
    expect(blocks.flatMap((b) => b.versions).sort((a, b) => a - b), 'the source parse missed a migration; keep `version: <n>` literals').toEqual(
      MIGRATIONS.map((m) => m.version),
    );
    const problems = blockProblems(blocks);
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('no migration source drops or renames (migrations.ts)', () => {
    const hits = code(src)
      .split('\n')
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => DESTRUCTIVE.test(l))
      .map(({ l, i }) => `migrations.ts:${i + 1}: ${l.trim()}`);
    expect(hits, `${hits.join('\n')}\n${FIX}`).toEqual([]);
  });

  it('no migration runs DROP TABLE, DROP COLUMN or RENAME (SQL captured while migrating a fresh database)', () => {
    const run = executedSql(MIGRATIONS);
    expect(run.length, 'the SQL spy captured nothing').toBeGreaterThan(0);
    const hits = run.filter((r) => DESTRUCTIVE.test(r.sql)).map((r) => `migration ${r.version}: ${r.sql.slice(0, 160)}`);
    expect(hits, `${hits.join('\n')}\n${FIX}`).toEqual([]);
  });

  it('no Supabase migration drops or renames (supabase/migrations/*.sql)', () => {
    const files = fs.readdirSync(SUPABASE_DIR).filter((f) => f.endsWith('.sql'));
    expect(files.length).toBeGreaterThan(0);
    const hits = files.flatMap((f) =>
      fs
        .readFileSync(path.join(SUPABASE_DIR, f), 'utf8')
        .replace(/--.*$/gm, '')
        .split(/\r?\n/)
        .filter((l) => DESTRUCTIVE.test(l))
        .map((l) => `${f}: ${l.trim()}`),
    );
    expect(hits, `${hits.join('\n')}\n${FIX}`).toEqual([]);
  });

  it('the checks catch a bad block, a duplicate, a descending list and destructive SQL', () => {
    expect(blockProblems([{ lo: 10, hi: 19, versions: [10, 11] }, { lo: 20, hi: 29, versions: [20] }])).toEqual([]);
    expect(blockProblems([{ lo: 15, hi: 24, versions: [15] }])[0]).toMatch(/not a phase block; use \[10, 19\]/);
    expect(blockProblems([{ lo: 10, hi: 19, versions: [12, 11] }])[0]).toMatch(/keep versions ascending/);
    expect(blockProblems([{ lo: 10, hi: 19, versions: [10] }, { lo: 10, hi: 19, versions: [10] }]).join('\n')).toMatch(/registered twice/);
    expect(blockProblems([{ lo: 10, hi: 19, versions: [20] }])[0]).toMatch(/outside its block/);
    const bad: Migration = { version: 999, name: 'bad', up: (db) => db.exec('CREATE TABLE t (a); ALTER TABLE t RENAME TO u; DROP TABLE u') };
    expect(executedSql([bad]).filter((r) => DESTRUCTIVE.test(r.sql))).toHaveLength(1);
    expect(DESTRUCTIVE.test('DROP TRIGGER IF EXISTS messages_fts_ai'), 'triggers and indexes may be rebuilt').toBe(false);
    expect(DESTRUCTIVE.test('ALTER TABLE x DROP COLUMN y')).toBe(true);
  });
});
