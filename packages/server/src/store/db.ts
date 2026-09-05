import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { SCHEMA } from './schema.ts'

/**
 * node:sqlite is built into the Node/Electron runtime; no native rebuild is
 * needed. Schema changes are explicit so a stale user database is never
 * silently rebuilt over user data.
 */
export const SCHEMA_VERSION = 5

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  return rows.some((row) => row.name === column)
}

/** Upgrade the A v4 schema while preserving all existing rows. */
function migrateV4ToV5(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    if (!hasColumn(db, 'focus_sessions', 'ended_at')) {
      db.exec('ALTER TABLE focus_sessions ADD COLUMN ended_at TEXT')
    }
    if (!hasColumn(db, 'focus_sessions', 'outcome')) {
      db.exec('ALTER TABLE focus_sessions ADD COLUMN outcome TEXT')
    }
    if (!hasColumn(db, 'focus_sessions', 'client_key')) {
      db.exec('ALTER TABLE focus_sessions ADD COLUMN client_key TEXT')
    }
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_focus_client_key ON focus_sessions(client_key)`)
    db.exec(`
      CREATE TABLE IF NOT EXISTS focus_session_fragments (
        session_id TEXT NOT NULL REFERENCES focus_sessions(id) ON DELETE CASCADE,
        fragment_id TEXT NOT NULL REFERENCES fragments(id),
        added_at TEXT NOT NULL,
        PRIMARY KEY (session_id, fragment_id)
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sync_runs (
        id TEXT PRIMARY KEY,
        source TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        status TEXT NOT NULL,
        imported_count INTEGER NOT NULL DEFAULT 0,
        error_code TEXT,
        error_message TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_sync_runs_started ON sync_runs(started_at);
      CREATE INDEX IF NOT EXISTS idx_sync_runs_running ON sync_runs(status);
      CREATE TABLE IF NOT EXISTS sync_records (
        external_id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        kind TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        item_id TEXT REFERENCES items(id),
        raw_json TEXT
      );
    `)
    db.exec('COMMIT')
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* keep the original migration error */ }
    throw error
  }
}

export function openDb(dataDir: string): DatabaseSync {
  const db = dataDir === ':memory:'
    ? new DatabaseSync(':memory:')
    : (() => {
        mkdirSync(dataDir, { recursive: true })
        return new DatabaseSync(join(dataDir, 'flowpal.db'))
      })()

  const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
  const hasTables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'fragments'",
  ).get() !== undefined

  if (hasTables && version === SCHEMA_VERSION - 1) {
    try {
      migrateV4ToV5(db)
    } catch (error) {
      db.close()
      throw new Error(
        `数据库从 schema v${version} 升级到 v${SCHEMA_VERSION} 失败；` +
        `未继续启动，保留原库供人工检查。原因：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  } else if (hasTables && version !== SCHEMA_VERSION) {
    db.close()
    throw new Error(
      `数据库是旧形状（schema v${version}，当前 v${SCHEMA_VERSION}），不做静默迁移。` +
      `库里还没有真实数据，删掉 ${join(dataDir, 'flowpal.db')} 重启即可（demo:reset 上线后用它重建）。`,
    )
  }

  db.exec(SCHEMA)
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
  return db
}

/** IDs do not depend on wall-clock reads; request context owns the clock. */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`
}
