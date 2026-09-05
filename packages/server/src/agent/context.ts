import type { DatabaseSync } from 'node:sqlite'
import type { Ctx, Fragment } from '@flowpal/shared'
import { weekOf } from '@flowpal/shared'
import { listItems } from '../store/items.ts'
import { listProjects } from '../store/projects.ts'

/**
 * agent 循环的 context。这里只负责把库里的真相当成事实喂给模型，不预筛相关性，
 * 也不替模型做判断。切了时间窗就必须写出范围与窗外条数——模型不知道它没看见什么，
 * 就会新建重复条目且不会想到去检索。
 */

const MAX_ITEMS_IN_CONTEXT = 80

export function buildAgentContext(db: DatabaseSync, ctx: Ctx, fragment: Fragment): string {
  const projects = listProjects(db)
  const items = selectItems(db, ctx)

  const lines: string[] = []

  lines.push(`当前时间：${ctx.now}（时区 ${ctx.tz}）`)
  lines.push(`当前学期：${ctx.term.name}，第一教学周的周一是 ${ctx.term.startMonday}，共 ${ctx.term.weeks} 周`)
  lines.push(`今天是本学期第 ${weekOf(ctx.term, ctx.now)} 周`)
  lines.push('')

  lines.push('全部项目（id | name | statusNote | status）：')
  if (projects.length === 0) lines.push('（无）')
  for (const p of projects) lines.push(`- ${p.id} | ${p.name} | ${p.statusNote ?? ''} | ${p.status}`)
  lines.push('')

  lines.push('条目清单（id | type | title | at | projectId | status）：')
  if (items.listed.length === 0) lines.push('（无）')
  for (const i of items.listed) {
    lines.push(`- ${i.id} | ${i.type} | ${i.title} | at=${i.startsAt ?? i.dueAt ?? ''} | ${i.projectId ?? ''} | ${i.status}`)
  }
  if (items.scopeLine) {
    lines.push('')
    lines.push(items.scopeLine)
  }
  lines.push('')

  lines.push(`当前碎片（source=${fragment.source}, rawType=${fragment.rawType}）：`)
  lines.push('原文：')
  lines.push(fragment.rawText ?? '（无文本，见附图）')
  lines.push('')
  lines.push('项目名参考（有需要时用 getProject 拿完整 status_note 与条目）：')
  for (const p of projects) lines.push(`- ${p.name}`)

  return lines.join('\n')
}

function selectItems(
  db: DatabaseSync, ctx: Ctx,
): { listed: ReturnType<typeof listItems>; scopeLine: string | null } {
  const all = listItems(db)
  const nowMs = new Date(ctx.now).getTime()
  const recentMs = nowMs - 14 * 86_400_000

  const relevant = all.filter((i) => {
    if (i.status === 'active' || i.status === 'needs_confirm') return true
    if (i.status !== 'done') return false
    const at = i.startsAt ?? i.dueAt
    if (at && new Date(at).getTime() >= recentMs) return true
    return new Date(i.updatedAt).getTime() >= recentMs
  })

  relevant.sort((a, b) => {
    const at = (x: typeof a) => x.startsAt ?? x.dueAt ?? x.createdAt
    return at(a).localeCompare(at(b))
  })

  if (relevant.length <= MAX_ITEMS_IN_CONTEXT) {
    return { listed: relevant, scopeLine: null }
  }

  // 装不下时按时间窗切：优先给现在前后最相关的一段，并明说窗外还有多少。
  const from = shiftDate(ctx.now, -14)
  const to = shiftDate(ctx.now, 28)
  const inWindow = relevant.filter((i) => {
    const day = (i.startsAt ?? i.dueAt)?.slice(0, 10)
    return day !== undefined && day >= from && day <= to
  })
  const listed = inWindow.slice(0, MAX_ITEMS_IN_CONTEXT)
  const scopeLine = `以下是 ${from} 至 ${to} 的条目，${listed.length} 条。此范围之外另有 ${relevant.length - listed.length} 条，用 searchItems 查。`
  return { listed, scopeLine }
}

function shiftDate(iso: string, days: number): string {
  const d = new Date(iso)
  d.setDate(d.getDate() + days)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
