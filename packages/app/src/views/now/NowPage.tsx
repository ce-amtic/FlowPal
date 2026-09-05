import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { api, queryKeys } from '../../api.ts'
import { transition } from '../../tokens/motion.ts'
import { Empty, ErrorState, Loading } from '../../shell/State.tsx'
import { formatDay } from '../../lib/format.ts'
import './now.css'

/**
 * 此刻——第一眼不是列表，是一件事。
 *
 * 「不知道先干哪个」正是用户卡住的原因，给他一张表等于把问题原样退回。
 *
 * 「换一件」在候选之间走，「更小的一步」在同一候选的切口里往后走。两者都是
 * 本地切换：这一组是一次调用返回的，点击零延迟、零费用。
 */
export function NowPage() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: queryKeys.now,
    queryFn: api.getNow,
  })

  const [pickIndex, setPickIndex] = useState(0)
  const [stepIndex, setStepIndex] = useState(0)
  const navigate = useNavigate()

  // 换了一件事，切口从最粗的那一个重新开始
  useEffect(() => setStepIndex(0), [pickIndex])

  if (isLoading) return <Loading />
  if (error) return <ErrorState error={error} onRetry={() => refetch()} />

  // primary 为 null 是库里没有可推的，不是出错：不调模型，请用户先扔点东西进来
  if (!data?.primary) {
    return <Empty>还没有可以开始的事。扔点什么进来，或者从日程里挑一件。</Empty>
  }

  const candidates = [data.primary, ...data.alternates]
  const candidate = candidates[pickIndex] ?? data.primary
  const step = candidate.steps[stepIndex] ?? candidate.steps[0] ?? candidate.title
  const hasSmaller = stepIndex < candidate.steps.length - 1
  const hasOther = candidates.length > 1

  return (
    <div className="now">
      <div className="now-head">
        <div className="avatar" aria-hidden />
        <p className="greeting">{greeting()}</p>
      </div>

      <motion.div layout transition={transition.base} className="card now-card">
        <motion.p layout="position" key={step} className="now-step">{step}</motion.p>
        <p className="now-reason">{candidate.reason}</p>

        <div className="now-actions">
          <button className="primary" onClick={() => navigate('/focus')}>开始</button>
          {hasOther && (
            <button className="quiet" onClick={() => setPickIndex((i) => (i + 1) % candidates.length)}>
              换一件
            </button>
          )}
          {hasSmaller && (
            <button className="quiet" onClick={() => setStepIndex((i) => i + 1)}>
              更小的一步
            </button>
          )}
        </div>
      </motion.div>

      <DateBand />

      {data.energy && <p className="energy">{data.energy}</p>}
    </div>
  )
}

/**
 * 底部那条日期带。它不是装饰，是「剩下的没丢」的凭据——只显示一件事而不给这个
 * 凭据，用户不敢信。取的是日程那份数据，不需要「此刻」的接口再返一遍。
 */
function DateBand() {
  const { data } = useQuery({ queryKey: queryKeys.agenda, queryFn: api.getAgenda })

  const upcoming = (data?.days ?? [])
    .flatMap((d) => d.items.map((entry) => ({ day: d.day, title: entry.item.title })))
    .slice(0, 4)

  if (upcoming.length === 0) return null

  return (
    <ul className="date-band">
      {upcoming.map((u) => (
        <li key={`${u.day}-${u.title}`}>
          <span className="stamp">{formatDay(u.day)}</span>
          {u.title}
        </li>
      ))}
    </ul>
  )
}

/** 问候语按本机时刻算。它不是判断，所以不必等模型 */
function greeting(): string {
  const hour = new Date().getHours()
  if (hour < 6) return '还没睡。'
  if (hour < 11) return '早上好。'
  if (hour < 14) return '中午好。'
  if (hour < 18) return '下午好。'
  return '晚上好。'
}
