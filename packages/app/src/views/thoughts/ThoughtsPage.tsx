import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { api, queryKeys } from '../../api.ts'
import { Empty, ErrorState, Loading } from '../../shell/State.tsx'

/**
 * 想法——倒序的流。
 *
 * 它天生既没有时间也不属于项目，而且不需要变成任何东西：正常归宿就是待在
 * 这里，所以这一页没有「整理」「清空」一类的动作，也不显示任何计数压力。
 */
export function ThoughtsPage() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: queryKeys.items,
    queryFn: api.listItems,
  })

  if (isLoading) return <Page><Loading /></Page>
  if (error) return <Page><ErrorState error={error} onRetry={() => refetch()} /></Page>

  const thoughts = (data?.items ?? [])
    .filter((i) => i.type === 'thought')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))

  if (thoughts.length === 0) return <Page><Empty>还没有想法。</Empty></Page>

  return (
    <Page>
      <ul className="plain-list">
        {thoughts.map((t) => (
          <li key={t.id}>
            <Link to={`/items/${t.id}`}>{t.title}</Link>
          </li>
        ))}
      </ul>
    </Page>
  )
}

function Page({ children }: { children: React.ReactNode }) {
  return (
    <>
      <h1 className="page-title">想法</h1>
      {children}
    </>
  )
}
