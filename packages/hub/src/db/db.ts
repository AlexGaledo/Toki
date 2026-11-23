import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { DB_PATH } from '../config.js';
import { SCHEMA_SQL } from './schema.js';
import { MIGRATIONS, type Migration } from './migrations.js';

export { registerMigrations, addColumnIfMissing, hasColumn, type Migration } from './migrations.js';

export type Row = Record<string, unknown>;

export class Db {
  readonly raw: DatabaseSync;
  constructor(file: string = DB_PATH, migrations: readonly Migration[] = MIGRATIONS) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.raw = new DatabaseSync(file);
    if (file !== ':memory:') this.raw.exec('PRAGMA journal_mode = WAL;');
    try {
      this.raw.exec(SCHEMA_SQL);
      this.migrate(migrations);
    } catch (e) {
      this.raw.close();
      throw e;
    }
  }

  private migrate(migrations: readonly Migration[]) {
    this.raw.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)');
    const applied = new Set(this.all<{ version: number }>('SELECT version FROM schema_version').map((r) => r.version));
    for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
      if (applied.has(m.version)) continue;
      this.tx(() => {
        m.up(this.raw);
        this.run('INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)', m.version, m.name, Date.now());
      });
    }
  }

  schemaVersions(): number[] {
    return this.all<{ version: number }>('SELECT version FROM schema_version ORDER BY version').map((r) => r.version);
  }
  run(sql: string, ...params: unknown[]) {
    return this.raw.prepare(sql).run(...(params as never[]));
  }
  get<T = Row>(sql: string, ...params: unknown[]): T | undefined {
    return this.raw.prepare(sql).get(...(params as never[])) as T | undefined;
  }
  all<T = Row>(sql: string, ...params: unknown[]): T[] {
    return this.raw.prepare(sql).all(...(params as never[])) as T[];
  }
  tx<T>(fn: () => T): T {
    this.raw.exec('BEGIN');
    try {
      const r = fn();
      this.raw.exec('COMMIT');
      return r;
    } catch (e) {
      this.raw.exec('ROLLBACK');
      throw e;
    }
  }
}
