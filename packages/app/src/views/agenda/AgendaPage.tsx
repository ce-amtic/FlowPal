import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Repeat } from 'lucide-react'
import { api, queryKeys, type AgendaEntry } from '../../api.ts'
import { ICON } from '../../tokens/icons.ts'
import { DayLabel } from '../../shell/DayLabel.tsx'
import { Empty, ErrorState, Loading } from '../../shell/State.tsx'
import { formatAt, formatDue, formatRrule } from '../../lib/format.ts'
import './agenda.css'

/**
 * 日程——纵向按天的轴，不是月历格子。
 *
 * 月历给每天同样的面积，而用户只关心接下来几天；十几条数据填不满格子，看起来
 * 是空的。分组与筛选都在语义层做好了，这里只负责呈现。
 *
 * 重复项不占条目位置，压成那一天顶上的一条细带——否则同步完课表，真正的节点
 * 全被每周重复的课淹掉。带子挂在每一天而不是页顶：一学期十几门课堆在页顶那一条
 * 里读不动，而「今天有没有课、几点」正是这一页最该一眼看到的。
 */
export function AgendaPage() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: queryKeys.agenda,
    queryFn: api.getAgenda,
  })

  if (isLoading) return <Loading />
  if (error) return <ErrorState error={error} onRetry={() => refetch()} />

  const days = data?.days ?? []
  if (days.length === 0) return <Empty>接下来没有安排。</Empty>

  return (
    <div className="agenda">
      {days.map(({ day, items, recurring }) => (
        <section key={day} className="day">
          <DayLabel day={day} />

          {recurring.length > 0 && (
            <p className="recurring">
              <Repeat size={ICON.sizeSmall} strokeWidth={ICON.stroke} />
              {recurring.map(({ item }) => (
                <span key={item.id}>
                  {item.title}
                  {/* 时刻比「每周一」有用：那一天是哪天，日期标题已经说了 */}
                  {band(item)}
                </span>
              ))}
            </p>
          )}

          <ul className="plain-list">
            {items.map((entry) => (
              <li key={entry.item.id}>
                <Link className="row" to={`/items/${entry.item.id}`}>
                  <span className="row-title">{entry.item.title}</span>
                  <span className="row-meta">{meta(entry)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

/** 细带上那一条后面跟的字：有时刻给时刻加地点，没有就退回「每周一」这种说法。 */
function band(item: AgendaEntry['item']): string {
  const time = item.startsAt ? formatAt(item.startsAt, item.datePrecision) : ''
  if (time === '') return item.rrule ? ` · ${formatRrule(item.rrule)}` : ''
  return item.location ? ` · ${time} · ${item.location}` : ` · ${time}`
}

function meta({ item, project }: AgendaEntry): string {
  const parts: string[] = []
  const at = item.startsAt ?? item.dueAt
  if (at) {
    const time = formatAt(at, item.datePrecision)
    if (time) parts.push(time)
  }
  if (item.location) parts.push(item.location)
  if (item.dueAt) parts.push(formatDue(item.dueAt))
  if (project?.name) parts.push(project.name)
  if (item.confidence === 'medium') parts.push('猜的')
  return parts.join(' · ')
}
