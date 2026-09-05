import type { DatabaseSync } from 'node:sqlite'
import type {
  Ctx, EndFocusRequest, FocusResponse, FocusSession as SharedFocusSession,
  FocusSummary, StartFocusRequest,
} from '@flowpal/shared'
import { newId } from './db.ts'

/**
 * 专注时段：一次专注无条件产生的四个数（开始时刻、计划时长、实际时长、是否提前结束）。
 * B 的 /focus 页结束时的两个按钮（已完成 / 下次继续）写这里；buildContext「观察到的」
 * 只从这里读。endedEarly=1 就是「下次继续」。
 */
export type NewFocusSession = {
  startedAt: string
  plannedMinutes: number
  actualMinutes?: number | null
  endedEarly?: boolean
  itemId?: string | null
  projectId?: string | null
}

export type FocusSession = {
  id: string
  startedAt: string
  plannedMinutes: number
  actualMinutes: number | null
  endedEarly: 0 | 1
  itemId: string | null
  projectId: string | null
  createdAt: string
}

export function insertFocusSession(db: DatabaseSync, ctx: Ctx, input: NewFocusSession): FocusSession {
  if (!Number.isInteger(input.plannedMinutes) || input.plannedMinutes <= 0) {
    throw new Error(`plannedMinutes 必须是正整数，收到 ${input.plannedMinutes}`)
  }
  const session: FocusSession = {
    id: newId('fcs'),
    startedAt: input.startedAt,
    plannedMinutes: input.plannedMinutes,
    actualMinutes: input.actualMinutes ?? null,
    endedEarly: input.endedEarly ? 1 : 0,
    itemId: input.itemId ?? null,
    projectId: input.projectId ?? null,
    createdAt: ctx.now,
  }
  db.prepare(
    `INSERT INTO focus_sessions
       (id, started_at, planned_minutes, actual_minutes, ended_early, ended_at, outcome,
        client_key, item_id, project_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    session.id, session.startedAt, session.plannedMinutes, session.actualMinutes,
    session.endedEarly, session.actualMinutes === null ? null : ctx.now,
    // The frozen legacy contract calls endedEarly=1 "下次继续"; preserve
    // that meaning when adapting old callers into the richer outcome enum.
    session.actualMinutes === null ? null : (session.endedEarly ? 'continue' : 'done'),
    null, session.itemId, session.projectId, session.createdAt,
  )
  return session
}

export function listFocusSessions(db: DatabaseSync): FocusSession[] {
  const rows = db.prepare(`SELECT * FROM focus_sessions ORDER BY started_at DESC`).all() as Record<string, any>[]
  return rows.map(rowToSession)
}

/** Canonical read model for the B `/focus` route.  The legacy list above is
 * kept for A's frozen demo endpoint; new clients must not have to understand
 * SQLite's `0|1` booleans or infer status from `actual_minutes`. */
export function listFocusApiSessions(db: DatabaseSync): SharedFocusSession[] {
  const rows = db.prepare(`SELECT * FROM focus_sessions ORDER BY started_at DESC`).all() as Record<string, any>[]
  return rows.map(rowToApiSession)
}

/**
 * Start or recover the one active session for a target. A synchronous SQLite
 * request is serialized, so the read-then-insert is safe for the local server;
 * clientKey additionally protects retries that do not carry a target.
 */
export type StartFocusResult = { response: FocusResponse; reused: boolean }

export function startFocusSessionResult(
  db: DatabaseSync, ctx: Ctx, input: StartFocusRequest,
): StartFocusResult {
  const clientKey = input.idempotencyKey ?? null
  // A retry key deduplicates transport retries, while the target itself is
  // the stronger product invariant: one active session per item/project.
  // Always check both so changing a client-generated key cannot create two
  // simultaneous inbox sessions.
  const existingTarget = findActive(db, input.itemId ?? null, input.projectId ?? null)
  const existingByKey = clientKey
    ? db.prepare(`SELECT * FROM focus_sessions WHERE client_key = ? AND actual_minutes IS NULL`).get(clientKey) as Record<string, any> | undefined
    : undefined
  // Target identity wins. A stale/reused client key must never attach a new
  // focus request to another item's active session.
  const existing = existingTarget ?? existingByKey
  if (existing) return { response: responseFor(db, rowToApiSession(existing), ctx.now), reused: true }

  // A client key only deduplicates an active start request. Once that session
  // ended, release the key so a later focus from the same item can start anew.
  if (clientKey) {
    db.prepare(`UPDATE focus_sessions SET client_key = NULL WHERE client_key = ? AND actual_minutes IS NOT NULL`)
      .run(clientKey)
  }

  const id = newId('fcs')
  try {
    db.prepare(
      `INSERT INTO focus_sessions
         (id, started_at, planned_minutes, actual_minutes, ended_early, ended_at, outcome,
          client_key, item_id, project_id, created_at)
       VALUES (?, ?, ?, NULL, 0, NULL, NULL, ?, ?, ?, ?)`,
    ).run(id, ctx.now, input.plannedMinutes, clientKey, input.itemId ?? null, input.projectId ?? null, ctx.now)
  } catch (error) {
    // A duplicate client key can only happen on a retry; return its durable row.
    if (clientKey) {
      const retry = db.prepare(`SELECT * FROM focus_sessions WHERE client_key = ? AND actual_minutes IS NULL`).get(clientKey) as Record<string, any> | undefined
      if (retry) return { response: responseFor(db, rowToApiSession(retry), ctx.now), reused: true }
    }
    throw error
  }
  const row = db.prepare(`SELECT * FROM focus_sessions WHERE id = ?`).get(id) as Record<string, any>
  return { response: responseFor(db, rowToApiSession(row), ctx.now), reused: false }
}

/** Backward-compatible store API for callers that only need the response. */
export function startFocusSession(
  db: DatabaseSync, ctx: Ctx, input: StartFocusRequest,
): FocusResponse {
  return startFocusSessionResult(db, ctx, input).response
}

export function getFocusSession(db: DatabaseSync, id: string, now: string): FocusResponse | null {
  const row = db.prepare(`SELECT * FROM focus_sessions WHERE id = ?`).get(id) as Record<string, any> | undefined
  return row ? responseFor(db, rowToApiSession(row), now) : null
}

/** End is idempotent: once actual_minutes is set, later actions return the first outcome. */
export function endFocusSession(
  db: DatabaseSync, ctx: Ctx, id: string, input: EndFocusRequest,
): FocusResponse | null {
  const row = db.prepare(`SELECT * FROM focus_sessions WHERE id = ?`).get(id) as Record<string, any> | undefined
  if (!row) return null
  if (row.actual_minutes === null || row.actual_minutes === undefined) {
    const elapsed = elapsedMinutes(row.started_at, ctx.now)
    // The durable timestamps are authoritative.  A renderer may send a
    // display hint, but trusting it would let a stale tab (or a clock-skewed
    // client) rewrite the observation that buildContext relies on.
    const actual = elapsed
    const early = input.outcome !== 'done'
    db.prepare(
      `UPDATE focus_sessions SET actual_minutes = ?, ended_early = ?, ended_at = ?, outcome = ?,
         client_key = NULL WHERE id = ?`,
    ).run(actual, early ? 1 : 0, ctx.now, input.outcome, id)
  }
  const updated = db.prepare(`SELECT * FROM focus_sessions WHERE id = ?`).get(id) as Record<string, any>
  return responseFor(db, rowToApiSession(updated), ctx.now)
}

export function attachFocusFragment(
  db: DatabaseSync, ctx: Ctx, sessionId: string, fragmentId: string,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO focus_session_fragments (session_id, fragment_id, added_at)
     VALUES (?, ?, ?)`,
  ).run(sessionId, fragmentId, ctx.now)
}

function findActive(
  db: DatabaseSync, itemId: string | null, projectId: string | null,
): Record<string, any> | undefined {
  if (itemId) {
    return db.prepare(
      `SELECT * FROM focus_sessions WHERE item_id = ? AND actual_minutes IS NULL
       ORDER BY started_at DESC LIMIT 1`,
    ).get(itemId) as Record<string, any> | undefined
  }
  if (projectId) {
    return db.prepare(
      `SELECT * FROM focus_sessions WHERE project_id = ? AND item_id IS NULL
       AND actual_minutes IS NULL ORDER BY started_at DESC LIMIT 1`,
    ).get(projectId) as Record<string, any> | undefined
  }
  return db.prepare(
    `SELECT * FROM focus_sessions WHERE item_id IS NULL AND project_id IS NULL
     AND actual_minutes IS NULL ORDER BY started_at DESC LIMIT 1`,
  ).get() as Record<string, any> | undefined
}

function rowToApiSession(row: Record<string, any>): SharedFocusSession {
  const actual = row.actual_minutes === null || row.actual_minutes === undefined
    ? null : Number(row.actual_minutes)
  const outcome = row.outcome ?? (actual === null ? null : row.ended_early ? 'continue' : 'done')
  return {
    id: row.id,
    startedAt: row.started_at,
    plannedMinutes: Number(row.planned_minutes),
    actualMinutes: actual,
    endedEarly: Boolean(row.ended_early),
    endedAt: row.ended_at ?? null,
    outcome,
    itemId: row.item_id ?? null,
    projectId: row.project_id ?? null,
    createdAt: row.created_at,
    status: actual === null ? 'running' : 'ended',
  }
}

function responseFor(db: DatabaseSync, session: SharedFocusSession, now: string): FocusResponse {
  const duration = session.actualMinutes ?? elapsedMinutes(session.startedAt, now)
  const row = db.prepare(
    `SELECT COUNT(*) AS n FROM focus_session_fragments WHERE session_id = ?`,
  ).get(session.id) as { n: number }
  const summary: FocusSummary = {
    durationMinutes: duration,
    plannedMinutes: session.plannedMinutes,
    outcome: session.outcome,
    itemId: session.itemId,
    projectId: session.projectId,
    fragmentCount: Number(row.n),
  }
  return { session, summary }
}

function elapsedMinutes(startedAt: string, now: string): number {
  const diff = Date.parse(now) - Date.parse(startedAt)
  if (!Number.isFinite(diff)) throw new Error('专注时段时间格式无效')
  return Math.max(0, Math.floor(diff / 60_000))
}

function rowToSession(row: Record<string, any>): FocusSession {
  return {
    id: row.id,
    startedAt: row.started_at,
    plannedMinutes: row.planned_minutes,
    actualMinutes: row.actual_minutes,
    endedEarly: row.ended_early,
    itemId: row.item_id,
    projectId: row.project_id,
    createdAt: row.created_at,
  }
}
