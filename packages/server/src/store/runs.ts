import type { DatabaseSync } from 'node:sqlite'
import type { Ctx, Run, RunCounts, RunStatus } from '@flowpal/shared'
import { newId } from './db.ts'

/**
 * 一次投放的处理记录。「最近」页的落点、气泡回执与 /api/runs/:id/events 的共同对象。
 * 碎片已落库而 run 失败，是「原文已存」那四种话术要表达的常态，不是异常路径。
 */
export function startRun(db: DatabaseSync, ctx: Ctx, fragmentId: string): Run {
  const run: Run = {
    id: newId('run'),
    fragmentId,
    status: 'running',
    startedAt: ctx.now,
    finishedAt: null,
    message: null,
    counts: null,
  }
  db.prepare(
    `INSERT INTO runs (id, fragment_id, status, started_at, finished_at, message, counts)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(run.id, run.fragmentId, run.status, run.startedAt, null, null, null)
  return run
}

export function finishRun(
  db: DatabaseSync, ctx: Ctx, runId: string, status: Exclude<RunStatus, 'running'>,
  message: string | null, counts: RunCounts | null,
): Run {
  db.prepare(
    `UPDATE runs SET status = ?, finished_at = ?, message = ?, counts = ? WHERE id = ?`,
  ).run(status, ctx.now, message, counts ? JSON.stringify(counts) : null, runId)
  const run = getRun(db, runId)
  if (!run) throw new Error(`run 不存在：${runId}`)
  return run
}

export function getRun(db: DatabaseSync, id: string): Run | null {
  const row = db.prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as Record<string, any> | undefined
  return row ? rowToRun(row) : null
}

export function listRuns(db: DatabaseSync): Run[] {
  const rows = db.prepare(`SELECT * FROM runs ORDER BY started_at DESC`).all() as Record<string, any>[]
  return rows.map(rowToRun)
}

function rowToRun(row: Record<string, any>): Run {
  return {
    id: row.id,
    fragmentId: row.fragment_id,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    message: row.message,
    counts: row.counts ? JSON.parse(row.counts) : null,
  }
}
