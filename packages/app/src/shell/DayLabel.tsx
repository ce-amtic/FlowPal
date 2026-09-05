import { formatDayLabel } from '../lib/format.ts'

/** 最近、日程、想法三页共用的分组标题。同一个东西必须长成同一个样子 */
export function DayLabel({ day }: { day: string }) {
  const [date, aside] = formatDayLabel(day)
  return (
    <h2 className="day-label">
      {date}
      <span>{aside}</span>
    </h2>
  )
}
