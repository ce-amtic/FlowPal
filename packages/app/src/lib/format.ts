/**
 * 日期与时间的呈现。全 App 只有这一处把 ISO 串变成给人看的字。
 *
 * 只有日期没有时刻的条目不显示 00:00——那个零点是没有的东西，显示出来会让人
 * 以为系统知道一个它并不知道的时刻。
 */
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

export function formatDay(iso: string): string {
  const d = new Date(iso)
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

/**
 * 分组标题上的日期，拆成两级：日期本身，与星期加「今天／明天」。
 *
 * 拆开是为了让日期用正文色、其余用弱色。整行灰掉的话，一列日期看上去一样重，
 * 而在一页按天排下来的列表里，日期就是骨架。
 */
export function formatDayLabel(iso: string, today = new Date()): [string, string] {
  const d = new Date(iso)
  const days = daysBetween(today, d)
  const weekday = WEEKDAYS[d.getDay()]!
  if (days === 0) return [formatDay(iso), `今天 · ${weekday}`]
  if (days === 1) return [formatDay(iso), `明天 · ${weekday}`]
  return [formatDay(iso), weekday]
}

export function formatTime(iso: string): string {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 条目上那一行：有时刻显示时刻，只有日期就什么都不显示 */
export function formatAt(iso: string, precision: string | null): string {
  return precision === 'minute' ? formatTime(iso) : ''
}

export function daysBetween(from: Date, to: Date): number {
  const a = new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime()
  const b = new Date(to.getFullYear(), to.getMonth(), to.getDate()).getTime()
  return Math.round((b - a) / 86_400_000)
}

/** 「还剩 2 天」「今天截止」「已过期 3 天」 */
export function formatDue(iso: string, today = new Date()): string {
  const days = daysBetween(today, new Date(iso))
  if (days === 0) return '今天截止'
  if (days === 1) return '明天截止'
  if (days > 0) return `还剩 ${days} 天`
  return `已过期 ${-days} 天`
}

/** RFC 5545 的重复规则，只翻译我们会产生的那几种 */
const BYDAY: Record<string, string> = {
  MO: '周一', TU: '周二', WE: '周三', TH: '周四', FR: '周五', SA: '周六', SU: '周日',
}

export function formatRrule(rrule: string): string {
  const parts = Object.fromEntries(
    rrule.split(';').map((p) => p.split('=') as [string, string]),
  )
  const day = parts.BYDAY ? BYDAY[parts.BYDAY] ?? '' : ''
  const interval = Number(parts.INTERVAL ?? 1)

  if (parts.FREQ === 'WEEKLY') {
    const unit = day || '周'
    return interval === 1 ? `每${unit}` : `每 ${interval} 周${day}`
  }
  if (parts.FREQ === 'DAILY') return interval === 1 ? '每天' : `每 ${interval} 天`
  if (parts.FREQ === 'MONTHLY') return '每月'
  return rrule
}
