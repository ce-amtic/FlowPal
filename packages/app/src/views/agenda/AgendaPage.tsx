import { Link } from 'react-router-dom'
import { ItemRow } from '../../shell/ItemRow.tsx'
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
 * 重复项不占某一天，压成顶上一条细带——否则同步完课表，真正的节点全被每周
 * 重复的课淹掉。
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
        <p className="recurring">
          {/* 「每周」那几个字就在旁边，图标只是重复一遍，读屏器跳过它 */}
          <Repeat size={ICON.sizeSmall} strokeWidth={ICON.stroke} aria-hidden />
          {recurring.map(({ item }) => (
            <span key={item.id}>
              {item.title}
              {item.rrule && ` · ${formatRrule(item.rrule)}`}
            </span>
          ))}
        </p>
      )}

      {days.map(({ day, items }) => (
        <section key={day} className="day">
          <DayLabel day={day} />
          <ul className="plain-list">
            {items.map((entry) => (
              <ItemRow item={entry.item} meta={meta(entry)} key={entry.item.id} />
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
