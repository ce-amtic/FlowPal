import type { DatabaseSync } from 'node:sqlite'
import type { Citation, Ctx, ExtractedItem, Item, MergePlan, PlannedItem } from '@flowpal/shared'
import { newId } from './db.ts'

export type ItemWithSources = Item & {
  sourceFragmentIds: string[]
  citations: Citation[]
}

export function listItems(db: DatabaseSync): ItemWithSources[] {
  const rows = db.prepare(
    `SELECT * FROM items WHERE status != 'dropped' ORDER BY created_at DESC`,
  ).all() as Record<string, any>[]
  return rows.map((row) => hydrate(db, rowToItem(row)))
}

export function getItem(db: DatabaseSync, id: string): ItemWithSources | null {
  const row = db.prepare(`SELECT * FROM items WHERE id = ?`).get(id) as Record<string, any> | undefined
  return row ? hydrate(db, rowToItem(row)) : null
}

/**
 * 落合并计划。语义层只算出计划，写 item_sources / item_history 的是这里。
 *
 * 返回受影响的条目 id，顺序与传入的 planned 一一对应。
 */
export function applyPlans(
  db: DatabaseSync, ctx: Ctx, fragmentId: string, planned: PlannedItem[],
): string[] {
  const out: string[] = []
  for (const { extracted, plan } of planned) {
    out.push(applyOne(db, ctx, fragmentId, extracted, plan))
  }
  return out
}

function applyOne(
  db: DatabaseSync, ctx: Ctx, fragmentId: string, extracted: ExtractedItem, plan: MergePlan,
): string {
  switch (plan.action) {
    case 'new': {
      const id = insertItem(db, ctx, extracted)
      addSource(db, ctx, id, fragmentId)
      addCitations(db, id, fragmentId, extracted)
      return id
    }
    case 'merge_into': {
      // 已有条目再多一个来源。items 一个字段都不用动。
      addSource(db, ctx, plan.itemId, fragmentId)
      addCitations(db, plan.itemId, fragmentId, extracted)
      return plan.itemId
    }
    case 'reschedule': {
      // 改期：既是合并也是一次带来源的字段变更。历史里那一行是画像的「日期推移」信号。
      // 动哪一列由语义层在计划里指定，这里不猜。
      db.prepare(`UPDATE items SET ${plan.field} = ?, updated_at = ? WHERE id = ?`)
        .run(plan.to, ctx.now, plan.itemId)
      recordHistory(db, ctx, plan.itemId, plan.field, plan.from, plan.to, 'llm', fragmentId)
      addSource(db, ctx, plan.itemId, fragmentId)
      addCitations(db, plan.itemId, fragmentId, extracted)
      return plan.itemId
    }
  }
}

function insertItem(db: DatabaseSync, ctx: Ctx, e: ExtractedItem): string {
  const id = newId('itm')
  db.prepare(
    `INSERT INTO items (id, type, title, starts_at, due_at, date_precision, date_raw, rrule,
                        date_confidence, confidence, location, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, e.type, e.title, e.starts_at, e.due_at, e.date_precision, e.date_raw, e.recurrence,
    e.date_confidence, e.confidence, e.location,
    // 低置信度不直接入库，进待确认队列；产品不催，用户永远可以不理它。
    e.confidence === 'low' ? 'needs_confirm' : 'active',
    ctx.now, ctx.now,
  )
  return id
}

function addSource(db: DatabaseSync, ctx: Ctx, itemId: string, fragmentId: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO item_sources (item_id, fragment_id, added_at) VALUES (?, ?, ?)`,
  ).run(itemId, fragmentId, ctx.now)
}

function addCitations(db: DatabaseSync, itemId: string, fragmentId: string, e: ExtractedItem): void {
  const raw = db.prepare(`SELECT raw_text FROM fragments WHERE id = ?`).get(fragmentId) as
    { raw_text: string | null } | undefined
  const text = raw?.raw_text ?? ''
  for (const c of e.citations) {
    // 引用必须逐字出现在原文里；偏移由我们算，不问模型要。
    const start = text.indexOf(c.quote)
    db.prepare(
      `INSERT OR REPLACE INTO item_citations
         (item_id, field, fragment_id, quote, start_offset, end_offset)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(itemId, c.field, fragmentId, c.quote, start, start < 0 ? -1 : start + c.quote.length)
  }
}

export function updateItemFields(
  db: DatabaseSync, ctx: Ctx, id: string, patch: Record<string, string | null>,
): void {
  const before = db.prepare(`SELECT * FROM items WHERE id = ?`).get(id) as Record<string, any> | undefined
  if (!before) throw new Error(`条目不存在：${id}`)
  for (const [field, value] of Object.entries(patch)) {
    if (!ALLOWED_PATCH_FIELDS.has(field)) throw new Error(`不可改的字段：${field}`)
    if (before[field] === value) continue
    db.prepare(`UPDATE items SET ${field} = ?, updated_at = ? WHERE id = ?`).run(value, ctx.now, id)
    recordHistory(db, ctx, id, field, before[field], value, 'user', null)
  }
}

const ALLOWED_PATCH_FIELDS = new Set([
  'title', 'type', 'starts_at', 'due_at', 'date_precision', 'date_raw',
  'rrule', 'location', 'status', 'confidence',
])

function recordHistory(
  db: DatabaseSync, ctx: Ctx, itemId: string, field: string,
  oldValue: string | null, newValue: string | null,
  actor: 'user' | 'llm' | 'merge', fragmentId: string | null,
): void {
  db.prepare(
    `INSERT INTO item_history (id, item_id, changed_at, field, old_value, new_value, actor, fragment_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(newId('hst'), itemId, ctx.now, field, oldValue, newValue, actor, fragmentId)
}

export function itemHistory(db: DatabaseSync, itemId: string): Record<string, any>[] {
  return db.prepare(
    `SELECT * FROM item_history WHERE item_id = ? ORDER BY changed_at`,
  ).all(itemId) as Record<string, any>[]
}

function hydrate(db: DatabaseSync, item: Item): ItemWithSources {
  const sources = db.prepare(
    `SELECT fragment_id FROM item_sources WHERE item_id = ? ORDER BY added_at`,
  ).all(item.id) as { fragment_id: string }[]
  const citations = db.prepare(
    `SELECT * FROM item_citations WHERE item_id = ?`,
  ).all(item.id) as Record<string, any>[]
  return {
    ...item,
    sourceFragmentIds: sources.map((s) => s.fragment_id),
    citations: citations.map((c) => ({
      itemId: c.item_id,
      field: c.field,
      fragmentId: c.fragment_id,
      quote: c.quote,
      startOffset: c.start_offset,
      endOffset: c.end_offset,
    })),
  }
}

function rowToItem(row: Record<string, any>): Item {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    startsAt: row.starts_at,
    dueAt: row.due_at,
    datePrecision: row.date_precision,
    dateRaw: row.date_raw,
    rrule: row.rrule,
    dateConfidence: row.date_confidence,
    confidence: row.confidence,
    location: row.location,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
