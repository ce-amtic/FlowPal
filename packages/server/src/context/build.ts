import type { DatabaseSync } from 'node:sqlite'
import { occursOn, supportsRrule, type Ctx } from '@flowpal/shared'
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
    momentSection(db, ctx),
    computedSection(db, ctx),
    observedSection(db, ctx),
    statedSection(db),
    priorSection(db, ctx),
  ]
  return { sections, formatted: formatSections(sections) }
}

/**
 * 锚点。作息与当日课密度都是相对「现在」才有意义的事实：不给这一节，
 * 起床时刻在模型眼里就是一句没有位置的话，prompt 里的曲线规律也无从套用。
 */
function momentSection(db: DatabaseSync, ctx: Ctx): ContextSection {
  const facts: string[] = []
  const today = ctx.now.slice(0, 10)
  const clock = ctx.now.slice(11, 16)
  facts.push(`现在是 ${today}（${weekdayLabel(today)}）${clock}`)

  const todays = timedEventsToday(db, ctx)
  if (todays.length === 0) {
    facts.push('今天没有课，也没有定时的事件')
  } else {
    facts.push(`今天有 ${todays.length} 项定时安排（课或事件）：`)
    for (const e of todays) {
      const at = e.startsAt!.slice(11, 16)
      const range = e.dateRaw !== null && /–/.test(e.dateRaw) ? e.dateRaw.replace(/ · 第.*$/, '') : at
      facts.push(`${range} 「${e.title}」${at <= clock ? '（已开始或已结束）' : ''}`)
    }
  }
  return { source: 'computed', label: '此刻', facts }
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
  // 时段要带上做的是哪一件。「下次继续」之所以能改变下一次「此刻」，靠的就是这个
  // 名字——模型接不上一件它叫不出名字的事。
  const titleOf = new Map(listItems(db).map((i) => [i.id, i.title]))
  for (const s of todaySessions) {
    const on = s.itemId ? `做「${titleOf.get(s.itemId) ?? s.itemId}」` : ''
    const ending = s.endedEarly ? '，没做完，用户选了下次继续' : '，做完了'
    facts.push(`今天 ${s.startedAt.slice(11, 16)} 开始${on}，计划 ${s.plannedMinutes} 分钟，实际 ${s.actualMinutes ?? '未填'} 分钟${ending}`)
  }
  // 往前十四天里停在一半的事。「下次继续」要跨天才有意义——当晚接上是记性，
  // 十二天后还接得上才是记住了。只看每件事最近的一次：后来又做完了的不算。
  const latestByItem = new Map<string, (typeof sessions)[number]>()
  for (const s of sessions) {
    if (s.itemId && !latestByItem.has(s.itemId)) latestByItem.set(s.itemId, s)
  }
  for (const s of latestByItem.values()) {
    const day = s.startedAt.slice(0, 10)
    if (day === today || !s.endedEarly) continue
    const ago = -daysUntil(ctx.now, s.startedAt)
    if (ago > 14) continue
    facts.push(`${ago} 天前做「${titleOf.get(s.itemId!) ?? s.itemId}」，计划 ${s.plannedMinutes} 分钟，实际 ${s.actualMinutes ?? '未填'} 分钟，没做完，用户选了下次继续，之后没有再开始过`)
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

/**
 * 作息两问（MCTQ 短式）与文献里的曲线形状。数值推算在这里做完：这次调用关着思考，
 * 「距起床几小时」这种减法不该留给模型。哪一个起床时刻适用于今天不在这里判——
 * 今天是周几、有没有课已经在「此刻」一节里，由模型对上。
 */
function priorSection(db: DatabaseSync, ctx: Ctx): ContextSection {
  const facts: string[] = []
  const work = getSetting(db, 'chronotype_workday_wake')
  const rest = getSetting(db, 'chronotype_restday_wake')
  if (work && rest) {
    // 不把两个原始起床时刻原样给出去：模型会把「没课日」这种我们的分类词直接说给用户。
    // 它需要的三样都在下面：差值、今天距起床多久、作息类型。
    const workH = wakeHour(work)
    const restH = wakeHour(rest)
    const nowH = Number(ctx.now.slice(11, 13)) + Number(ctx.now.slice(14, 16)) / 60
    if (workH !== null && restH !== null && restH - workH >= 1) {
      facts.push(`没课的日子比有课的日子晚起约 ${hoursLabel(restH - workH)}，有课的日子多半靠闹钟起`)
    }
    // 今天适用哪一个起床时刻，在这里定，不留给模型：给它两个数它就两个都报。
    // 有课与否看今天有没有按课表展开出来的重复项。
    const hasClass = timedEventsToday(db, ctx).some((e) => e.rrule !== null)
    const todayH = hasClass ? workH : restH
    if (todayH !== null) {
      if (nowH < todayH) facts.push('现在还早于他通常的起床时刻')
      else if (nowH - todayH < 1) facts.push('起床不到一小时')
      else facts.push(`起床约 ${hoursLabel(nowH - todayH)}`)
    }
    const type = chronotypeOf(rest, restH)
    if (type !== null) facts.push(`作息${type}`)
  } else {
    facts.push(`作息时间未知：用户没有填起床时间`)
  }
  return { source: 'prior', label: '作息', facts }
}

/**
 * MCTQ 的结论是从没课日算的：那天没有闹钟，起床时刻才反映自己的钟。
 * 阈值按选项的档位划：8 点前偏早，9 到 10 点居中，11 点起偏晚。
 * 「更晚」没有数字，但它的意思是明确的。
 */
function chronotypeOf(label: string, hour: number | null): string | null {
  if (hour === null) return label === '更晚' ? '偏晚' : null
  if (hour <= 8) return '偏早'
  if (hour <= 10) return '居中'
  return '偏晚'
}

/**
 * 今天有时刻的事件，按开始时刻排。重复项按 rrule 展开到今天，非重复的按日期落在今天，
 * 与日程页同一套展开规则。全天的日子（「学期开始」）不占时段，不算。
 */
function timedEventsToday(db: DatabaseSync, ctx: Ctx) {
  const today = ctx.now.slice(0, 10)
  return listItems(db)
    .filter((i) => i.type === 'event' && i.status === 'active' && i.startsAt !== null && i.datePrecision !== 'day')
    .filter((i) => {
      if (i.rrule !== null && supportsRrule(i.rrule)) return occursOn(i.rrule, i.startsAt!, today)
      return i.startsAt!.slice(0, 10) === today
    })
    .sort((a, b) => a.startsAt!.slice(11, 16).localeCompare(b.startsAt!.slice(11, 16)))
}

/** 「7:30」「07:30」「6:30 前」→ 小时数；「更晚」这种没有数字的选项 → null。 */
function wakeHour(label: string): number | null {
  const m = /(\d{1,2}):(\d{2})/.exec(label)
  if (!m) return null
  return Number(m[1]) + Number(m[2]) / 60
}

function hoursLabel(h: number): string {
  const half = Math.round(h * 2) / 2
  if (half < 1) return '不到一小时'
  return Number.isInteger(half) ? `${half} 小时` : `${Math.floor(half)} 个半小时`
}

function weekdayLabel(day: string): string {
  const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  return names[new Date(`${day}T12:00:00+08:00`).getUTCDay()]!
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
