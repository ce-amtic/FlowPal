import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { api, queryKeys } from '../../api.ts'
import { transition } from '../../tokens/motion.ts'
import { Empty, ErrorState, Loading } from '../../shell/State.tsx'
import { formatDay } from '../../lib/format.ts'
import './projects.css'

/**
 * 项目——长期追踪的居所。
 *
 * 卡片上没有进度条：进度追踪结构性不可解，摆一个百分比比没有更糟。
 * 「多久没动」才是这一页的核心，它测的是回避而非进展，而回避正是这道题的靶心。
 *
 * 顶部的「未归类」是正常状态，不是待办——所以它不带计数压力，也没有清空按钮。
 */
export function ProjectsPage() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: queryKeys.projects,
    queryFn: api.listProjects,
  })

  if (isLoading) return <Loading />
  if (error) return <ErrorState error={error} onRetry={() => refetch()} />

  const cards = data?.projects ?? []
  const unclassified = data?.unclassified ?? []

  if (cards.length === 0 && unclassified.length === 0) {
    return <Empty>还没有项目。同步课表之后，每门课会成为一个。</Empty>
  }

  return (
    <>
      <ul className="project-list">
        {cards.map((card) => (
          <motion.li layout key={card.project.id} transition={transition.base}>
            <Link to={`/projects/${card.project.id}`} className="project-row">
              <div className="project-head">
                <span className="project-name">{card.project.name}</span>
                <span className="idle">{idleLabel(card.idleDays)}</span>
              </div>

              {card.next.length > 0 && (
                <p className="project-next">
                  {card.next.map((n) => (
                    <span key={n.id}>
                      <span className="stamp">{formatDay(n.at)}</span>
                      {n.title}
                    </span>
                  ))}
                </p>
              )}

              {card.project.statusNote && <p className="project-note">{card.project.statusNote}</p>}

              <p className="project-counts">
                {card.unfinished > 0 && <span>未完成 {card.unfinished}</span>}
                {card.done > 0 && <span>已完成 {card.done}</span>}
              </p>
            </Link>
          </motion.li>
        ))}
      </ul>

      {/* 未归类排在项目后面：它是常态，不是需要先清掉的收件箱 */}
      {unclassified.length > 0 && (
        <section className="group unclassified">
          <h2 className="group-label">未归类</h2>
          <ul className="plain-list">
            {unclassified.map((item) => (
              <li key={item.id}>
                <Link className="row" to={`/items/${item.id}`}>
                  <span className="row-title">{item.title}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  )
}

/** 「多久没动」。零天不说话——刚动过的事不需要被提醒它刚动过 */
function idleLabel(days: number | null): string {
  if (days === null || days <= 0) return ''
  return `${days} 天没动`
}
