import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api, queryKeys, type AgendaEntry } from '../../api.ts'
import { Empty, ErrorState, Loading } from '../../shell/State.tsx'
import { formatAt, formatDayLabel, formatDue, formatRrule } from '../../lib/format.ts'
import './agenda.css'

/**
 * 日程——纵向按天的轴，不是月历格子。
 *
 * 月历给每天同样的面积，而用户只关心接下来几天；十几条数据填不满格子，看起来
 * 是空的。分组与筛选都在语义层做好了，这里只负责呈现。
 *
 * 重复项不占某一天，压成每天顶上一条细带——否则同步完课表，真正的节点全被
 * 每周重复的课淹掉。
 */
export function AgendaPage() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: queryKeys.agenda,
    queryFn: api.getAgenda,
  })

  if (isLoading) return <Loading />
  if (error) return <ErrorState error={error} onRetry={() => refetch()} />

  const days = data?.days ?? []
  const recurring = data?.recurring ?? []

  if (days.length === 0 && recurring.length === 0) {
    return <Empty>接下来没有安排。</Empty>
  }

  return (
    <div className="agenda">
      {recurring.length > 0 && (
        <p className="day-band">
          {recurring.map(({ item }) => (
            <span key={item.id}>
              {item.title}
              {item.rrule && `（${formatRrule(item.rrule)}）`}
            </span>
          ))}
        </p>
      )}

      {days.map(({ day, items }) => (
        <section key={day} className="day">
          <h2 className="day-label">{formatDayLabel(day)}</h2>
          <ul className="plain-list">
            {items.map((entry) => (
              <li key={entry.item.id} className="agenda-row">
                <Link to={`/items/${entry.item.id}`}>{entry.item.title}</Link>
                <span className="agenda-meta">{meta(entry)}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
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
