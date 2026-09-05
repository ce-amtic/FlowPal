import { Link, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api, queryKeys, type ItemWithSources } from '../../api.ts'
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
            {said.map((s) => (
              <li key={s.id}>
                <Link className="row" to={`/items/${s.id}`}>
                  <span className="stamp">{formatDay(s.createdAt)}</span>
                  <span className="row-title">{s.title}</span>
                </Link>
              </li>
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
        {items.map((item) => {
          const at = item.startsAt ?? item.dueAt
          return (
            <li key={item.id}>
              <Link className="row" to={`/items/${item.id}`}>
                {withDate && at && (
                  <span className="stamp">
                    {formatDay(at)} {formatAt(at, item.datePrecision)}
                  </span>
                )}
                <span className="row-title">{item.title}</span>
              </Link>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
