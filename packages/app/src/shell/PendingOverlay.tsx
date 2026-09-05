import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, queryKeys, type ItemWithSources } from '../api.ts'
import { transition } from '../tokens/motion.ts'
import { formatDay } from '../lib/format.ts'
import { Empty, ErrorState } from './State.tsx'

/**
 * 待确认不是页面，是状态：只在有内容时出现，确认完自己消失。
 *
 * 进这里的门槛是「错了代价高或不可逆」，不是「模型没把握」——所以这里的每一条
 * 都值得占用户一次注意力，而不是一堆需要划过去的噪音。产品不催：用户随时可以
 * 关掉它，剩下的下次再说。
 */
export function PendingOverlay({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient()
  const { data, error } = useQuery({
    queryKey: queryKeys.confirmations,
    queryFn: api.listConfirmations,
  })

  const decide = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'active' | 'dropped' }) =>
      api.patchItem(id, { status }),
    onSuccess: () => queryClient.invalidateQueries(),
  })

  const pending = data?.items ?? []

  // 确认完自己消失：最后一条处理掉，浮层就没有理由留在屏幕上
  useEffect(() => {
    if (data && pending.length === 0) onClose()
  }, [data, pending.length, onClose])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="overlay-scrim" onClick={onClose}>
      <motion.div
        className="overlay"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={transition.base}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="overlay-head">
          <span>待确认</span>
          <button className="icon-button" onClick={onClose}>关闭</button>
        </div>

        {error && <ErrorState error={error} />}
        {!error && pending.length === 0 && <Empty>没有需要确认的东西。</Empty>}

        <ul className="plain-list">
          {pending.map((item) => (
            <li key={item.id} className="confirm-row">
              <div>
                <Link to={`/items/${item.id}`} onClick={onClose}>{item.title}</Link>
                <p className="confirm-why">{why(item)}</p>
              </div>
              <div className="confirm-actions">
                <button
                  className="quiet"
                  disabled={decide.isPending}
                  onClick={() => decide.mutate({ id: item.id, status: 'active' })}
                >
                  收下
                </button>
                <button
                  className="quiet"
                  disabled={decide.isPending}
                  onClick={() => decide.mutate({ id: item.id, status: 'dropped' })}
                >
                  丢掉
                </button>
              </div>
            </li>
          ))}
        </ul>

        {decide.error && <ErrorState error={decide.error} />}
      </motion.div>
    </div>
  )
}

/**
 * 为什么这条要问。不说清楚，用户就只能凭标题猜，而猜出来的确认没有价值。
 * 两个原因对应落库时的两条规则：低置信度，以及进度没有所属项目。
 */
function why(item: ItemWithSources): string {
  const parts: string[] = []
  if (item.type === 'progress' && item.projectId === null) parts.push('不确定属于哪个项目')
  if (item.confidence === 'low') parts.push('没读准')
  if (item.dateRaw) parts.push(`原文写的是「${item.dateRaw}」`)
  const at = item.dueAt ?? item.startsAt
  if (at) parts.push(`理解成 ${formatDay(at)}`)
  return parts.join(' · ')
}
