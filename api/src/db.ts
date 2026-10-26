import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type DB = Database.Database;

/**
 * Forward-only migrations. Never edit an entry once it has shipped; append a new one.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE workspaces (
    id INTEGER PRIMARY KEY,
    pdaftar_shop_id INTEGER NOT NULL UNIQUE,
    shop_name TEXT NOT NULL,
    pdaftar_token_enc TEXT NOT NULL,
    settings_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );
  CREATE TABLE oauth_states (
    state TEXT PRIMARY KEY,
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE ig_accounts (
    id INTEGER PRIMARY KEY,
    workspace_id INTEGER NOT NULL UNIQUE REFERENCES workspaces(id) ON DELETE CASCADE,
    ig_user_id TEXT NOT NULL UNIQUE,
    username TEXT NOT NULL,
    profile_picture_url TEXT,
    access_token_enc TEXT NOT NULL,
    token_expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE conversations (
    id INTEGER PRIMARY KEY,
    ig_account_id INTEGER NOT NULL REFERENCES ig_accounts(id) ON DELETE CASCADE,
    igsid TEXT NOT NULL,
    username TEXT,
    ai_enabled INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'open',
    last_inbound_at TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (ig_account_id, igsid)
  );
  CREATE TABLE messages (
    id INTEGER PRIMARY KEY,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    direction TEXT NOT NULL,
    mid TEXT UNIQUE,
    text TEXT,
    attachments_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'received',
    handled_by TEXT,
    ai_meta_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX messages_conversation ON messages(conversation_id, id);
  CREATE TABLE comments (
    id INTEGER PRIMARY KEY,
    ig_account_id INTEGER NOT NULL REFERENCES ig_accounts(id) ON DELETE CASCADE,
    comment_id TEXT NOT NULL UNIQUE,
    media_id TEXT,
    from_id TEXT,
    from_username TEXT,
    text TEXT,
    reply_text TEXT,
    reply_comment_id TEXT,
    status TEXT NOT NULL DEFAULT 'received',
    reason TEXT,
    ai_meta_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE webhook_events (
    dedupe_key TEXT PRIMARY KEY,
    received_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE jobs (
    id INTEGER PRIMARY KEY,
    type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    run_after TEXT NOT NULL DEFAULT (datetime('now')),
    last_error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX jobs_pending ON jobs(status, run_after);
  CREATE TABLE promo_videos (
    id INTEGER PRIMARY KEY,
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    product_ids_json TEXT NOT NULL,
    template TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    caption TEXT,
    video_file TEXT,
    cover_file TEXT,
    ig_container_id TEXT,
    ig_media_id TEXT,
    permalink TEXT,
    scheduled_at TEXT,
    error TEXT,
    ai_meta_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE media_products (
    ig_media_id TEXT PRIMARY KEY,
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    product_ids_json TEXT NOT NULL
  );
  CREATE TABLE usage (
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    month TEXT NOT NULL,
    replies INTEGER NOT NULL DEFAULT 0,
    videos INTEGER NOT NULL DEFAULT 0,
    ai_calls INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (workspace_id, month)
  );
  `,
];

export function openDb(file: string): DB {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

function migrate(db: DB): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)');
  const done = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map((r) => r.version),
  );
  MIGRATIONS.forEach((sql, i) => {
    if (done.has(i + 1)) return;
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(i + 1);
    })();
  });
}

export function currentMonth(now = new Date()): string {
  return now.toISOString().slice(0, 7);
}

export function bumpUsage(db: DB, workspaceId: number, field: 'replies' | 'videos' | 'ai_calls', by = 1): void {
  db.prepare(
    `INSERT INTO usage (workspace_id, month, ${field}) VALUES (?, ?, ?)
     ON CONFLICT (workspace_id, month) DO UPDATE SET ${field} = ${field} + excluded.${field}`,
  ).run(workspaceId, currentMonth(), by);
}
