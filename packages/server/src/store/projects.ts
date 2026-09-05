import type { DatabaseSync } from 'node:sqlite'
import type { Ctx, Project, ProjectStatus } from '@flowpal/shared'
import { newId } from './db.ts'

/**
 * 项目名归一：忽略大小写与空白（[[010]]「new 撞同名降级 existing」与用户重复建名
 * 共用同一规则）。索引只兜了大小写（NOCASE），空白的部分在这里比——
 * 项目规模小，逐行比较足够，不必把归一塞进索引。
 */
export function normalizeProjectName(name: string): string {
  return name.replace(/\s+/g, '').toLowerCase()
}

export type NewProject = { name: string; statusNote?: string | null }

/**
 * 建项目。同名（忽略大小写与空白）已存在时归入既有项目，不新建——
 * 模型看不见同步刚建的项目是常态，这一条保证项目名永远唯一。
 */
export function createProject(db: DatabaseSync, ctx: Ctx, input: NewProject): Project {
  const name = input.name.trim()
  if (!name) throw new Error('项目名不能为空')
  const existing = findProjectByName(db, name)
  if (existing) return existing

  const project: Project = {
    id: newId('prj'),
    name,
    statusNote: input.statusNote ?? null,
    status: 'active',
    createdAt: ctx.now,
    updatedAt: ctx.now,
  }
  db.prepare(
    `INSERT INTO projects (id, name, status_note, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(project.id, project.name, project.statusNote, project.status, project.createdAt, project.updatedAt)
  return project
}

export function findProjectByName(db: DatabaseSync, name: string): Project | null {
  const norm = normalizeProjectName(name.trim())
  if (!norm) return null
  const rows = db.prepare(`SELECT * FROM projects`).all() as Record<string, any>[]
  for (const row of rows) {
    if (normalizeProjectName(row.name) === norm) return rowToProject(row)
  }
  return null
}

export function getProject(db: DatabaseSync, id: string): Project | null {
  const row = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id) as Record<string, any> | undefined
  return row ? rowToProject(row) : null
}

export function listProjects(db: DatabaseSync): Project[] {
  const rows = db.prepare(
    `SELECT * FROM projects WHERE status != 'dropped' ORDER BY created_at`,
  ).all() as Record<string, any>[]
  return rows.map(rowToProject)
}

export function updateProjectFields(
  db: DatabaseSync, ctx: Ctx, id: string,
  patch: { name?: string; statusNote?: string | null; status?: ProjectStatus },
): void {
  const before = getProject(db, id)
  if (!before) throw new Error(`项目不存在：${id}`)

  if (patch.name !== undefined) {
    const name = patch.name.trim()
    if (!name) throw new Error('项目名不能为空')
    const clash = findProjectByName(db, name)
    if (clash && clash.id !== id) throw new Error(`已有同名项目：${clash.name}`)
    patch = { ...patch, name }
  }
  if (Object.keys(patch).length === 0) return

  for (const [field, value] of Object.entries(patch)) {
    if (!ALLOWED_FIELDS.has(field)) throw new Error(`不可改的字段：${field}`)
    if (field === 'name' && before.name === value) continue
    if (field !== 'name' && before[field as 'statusNote' | 'status'] === value) continue
    const column = field === 'statusNote' ? 'status_note' : field
    db.prepare(`UPDATE projects SET ${column} = ?, updated_at = ? WHERE id = ?`)
      .run(value, ctx.now, id)
  }
}

/** 标记丢弃。条目保留 project_id 引用，在项目页归入「未归类」；不删行。 */
export function dropProject(db: DatabaseSync, ctx: Ctx, id: string): void {
  if (!getProject(db, id)) throw new Error(`项目不存在：${id}`)
  db.prepare(`UPDATE projects SET status = 'dropped', updated_at = ? WHERE id = ?`).run(ctx.now, id)
}

const ALLOWED_FIELDS = new Set(['name', 'statusNote', 'status'])

function rowToProject(row: Record<string, any>): Project {
  return {
    id: row.id,
    name: row.name,
    statusNote: row.status_note,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
