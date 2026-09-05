import type { DatabaseSync } from 'node:sqlite'
import type { Ctx } from '@flowpal/shared'

export type NowCacheRow = { payload: string; createdAt: string }

export function getNowCache(db: DatabaseSync): NowCacheRow | null {
  const row = db.prepare(`SELECT payload, created_at FROM now_cache WHERE id = 'singleton'`).get() as
    { payload: string; created_at: string } | undefined
  return row ? { payload: row.payload, createdAt: row.created_at } : null
}

export function setNowCache(db: DatabaseSync, ctx: Ctx, payload: string): void {
  db.prepare(
    `INSERT INTO now_cache (id, payload, created_at) VALUES ('singleton', ?, ?)
     ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, created_at = excluded.created_at`,
  ).run(payload, ctx.now)
}

export function clearNowCache(db: DatabaseSync): void {
  db.prepare(`DELETE FROM now_cache WHERE id = 'singleton'`).run()
}
