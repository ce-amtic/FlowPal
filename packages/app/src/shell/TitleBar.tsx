import { NavLink, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Plus, Settings } from 'lucide-react'
import { api, queryKeys, usingMock } from '../api.ts'
import { ICON } from '../tokens/icons.ts'

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

  const { data } = useQuery({ queryKey: queryKeys.confirmations, queryFn: api.listConfirmations })
  const pending = data?.count ?? 0

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
        {/* 样例数据必须看得见。最怕的失败是拿着它演了却不知道 */}
        {usingMock && <span className="tag mock">样例数据</span>}

        {/* 投放口在「最近」页顶上，这里只是把人和焦点一起带过去 */}
        <button
          className="icon-button"
          aria-label="记录"
          onClick={() => navigate('/recent', { state: { focusComposer: true } })}
        >
          <Plus size={ICON.size} strokeWidth={ICON.stroke} />
        </button>

        {pending > 0 && (
          <button className="icon-button badge" onClick={onOpenPending}>
            {pending} 条待确认
          </button>
        )}

        <button className="icon-button" onClick={() => navigate('/settings')} aria-label="设置">
          <Settings size={ICON.size} strokeWidth={ICON.stroke} />
        </button>
      </div>
    </header>
  )
}
