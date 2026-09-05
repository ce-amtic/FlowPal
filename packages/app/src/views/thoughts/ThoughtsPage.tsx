import { useQuery } from '@tanstack/react-query'
import { api, queryKeys, type ItemWithSources } from '../../api.ts'
import { DayLabel } from '../../shell/DayLabel.tsx'
import { ItemRow } from '../../shell/ItemRow.tsx'
import { Empty, ErrorState, Loading } from '../../shell/State.tsx'
import { formatTime } from '../../lib/format.ts'

/**
 * 想法——倒序的流。
 *
 * 它天生既没有时间也不属于项目，而且不需要变成任何东西：正常归宿就是待在
 * 这里。所以这一页没有「整理」「清空」一类的动作，也不显示总数——那会变成
 * 一个待办计数，而计数就是催促。
 */
export function ThoughtsPage() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: queryKeys.thoughts,
    queryFn: api.listThoughts,
  })

  if (isLoading) return <Loading />
  if (error) return <ErrorState error={error} onRetry={() => refetch()} />

  const days = groupByDay(data?.thoughts ?? [])
  if (days.length === 0) return <Empty>还没有想法。</Empty>

  return (
    <div className="thoughts">
      {days.map(([day, thoughts]) => (
        <section key={day} className="day">
          <DayLabel day={day} />
          <ul className="plain-list">
            {/*
              和全 App 其余的行同一个形状：左端的图标锚点，标题，行尾的时刻。
              时刻原来在左边自成一列，现在挪到行尾——想法没有日期，行尾空着，
              而左边那一列时刻会把标题挤到日期骨架的右边，和别处对不齐。
            */}
            {thoughts.map((t) => (
              <ItemRow key={t.id} item={t} meta={formatTime(t.createdAt)} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

function groupByDay(items: ItemWithSources[]): [string, ItemWithSources[]][] {
  const byDay = new Map<string, ItemWithSources[]>()

  for (const item of items) {
    const day = item.createdAt.slice(0, 10)
    const bucket = byDay.get(day)
    if (bucket) bucket.push(item)
    else byDay.set(day, [item])
  }

  for (const bucket of byDay.values()) {
    bucket.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  return [...byDay.entries()].sort((a, b) => b[0].localeCompare(a[0]))
}
