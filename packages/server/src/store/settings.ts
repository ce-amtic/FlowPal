import type { DatabaseSync } from 'node:sqlite'
import type { Ctx } from '@flowpal/shared'

const INSERT = `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`

export function getSetting(db: DatabaseSync, key: string): string | null {
  const row = db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get(key) as
    { value: string } | undefined
  return row?.value ?? null
}

export function setSetting(db: DatabaseSync, ctx: Ctx, key: string, value: string): void {
  db.prepare(INSERT).run(key, value, ctx.now)
}
