import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { api, queryKeys, type ItemWithSources } from '../../api.ts'
import { Empty, ErrorState, Loading } from '../../shell/State.tsx'

/**
 * 日程——纵向按天的轴，不是月历格子。
 *
 * 月历给每天同样的面积，而用户只关心接下来几天；十几条数据填不满格子，看起来
 * 是空的。没有内容的天直接跳过。
 *
 * 课表那类重复项压成每天顶上一条细带的处理随日程页那一步补上，否则同步完课表
 * 真正的节点会被淹没。
 */
export function AgendaPage() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: queryKeys.items,
    queryFn: api.listItems,
  })

  if (isLoading) return <Page><Loading /></Page>
  if (error) return <Page><ErrorState error={error} onRetry={() => refetch()} /></Page>

  const days = groupByDay(data?.items ?? [])

  if (days.length === 0) return <Page><Empty>接下来没有安排。</Empty></Page>

  return (
    <Page>
      {days.map(([day, items]) => (
        <section key={day} className="day">
          <h2 className="day-label">{day}</h2>
          <ul className="plain-list">
            {items.map((item) => (
              <li key={item.id}>
                <Link to={`/items/${item.id}`}>{item.title}</Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </Page>
  )
}

/** 只有带时间的条目上轴。没有时间的东西在项目页与想法页，不在这里凑数。 */
function groupByDay(items: ItemWithSources[]): [string, ItemWithSources[]][] {
  const byDay = new Map<string, ItemWithSources[]>()

  for (const item of items) {
    const at = item.dueAt ?? item.startsAt
    if (!at) continue
    const day = at.slice(0, 10)
    const bucket = byDay.get(day)
    if (bucket) bucket.push(item)
    else byDay.set(day, [item])
  }

  return [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))
}

function Page({ children }: { children: React.ReactNode }) {
  return (
    <>
      <h1 className="page-title">日程</h1>
      {children}
    </>
  )
}
