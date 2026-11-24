import type { DatabaseSync } from 'node:sqlite';
import { isBotIconKey } from '@pocketrocket/shared';
import { nanoid } from 'nanoid';
import { MIGRATION_BACKFILL_ROWS, backfillMessagesFts } from './historyIndex.js';

export interface Migration {
  version: number;
  name: string;
  up(db: DatabaseSync): void;
}

export const MIGRATIONS: Migration[] = [];

export function registerMigrations(block: readonly [number, number], list: readonly Migration[]): void {
  const [lo, hi] = block;
  for (const m of list) {
    if (!Number.isInteger(m.version) || m.version < lo || m.version > hi) {
      throw new Error(`migration ${m.version} (${m.name}) is outside its block ${lo}-${hi}`);
    }
    if (MIGRATIONS.some((x) => x.version === m.version)) throw new Error(`migration version ${m.version} is registered twice`);
    MIGRATIONS.push(m);
  }
  MIGRATIONS.sort((a, b) => a.version - b.version);
}

export function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const cols = db.prepare('PRAGMA table_info(' + table + ')').all() as { name: string }[];
  return cols.some((c) => c.name === column);
}

export function addColumnIfMissing(db: DatabaseSync, table: string, column: string, ddl: string): void {
  if (!hasColumn(db, table, column)) db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + column + ' ' + ddl);
}

registerMigrations([1, 9], [
  { version: 1, name: 'sessions.provider', up: (db) => addColumnIfMissing(db, 'sessions', 'provider', 'TEXT') },
  { version: 2, name: 'bots.auto_memory', up: (db) => addColumnIfMissing(db, 'bots', 'auto_memory', 'INTEGER NOT NULL DEFAULT 1') },
  { version: 3, name: 'bots.auto_memory_every', up: (db) => addColumnIfMissing(db, 'bots', 'auto_memory_every', 'INTEGER NOT NULL DEFAULT 10') },
]);

registerMigrations([10, 19], [
  {
    version: 10,
    name: 'computers table',
    up: (db) =>
      db.exec(
        'CREATE TABLE IF NOT EXISTS computers (' +
          'bot_id TEXT PRIMARY KEY, slot INTEGER UNIQUE NOT NULL, state TEXT NOT NULL DEFAULT \'asleep\', ' +
          'last_used_at INTEGER, disk_bytes INTEGER NOT NULL DEFAULT 0, quota_bytes INTEGER NOT NULL, ' +
          'keep_awake INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)',
      ),
  },
]);

registerMigrations([20, 29], [
  {
    version: 20,
    name: 'approvals parking columns',
    up: (db) => {
      addColumnIfMissing(db, 'approvals', 'parked_at', 'INTEGER');
      addColumnIfMissing(db, 'approvals', 'cause_id', 'TEXT');
      addColumnIfMissing(db, 'approvals', 'hop', 'INTEGER');
      addColumnIfMissing(db, 'approvals', 'run_id', 'TEXT');
      addColumnIfMissing(db, 'approvals', 'message_id', 'TEXT');
    },
  },
  {
    version: 21,
    name: 'approval_policies table',
    up: (db) => db.exec(`
      CREATE TABLE IF NOT EXISTS approval_policies (
        id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, tool TEXT NOT NULL, pattern TEXT NOT NULL,
        decision TEXT NOT NULL CHECK(decision IN ('allow','deny')), scope TEXT NOT NULL DEFAULT 'always' CHECK(scope IN ('always','session')),
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_approval_policies_bot ON approval_policies(bot_id, tool);
    `),
  },
]);

registerMigrations([30, 39], [
  { version: 30, name: 'routines.once_at', up: (db) => addColumnIfMissing(db, 'routines', 'once_at', 'INTEGER') },
  {
    version: 31,
    name: 'lane_journal table',
    up: (db) =>
      db.exec(
        'CREATE TABLE IF NOT EXISTS lane_journal (' +
          'id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, room_id TEXT NOT NULL, cause_id TEXT NOT NULL, hop INTEGER NOT NULL, ' +
          'trigger_seq INTEGER NOT NULL, run_id TEXT, note TEXT, attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)',
      ),
  },
]);

registerMigrations([40, 49], [
  {
    version: 40,
    name: 'integrations + bot_integrations',
    up: (db) => db.exec(`
      CREATE TABLE IF NOT EXISTS integrations (
        id TEXT PRIMARY KEY, provider TEXT NOT NULL UNIQUE, method TEXT NOT NULL CHECK(method IN ('oauth','token')),
        account_label TEXT NOT NULL DEFAULT '', scopes TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'connected',
        last_error TEXT, warnings TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        last_checked_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS bot_integrations (
        bot_id TEXT NOT NULL, integration_id TEXT NOT NULL, scopes TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL,
        PRIMARY KEY (bot_id, integration_id)
      );
      CREATE INDEX IF NOT EXISTS idx_bot_integrations_integration ON bot_integrations(integration_id);
    `),
  },
]);

registerMigrations([50, 59], [
  {
    version: 50,
    name: 'triggers table',
    up: (db) => db.exec(`
      CREATE TABLE IF NOT EXISTS triggers (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, source TEXT NOT NULL,
        filter_json TEXT NOT NULL DEFAULT '{}', bot_id TEXT NOT NULL, room_id TEXT NOT NULL, prompt TEXT NOT NULL,
        max_per_hour INTEGER NOT NULL DEFAULT 6, budget_usd REAL NOT NULL DEFAULT 2,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_fired_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_triggers_source ON triggers(source, enabled);
    `),
  },
  {
    version: 51,
    name: 'events_inbox table',
    up: (db) => db.exec(`
      CREATE TABLE IF NOT EXISTS events_inbox (
        id TEXT PRIMARY KEY, source TEXT NOT NULL, poll_key TEXT NOT NULL, dedupe_key TEXT NOT NULL UNIQUE,
        payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new', seen_at INTEGER NOT NULL, processed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_events_inbox_status ON events_inbox(status, seen_at);
    `),
  },
  {
    version: 52,
    name: 'trigger_fires table',
    up: (db) => db.exec(`
      CREATE TABLE IF NOT EXISTS trigger_fires (
        id TEXT PRIMARY KEY, trigger_id TEXT NOT NULL, event_id TEXT, title TEXT NOT NULL DEFAULT '', status TEXT NOT NULL,
        note TEXT, message_id TEXT, cost_usd REAL, test INTEGER NOT NULL DEFAULT 0, started_at INTEGER NOT NULL, ended_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_trigger_fires_trigger ON trigger_fires(trigger_id, started_at);
    `),
  },
  {
    version: 53,
    name: 'trigger_cursors table',
    up: (db) => db.exec(`
      CREATE TABLE IF NOT EXISTS trigger_cursors (
        key TEXT PRIMARY KEY, source TEXT NOT NULL, cursor TEXT, etag TEXT, last_polled_at INTEGER, next_poll_at INTEGER,
        failures INTEGER NOT NULL DEFAULT 0, last_error TEXT
      );
    `),
  },
]);

registerMigrations([70, 79], [
  {
    version: 70,
    name: 'knowledge_sync table',
    up: (db) => db.exec(
      "CREATE TABLE IF NOT EXISTS knowledge_sync (id INTEGER PRIMARY KEY CHECK (id = 1), source TEXT NOT NULL DEFAULT '', " +
      "mode TEXT NOT NULL DEFAULT 'off', last_synced_at INTEGER, head TEXT, last_error TEXT)",
    ),
  },
  {
    version: 71,
    name: 'voice_proposals table',
    up: (db) => db.exec(
      'CREATE TABLE IF NOT EXISTS voice_proposals (id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL);' +
      'CREATE INDEX IF NOT EXISTS idx_voice_proposals_bot ON voice_proposals(bot_id, created_at)',
    ),
  },
]);

registerMigrations([80, 89], [
  { version: 80, name: 'usage.model', up: (db) => addColumnIfMissing(db, 'usage', 'model', 'TEXT') },
  { version: 81, name: 'usage.route_reason', up: (db) => addColumnIfMissing(db, 'usage', 'route_reason', 'TEXT') },
  {
    version: 82,
    name: 'usage.cause_kind',
    up: (db) => {
      addColumnIfMissing(db, 'usage', 'cause_kind', 'TEXT');
      db.exec(`UPDATE usage SET cause_kind = CASE
        WHEN turn_id LIKE 'mem-%' THEN 'memory'
        WHEN EXISTS (SELECT 1 FROM messages m WHERE m.turn_id = usage.turn_id AND m.hop > 0) THEN 'bot'
        WHEN EXISTS (SELECT 1 FROM messages m WHERE m.id = usage.cause_id AND m.kind = 'routine') THEN 'routine'
        WHEN EXISTS (SELECT 1 FROM messages m WHERE m.id = usage.cause_id AND m.author_type = 'user') THEN 'user'
      END WHERE cause_kind IS NULL`);
      db.exec(`UPDATE usage SET model = (
        SELECT j.key FROM json_each(usage.model_usage) j
        ORDER BY COALESCE(json_extract(j.value, '$.costUSD'), json_extract(j.value, '$.costUsd'), 0) DESC LIMIT 1
      ) WHERE model IS NULL AND model_usage IS NOT NULL AND json_valid(model_usage) AND json_type(model_usage) = 'object'`);
    },
  },
  { version: 83, name: 'messages.model', up: (db) => addColumnIfMissing(db, 'messages', 'model', 'TEXT') },
  { version: 84, name: 'messages.model_reason', up: (db) => addColumnIfMissing(db, 'messages', 'model_reason', 'TEXT') },
]);

// A device row holds only the SHA-256 of its token; the token itself is never stored.
registerMigrations([90, 99], [
  {
    version: 90,
    name: 'devices table',
    up: (db) => db.exec(
      'CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, ' +
      'created_at INTEGER NOT NULL, last_seen_at INTEGER, revoked INTEGER NOT NULL DEFAULT 0)',
    ),
  },
  {
    version: 91,
    name: 'push_subscriptions table',
    up: (db) => db.exec(
      'CREATE TABLE IF NOT EXISTS push_subscriptions (id TEXT PRIMARY KEY, device_id TEXT, endpoint TEXT NOT NULL UNIQUE, ' +
      'p256dh TEXT NOT NULL, auth TEXT NOT NULL, created_at INTEGER NOT NULL);' +
      'CREATE INDEX IF NOT EXISTS idx_push_subscriptions_device ON push_subscriptions(device_id)',
    ),
  },
]);

registerMigrations([60, 69], [
  { version: 60, name: 'skills.version', up: (db) => addColumnIfMissing(db, 'skills', 'version', 'INTEGER NOT NULL DEFAULT 1') },
  { version: 61, name: 'skills.parent_id', up: (db) => addColumnIfMissing(db, 'skills', 'parent_id', 'TEXT') },
  {
    version: 62,
    name: 'skills version metadata',
    up: (db) => {
      addColumnIfMissing(db, 'skills', 'origin', 'TEXT');
      addColumnIfMissing(db, 'skills', 'note', 'TEXT');
      addColumnIfMissing(db, 'skills', 'created_at', 'INTEGER');
      addColumnIfMissing(db, 'skills', 'decided_at', 'INTEGER');
      db.exec('CREATE INDEX IF NOT EXISTS idx_skills_parent ON skills(parent_id)');
    },
  },
  {
    version: 63,
    name: 'skill reflection',
    up: (db) =>
      db.exec(
        'CREATE TABLE IF NOT EXISTS skill_reflection (' +
          'bot_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, every INTEGER NOT NULL DEFAULT 5, ' +
          'daily_cap_usd REAL NOT NULL DEFAULT 0.25);' +
          'CREATE TABLE IF NOT EXISTS skill_reflection_runs (' +
          'bot_id TEXT NOT NULL, skill_id TEXT NOT NULL, runs_since INTEGER NOT NULL DEFAULT 0, ' +
          'PRIMARY KEY (bot_id, skill_id))',
      ),
  },
]);

const LEGACY_AVATARS: Record<string, string> = {
  '🧭': 'compass', '🔎': 'search', '🛠': 'wrench', '✍': 'pen', '🙂': 'smile', '🤖': '',
  '🔍': 'search', '🚀': 'rocket', '💻': 'terminal', '🧑‍💻': 'terminal', '⚙': 'wrench', '🎨': 'palette',
};
const SEEDED_ICONS: Record<string, string> = { 'pocketrocket-support': 'shield', 'data-engineer': 'database' };
registerMigrations([100, 109], [
  {
    version: 100,
    name: 'bots.avatar to icon keys',
    up: (db) => {
      const rows = db.prepare('SELECT id, handle, avatar FROM bots').all() as { id: string; handle: string; avatar: string | null }[];
      const set = db.prepare('UPDATE bots SET avatar=? WHERE id=?');
      for (const r of rows) {
        const was = (r.avatar ?? '').replace(/\uFE0F/g, '').trim();
        const known = isBotIconKey(was) ? was : Object.hasOwn(LEGACY_AVATARS, was) ? LEGACY_AVATARS[was] : '';
        const key = known || (Object.hasOwn(SEEDED_ICONS, r.handle) ? SEEDED_ICONS[r.handle] : '');
        if (key !== r.avatar) set.run(key, r.id);
      }
    },
  },
  { version: 101, name: 'rooms.chat_model', up: (db) => addColumnIfMissing(db, 'rooms', 'chat_model', 'TEXT') },
  { version: 102, name: 'rooms.avatar', up: (db) => addColumnIfMissing(db, 'rooms', 'avatar', "TEXT NOT NULL DEFAULT ''") },
]);

registerMigrations([110, 119], [
  {
    version: 110,
    name: 'bot training',
    up: (db) =>
      db.exec(
        'CREATE TABLE IF NOT EXISTS training_config (' +
          'bot_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, last_run_at INTEGER);' +
          'CREATE TABLE IF NOT EXISTS training_proposals (' +
          'id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, ' +
          "status TEXT NOT NULL CHECK(status IN ('pending','blocked','approved','rejected','undone')), " +
          "rule TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', evidence_summary TEXT NOT NULL DEFAULT '', " +
          "verifier_note TEXT NOT NULL DEFAULT '', description_before TEXT, heading_added INTEGER NOT NULL DEFAULT 0, " +
          'created_at INTEGER NOT NULL, decided_at INTEGER, undone_at INTEGER);' +
          'CREATE INDEX IF NOT EXISTS idx_training_proposals_bot ON training_proposals(bot_id, status)',
      ),
  },
  {
    version: 111,
    name: 'training window, unjudged proposals, who answered an approval',
    up: (db) => {
      addColumnIfMissing(db, 'training_config', 'window_start', 'INTEGER');
      db.prepare('UPDATE training_config SET window_start=? WHERE enabled=1 AND window_start IS NULL').run(Date.now());
      addColumnIfMissing(db, 'training_proposals', 'retry', 'INTEGER NOT NULL DEFAULT 0');
      addColumnIfMissing(db, 'approvals', 'decided_by', 'TEXT');
    },
  },
  {
    version: 112,
    name: 'users: a stable id for the owner, separate from the display name',
    up: (db) => {
      db.exec(
        'CREATE TABLE IF NOT EXISTS users (' +
          "id TEXT PRIMARY KEY, display_name TEXT NOT NULL DEFAULT '', " +
          "role TEXT NOT NULL CHECK(role IN ('owner','admin','member')), " +
          "previous_names TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL)",
      );
      const stored = db.prepare("SELECT value FROM settings WHERE key='userName'").get() as { value?: string } | undefined;
      let name = '';
      try { name = stored?.value ? String(JSON.parse(stored.value)) : ''; } catch { /* left empty; the hub fills it in at start */ }
      const id = nanoid(10);
      db.prepare("INSERT INTO users (id, display_name, role, created_at) VALUES (?,?,'owner',?)").run(id, name, Date.now());
      db.prepare("UPDATE messages SET author_id=? WHERE author_type='user' AND author_id IS NULL").run(id);
    },
  },
  {
    version: 113,
    name: 'sign-in: owner password, browser sessions, audit log',
    up: (db) =>
      db.exec(
        'CREATE TABLE IF NOT EXISTS user_credentials (' +
          'user_id TEXT PRIMARY KEY, password_hash TEXT NOT NULL, updated_at INTEGER NOT NULL);' +
          'CREATE TABLE IF NOT EXISTS user_sessions (' +
          'id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, user_agent TEXT, ip TEXT, ' +
          'created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER);' +
          'CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);' +
          'CREATE TABLE IF NOT EXISTS audit_log (' +
          'id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor_kind TEXT NOT NULL, actor_id TEXT, ' +
          'action TEXT NOT NULL, target TEXT, detail TEXT, ip TEXT)',
      ),
  },
]);

registerMigrations([120, 129], [
  { version: 120, name: 'messages.attachments', up: (db) => addColumnIfMissing(db, 'messages', 'attachments', 'TEXT') },
]);

registerMigrations([130, 139], [
  {
    version: 130,
    name: 'project folders, their search index, connector queue and secret',
    up: (db) =>
      db.exec(
        'CREATE TABLE IF NOT EXISTS projects (slug TEXT PRIMARY KEY, name TEXT NOT NULL, room_id TEXT, template_version INTEGER, created_at INTEGER NOT NULL);' +
          'CREATE TABLE IF NOT EXISTS project_members (slug TEXT NOT NULL, bot_id TEXT NOT NULL, PRIMARY KEY (slug, bot_id));' +
          'CREATE INDEX IF NOT EXISTS idx_project_members_bot ON project_members(bot_id);' +
          'CREATE TABLE IF NOT EXISTS project_files (slug TEXT NOT NULL, path TEXT NOT NULL, mtime REAL NOT NULL, size INTEGER NOT NULL, status TEXT, updated TEXT, review_by TEXT, PRIMARY KEY (slug, path));' +
          "CREATE VIRTUAL TABLE IF NOT EXISTS project_fts USING fts5(slug UNINDEXED, path UNINDEXED, text, tokenize='porter unicode61');" +
          'CREATE TABLE IF NOT EXISTS project_search_misses (at INTEGER NOT NULL, projects TEXT NOT NULL, query TEXT NOT NULL);' +
          'CREATE TABLE IF NOT EXISTS context_queue (id TEXT PRIMARY KEY, project TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL);' +
          'CREATE TABLE IF NOT EXISTS context_connector (token_hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL)',
      ),
  },
]);

registerMigrations([150, 159], [
  { version: 150, name: 'auto_memory.saved_at', up: (db) => addColumnIfMissing(db, 'auto_memory', 'saved_at', 'INTEGER') },
]);

registerMigrations([160, 169], [
  {
    version: 160,
    name: 'pc_jobs',
    up: (db) =>
      db.exec(
        'CREATE TABLE IF NOT EXISTS pc_jobs (' +
          'id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, room_id TEXT NOT NULL, folder TEXT NOT NULL, prompt TEXT NOT NULL, ' +
          "status TEXT NOT NULL CHECK(status IN ('pending_approval','queued','claimed','running','done','failed','refused','expired','cancelled')), " +
          'result TEXT, cost_usd REAL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);' +
          'CREATE INDEX IF NOT EXISTS idx_pc_jobs_status ON pc_jobs(status, updated_at)',
      ),
  },
  {
    version: 161,
    name: 'pc_jobs.started_at, finished_at, duration_ms',
    up: (db) => {
      addColumnIfMissing(db, 'pc_jobs', 'started_at', 'INTEGER');
      addColumnIfMissing(db, 'pc_jobs', 'finished_at', 'INTEGER');
      addColumnIfMissing(db, 'pc_jobs', 'duration_ms', 'INTEGER');
      db.exec('CREATE INDEX IF NOT EXISTS idx_pc_jobs_created ON pc_jobs(created_at)');
    },
  },
  {
    version: 162,
    name: 'pc_jobs.mode, session_id, origin, resolved_folder, new_session_id',
    up: (db) => {
      addColumnIfMissing(db, 'pc_jobs', 'mode', "TEXT NOT NULL DEFAULT 'new'");
      addColumnIfMissing(db, 'pc_jobs', 'session_id', 'TEXT');
      addColumnIfMissing(db, 'pc_jobs', 'origin', "TEXT NOT NULL DEFAULT 'bot'");
      addColumnIfMissing(db, 'pc_jobs', 'resolved_folder', 'TEXT');
      addColumnIfMissing(db, 'pc_jobs', 'new_session_id', 'TEXT');
    },
  },
  {
    version: 163,
    name: 'pc_jobs.sync_json, sync_result_json, sync_import_json',
    up: (db) => {
      addColumnIfMissing(db, 'pc_jobs', 'sync_json', 'TEXT');
      addColumnIfMissing(db, 'pc_jobs', 'sync_result_json', 'TEXT');
      addColumnIfMissing(db, 'pc_jobs', 'sync_import_json', 'TEXT');
    },
  },
]);

registerMigrations([170, 179], [
  {
    version: 170,
    name: 'sessions: cost_total, context_tokens, context_at, memory/identity snapshot, summary',
    up: (db) => {
      addColumnIfMissing(db, 'sessions', 'cost_total', 'REAL');
      addColumnIfMissing(db, 'sessions', 'context_tokens', 'INTEGER');
      addColumnIfMissing(db, 'sessions', 'context_at', 'INTEGER');
      addColumnIfMissing(db, 'sessions', 'memory_snapshot', 'TEXT');
      addColumnIfMissing(db, 'sessions', 'identity_snapshot', 'TEXT');
      addColumnIfMissing(db, 'sessions', 'summary', 'TEXT');
    },
  },
  { version: 171, name: 'sessions.context_window', up: (db) => addColumnIfMissing(db, 'sessions', 'context_window', 'INTEGER') },
]);

registerMigrations([180, 189], [
  {
    version: 180,
    name: 'messages.client_msg_id + unique (room_id, client_msg_id)',
    up: (db) => {
      addColumnIfMissing(db, 'messages', 'client_msg_id', 'TEXT');
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_client_msg ON messages(room_id, client_msg_id) WHERE client_msg_id IS NOT NULL');
    },
  },
]);

registerMigrations([200, 209], [
  {
    version: 200,
    name: 'tasks',
    up: (db) =>
      db.exec(
        'CREATE TABLE IF NOT EXISTS tasks (' +
          "id TEXT PRIMARY KEY, room_id TEXT NOT NULL, bot_id TEXT, assignee_bot_id TEXT, title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', " +
          "status TEXT NOT NULL DEFAULT 'todo' CHECK(status IN ('todo','doing','done','blocked')), " +
          'due_at INTEGER, parent_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);' +
          'CREATE INDEX IF NOT EXISTS idx_tasks_room ON tasks(room_id, status, updated_at)',
      ),
  },
  {
    version: 201,
    name: 'messages_fts + triggers + bounded backfill',
    up: (db) => {
      db.exec(
        "CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(text, tokenize='porter unicode61');" +
          'CREATE TABLE IF NOT EXISTS fts_backfill (name TEXT PRIMARY KEY, next_rowid INTEGER NOT NULL, upto INTEGER NOT NULL);' +
          'CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN INSERT INTO messages_fts (rowid, text) VALUES (new.rowid, new.text); END;' +
          'CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN DELETE FROM messages_fts WHERE rowid=old.rowid; END;' +
          'CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE OF text ON messages BEGIN DELETE FROM messages_fts WHERE rowid=old.rowid; INSERT INTO messages_fts (rowid, text) VALUES (new.rowid, new.text); END',
      );
      db.exec("INSERT OR IGNORE INTO fts_backfill (name, next_rowid, upto) SELECT 'messages', 0, COALESCE(MAX(rowid), 0) FROM messages");
      backfillMessagesFts(db, MIGRATION_BACKFILL_ROWS, true);
    },
  },
  {
    version: 202,
    name: 'bot_reports',
    up: (db) =>
      db.exec(
        'CREATE TABLE IF NOT EXISTS bot_reports (' +
          "id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, room_id TEXT, type TEXT NOT NULL CHECK(type IN ('blocked','feedback')), " +
          "kind TEXT, site TEXT, reason TEXT, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','resolved','dismissed')), created_at INTEGER NOT NULL);" +
          'CREATE INDEX IF NOT EXISTS idx_bot_reports_bot ON bot_reports(bot_id, type, created_at)',
      ),
  },
]);

const FTS_KINDS = "('text','handoff','routine','trigger')";
registerMigrations([240, 249], [
  {
    version: 240,
    name: 'messages_fts: index searchable kinds only',
    up: (db) => {
      db.exec(
        'DROP TRIGGER IF EXISTS messages_fts_ai; DROP TRIGGER IF EXISTS messages_fts_au;' +
          'CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages WHEN new.kind IN ' + FTS_KINDS + ' BEGIN INSERT INTO messages_fts (rowid, text) VALUES (new.rowid, new.text); END;' +
          'CREATE TRIGGER messages_fts_au AFTER UPDATE ON messages WHEN old.text IS NOT new.text OR old.kind IS NOT new.kind ' +
          'BEGIN DELETE FROM messages_fts WHERE rowid=old.rowid; INSERT INTO messages_fts (rowid, text) SELECT new.rowid, new.text WHERE new.kind IN ' + FTS_KINDS + '; END',
      );
      db.exec('DELETE FROM messages_fts WHERE rowid IN (SELECT rowid FROM messages WHERE kind NOT IN ' + FTS_KINDS + ')');
    },
  },
]);

registerMigrations([190, 199], [
  {
    version: 190,
    name: 'machine_policies table',
    up: (db) => db.exec(`
      CREATE TABLE IF NOT EXISTS machine_policies (
        machine TEXT PRIMARY KEY,
        policy TEXT NOT NULL CHECK(policy IN ('never','ask','always')),
        updated_at INTEGER NOT NULL
      );
    `),
  },
  {
    version: 191,
    name: 'approval_policies.machine + expires_at',
    up: (db) => {
      addColumnIfMissing(db, 'approval_policies', 'machine', 'TEXT');
      addColumnIfMissing(db, 'approval_policies', 'expires_at', 'INTEGER');
    },
  },
]);

// The secret lives in the encrypted vault, never in this table.
registerMigrations([210, 219], [
  {
    version: 210,
    name: 'credentials',
    up: (db) =>
      db.exec(
        'CREATE TABLE IF NOT EXISTS credentials (' +
          "id TEXT PRIMARY KEY, name TEXT NOT NULL, origin TEXT NOT NULL, username TEXT NOT NULL DEFAULT '', " +
          'created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_used_at INTEGER);' +
          'CREATE UNIQUE INDEX IF NOT EXISTS idx_credentials_name ON credentials(name COLLATE NOCASE)',
      ),
  },
]);

registerMigrations([250, 259], [
  {
    version: 250,
    name: 'lane_journal.status + message_id (steering)',
    up: (db) => {
      addColumnIfMissing(db, 'lane_journal', 'status', "TEXT NOT NULL DEFAULT 'queued'");
      addColumnIfMissing(db, 'lane_journal', 'message_id', 'TEXT');
    },
  },
  {
    version: 251,
    name: 'messages.cancelled_at + edited_at, lane_pauses (queue controls)',
    up: (db) => {
      addColumnIfMissing(db, 'messages', 'cancelled_at', 'INTEGER');
      addColumnIfMissing(db, 'messages', 'edited_at', 'INTEGER');
      db.exec(
        'CREATE TABLE IF NOT EXISTS lane_pauses (bot_id TEXT NOT NULL, room_id TEXT NOT NULL, paused_at INTEGER NOT NULL, PRIMARY KEY (bot_id, room_id))',
      );
    },
  },
]);

registerMigrations([260, 269], [
  {
    version: 260,
    name: 'file_revisions (provenance of shared files)',
    up: (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS file_revisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        root_kind TEXT NOT NULL,
        root_key TEXT NOT NULL,
        path TEXT NOT NULL,
        rev INTEGER NOT NULL,
        hash TEXT,
        size INTEGER NOT NULL DEFAULT 0,
        content TEXT,
        author_kind TEXT NOT NULL,
        author_id TEXT,
        author_label TEXT NOT NULL DEFAULT '',
        machine TEXT NOT NULL,
        session_id TEXT,
        room_id TEXT,
        sources TEXT,
        tool TEXT,
        created_at INTEGER NOT NULL
      )`);
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS file_revisions_path_rev ON file_revisions (root_kind, root_key, path, rev)');
    },
  },
]);

registerMigrations([270, 279], [
  {
    version: 270,
    name: 'pc_sessions + pc_session_entries (PC session mirror)',
    up: (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS pc_sessions (
        id TEXT PRIMARY KEY,
        parent_id TEXT,
        machine TEXT NOT NULL,
        project_dir TEXT NOT NULL DEFAULT '',
        cwd TEXT,
        repo_json TEXT,
        title TEXT,
        first_at INTEGER NOT NULL,
        last_at INTEGER NOT NULL,
        offset INTEGER NOT NULL DEFAULT 0,
        entry_count INTEGER NOT NULL DEFAULT 0,
        bytes INTEGER NOT NULL DEFAULT 0,
        truncated INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      )`);
      db.exec('CREATE INDEX IF NOT EXISTS pc_sessions_last ON pc_sessions (last_at)');
      db.exec('CREATE INDEX IF NOT EXISTS pc_sessions_parent ON pc_sessions (parent_id)');
      db.exec(`CREATE TABLE IF NOT EXISTS pc_session_entries (
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        uuid TEXT NOT NULL,
        parent_uuid TEXT,
        at INTEGER NOT NULL,
        kind TEXT NOT NULL,
        text TEXT NOT NULL DEFAULT '',
        tool TEXT,
        is_error INTEGER NOT NULL DEFAULT 0,
        is_sidechain INTEGER NOT NULL DEFAULT 0,
        model TEXT,
        PRIMARY KEY (session_id, seq)
      )`);
      db.exec('CREATE INDEX IF NOT EXISTS pc_session_entries_seq ON pc_session_entries (session_id, seq)');
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS pc_session_entries_uuid ON pc_session_entries (session_id, uuid)');
    },
  },
  {
    version: 271,
    name: 'pc_session_tombstones (a deleted mirrored session is not mirrored again)',
    up: (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS pc_session_tombstones (
        id TEXT PRIMARY KEY,
        deleted_at INTEGER NOT NULL,
        by_owner INTEGER NOT NULL DEFAULT 0
      )`);
    },
  },
]);

registerMigrations([280, 289], [
  {
    version: 280,
    name: 'pc_session_moves (a PC session moved to the VPS)',
    up: (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS pc_session_moves (
        session_id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        project TEXT,
        room_id TEXT,
        repos_json TEXT NOT NULL DEFAULT '[]',
        pc_root TEXT,
        vps_cwd TEXT,
        worktree TEXT,
        feed_offset INTEGER NOT NULL DEFAULT 0,
        moved_at INTEGER NOT NULL,
        pulled_at INTEGER,
        move_job_id TEXT,
        pull_job_id TEXT,
        turns INTEGER NOT NULL DEFAULT 0
      )`);
    },
  },
  {
    version: 281,
    name: 'pc_jobs.move_json, move_result_json, pull_json, pull_result_json',
    up: (db) => {
      addColumnIfMissing(db, 'pc_jobs', 'move_json', 'TEXT');
      addColumnIfMissing(db, 'pc_jobs', 'move_result_json', 'TEXT');
      addColumnIfMissing(db, 'pc_jobs', 'pull_json', 'TEXT');
      addColumnIfMissing(db, 'pc_jobs', 'pull_result_json', 'TEXT');
    },
  },
  { version: 282, name: 'pc_session_entries.machine', up: (db) => addColumnIfMissing(db, 'pc_session_entries', 'machine', 'TEXT') },
]);

registerMigrations([290, 299], [
  {
    version: 290,
    name: 'lane_journal.owner_ref + approvals.owner_ref (backfilled from run_id)',
    up: (db) => {
      addColumnIfMissing(db, 'lane_journal', 'owner_ref', 'TEXT');
      addColumnIfMissing(db, 'approvals', 'owner_ref', 'TEXT');
      db.exec("UPDATE lane_journal SET owner_ref='routine:'||run_id WHERE owner_ref IS NULL AND run_id IS NOT NULL");
      db.exec("UPDATE approvals SET owner_ref='routine:'||run_id WHERE owner_ref IS NULL AND run_id IS NOT NULL");
    },
  },
  {
    version: 291,
    name: 'workflows table',
    up: (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS workflows (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        room_id TEXT NOT NULL,
        trigger_kind TEXT NOT NULL CHECK(trigger_kind IN ('routine','trigger','manual')),
        routine_id TEXT,
        trigger_id TEXT,
        graph_json TEXT NOT NULL,
        budget_usd REAL NOT NULL DEFAULT 2,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`);
      db.exec('CREATE INDEX IF NOT EXISTS idx_workflows_routine ON workflows(routine_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_workflows_trigger ON workflows(trigger_id)');
    },
  },
  {
    version: 292,
    name: 'workflow_runs table',
    up: (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS workflow_runs (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        cause_id TEXT,
        node_id TEXT,
        status TEXT NOT NULL CHECK(status IN ('running','waiting','success','error','cancelled')),
        steps_json TEXT NOT NULL DEFAULT '[]',
        graph_json TEXT NOT NULL,
        budget_usd REAL NOT NULL DEFAULT 2,
        cost_usd REAL NOT NULL DEFAULT 0,
        manual INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        expires_at INTEGER,
        started_at INTEGER NOT NULL,
        ended_at INTEGER
      )`);
      db.exec('CREATE INDEX IF NOT EXISTS idx_workflow_runs_wf ON workflow_runs(workflow_id, started_at)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status)');
    },
  },
  { version: 293, name: 'workflow_runs.room_id', up: (db) => addColumnIfMissing(db, 'workflow_runs', 'room_id', 'TEXT') },
]);

// The bot token is in the encrypted vault, never here.
registerMigrations([300, 309], [
  {
    version: 300,
    name: 'telegram_link',
    up: (db) =>
      db.exec(`CREATE TABLE IF NOT EXISTS telegram_link (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        bot_id TEXT,
        bot_username TEXT,
        chat_id TEXT,
        linked_name TEXT,
        notify INTEGER NOT NULL DEFAULT 0,
        linked_at INTEGER
      )`),
  },
]);

registerMigrations([310, 319], [
  { version: 310, name: 'bots.provider', up: (db) => addColumnIfMissing(db, 'bots', 'provider', 'TEXT') },
  { version: 311, name: 'bots.backup', up: (db) => addColumnIfMissing(db, 'bots', 'backup', 'TEXT') },
  { version: 312, name: 'usage.provider', up: (db) => addColumnIfMissing(db, 'usage', 'provider', 'TEXT') },
  {
    version: 313,
    name: 'failover_cards',
    up: (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS failover_cards (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL,
        room_id TEXT NOT NULL,
        cause_id TEXT NOT NULL,
        hop INTEGER NOT NULL DEFAULT 0,
        provider TEXT NOT NULL,
        model TEXT,
        limit_window TEXT,
        backup_provider TEXT NOT NULL,
        backup_model TEXT NOT NULL,
        resets_at INTEGER,
        expires_at INTEGER NOT NULL,
        from_seq INTEGER NOT NULL DEFAULT 0,
        to_seq INTEGER NOT NULL DEFAULT 0,
        budget_usd REAL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        answered_at INTEGER
      )`);
      db.exec('CREATE INDEX IF NOT EXISTS idx_failover_cards_status ON failover_cards(status, expires_at)');
    },
  },
]);

registerMigrations([320, 329], [
  { version: 320, name: 'approval_policies.message', up: (db) => addColumnIfMissing(db, 'approval_policies', 'message', 'TEXT') },
  { version: 321, name: 'rooms.lead_mode', up: (db) => addColumnIfMissing(db, 'rooms', 'lead_mode', 'INTEGER NOT NULL DEFAULT 0') },
]);

// Local-first game dev (spec toki-local-first-gamedev). B12: a 'game' project gets Toki's headless Blender.
registerMigrations([330, 339], [
  { version: 330, name: 'projects.kind', up: (db) => addColumnIfMissing(db, 'projects', 'kind', 'TEXT') },
  // B10: names of projects on another host, written only by the desktop app with the hub token. Bots never read these.
  {
    version: 331,
    name: 'remote_hosts',
    up: (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS remote_hosts (
        host TEXT PRIMARY KEY,
        connected INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      )`);
      db.exec(`CREATE TABLE IF NOT EXISTS project_stubs (
        host TEXT NOT NULL,
        slug TEXT NOT NULL,
        name TEXT NOT NULL,
        seen_at INTEGER NOT NULL,
        PRIMARY KEY (host, slug)
      )`);
    },
  },
]);
