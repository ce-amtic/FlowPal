import { Link, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api, queryKeys, type ItemWithSources } from '../../api.ts'
import { Empty, ErrorState, Loading } from '../../shell/State.tsx'
import { formatDay, formatAt } from '../../lib/format.ts'
import './projects.css'

/**
 * 一个项目：接下来的节点、未完成、已完成、用户说过的话，以及「多久没动」。
 *
 * 「说过的」是用户自己扔进来的进度陈述，以它本来的样子呈现——几句带日期的话，
 * 不假装成一条进展线。他说出来是为了卸载，不是为了汇报，所以内容是真的。
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

  const { project, upcoming, todo, done, said } = data

  return (
    <>
      <div className="project-title">
        <h1 className="page-title">{project.name}</h1>
        {project.idleDays !== null && project.idleDays > 0 && (
          <span className="idle">{project.idleDays} 天没动</span>
        )}
      </div>

      {project.statusNote && <p className="project-note project-lead">{project.statusNote}</p>}

      <Group label="接下来" items={upcoming} withDate />
      <Group label="未完成" items={todo} />
      <Group label="已完成" items={done} />

      {said.length > 0 && (
        <section className="group">
          <h2 className="group-label">说过的</h2>
          <ul className="plain-list">
            {said.map((s) => (
              <li key={s.at}>
                <span className="stamp">{formatDay(s.at)}</span>
                {s.text}
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
              {withDate && at && (
                <span className="stamp">
                  {formatDay(at)} {formatAt(at, item.datePrecision)}
                </span>
              )}
              <Link to={`/items/${item.id}`}>{item.title}</Link>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
