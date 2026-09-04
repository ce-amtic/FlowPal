import { z } from 'zod'

/**
 * 校历：学期列表，不是单个学期。解析「第 8 周周三」这类相对表达时，
 * 按 ctx.now 选中当时所处的学期再算。
 *
 * 这是手敲 / 从教务系统拉一次落下来的参照数据，不是用户数据，所以是文件不是表。
 */
export const TermSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** 第一教学周的周一，YYYY-MM-DD */
  startMonday: z.string(),
  /** 教学周数 */
  weeks: z.number().int().positive(),
})
export type Term = z.infer<typeof TermSchema>

export const CalendarSchema = z.object({
  terms: z.array(TermSchema),
})
export type Calendar = z.infer<typeof CalendarSchema>

const DAY_MS = 86_400_000

/** 学期的最后一天（第 weeks 周的周日）。 */
export function termEnd(term: Term): Date {
  const start = new Date(`${term.startMonday}T00:00:00+08:00`)
  return new Date(start.getTime() + (term.weeks * 7 - 1) * DAY_MS)
}

/**
 * 按时刻选出所处的学期。落在任何学期区间外时返回起始日最接近且不晚于它的那个学期，
 * 都不满足则返回第一个——碎片里的日期可能落在假期，仍然需要一个周次基准。
 */
export function selectTerm(calendar: Calendar, now: string): Term {
  const t = new Date(now).getTime()
  const sorted = [...calendar.terms].sort((a, b) => a.startMonday.localeCompare(b.startMonday))
  if (sorted.length === 0) throw new Error('校历里一个学期都没有：data/calendar.json')

  for (const term of sorted) {
    const start = new Date(`${term.startMonday}T00:00:00+08:00`).getTime()
    if (t >= start && t <= termEnd(term).getTime()) return term
  }
  let fallback = sorted[0]!
  for (const term of sorted) {
    if (new Date(`${term.startMonday}T00:00:00+08:00`).getTime() <= t) fallback = term
  }
  return fallback
}

/** 某个时刻是学期的第几周（第一教学周为 1）。可能为负或超出 weeks，调用方自己判断。 */
export function weekOf(term: Term, at: string): number {
  const start = new Date(`${term.startMonday}T00:00:00+08:00`).getTime()
  return Math.floor((new Date(at).getTime() - start) / (7 * DAY_MS)) + 1
}
