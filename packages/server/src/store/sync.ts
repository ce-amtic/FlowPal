import type { DatabaseSync } from 'node:sqlite'
import type {
  Ctx, ExternalKind, ExternalRecord, ExternalSource, RucExternalSource, SourceCapability,
  SyncRun, SyncRunStatus, SyncStatus,
} from '@flowpal/shared'
import type { ServerConfig } from '../config.ts'
import { newId } from './db.ts'

export function startSyncRun(
  db: DatabaseSync, ctx: Ctx, source: RucExternalSource | null,
): { run: SyncRun; reused: boolean } {
  const existing = db.prepare(
    `SELECT * FROM sync_runs WHERE status = 'running' ORDER BY started_at DESC LIMIT 1`,
  ).get() as Record<string, any> | undefined
  if (existing) {
    // A process crash can leave a durable running row behind. Reuse recent
    // work for idempotence, but do not let a stale row block every future
    // manual or scheduled sync forever.
    const age = Date.parse(ctx.now) - Date.parse(String(existing.started_at))
    // An invalid timestamp is just as unrecoverable as an old one; keeping it
    // forever would permanently block manual sync after a partial write.
    // A future timestamp can come from a clock correction or a partially
    // written fixture; it must not pin the app in "running" forever either.
    if (!Number.isFinite(age) || age < 0 || age >= 30 * 60 * 1000) {
      db.prepare(
        `UPDATE sync_runs SET ended_at = ?, status = 'failed', error_code = ?,
         error_message = ? WHERE id = ? AND status = 'running'`,
      ).run(ctx.now, 'stale_run_recovered', '上一次同步进程已中断，本次重新开始', existing.id)
    } else {
      return { run: rowToSyncRun(existing), reused: true }
    }
  }

  const run: SyncRun = {
    id: newId('syn'),
    source,
    startedAt: ctx.now,
    endedAt: null,
    status: 'running',
    importedCount: 0,
    errorCode: null,
    errorMessage: null,
  }
  db.prepare(
    `INSERT INTO sync_runs
       (id, source, started_at, ended_at, status, imported_count, error_code, error_message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(run.id, run.source, run.startedAt, null, run.status, 0, null, null)
  return { run, reused: false }
}

export function finishSyncRun(
  db: DatabaseSync, ctx: Ctx, id: string, status: Exclude<SyncRunStatus, 'running'>,
  importedCount: number, errorCode: string | null, errorMessage: string | null,
): SyncRun {
  const before = db.prepare(`SELECT * FROM sync_runs WHERE id = ?`).get(id) as Record<string, any> | undefined
  if (!before) throw new Error(`sync run 不存在：${id}`)
  // Completion is a durable one-shot transition.  A late retry from an
  // adapter must not rewrite a successful (or explicitly failed) run with a
  // contradictory outcome.
  if (before.status !== 'running') return rowToSyncRun(before)
  db.prepare(
    `UPDATE sync_runs SET ended_at = ?, status = ?, imported_count = ?, error_code = ?,
       error_message = ? WHERE id = ?`,
  ).run(ctx.now, status, importedCount, errorCode, errorMessage, id)
  const row = db.prepare(`SELECT * FROM sync_runs WHERE id = ?`).get(id) as Record<string, any> | undefined
  if (!row) throw new Error(`sync run 不存在：${id}`)
  return rowToSyncRun(row)
}

export function getSyncRun(db: DatabaseSync, id: string): SyncRun | null {
  const row = db.prepare(`SELECT * FROM sync_runs WHERE id = ?`).get(id) as Record<string, any> | undefined
  return row ? rowToSyncRun(row) : null
}

export function listSyncRuns(db: DatabaseSync, limit = 10): SyncRun[] {
  const rows = db.prepare(
    `SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT ?`,
  ).all(Math.max(1, Math.min(100, limit))) as Record<string, any>[]
  return rows.map(rowToSyncRun)
}

export function buildCapabilities(
  config: ServerConfig,
  authorized: boolean,
  onlineAdapterAvailable = false,
): SourceCapability[] {
  // Authentication is owned by the desktop broker, not by a plaintext server
  // config entry.  A persisted `authorized` flag alone is therefore not
  // enough to claim that a source can be queried: the broker seam must also
  // be present.  Keep this mapping explicit so settings never says "可用"
  // while the server would only produce an unsupported run.
  // Keep the legacy config guard for standalone server callers that have no
  // broker.  A desktop broker is authoritative when present and may provide
  // a transport without putting a password in ServerConfig.
  const credentialsConfigured = Boolean(
    config.ruc?.studentId.trim() && config.ruc.password.length > 0,
  )
  const status = !authorized || (!credentialsConfigured && !onlineAdapterAvailable)
    ? 'unauthorized' as const
    : onlineAdapterAvailable
      ? 'available' as const
      : 'unsupported' as const
  const reason = !authorized || (!credentialsConfigured && !onlineAdapterAvailable)
    ? 'ruc_login_required'
    : onlineAdapterAvailable
      ? null
      : 'ruc_connector_not_implemented'
  return [
    // The portal endpoint also carries category -2 teaching/adjustment rows;
    // exposing only `calendar` here would make a successful imported timetable
    // look unsupported in Settings.  Exams remain a separate, explicit P1
    // limitation rather than being inferred from this capability flag.
    { source: 'ruc.portal', kinds: ['calendar', 'timetable'], status, reason },
    // Exams remain P1: the shared enum reserves the kind, but no verified
    // endpoint/normalizer exists yet. Advertising it here would make an
    // available timetable broker look like an available exam connector.
    { source: 'ruc.graduate', kinds: ['timetable'], status, reason },
  ]
}

export function getSyncStatus(
  db: DatabaseSync, config: ServerConfig, authorized: boolean, onlineAdapterAvailable = false,
): SyncStatus {
  const running = db.prepare(
    `SELECT id FROM sync_runs WHERE status = 'running' ORDER BY started_at DESC LIMIT 1`,
  ).get() as { id: string } | undefined
  return {
    runningRunId: running?.id ?? null,
    nextRunAt: null,
    capabilities: buildCapabilities(config, authorized, onlineAdapterAvailable),
    recentRuns: listSyncRuns(db),
  }
}

/** Record an adapter result without duplicating its raw response in sync_runs. */
export function upsertSyncRecord(db: DatabaseSync, record: ExternalRecord, itemId: string | null): void {
  db.prepare(
    `INSERT INTO sync_records (external_id, source, kind, observed_at, item_id, raw_json)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(external_id) DO UPDATE SET source = excluded.source, kind = excluded.kind,
       observed_at = excluded.observed_at, item_id = excluded.item_id, raw_json = excluded.raw_json`,
  ).run(
    record.externalId, record.source, record.kind, record.observedAt, itemId,
    // `z.unknown()` intentionally permits an absent/undefined raw value for
    // adapters that have no endpoint body. SQLite bindings do not accept
    // JavaScript `undefined`, so preserve the fact as JSON null rather than
    // turning a valid normalized record into a failed sync transaction.
    JSON.stringify(record.raw ?? null),
  )
}

export function getSyncRecord(db: DatabaseSync, externalId: string): {
  externalId: string; source: ExternalSource; kind: ExternalKind; observedAt: string; itemId: string | null
} | null {
  const row = db.prepare(`SELECT * FROM sync_records WHERE external_id = ?`).get(externalId) as Record<string, any> | undefined
  if (!row) return null
  return {
    externalId: row.external_id,
    source: row.source,
    kind: row.kind,
    observedAt: row.observed_at,
    itemId: row.item_id,
  }
}

function rowToSyncRun(row: Record<string, any>): SyncRun {
  return {
    id: row.id,
    source: row.source,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    status: row.status,
    importedCount: row.imported_count,
    errorCode: row.error_code,
    errorMessage: row.error_message,
  }
}
