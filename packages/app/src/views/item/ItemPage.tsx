import { useParams } from 'react-router-dom'
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, queryKeys, type Citation, type Fragment, type ItemWithSources } from '../../api.ts'
import { Empty, ErrorState, Loading } from '../../shell/State.tsx'
import { formatAt, formatDay, formatDue, formatRrule } from '../../lib/format.ts'
import './item.css'

const TYPE_LABEL: Record<string, string> = {
  event: '事件', task: '事务', thought: '想法', progress: '进度', state: '状态',
}

/**
 * 一条条目的详情：从任意一页进来，返回自动回到来处。
 *
 * 这一页存在的理由是「扔了就可以忘」的前提——用户随时能看到它是从哪句话理解
 * 出来的，并且改得掉。看不到出处，就只能选择相信或者不相信，那是两个都不好的
 * 选项。
 */
export function ItemPage() {
  const { id = '' } = useParams()
  const queryClient = useQueryClient()

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: queryKeys.item(id),
    queryFn: () => api.getItem(id),
  })

  const fragments = useQueries({
    queries: (data?.item.sourceFragmentIds ?? []).map((fid) => ({
      queryKey: queryKeys.fragment(fid),
      queryFn: () => api.getFragment(fid),
    })),
  })

  const patch = useMutation({
    mutationFn: (fields: Record<string, string | null>) => api.patchItem(id, fields),
    onSuccess: () => queryClient.invalidateQueries(),
  })

  if (isLoading) return <Loading />
  if (error) return <ErrorState error={error} onRetry={() => refetch()} />
  if (!data) return <Empty>找不到这一条。</Empty>

  const { item, history } = data

  return (
    <>
      <h1 className="page-title">{item.title}</h1>

      <p className="item-meta">
        {[TYPE_LABEL[item.type] ?? item.type, ...timeParts(item)].join(' · ')}
      </p>

      <div className="item-actions">
        {item.status === 'active' && (
          <button className="quiet" onClick={() => patch.mutate({ status: 'done' })}>标记完成</button>
        )}
        {item.status === 'needs_confirm' && (
          <button className="quiet" onClick={() => patch.mutate({ status: 'active' })}>收下</button>
        )}
        {item.status !== 'dropped' && (
          <button className="quiet" onClick={() => patch.mutate({ status: 'dropped' })}>丢掉</button>
        )}
        {item.status === 'done' && <span className="item-status">已完成</span>}
        {item.status === 'dropped' && <span className="item-status">已丢弃</span>}
      </div>

      {patch.error && <ErrorState error={patch.error} />}

      <section className="group">
        <h2 className="group-label">原文</h2>
        {fragments.length === 0 && <Empty>这一条没有关联的原文。</Empty>}
        {fragments.map((q, i) => {
          const fid = item.sourceFragmentIds[i]!
          if (q.isLoading) return <Loading key={fid} />
          if (q.error) return <ErrorState key={fid} error={q.error} />
          if (!q.data) return null
          return <Source key={fid} fragment={q.data.fragment} citations={item.citations} />
        })}
      </section>

      {history.length > 0 && (
        <section className="group">
          <h2 className="group-label">改动</h2>
          <ul className="plain-list">
            {history.map((h) => (
              <li key={h.id} className="history-row">
                <span className="stamp">{formatDay(h.changed_at)}</span>
                {describe(h.field)}：{h.old_value ?? '空'} → {h.new_value ?? '空'}
                <span className="history-actor">{ACTOR[h.actor] ?? h.actor}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  )
}

/**
 * 一条碎片的原文，引用过的片段标出来。
 *
 * 引文是逐字的，偏移由服务端 indexOf 出来；对不上时偏移是 -1，那种引用不高亮
 * ——宁可不标，也不能标错位置，标错比不标更误导。
 */
function Source({ fragment, citations }: { fragment: Fragment; citations: Citation[] }) {
  if (fragment.rawText === null) {
    return <p className="source-blob">{fragment.rawType === 'image' ? '一张图片' : '一份文件'}</p>
  }

  const mine = citations
    .filter((c) => c.fragmentId === fragment.id && c.startOffset >= 0)
    .sort((a, b) => a.startOffset - b.startOffset)

  const parts: React.ReactNode[] = []
  let cursor = 0
  for (const [i, c] of mine.entries()) {
    if (c.startOffset < cursor) continue // 引文重叠时只标第一段，不叠色
    if (c.startOffset > cursor) parts.push(fragment.rawText.slice(cursor, c.startOffset))
    parts.push(
      <mark key={i} title={FIELD_LABEL[c.field] ?? c.field}>
        {fragment.rawText.slice(c.startOffset, c.endOffset)}
      </mark>,
    )
    cursor = c.endOffset
  }
  parts.push(fragment.rawText.slice(cursor))

  return (
    <div className="source">
      <p className="source-text">{parts}</p>
      {mine.length > 0 && (
        <p className="source-legend">
          {mine.map((c, i) => (
            <span key={i}>{FIELD_LABEL[c.field] ?? c.field}：「{c.quote}」</span>
          ))}
        </p>
      )}
    </div>
  )
}

const FIELD_LABEL: Record<string, string> = {
  title: '标题', starts_at: '开始', due_at: '截止', date_raw: '原始表达',
  recurrence: '重复', location: '地点', type: '类型',
}

const ACTOR: Record<string, string> = {
  user: '你改的', llm: '理解出来的', merge: '合并带来的', sync: '同步带来的',
}

function describe(field: string): string {
  return FIELD_LABEL[field] ?? field
}

function timeParts(item: ItemWithSources): string[] {
  const parts: string[] = []
  const at = item.startsAt ?? item.dueAt
  if (at) {
    parts.push(`${formatDay(at)}${formatAt(at, item.datePrecision) ? ` ${formatAt(at, item.datePrecision)}` : ''}`)
  }
  if (item.dueAt) parts.push(formatDue(item.dueAt))
  if (item.rrule) parts.push(formatRrule(item.rrule))
  if (item.location) parts.push(item.location)
  if (item.dateRaw) parts.push(`原文「${item.dateRaw}」`)
  if (item.confidence === 'medium') parts.push('猜的')
  return parts
}
