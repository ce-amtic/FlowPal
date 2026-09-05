import type { DatabaseSync } from 'node:sqlite'
import type { Ctx } from '@flowpal/shared'
import { listFocusSessions } from '../store/focus.ts'
import { listItems } from '../store/items.ts'
import { projectCards } from '../store/projects.ts'
import { getSetting } from '../store/settings.ts'

/**
 * 处境是一个查询，不是一份存储。四组来源分节，每节标明来源；
 * 精力只给事实不给数。这里是「此刻」的输入，不写库。
 */
export type ContextSource = 'computed' | 'observed' | 'stated' | 'prior'

export type ContextSection = {
  source: ContextSource
  label: string
  facts: string[]
}

export type ContextSnapshot = {
  sections: ContextSection[]
  formatted: string
}

export function buildContext(db: DatabaseSync, ctx: Ctx): ContextSnapshot {
  const sections: ContextSection[] = [
    computedSection(db, ctx),
    observedSection(db, ctx),
    statedSection(db),
    priorSection(db),
  ]
  return { sections, formatted: formatSections(sections) }
}

function computedSection(db: DatabaseSync, ctx: Ctx): ContextSection {
  const facts: string[] = []
  const items = listItems(db)
  const candidates = items.filter((i) => (i.type === 'event' || i.type === 'task') && i.status === 'active')
  const dated = candidates.filter((i) => i.startsAt ?? i.dueAt)

  facts.push('可挑选条目：')
  if (candidates.length === 0) facts.push('（无）')
  for (const i of candidates) {
    facts.push(`${i.id} | ${i.type} | ${i.title} | ${i.startsAt ?? i.dueAt ?? ''} | projectId=${i.projectId ?? ''}`)
  }

  const in7 = dated.filter((i) => {
    const d = daysUntil(ctx.now, i.startsAt ?? i.dueAt)
    return d >= 0 && d <= 7
  })
  const in14 = dated.filter((i) => {
    const d = daysUntil(ctx.now, i.startsAt ?? i.dueAt)
    return d >= 0 && d <= 14
  })
  if (in14.length > 0) {
    const projects7 = new Set(in7.map((i) => i.projectId).filter((x): x is string => x !== null))
    facts.push(`未来 7 天有 ${in7.length} 件事到期${projects7.size > 0 ? `，跨 ${projects7.size} 个项目` : ''}`)
    facts.push(`未来 14 天有 ${in14.length} 件事到期`)
  }

  for (const i of dated) {
    const d = daysUntil(ctx.now, i.startsAt ?? i.dueAt)
    if (d < -7 || d > 14) continue
    const when = d >= 0 ? `距今 ${d} 天` : `已过 ${-d} 天`
    facts.push(`${i.type === 'event' ? '事件' : '事务'}「${i.title}」：${i.startsAt ?? i.dueAt}（${when}）`)
  }

  // 改期是画像里的日期推移信号，必须有出处（item_history.fragment_id）。
  const byId = new Map(items.map((i) => [i.id, i]))
  const historyRows = db.prepare(
    `SELECT item_id, field, old_value, new_value, changed_at FROM item_history
     WHERE field IN ('starts_at', 'due_at') ORDER BY changed_at`,
  ).all() as { item_id: string; field: string; old_value: string | null; new_value: string | null; changed_at: string }[]
  const rescheduled = new Map<string, { title: string; count: number; last: string }>()
  for (const row of historyRows) {
    const item = byId.get(row.item_id)
    const current = rescheduled.get(row.item_id) ?? { title: item?.title ?? row.item_id, count: 0, last: row.changed_at }
    current.count += 1
    current.last = row.changed_at
    rescheduled.set(row.item_id, current)
  }
  for (const r of [...rescheduled.values()].sort((a, b) => b.last.localeCompare(a.last)).slice(0, 3)) {
    facts.push(`「${r.title}」被改期过 ${r.count} 次`)
  }

  const idle = projectCards(db, ctx.now)
    .filter((c) => c.idleDays !== null && c.idleDays >= 2)
    .sort((a, b) => (b.idleDays ?? 0) - (a.idleDays ?? 0))
    .slice(0, 3)
  for (const c of idle) facts.push(`项目「${c.project.name}」已经 ${c.idleDays} 天没有动静`)

  return { source: 'computed', label: '算出来的', facts }
}

function observedSection(db: DatabaseSync, ctx: Ctx): ContextSection {
  const facts: string[] = []
  const sessions = listFocusSessions(db)
  const today = ctx.now.slice(0, 10)
  const todaySessions = sessions.filter((s) => s.startedAt.slice(0, 10) === today)
  facts.push(`今天已完成 ${todaySessions.length} 次专注`)
  for (const s of todaySessions) {
    facts.push(`今天 ${s.startedAt.slice(11, 16)} 开始，计划 ${s.plannedMinutes} 分钟，实际 ${s.actualMinutes ?? '未填'} 分钟${s.endedEarly ? '，提前结束' : '，完成'}`)
  }
  if (sessions.length > 0 && sessions.length < 5) {
    facts.push(`专注记录共 ${sessions.length} 次，不足以看出规律`)
  }
  return { source: 'observed', label: '观察到的', facts }
}

function statedSection(db: DatabaseSync): ContextSection {
  const states = listItems(db)
    .filter((i) => i.type === 'state' && i.status !== 'dropped')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 5)
  const facts = states.length > 0
    ? states.map((i) => `${i.createdAt.slice(0, 10)}：${i.title}`)
    : ['（没有说过的状态）']
  return { source: 'stated', label: '用户说的', facts }
}

function priorSection(db: DatabaseSync): ContextSection {
  const facts: string[] = []
  const work = getSetting(db, 'chronotype_workday_wake')
  const rest = getSetting(db, 'chronotype_restday_wake')
  if (work && rest) {
    facts.push(`工作日 ${work} 起，休息日 ${rest} 起（用户提供的作息）`)
  } else {
    facts.push(`作息时间未知（先验，猜的）`)
  }
  facts.push(`精力存在约 90 分钟的超日节律波动（先验）`)
  return { source: 'prior', label: '先验', facts }
}

function daysUntil(nowIso: string, at: string | null): number {
  if (!at) return 0
  const now = new Date(`${nowIso.slice(0, 10)}T00:00:00+08:00`).getTime()
  const target = new Date(`${at.slice(0, 10)}T00:00:00+08:00`).getTime()
  return Math.round((target - now) / 86_400_000)
}

function formatSections(sections: ContextSection[]): string {
  const lines: string[] = []
  for (const section of sections) {
    lines.push(`【${section.label}】`)
    if (section.facts.length === 0) lines.push('（无）')
    for (const fact of section.facts) lines.push(`- ${fact}`)
    lines.push('')
  }
  return lines.join('\n').trim()
}
