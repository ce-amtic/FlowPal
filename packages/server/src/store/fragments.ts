import type { DatabaseSync } from 'node:sqlite'
import type { Ctx, Fragment, FragmentSource, RawType } from '@flowpal/shared'
import { newId } from './db.ts'

export type NewFragment = {
  source: FragmentSource
  rawType: RawType
  rawText?: string | null
  rawBlobPath?: string | null
  device?: string
}

/**
 * 碎片只增。这个模块不导出 update 或 delete，也不该有——
 * 「扔了就可以忘」只有在用户随时能看到「它是从哪句话理解出来的」时才成立。
 */
export function insertFragment(db: DatabaseSync, ctx: Ctx, input: NewFragment): Fragment {
  const fragment: Fragment = {
    id: newId('frg'),
    createdAt: ctx.now,
    device: input.device ?? 'desktop',
    source: input.source,
    rawType: input.rawType,
    rawText: input.rawText ?? null,
    rawBlobPath: input.rawBlobPath ?? null,
  }
  db.prepare(
    `INSERT INTO fragments (id, created_at, device, source, raw_type, raw_text, raw_blob_path)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    fragment.id, fragment.createdAt, fragment.device, fragment.source,
    fragment.rawType, fragment.rawText, fragment.rawBlobPath,
  )
  return fragment
}

export function getFragment(db: DatabaseSync, id: string): Fragment | null {
  const row = db.prepare(`SELECT * FROM fragments WHERE id = ?`).get(id) as Record<string, any> | undefined
  return row ? rowToFragment(row) : null
}

export function listFragments(db: DatabaseSync): Fragment[] {
  const rows = db.prepare(`SELECT * FROM fragments ORDER BY created_at DESC`).all() as Record<string, any>[]
  return rows.map(rowToFragment)
}

export function countFragments(db: DatabaseSync): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM fragments`).get() as { n: number }
  return row.n
}

function rowToFragment(row: Record<string, any>): Fragment {
  return {
    id: row.id,
    createdAt: row.created_at,
    device: row.device,
    source: row.source,
    rawType: row.raw_type,
    rawText: row.raw_text,
    rawBlobPath: row.raw_blob_path,
  }
}
