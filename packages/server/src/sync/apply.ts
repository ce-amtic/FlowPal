import type { DatabaseSync } from 'node:sqlite'
import type { Ctx } from '@flowpal/shared'
import { upsertByExternalId } from '../store/items.ts'
import { createProject, findProjectByName } from '../store/projects.ts'
import type { MappedItem } from './map.ts'

/**
 * 结构化来源落库的唯一一段。同步的定时任务与手动投放一份结构化碎片都走它，
 * 所以「同一份课表连拉两次不新增条目」这条不变量只有一处需要成立。
 *
 * 判定靠 `external_id` 这个主键，不靠模型。库因此有两个写入者，判定方式各不
 * 相同：一条靠模型（agent 循环），一条靠主键（这里）。
 */
export function applyMapped(
  db: DatabaseSync, ctx: Ctx, fragmentId: string, mapped: MappedItem[],
): { created: number; updated: number; itemIds: string[] } {
  let created = 0
  let updated = 0
  const itemIds: string[] = []

  for (const m of mapped) {
    const existing = db.prepare(`SELECT id FROM items WHERE external_id = ?`)
      .get(m.externalId) as { id: string } | undefined
    // 课程自动成为项目：学生的绝大部分事务属于某门课，冷启动因此由真实数据解决。
    const projectId = m.projectName === null ? null : projectFor(db, ctx, m.projectName)
    itemIds.push(upsertByExternalId(db, ctx, fragmentId, m.externalId, m.item, { projectId }))
    if (existing) updated += 1
    else created += 1
  }
  return { created, updated, itemIds }
}

/**
 * 名字撞上已有项目就用已有的那个（忽略大小写与空白，归一在 store 层做）。
 *
 * 同步落地的第一天，模型那边刚好也会输出一个同名的新项目——不管这一条，项目页
 * 上会出现成对的重复项，用户会读成这一层坏了。
 */
function projectFor(db: DatabaseSync, ctx: Ctx, name: string): string {
  const existing = findProjectByName(db, name)
  if (existing) return existing.id
  return createProject(db, ctx, { name, statusNote: null }).id
}
