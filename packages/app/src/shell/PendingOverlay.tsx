import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { useQuery } from '@tanstack/react-query'
import { api, queryKeys } from '../api.ts'
import { transition } from '../tokens/motion.ts'
import { Empty } from './State.tsx'

/**
 * 待确认不是页面，是状态：只在有内容时出现，确认完自己消失。
 *
 * 这一版只把待确认的条目摆出来并能点进去看；逐条确认的动作随浮层那一步补上。
 * 进这里的门槛是「错了不可逆」——合并、以及会污染后续判断的低置信度条目——
 * 不是「模型没把握」。
 */
export function PendingOverlay({ onClose }: { onClose: () => void }) {
  const { data } = useQuery({ queryKey: queryKeys.confirmations, queryFn: api.listConfirmations })
  const pending = data?.items ?? []

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

        {pending.length === 0 ? (
          <Empty>没有需要确认的东西。</Empty>
        ) : (
          <ul className="plain-list">
            {pending.map((item) => (
              <li key={item.id}>
                <Link to={`/items/${item.id}`} onClick={onClose}>{item.title}</Link>
              </li>
            ))}
          </ul>
        )}
      </motion.div>
    </div>
  )
}
