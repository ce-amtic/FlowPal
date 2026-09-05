import { useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api, queryKeys } from '../../api.ts'
import { Empty, ErrorState, Loading } from '../../shell/State.tsx'

/**
 * 一条条目的详情：从日程、项目、想法、最近任意一处进来，返回自动回到来处。
 *
 * 这一页最终要展示每个字段是从原文哪一段读出来的，那是「扔了就可以忘」成立的
 * 前提——用户随时能看到它是怎么理解的，并且改得掉。
 */
export function ItemPage() {
  const { id = '' } = useParams()
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: queryKeys.item(id),
    queryFn: () => api.getItem(id),
  })

  if (isLoading) return <Loading />
  if (error) return <ErrorState error={error} onRetry={() => refetch()} />
  if (!data) return <Empty>找不到这一条。</Empty>

  const { item } = data

  return (
    <>
      <h1 className="page-title">{item.title}</h1>
      <dl className="fields">
        <Field label="类型" value={item.type} />
        <Field label="开始" value={item.startsAt} />
        <Field label="截止" value={item.dueAt} />
        <Field label="原始表达" value={item.dateRaw} />
        <Field label="重复" value={item.rrule} />
        <Field label="地点" value={item.location} />
        <Field label="状态" value={item.status} />
      </dl>
    </>
  )
}

function Field({ label, value }: { label: string; value: string | null }) {
  if (!value) return null
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  )
}
