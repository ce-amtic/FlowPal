import { useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api, queryKeys, type ItemWithSources } from '../../api.ts'
import { ItemRow } from '../../shell/ItemRow.tsx'
import { Empty, ErrorState, Loading } from '../../shell/State.tsx'
import { formatAt, formatDay } from '../../lib/format.ts'
import './projects.css'

/**
 * 一个项目：接下来的节点、未完成、已完成、用户说过的话。
 *
 * 「说过的」是状态类条目，也就是用户自己扔进来的那几句，以本来的样子呈现——
 * 几句带日期的话，不假装成一条进展线。他说出来是为了卸载，不是为了汇报，
 * 所以内容是真的。
 */
export function ProjectPage() {
  const { id = '' } = useParams()
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: queryKeys.project(id),
    queryFn: () => api.getProject(id),
  })

  if (isLoading) return <Loading />
  if (error) return <ErrorState error={error} onRetry={() => refetch()} />
  if (!data) return <Empty>找不到这个项目。</Empty>

  const { project, items } = data
  const active = items.filter((i) => i.status === 'active')

  const upcoming = active
    .filter((i) => i.type !== 'state' && (i.startsAt ?? i.dueAt))
    .sort((a, b) => (a.startsAt ?? a.dueAt ?? '').localeCompare(b.startsAt ?? b.dueAt ?? ''))
  const todo = active.filter((i) => i.type !== 'state' && !i.startsAt && !i.dueAt)
  const done = items.filter((i) => i.status === 'done')
  const said = items
    .filter((i) => i.type === 'state')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))

  return (
    <>
      <h1 className="page-title">{project.name}</h1>

      {project.statusNote && <p className="project-lead">{project.statusNote}</p>}

      <Group label="接下来" items={upcoming} withDate />
      <Group label="未完成" items={todo} />
      <Group label="已完成" items={done} />

      {said.length > 0 && (
        <section className="group">
          <h2 className="group-label">说过的</h2>
          <ul className="plain-list">
            {/* 说过的那几句本来就是状态类条目，用同一行呈现；日期挪到行尾，和别处一致 */}
            {said.map((s) => (
              <ItemRow key={s.id} item={s} meta={formatDay(s.createdAt)} />
            ))}
          </ul>
        </section>
      )}
    </>
  )
}

function Group({
  label, items, withDate = false,
}: { label: string; items: ItemWithSources[]; withDate?: boolean }) {
  if (items.length === 0) return null

  return (
    <section className="group">
      <h2 className="group-label">{label}</h2>
      <ul className="plain-list">
        {items.map((item) => (
          <ItemRow key={item.id} item={item} meta={groupMeta(item, withDate)} />
        ))}
      </ul>
    </section>
  )
}

/**
 * 行尾。「接下来」那一组按时间排，所以连日期带时刻都要给——只给时刻读不出先后。
 *
 * 其余两组行尾留空，尤其是已完成：那一条的日期已经过去了，交给行自己算的话，
 * 一件做完的事后面会挂上「已过期 3 天」，那是在催一件不存在的事。
 */
function groupMeta(item: ItemWithSources, withDate: boolean): string {
  if (!withDate) return ''
  const at = item.startsAt ?? item.dueAt
  if (!at) return ''
  const time = formatAt(at, item.datePrecision)
  return time ? `${formatDay(at)} ${time}` : formatDay(at)
}
