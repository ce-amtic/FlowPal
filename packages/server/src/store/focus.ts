import type { DatabaseSync } from 'node:sqlite'
import type { Ctx } from '@flowpal/shared'
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
       (id, started_at, planned_minutes, actual_minutes, ended_early, item_id, project_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    session.id, session.startedAt, session.plannedMinutes, session.actualMinutes,
    session.endedEarly, session.itemId, session.projectId, session.createdAt,
  )
  return session
}

export function listFocusSessions(db: DatabaseSync): FocusSession[] {
  const rows = db.prepare(`SELECT * FROM focus_sessions ORDER BY started_at DESC`).all() as Record<string, any>[]
  return rows.map(rowToSession)
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
