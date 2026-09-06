/**
 * RRULE 只回答一个问题：这一条重复项在某一天发生不发生。
 *
 * 不引 RFC 5545 的完整实现，也不打算支持全部规则——我们自己只写出三种形状
 * （每周、隔周、每天，都可能带 UNTIL），而**看不懂的规则一律当成不发生**是错的：
 * 那会让一门课在日程上整个消失，且不报错。所以看不懂就抛，让它响亮地坏掉。
 */
const BYDAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']
const DAY_MS = 86_400_000

/**
 * `rrule` 描述的重复项在 `day`（YYYY-MM-DD）这天发生吗。
 *
 * `dtstart` 是第一次发生的时刻（ISO8601 带 +08:00），同时也是相位的基准：隔周的
 * 课到底是单周还是双周，只有它说了算。
 */
export function occursOn(rrule: string, dtstart: string, day: string): boolean {
  const rule = parseRrule(rrule)
  const start = dayOf(dtstart)
  if (day < start) return false
  if (rule.until !== null && day > rule.until) return false

  if (rule.freq === 'DAILY') return daysBetween(start, day) % rule.interval === 0

  if (rule.freq === 'MONTHLY') {
    // 按 DTSTART 那个日子，不支持「第二个周二」那种写法——parseRrule 会先拦下来。
    if (day.slice(8) !== start.slice(8)) return false
    return monthsBetween(start, day) % rule.interval === 0
  }

  // WEEKLY：先看星期对不对，再看是不是落在该发生的那一周。
  if (rule.byday !== null && rule.byday !== BYDAY[weekdayOf(day)]) return false
  const weeksApart = Math.floor(daysBetween(weekStart(start), weekStart(day)) / 7)
  return weeksApart % rule.interval === 0
}

/**
 * 这条规则我们放得下吗。
 *
 * 存在的理由：`recurrence` 是模型写的自由字符串，它随时可能写出一条这里没有的
 * 规则。调用方（日程页）要在**遍历之前**问一次，才能给放不下的那些另找一个位置
 * ——放不下不等于不存在，而 `occursOn` 抛异常是为了不让它悄悄消失。
 */
export function supportsRrule(rrule: string): boolean {
  try {
    parseRrule(rrule)
    return true
  } catch {
    return false
  }
}

type Rule = {
  freq: 'WEEKLY' | 'DAILY' | 'MONTHLY'
  interval: number
  byday: string | null
  /** YYYY-MM-DD，含当天 */
  until: string | null
}

function parseRrule(rrule: string): Rule {
  const parts = new Map(
    rrule.split(';').filter((p) => p !== '').map((p) => {
      const at = p.indexOf('=')
      if (at < 0) throw new Error(`RRULE 的「${p}」不是 KEY=VALUE`)
      return [p.slice(0, at), p.slice(at + 1)] as const
    }),
  )

  const freq = parts.get('FREQ')
  if (freq !== 'WEEKLY' && freq !== 'DAILY' && freq !== 'MONTHLY') {
    throw new Error(`还不认识 FREQ=${freq} 这种重复（${rrule}）`)
  }

  const byday = parts.get('BYDAY') ?? null
  // 一条规则里挂多个星期、或者「第二个周二」（`2TU`），我们自己写不出来；真出现
  // 说明这条规则来自模型或别的系统，形状另说，不能按单个星期去解。
  if (byday !== null && !BYDAY.includes(byday)) {
    throw new Error(`还不认识 BYDAY=${byday} 这种写法（${rrule}）`)
  }
  if (freq === 'MONTHLY' && (byday !== null || parts.has('BYMONTHDAY'))) {
    throw new Error(`按月重复只支持跟 DTSTART 同一个日子（${rrule}）`)
  }

  const rawInterval = parts.get('INTERVAL')
  const interval = rawInterval === undefined ? 1 : Number(rawInterval)
  if (!Number.isInteger(interval) || interval < 1) {
    throw new Error(`RRULE 的 INTERVAL=${rawInterval} 不是正整数（${rrule}）`)
  }

  return { freq, interval, byday, until: untilDay(parts.get('UNTIL'), rrule) }
}

/** UNTIL 是 UTC 基本格式（`20261228T155959Z`）。换回东八区的那一天，含当天。 */
function untilDay(raw: string | undefined, rrule: string): string | null {
  if (raw === undefined) return null
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/.exec(raw)
  if (!match) throw new Error(`RRULE 的 UNTIL=${raw} 不是可解析的时刻（${rrule}）`)
  const [, y, m, d, hh = '23', mm = '59', ss = '59'] = match
  const at = new Date(`${y}-${m}-${d}T${hh}:${mm}:${ss}Z`)
  return shanghaiDay(at)
}

function dayOf(iso: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(iso)
  if (!match) throw new Error(`「${iso}」里没有日期`)
  return match[1]!
}

function shanghaiDay(at: Date): string {
  return new Date(at.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
}

function weekdayOf(day: string): number {
  return new Date(`${day}T12:00:00+08:00`).getUTCDay()
}

/** 这一天所在那一周的周一。隔周的相位按周算，不按天算。 */
function weekStart(day: string): string {
  const weekday = weekdayOf(day)
  const back = (weekday + 6) % 7
  const at = new Date(`${day}T00:00:00+08:00`)
  return shanghaiDay(new Date(at.getTime() - back * DAY_MS))
}

function monthsBetween(from: string, to: string): number {
  const [fy, fm] = from.split('-').map(Number) as [number, number]
  const [ty, tm] = to.split('-').map(Number) as [number, number]
  return (ty - fy) * 12 + (tm - fm)
}

function daysBetween(from: string, to: string): number {
  const a = new Date(`${from}T00:00:00+08:00`).getTime()
  const b = new Date(`${to}T00:00:00+08:00`).getTime()
  return Math.round((b - a) / DAY_MS)
}
