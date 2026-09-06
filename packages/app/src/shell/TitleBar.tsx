import { Link, NavLink } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Plus, Settings } from 'lucide-react'
import { api, queryKeys, usingMock } from '../api.ts'
import { ICON } from '../tokens/icons.ts'

/**
 * 标题栏同时是导航与拖动区。系统标题栏被隐藏了，所以这条不只是装饰——
 * 没有它窗口挪不动。按钮周围要留足可拖动的空白。
 *
 * 五格是这条栏的上限。专注是动作不是页，设置与待确认是角落控件。
 *
 * 这四格讲的都是用户的世界。「最近」讲的是系统的账——每一次投放和它的产出——
 * 那是出了岔子才去查的地方，不是每天要走的地方，所以它有路由没有格子。
 */
const PAGES = [
  { to: '/now', label: '此刻' },
  { to: '/agenda', label: '日程' },
  { to: '/projects', label: '项目' },
  { to: '/thoughts', label: '想法' },
]

export function TitleBar({ onOpenPending }: { onOpenPending: () => void }) {
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

        {/*
          记录口在「此刻」，这里只是把人和焦点一起带回去。它去的是一页，不是做一件事，
          所以是链接不是按钮——后退能撤销的东西必须让浏览器与读屏器认出来是导航。
        */}
        <Link className="icon-button" to="/now" state={{ focusComposer: true }} aria-label="记录">
          <Plus size={ICON.size} strokeWidth={ICON.stroke} aria-hidden />
        </Link>

        {/* 待确认是浮层，开它不改地址，所以它是按钮 */}
        {pending > 0 && (
          <button className="icon-button badge" onClick={onOpenPending}>
            {pending} 条待确认
          </button>
        )}

        <Link className="icon-button" to="/settings" aria-label="设置">
          <Settings size={ICON.size} strokeWidth={ICON.stroke} aria-hidden />
        </Link>
      </div>
    </header>
  )
}
