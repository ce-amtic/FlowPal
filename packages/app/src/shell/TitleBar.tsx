import { NavLink, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api, queryKeys } from '../api.ts'

/**
 * 标题栏同时是导航与拖动区。系统标题栏被隐藏了，所以这条不只是装饰——
 * 没有它窗口挪不动。按钮周围要留足可拖动的空白。
 *
 * 五格是这条栏的上限。专注是动作不是页，设置与待确认是角落控件。
 */
const PAGES = [
  { to: '/now', label: '此刻' },
  { to: '/recent', label: '最近' },
  { to: '/agenda', label: '日程' },
  { to: '/projects', label: '项目' },
  { to: '/thoughts', label: '想法' },
]

export function TitleBar({ onOpenPending }: { onOpenPending: () => void }) {
  const navigate = useNavigate()

  // 待确认只在有内容时出现。数目前从条目列表里数；待确认队列的接口落地后
  // 换成它，届时这一处跟着改，别处不动。
  const { data } = useQuery({
    queryKey: queryKeys.items,
    queryFn: api.listItems,
  })
  const pending = data?.items.filter((i) => i.status === 'needs_confirm').length ?? 0

  return (
    <header className="titlebar">
      <nav className="nav">
        {PAGES.map((p) => (
          <NavLink key={p.to} to={p.to} className={({ isActive }) => (isActive ? 'active' : '')}>
            {p.label}
          </NavLink>
        ))}
      </nav>

      <div className="right">
        {pending > 0 && (
          <button className="icon-button badge" onClick={onOpenPending} title="待确认">
            {pending}
          </button>
        )}
        <button className="icon-button" onClick={() => navigate('/settings')} title="设置">
          设置
        </button>
      </div>
    </header>
  )
}
