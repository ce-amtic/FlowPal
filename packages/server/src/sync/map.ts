import type { Ctx, ExtractedItem } from '@flowpal/shared'
import { weekOf } from '@flowpal/shared'
import { CATEGORY, type PortalEvent } from './portal.ts'

/**
 * 日程中心的条目 → 条目候选。**不经模型。**
 *
 * 课表、校历拉回来已经是准确的结构，喂给模型只会让它变得不准，还慢、还花钱。
 * 这条路上没有模型判断，也不该有：去重靠 `external_id`，判定靠主键。
 *
 * 每一条都带 `externalId`，调用方用它走 `upsertByExternalId`——同一份课表连拉两次
 * 不新增条目，字段变了写一行 `item_history`。没有这一列，同步第一次用就会往库里
 * 灌几十条重复的课。
 */
export type MappedItem = {
  externalId: string
  item: ExtractedItem
  /** 课程名。课程自动成为项目，其余来源为 null */
  projectName: string | null
}

/** 一组同一门课、同一个时间槽的全部发生。 */
type ClassGroup = {
  key: string
  title: string
  location: string
  note: string
  occurrences: PortalEvent[]
}

export function mapPortalSchedule(ctx: Ctx, events: PortalEvent[]): MappedItem[] {
  const mapped: MappedItem[] = []
  const classes: PortalEvent[] = []

  for (const e of events) {
    if (e.categoryId === CATEGORY.timetable) classes.push(e)
    else if (e.categoryId === CATEGORY.academicCalendar) continue // 下面整段一起处理
    else mapped.push(mapPersonalEvent(e))
  }

  mapped.push(...mapClasses(ctx, classes))
  mapped.push(...mapAcademicCalendar(events.filter((e) => e.categoryId === CATEGORY.academicCalendar)))
  return mapped
}

// ── 课表 ──────────────────────────────────────────────────────────────

/**
 * 同一门课的同一个时间槽压成一条带 RRULE 的条目，而不是一周一条。
 *
 * 界面上「课表这类重复项压成每天顶上一条细带，不占条目位置」，判断依据就是
 * `rrule` 非空（见 /api/agenda）。一学期十八周、每周十几节，逐条落库会把日程页
 * 淹掉，而用户在日程上要看的是今天多出来的那些事，不是课。
 *
 * **只发生过一次的那一组不给 RRULE。** 调课就长这样：学校把某个周日定成「上星期
 * 二的课」，那一天会多出一节孤立的课。它本来就是「今天多出来的事」，该占日程上
 * 的一格，不该被压进细带里。
 */
function mapClasses(ctx: Ctx, classes: PortalEvent[]): MappedItem[] {
  const groups = new Map<string, ClassGroup>()
  for (const e of classes) {
    const key = `${e.title}|${e.location}|${weekdayOf(e.day)}|${timeOf(e.beginRaw)}|${timeOf(e.endRaw)}`
    let group = groups.get(key)
    if (!group) {
      group = { key, title: e.title, location: e.location, note: e.note, occurrences: [] }
      groups.set(key, group)
    }
    group.occurrences.push(e)
  }

  return [...groups.values()].map((group) => {
    const occurrences = [...group.occurrences].sort((a, b) => a.beginRaw.localeCompare(b.beginRaw))
    const first = occurrences[0]!
    const last = occurrences.at(-1)!
    const weeks = occurrences.map((o) => weekOf(ctx.term, isoOf(o.beginRaw)))
    const spacing = spacingOf(occurrences)

    // 单次发生不给 RRULE：它是调课，该落在它那一天上。
    const recurrence = occurrences.length === 1 ? null : rruleOf(first, last, spacing)
    const dateRaw = occurrences.length === 1
      ? `${first.day} ${timeOf(first.beginRaw)}`
      : `${weekdayLabel(first.day)} ${timeOf(first.beginRaw)}–${timeOf(first.endRaw)} · 第 ${describeWeeks(weeks)} 周`

    return {
      externalId: `ruc:class:${ctx.term.id}:${group.key}`,
      projectName: group.title === '' ? null : group.title,
      item: {
        type: 'event',
        title: group.title,
        starts_at: isoOf(first.beginRaw),
        due_at: null,
        date_precision: 'minute',
        date_raw: dateRaw,
        recurrence,
        location: group.location === '' ? null : group.location,
        confidence: 'high',
        // 间隔不规整时 RRULE 只是个近似——真正的发生集在 date_raw 里逐周列着。
        date_confidence: spacing === 'irregular' ? 'medium' : 'high',
        citations: citationsOf(group.title, first.beginRaw, group.location),
      },
    }
  })
}

/**
 * 发生的间隔。每周、隔周之外都算不规整——不规整时 RRULE 表达不了真正的发生集，
 * 所以那一组的日期置信度降一档，具体哪几周写在 `date_raw` 里，一周不少。
 */
function spacingOf(occurrences: PortalEvent[]): 'weekly' | 'biweekly' | 'irregular' {
  const gaps = new Set<number>()
  for (let i = 1; i < occurrences.length; i++) {
    gaps.add(daysBetween(occurrences[i - 1]!.day, occurrences[i]!.day))
  }
  if (gaps.size === 1 && gaps.has(7)) return 'weekly'
  if (gaps.size === 1 && gaps.has(14)) return 'biweekly'
  return 'irregular'
}

function rruleOf(first: PortalEvent, last: PortalEvent, spacing: string): string {
  const interval = spacing === 'biweekly' ? ';INTERVAL=2' : ''
  return `FREQ=WEEKLY;BYDAY=${BYDAY[weekdayOf(first.day)]}${interval};UNTIL=${untilOf(last)}`
}

// ── 校历 ──────────────────────────────────────────────────────────────

/**
 * 校历写的是**这一天与别的日子不一样**：放假、调课、考试周、学期开始。
 *
 * 服务端把跨天的事按天切开了（一条八月三十一日到九月六日的校历，在这七天里各
 * 出现一次），所以这里把连着的同名条目重新拢成一条，否则一个七天的假期会变成
 * 日程上连着七行。
 *
 * **只标出来，不替用户改课表。** 哪一节课真的停、调过去的到底是哪几节，两处数据
 * 都没有说；照着标题去猜是在编造服务端没给的东西。
 */
function mapAcademicCalendar(notes: PortalEvent[]): MappedItem[] {
  const byTitle = new Map<string, PortalEvent[]>()
  for (const e of notes) {
    if (e.title === '') {
      // 没有标题的校历标不出任何东西。真出现说明这一类的形状变了，要看见。
      throw new Error(`${e.day} 有一条没有标题的校历`)
    }
    const list = byTitle.get(e.title) ?? []
    list.push(e)
    byTitle.set(e.title, list)
  }

  const mapped: MappedItem[] = []
  for (const [title, list] of byTitle) {
    const days = [...new Set(list.map((e) => e.day))].sort()
    for (const run of consecutiveRuns(days)) {
      const from = run[0]!
      const to = run.at(-1)!
      const sample = list.find((e) => e.day === from)!
      mapped.push({
        externalId: `ruc:calendar:${title}:${from}`,
        projectName: null,
        item: {
          type: 'event',
          title,
          starts_at: `${from}T00:00:00+08:00`,
          due_at: null,
          date_precision: 'day',
          date_raw: from === to ? from : `${from} 至 ${to}`,
          recurrence: null,
          location: null,
          confidence: 'high',
          date_confidence: 'high',
          citations: citationsOf(title, sample.beginRaw, ''),
        },
      })
    }
  }
  return mapped
}

// ── 我的日历 ──────────────────────────────────────────────────────────

function mapPersonalEvent(e: PortalEvent): MappedItem {
  return {
    externalId: `ruc:event:${e.beginRaw}:${e.title}`,
    projectName: null,
    item: {
      type: 'event',
      title: e.title,
      starts_at: isoOf(e.beginRaw),
      due_at: null,
      date_precision: e.allDay ? 'day' : 'minute',
      date_raw: e.allDay ? e.day : `${e.day} ${timeOf(e.beginRaw)}`,
      recurrence: null,
      location: e.location === '' ? null : e.location,
      confidence: 'high',
      date_confidence: 'high',
      citations: citationsOf(e.title, e.beginRaw, e.location),
    },
  }
}

// ── 时间与引用 ────────────────────────────────────────────────────────

/**
 * 引用逐字指向拉回来的原始 JSON，所以这里只能引**原样的**字符串——标题、
 * 服务端写的 `2026-09-07 14:00:00`，绝不能引我们换算出来的 ISO 串。
 */
function citationsOf(title: string, beginRaw: string, location: string): ExtractedItem['citations'] {
  const citations: ExtractedItem['citations'] = []
  if (title !== '') citations.push({ field: 'title', quote: title })
  citations.push({ field: 'starts_at', quote: beginRaw })
  if (location !== '') citations.push({ field: 'location', quote: location })
  return citations
}

/** 库里的时刻一律带 +08:00，不存 UTC、不做时区转换。 */
function isoOf(raw: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(raw)
  if (!match) throw new Error(`日程的「${raw}」不是可解析的时刻`)
  return `${match[1]}T${match[2]}+08:00`
}

function timeOf(raw: string): string {
  const match = /(\d{2}:\d{2})/.exec(raw)
  if (!match) throw new Error(`日程的「${raw}」里没有时刻`)
  return match[1]!
}

const BYDAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']
const WEEKDAY_LABEL = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

function weekdayOf(day: string): number {
  return new Date(`${day}T12:00:00+08:00`).getUTCDay()
}

function weekdayLabel(day: string): string {
  return WEEKDAY_LABEL[weekdayOf(day)]!
}

/** RRULE 的 UNTIL 是 UTC 基本格式。取最后一次发生的当天末尾，含它自己。 */
function untilOf(last: PortalEvent): string {
  const end = new Date(`${last.day}T23:59:59+08:00`)
  return end.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

function daysBetween(from: string, to: string): number {
  const a = new Date(`${from}T00:00:00+08:00`).getTime()
  const b = new Date(`${to}T00:00:00+08:00`).getTime()
  return Math.round((b - a) / 86_400_000)
}

/** 「1–18」或「1、3、5、7」。压成区间是为了让一行读得完。 */
function describeWeeks(weeks: number[]): string {
  const sorted = [...new Set(weeks)].sort((a, b) => a - b)
  const parts: string[] = []
  for (const run of consecutiveNumbers(sorted)) {
    parts.push(run.length === 1 ? `${run[0]}` : `${run[0]}–${run.at(-1)}`)
  }
  return parts.join('、')
}

function consecutiveNumbers(sorted: number[]): number[][] {
  const runs: number[][] = []
  for (const n of sorted) {
    const last = runs.at(-1)
    if (last && n === last.at(-1)! + 1) last.push(n)
    else runs.push([n])
  }
  return runs
}

function consecutiveRuns(days: string[]): string[][] {
  const runs: string[][] = []
  for (const day of days) {
    const last = runs.at(-1)
    if (last && daysBetween(last.at(-1)!, day) === 1) last.push(day)
    else runs.push([day])
  }
  return runs
}
