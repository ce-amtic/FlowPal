import { useEffect, useState } from 'react'
import { api, type ItemWithSources } from '../../api.ts'
import { bridge } from '../../bridge.ts'

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
      <input
        id="drop-input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') throwIn() }}
        placeholder="扔点什么进来…"
        disabled={busy}
        style={{ width: '100%', padding: '10px 12px', fontSize: 14, boxSizing: 'border-box' }}
      />

      {error && <pre style={{ color: '#b00', whiteSpace: 'pre-wrap', fontSize: 12 }}>{error}</pre>}

      <ul style={{ listStyle: 'none', padding: 0, marginTop: 20 }}>
        {items.map((item) => (
          <li key={item.id} style={{ padding: '10px 0', borderBottom: '1px solid #eee' }}>
            <div style={{ fontSize: 14 }}>{item.title}</div>
            <div style={{ fontSize: 12, color: '#888', marginTop: 4 }}>
              {item.type}
              {item.dueAt && ` · 截止 ${item.dueAt}`}
              {item.startsAt && ` · ${item.startsAt}`}
              {item.rrule && ` · ${item.rrule}`}
              {item.confidence === 'medium' && ' · 猜的'}
              {item.sourceFragmentIds.length > 1 && ` · ${item.sourceFragmentIds.length} 个来源`}
            </div>
          </li>
        ))}
      </ul>
      {items.length === 0 && <p style={{ color: '#888', fontSize: 13 }}>还没有条目。</p>}
    </div>
  )
}
