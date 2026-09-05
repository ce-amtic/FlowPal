import type { DatabaseSync } from 'node:sqlite'
import type { Ctx, Fragment } from '@flowpal/shared'
import {
  CreateItemInput, DropItemInput, GetItemInput, GetProjectInput, SearchItemsInput, UpdateItemInput,
} from '@flowpal/shared'
import { getFragment } from '../store/fragments.ts'
import {
  addItemCitations, addItemSource, dropItem, getItem, insertItem, searchItems, updateItemForAgent,
} from '../store/items.ts'
import { createProject, getProject } from '../store/projects.ts'

/**
 * 六个工具的落地。工具不直接抛校验错误：参数不对、引文不逐字，都作为工具结果返回，
 * 让模型下一步改这一条。只有 DB 层真正坏了才抛出去，由循环记 failed。
 */

export type ToolExecution = {
  content: string
  /** 只给循环计数用；读工具没有 touched。 */
  touched?: { itemId: string; action: 'created' | 'updated' | 'dropped'; needsConfirm?: boolean }
}

export function executeAgentTool(
  db: DatabaseSync, ctx: Ctx, fragment: Fragment, tool: string, rawArgs: Record<string, unknown>,
): ToolExecution {
  switch (tool) {
    case 'getItem': return runGetItem(db, rawArgs)
    case 'searchItems': return runSearchItems(db, rawArgs)
    case 'getProject': return runGetProject(db, rawArgs)
    case 'createItem': return runCreateItem(db, ctx, fragment, rawArgs)
    case 'updateItem': return runUpdateItem(db, ctx, fragment, rawArgs)
    case 'dropItem': return runDropItem(db, ctx, fragment, rawArgs)
    default:
      return { content: JSON.stringify({ ok: false, error: `未知工具：${tool}` }) }
  }
}

function ok(payload: unknown): ToolExecution {
  return { content: JSON.stringify(payload) }
}

function err(error: string): ToolExecution {
  return { content: JSON.stringify({ ok: false, error }) }
}

function runGetItem(db: DatabaseSync, rawArgs: Record<string, unknown>): ToolExecution {
  const parsed = GetItemInput.safeParse(rawArgs)
  if (!parsed.success) return err(`getItem 参数不对：${JSON.stringify(parsed.error.issues)}`)
  const item = getItem(db, parsed.data.id)
  if (!item) return err(`没有 id=${parsed.data.id} 的条目`)
  const sources = item.sourceFragmentIds.map((fid) => {
    const f = getFragment(db, fid)
    return { id: fid, rawText: f?.rawText ?? null }
  })
  return ok({ ok: true, item, sources })
}

function runSearchItems(db: DatabaseSync, rawArgs: Record<string, unknown>): ToolExecution {
  const parsed = SearchItemsInput.safeParse(rawArgs)
  if (!parsed.success) return err(`searchItems 参数不对：${JSON.stringify(parsed.error.issues)}`)
  const items = searchItems(db, parsed.data.query, parsed.data.from, parsed.data.to)
  return ok({ ok: true, items })
}

function runGetProject(db: DatabaseSync, rawArgs: Record<string, unknown>): ToolExecution {
  const parsed = GetProjectInput.safeParse(rawArgs)
  if (!parsed.success) return err(`getProject 参数不对：${JSON.stringify(parsed.error.issues)}`)
  const project = getProject(db, parsed.data.id)
  if (!project) return err(`没有 id=${parsed.data.id} 的项目`)
  const items = db.prepare(
    `SELECT id, type, title, starts_at, due_at, status FROM items
     WHERE project_id = ? AND status != 'dropped' ORDER BY created_at DESC`,
  ).all(project.id) as Record<string, any>[]
  return ok({ ok: true, project, items })
}

function runCreateItem(db: DatabaseSync, ctx: Ctx, fragment: Fragment, rawArgs: Record<string, unknown>): ToolExecution {
  const parsed = CreateItemInput.safeParse(rawArgs)
  if (!parsed.success) {
    return err(`createItem 参数不符合契约：${JSON.stringify(parsed.error.issues)}`)
  }

  const { project, ...extracted } = parsed.data
  const citeError = assertCitationsVerbatim(fragment, extracted.citations)
  if (citeError) return err(citeError)

  const resolved = resolveProject(db, ctx, fragment, project)
  if (resolved.error) return err(resolved.error)

  const id = insertItem(db, ctx, extracted, { projectId: resolved.projectId })
  addItemSource(db, ctx, id, fragment.id)
  addItemCitations(db, id, fragment.id, extracted)
  const item = getItem(db, id)
  return {
    content: JSON.stringify({ ok: true, itemId: id, status: item?.status ?? null }),
    touched: { itemId: id, action: 'created', needsConfirm: item?.status === 'needs_confirm' },
  }
}

function runUpdateItem(db: DatabaseSync, ctx: Ctx, fragment: Fragment, rawArgs: Record<string, unknown>): ToolExecution {
  const parsed = UpdateItemInput.safeParse(rawArgs)
  if (!parsed.success) return err(`updateItem 参数不对：${JSON.stringify(parsed.error.issues)}`)
  if (!getItem(db, parsed.data.id)) return err(`没有 id=${parsed.data.id} 的条目`)

  const { project, ...patch } = parsed.data.patch
  let projectId: string | null | undefined
  if (project) {
    const resolved = resolveProject(db, ctx, fragment, project)
    if (resolved.error) return err(resolved.error)
    projectId = resolved.projectId
  }

  const fields: Record<string, string | null> = {}
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) fields[key] = value as string | null
  }
  updateItemForAgent(db, ctx, parsed.data.id, fields, fragment.id, projectId)
  addItemSource(db, ctx, parsed.data.id, fragment.id)
  const citations = parsed.data.citations
  if (citations && citations.length > 0) {
    const citeError = assertCitationsVerbatim(fragment, citations)
    if (citeError) return err(citeError)
    addItemCitations(db, parsed.data.id, fragment.id, { citations } as any)
  }
  const item = getItem(db, parsed.data.id)
  return {
    content: JSON.stringify({ ok: true, itemId: item?.id, status: item?.status ?? null }),
    touched: item ? { itemId: item.id, action: 'updated' } : undefined,
  }
}

function runDropItem(db: DatabaseSync, ctx: Ctx, fragment: Fragment, rawArgs: Record<string, unknown>): ToolExecution {
  const parsed = DropItemInput.safeParse(rawArgs)
  if (!parsed.success) return err(`dropItem 参数不对：${JSON.stringify(parsed.error.issues)}`)
  if (!getItem(db, parsed.data.id)) return err(`没有 id=${parsed.data.id} 的条目`)
  addItemSource(db, ctx, parsed.data.id, fragment.id)
  dropItem(db, ctx, parsed.data.id, 'llm', fragment.id)
  return {
    content: JSON.stringify({ ok: true, itemId: parsed.data.id, status: 'dropped' }),
    touched: { itemId: parsed.data.id, action: 'dropped' },
  }
}

function resolveProject(
  db: DatabaseSync, ctx: Ctx, fragment: Fragment, ref: { kind: string } & Record<string, any>,
): { projectId: string | null; error?: string } {
  if (ref.kind === 'none') return { projectId: null }
  if (fragment.rawText === null) {
    return { projectId: null, error: '图片碎片没有可校验的原文，项目归属只能用 kind:"none"；或先补一条文本碎片。' }
  }
  if (typeof ref.quote !== 'string' || !fragment.rawText.includes(ref.quote)) {
    return { projectId: null, error: `项目归属的 quote 不是原文逐字片段：「${ref.quote}」` }
  }
  if (ref.kind === 'existing') {
    const project = getProject(db, ref.projectId)
    if (!project) return { projectId: null, error: `没有 id=${ref.projectId} 的项目` }
    return { projectId: project.id }
  }
  if (ref.kind === 'new') {
    const project = createProject(db, ctx, { name: ref.name })
    return { projectId: project.id }
  }
  return { projectId: null, error: `未知项目归属 kind=${ref.kind}` }
}

function assertCitationsVerbatim(
  fragment: Fragment, citations: { field: string; quote: string }[],
): string | null {
  if (fragment.rawText === null) {
    if (citations.length > 0) return '图片碎片没有可校验的原文，citations 必须为空。'
    return null
  }
  for (const c of citations) {
    if (!fragment.rawText.includes(c.quote)) {
      return `引用不是原文的逐字片段：字段 ${c.field}，引文「${c.quote}」`
    }
  }
  return null
}
