import { useEffect, useState } from 'react'
import { api, type ItemWithSources } from '../../api.ts'
import { bridge } from '../../bridge.ts'
import './collection.css'

const TYPE_LABEL: Record<string, string> = {
  event: '事件', task: '事务', thought: '念头', progress: '进度', state: '状态',
}

/**
 * 采集视图：投放区 + 条目列表。
 *
 * 这是骨架——证明「扔进去 → 落库 → 列表里看得见」这条链路是通的。
 * 投放的反馈、条目编辑、原文与引用展示、待确认队列都在这一层往下做。
 */
export function CollectionView() {
  const [items, setItems] = useState<ItemWithSources[]>([])
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = () => api.listItems().then((r) => setItems(r.items)).catch((e) => setError(String(e)))

  useEffect(() => {
    reload()
    bridge.onHotkeyOpen(() => document.getElementById('drop-input')?.focus())
  }, [])

  async function throwIn() {
    if (!text.trim()) return
    setBusy(true)
    setError(null)
    try {
      await api.throwIn({ source: 'paste', rawType: 'text', rawText: text })
      setText('')
      await reload()
    } catch (e) {
      // 大声失败：抽取出错时把错误摆出来，不装作扔进去了。
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <div className="drop">
        <input
          id="drop-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') throwIn() }}
          placeholder="扔点什么进来…"
          disabled={busy}
          autoFocus
        />
        {busy && <span className="status">在看…</span>}
      </div>

      {error && <pre className="error">{error}</pre>}

      <ul className="items">
        {items.map((item) => (
          <li className="item" key={item.id}>
            <div className="title">{item.title}</div>
            <div className="meta">
              <span className="tag">{TYPE_LABEL[item.type] ?? item.type}</span>
              {item.dueAt && <span>截止 {formatDate(item.dueAt, item.datePrecision)}</span>}
              {item.startsAt && <span>{formatDate(item.startsAt, item.datePrecision)}</span>}
              {item.rrule && <span>{item.rrule}</span>}
              {item.confidence === 'medium' && <span className="tag guess">猜的</span>}
              {item.sourceFragmentIds.length > 1 && <span>{item.sourceFragmentIds.length} 个来源</span>}
            </div>
          </li>
        ))}
      </ul>

      {items.length === 0 && !error && <p className="empty">还没有条目。</p>}
    </div>
  )
}

/** 只有日期没有时刻的，不显示 00:00——那个零点是没有的东西。 */
function formatDate(iso: string, precision: string | null): string {
  const d = new Date(iso)
  const date = `${d.getMonth() + 1} 月 ${d.getDate()} 日`
  if (precision !== 'minute') return date
  return `${date} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
