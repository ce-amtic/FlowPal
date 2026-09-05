import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { api, queryKeys } from '../../api.ts'
import { transition } from '../../tokens/motion.ts'
import { Empty, ErrorState, Loading } from '../../shell/State.tsx'
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

  const projects = data?.projects ?? []
  const unassigned = data?.unassigned ?? []

  if (projects.length === 0 && unassigned.length === 0) {
    return <Empty>还没有项目。同步课表之后，每门课会成为一个。</Empty>
  }

  return (
    <>
      {unassigned.length > 0 && (
        <section className="unassigned">
          <h2 className="group-label">未归类</h2>
          <ul className="plain-list">
            {unassigned.map((item) => (
              <li key={item.id}>
                <Link to={`/items/${item.id}`}>{item.title}</Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <ul className="project-list">
        {projects.map((p) => (
          <motion.li layout key={p.id} transition={transition.base}>
            <Link to={`/projects/${p.id}`} className="card project-card">
              <div className="project-head">
                <span className="project-name">{p.name}</span>
                <span className="idle">{idleLabel(p.idleDays)}</span>
              </div>
              {p.statusNote && <p className="project-note">{p.statusNote}</p>}
            </Link>
          </motion.li>
        ))}
      </ul>
    </>
  )
}

/** 「多久没动」。零天不说话——刚动过的事不需要被提醒它刚动过 */
function idleLabel(days: number | null): string {
  if (days === null || days <= 0) return ''
  return `${days} 天没动`
}
