import type { DatabaseSync } from 'node:sqlite'
import type { Citation, Ctx, ExtractedItem, Item, ItemStatus } from '@flowpal/shared'
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

export type InsertItemOptions = {
  /** 所属项目。progress 不给归属时以 needs_confirm 落库（见 resolveInitialStatus）。 */
  projectId?: string | null
  /** 结构化来源的稳定标识。 */
  externalId?: string | null
}

export function insertItem(
  db: DatabaseSync, ctx: Ctx, e: ExtractedItem, opts: InsertItemOptions = {},
): string {
  const id = newId('itm')
  const projectId = opts.projectId ?? null
  db.prepare(
    `INSERT INTO items (id, type, title, starts_at, due_at, date_precision, date_raw, rrule,
                        date_confidence, confidence, location, status, project_id, external_id,
                        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, e.type, e.title, e.starts_at, e.due_at, e.date_precision, e.date_raw, e.recurrence,
    e.date_confidence, e.confidence, e.location,
    resolveInitialStatus(e, projectId),
    projectId, opts.externalId ?? null,
    ctx.now, ctx.now,
  )
  return id
}

/**
 * 初始状态。进待确认的门槛是「错了不可逆」，不是「模型没把握」——low confidence 仍然直接落库，
 * 用户在条目上自己改；只有 progress 没有所属项目才进待确认（[[010]]、[[015]]）。
 */
export function resolveInitialStatus(e: ExtractedItem, projectId: string | null): ItemStatus {
  if (e.type === 'progress' && projectId === null) return 'needs_confirm'
  return 'active'
}

/** 把一条条目挂到碎片上（来源关联）。合并时只追加，items 一个字段都不用动。 */
export function addItemSource(db: DatabaseSync, ctx: Ctx, itemId: string, fragmentId: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO item_sources (item_id, fragment_id, added_at) VALUES (?, ?, ?)`,
  ).run(itemId, fragmentId, ctx.now)
}

function addSource(db: DatabaseSync, ctx: Ctx, itemId: string, fragmentId: string): void {
  addItemSource(db, ctx, itemId, fragmentId)
}

/**
 * 写入引用的唯一入口（demo 种子也用）。quote 必须逐字出现在碎片原文里——偏移由我们
 * indexOf 出来，不问模型要；对不上时 start_offset 记 -1，调用方（抽取层）应当先拦住。
 */
export function addItemCitations(db: DatabaseSync, itemId: string, fragmentId: string, e: ExtractedItem): void {
  const raw = db.prepare(`SELECT raw_text FROM fragments WHERE id = ?`).get(fragmentId) as
    { raw_text: string | null } | undefined
  const text = raw?.raw_text ?? ''
  for (const c of e.citations) {
    const start = text.indexOf(c.quote)
    db.prepare(
      `INSERT OR REPLACE INTO item_citations
         (item_id, field, fragment_id, quote, start_offset, end_offset)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(itemId, c.field, fragmentId, c.quote, start, start < 0 ? -1 : start + c.quote.length)
  }
}

/**
 * 结构化来源的写入口：按 external_id 覆盖，幂等。课表、考试、系统日历自带稳定标识，
 * 重复拉取不新增条目；字段变化写一行 item_history——改期在这条路上同样是处境信号。
 * B 的 server/sync 是它的唯一调用方，不经过语义链路（[[016]]）。
 */
export function upsertByExternalId(
  db: DatabaseSync, ctx: Ctx, fragmentId: string, externalId: string,
  e: ExtractedItem, opts: InsertItemOptions = {},
): string {
  const row = db.prepare(`SELECT id FROM items WHERE external_id = ?`).get(externalId) as
    { id: string } | undefined
  if (!row) {
    const id = insertItem(db, ctx, e, { ...opts, externalId })
    addSource(db, ctx, id, fragmentId)
    addItemCitations(db, id, fragmentId, e)
    return id
  }

  const id = row.id
  const before = db.prepare(`SELECT * FROM items WHERE id = ?`).get(id) as Record<string, any>
  const fields: [string, string | null][] = [
    ['type', e.type], ['title', e.title], ['starts_at', e.starts_at], ['due_at', e.due_at],
    ['date_precision', e.date_precision], ['date_raw', e.date_raw], ['rrule', e.recurrence],
    ['date_confidence', e.date_confidence], ['confidence', e.confidence], ['location', e.location],
  ]
  for (const [column, value] of fields) {
    if (before[column] === value) continue
    db.prepare(`UPDATE items SET ${column} = ?, updated_at = ? WHERE id = ?`).run(value, ctx.now, id)
    recordItemHistory(db, ctx, id, column, before[column], value, 'sync', fragmentId)
  }
  if (opts.projectId !== undefined && opts.projectId !== null && before.project_id !== opts.projectId) {
    db.prepare(`UPDATE items SET project_id = ?, updated_at = ? WHERE id = ?`).run(opts.projectId, ctx.now, id)
    recordItemHistory(db, ctx, id, 'project_id', before.project_id, opts.projectId, 'sync', fragmentId)
  }
  addSource(db, ctx, id, fragmentId)
  addItemCitations(db, id, fragmentId, e)
  return id
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
    recordItemHistory(db, ctx, id, field, before[field], value, 'user', null)
  }
}

/** agent 循环里的 updateItem。actor 是 llm，fragment_id 指回引发改动的碎片。 */
export function updateItemForAgent(
  db: DatabaseSync, ctx: Ctx, id: string, patch: Record<string, string | null>,
  fragmentId: string, projectId?: string | null,
): void {
  const before = db.prepare(`SELECT * FROM items WHERE id = ?`).get(id) as Record<string, any> | undefined
  if (!before) throw new Error(`条目不存在：${id}`)
  for (const [field, value] of Object.entries(patch)) {
    if (field === 'project') continue
    if (!ALLOWED_PATCH_FIELDS.has(field)) throw new Error(`不可改的字段：${field}`)
    if (before[field] === value) continue
    db.prepare(`UPDATE items SET ${field} = ?, updated_at = ? WHERE id = ?`).run(value, ctx.now, id)
    recordItemHistory(db, ctx, id, field, before[field], value as string | null, 'llm', fragmentId)
  }
  if (projectId !== undefined && before.project_id !== projectId) {
    db.prepare(`UPDATE items SET project_id = ?, updated_at = ? WHERE id = ?`).run(projectId, ctx.now, id)
    recordItemHistory(db, ctx, id, 'project_id', before.project_id, projectId, 'llm', fragmentId)
  }
}

/** 标记丢弃。碎片永不删除，条目也只标不删。 */
export function dropItem(
  db: DatabaseSync, ctx: Ctx, id: string,
  actor: 'user' | 'llm' = 'llm', fragmentId: string | null = null,
): void {
  const before = db.prepare(`SELECT * FROM items WHERE id = ?`).get(id) as Record<string, any> | undefined
  if (!before) throw new Error(`条目不存在：${id}`)
  if (before.status === 'dropped') return
  db.prepare(`UPDATE items SET status = 'dropped', updated_at = ? WHERE id = ?`).run(ctx.now, id)
  recordItemHistory(db, ctx, id, 'status', before.status, 'dropped', actor, fragmentId)
}

/**
 * 工具兜底的条目检索。query 匹配 title / date_raw；from/to 给的是日期，只对有时间字段
 * 的条目做范围过滤。这里不做相关性预筛——那正是模型在循环里该做的事。
 */
export function searchItems(
  db: DatabaseSync, query: string, from: string | null, to: string | null,
): ItemWithSources[] {
  const like = '%' + query + '%'
  const rows = db.prepare(
    `SELECT * FROM items WHERE status != 'dropped' AND (title LIKE ? OR date_raw LIKE ?)
     ORDER BY created_at DESC`,
  ).all(like, like) as Record<string, any>[]
  let items = rows.map((row) => hydrate(db, rowToItem(row)))
  if (from || to) {
    items = items.filter((i) => {
      const at = i.startsAt ?? i.dueAt
      if (!at) return false
      const day = at.slice(0, 10)
      if (from && day < from) return false
      if (to && day > to) return false
      return true
    })
  }
  return items
}

const ALLOWED_PATCH_FIELDS = new Set([
  'title', 'type', 'starts_at', 'due_at', 'date_precision', 'date_raw',
  'rrule', 'location', 'status', 'confidence', 'project_id',
])

/** 写一行变更历史。actor 是谁改的，fragment_id 指回引发改动的碎片（改期的出处）。 */
export function recordItemHistory(
  db: DatabaseSync, ctx: Ctx, itemId: string, field: string,
  oldValue: string | null, newValue: string | null,
  actor: 'user' | 'llm' | 'merge' | 'sync', fragmentId: string | null,
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
    projectId: row.project_id,
    externalId: row.external_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
