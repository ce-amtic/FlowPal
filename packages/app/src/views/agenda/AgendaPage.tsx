import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api, queryKeys, type ItemWithSources } from '../../api.ts'
import { Empty, ErrorState, Loading } from '../../shell/State.tsx'
import { daysBetween, formatAt, formatDayLabel, formatDue, formatRrule } from '../../lib/format.ts'
import './agenda.css'

/**
 * 日程——纵向按天的轴，不是月历格子。
 *
 * 月历给每天同样的面积，而用户只关心接下来几天；十几条数据填不满格子，看起来
 * 是空的。没有内容的天直接跳过。
 *
 * 重复项压成每天顶上一条细带，不占条目的位置——否则同步完课表，真正的节点
 * 全被每周重复的课淹掉。
 */
export function AgendaPage() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: queryKeys.items,
    queryFn: api.listItems,
  })

  if (isLoading) return <Loading />
  if (error) return <ErrorState error={error} onRetry={() => refetch()} />

  const days = groupByDay(data?.items ?? [])
  if (days.length === 0) return <Empty>接下来没有安排。</Empty>

  return (
    <div className="agenda">
      {days.map(([day, { repeating, once }]) => (
        <section key={day} className="day">
          <h2 className="day-label">{formatDayLabel(day)}</h2>

          {repeating.length > 0 && (
            <p className="day-band">
              {repeating.map((i) => (
                <span key={i.id}>
                  {i.startsAt ? `${formatAt(i.startsAt, i.datePrecision)} ` : ''}{i.title}
                </span>
              ))}
            </p>
          )}

          <ul className="plain-list">
            {once.map((item) => (
              <li key={item.id} className="agenda-row">
                <Link to={`/items/${item.id}`}>{item.title}</Link>
                <span className="agenda-meta">{meta(item)}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

function meta(item: ItemWithSources): string {
  const parts: string[] = []
  const at = item.startsAt ?? item.dueAt
  if (at) {
    const time = formatAt(at, item.datePrecision)
    if (time) parts.push(time)
  }
  if (item.location) parts.push(item.location)
  if (item.dueAt) parts.push(formatDue(item.dueAt))
  if (item.confidence === 'medium') parts.push('猜的')
  return parts.join(' · ')
}

type Day = { repeating: ItemWithSources[]; once: ItemWithSources[] }

/**
 * 只有带时间的条目上轴。没有时间的东西在项目页与想法页，不在这里凑数。
 * 过去的天不显示——这一页回答的是「接下来」。
 */
function groupByDay(items: ItemWithSources[]): [string, Day][] {
  const today = new Date()
  const byDay = new Map<string, Day>()

  for (const item of items) {
    // 待确认的还不算数，它们的落点是角标那个浮层，不是这条轴
    if (item.status !== 'active') continue
    const at = item.startsAt ?? item.dueAt
    if (!at) continue
    if (daysBetween(today, new Date(at)) < 0) continue

    const day = at.slice(0, 10)
    const bucket = byDay.get(day) ?? { repeating: [], once: [] }
    if (item.rrule) bucket.repeating.push(item)
    else bucket.once.push(item)
    byDay.set(day, bucket)
  }

  return [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, d]) => [day, {
      repeating: d.repeating.map(withRruleLabel),
      once: d.once,
    }] as [string, Day])
}

/** 细带上显示的是「每周三」这类人话，不是 RFC 5545 的串 */
function withRruleLabel(item: ItemWithSources): ItemWithSources {
  return { ...item, title: `${item.title}（${formatRrule(item.rrule!)}）` }
}
