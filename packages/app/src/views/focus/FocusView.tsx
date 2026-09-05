import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { FocusSession, Item } from '@flowpal/shared'
import { api } from '../../api.ts'
import { bridge } from '../../bridge.ts'
import './focus.css'

type Phase = 'resolving' | 'starting' | 'running' | 'ending' | 'summary' | 'error'
type Outcome = 'done' | 'continue' | 'early_end'

export function FocusView({ search }: { search: URLSearchParams }) {
  const navigate = useNavigate()
  const itemId = search.get('item')
  const requestedMinutes = clampMinutes(Number(search.get('minutes') ?? 25))
  const [item, setItem] = useState<Item | null>(null)
  const [session, setSession] = useState<FocusSession | null>(null)
  const [phase, setPhase] = useState<Phase>('resolving')
  const [error, setError] = useState<string | null>(null)
  const [clock, setClock] = useState(() => Date.now())
  const [summary, setSummary] = useState<{ durationMinutes: number; outcome: Outcome | null } | null>(null)

  useEffect(() => {
    let cancelled = false
    async function resolve() {
      setPhase('resolving')
      setError(null)
      try {
        const items = await api.listItems()
        if (cancelled) return
        const selected = itemId ? items.items.find((candidate) => candidate.id === itemId) ?? null : null
        setItem(selected)
        if (itemId && !selected) throw new Error('目标条目不存在，无法开始专注。')

        const existing = (await api.listFocusSessions()).sessions.find(
          (candidate) => candidate.actualMinutes === null
            && (itemId === null
              ? candidate.itemId === null && candidate.projectId === null
              : candidate.itemId === itemId),
        )
        if (existing) {
          setSession(existing)
          setPhase('running')
          bridge.setPetStatus?.('focus')
          return
        }

        setPhase('starting')
        const result = await api.startFocus({
          plannedMinutes: requestedMinutes,
          itemId,
          idempotencyKey: `focus:${itemId ?? 'inbox'}:${requestedMinutes}`,
        })
        if (cancelled) return
        setSession(result.session)
        setPhase('running')
        bridge.setPetStatus?.('focus')
      } catch (cause) {
        if (cancelled) return
        setError(toMessage(cause))
        setPhase('error')
        bridge.setPetStatus?.('error', { message: toMessage(cause) })
      }
    }
    void resolve()
    return () => { cancelled = true }
  }, [itemId, requestedMinutes])

  useEffect(() => {
    if (phase !== 'running') return
    const timer = window.setInterval(() => setClock(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [phase])

  const elapsed = useMemo(() => {
    if (!session) return 0
    const started = Date.parse(session.startedAt)
    return Math.max(0, Math.floor((clock - started) / 60_000))
  }, [clock, session])
  const remaining = session ? Math.max(0, session.plannedMinutes - elapsed) : requestedMinutes

  async function finish(outcome: Outcome) {
    if (!session || phase === 'ending') return
    setPhase('ending')
    setError(null)
    try {
      const result = await api.endFocus(session.id, {
        outcome,
        actualMinutes: Math.max(0, elapsed),
      })
      setSummary({
        durationMinutes: result.summary.durationMinutes,
        outcome: result.summary.outcome,
      })
      setPhase('summary')
      bridge.setPetStatus?.(outcome === 'done' ? 'done' : 'idle')
    } catch (cause) {
      setError(toMessage(cause))
      setPhase('error')
      bridge.setPetStatus?.('error', { message: toMessage(cause) })
    }
  }

  if (phase === 'error') {
    return (
      <section className="focus-page" aria-labelledby="focus-title">
        <p className="eyebrow">专注</p>
        <h1 id="focus-title">暂时无法开始</h1>
        <p className="focus-error">{error}</p>
        <div className="focus-actions">
          <button type="button" className="primary" onClick={() => window.location.reload()}>再试一次</button>
          <button type="button" onClick={() => navigate('/now')}>返回此刻</button>
        </div>
      </section>
    )
  }

  if (phase === 'summary') {
    return (
      <section className="focus-page focus-summary" aria-labelledby="focus-title">
        <p className="eyebrow">专注结束</p>
        <h1 id="focus-title">这段时间记下了</h1>
        <p className="summary-time">{summary?.durationMinutes ?? elapsed} 分钟</p>
        <p className="summary-copy">
          {summary?.outcome === 'done' ? '已完成。' : '下次继续时，会从这里接上。'}
        </p>
        <div className="focus-actions">
          <button type="button" className="primary" onClick={() => navigate('/now')}>回到此刻</button>
          <button type="button" onClick={() => navigate('/recent')}>查看最近</button>
        </div>
      </section>
    )
  }

  return (
    <section className="focus-page" aria-labelledby="focus-title">
      <p className="eyebrow">专注中</p>
      <h1 id="focus-title">{item?.title ?? '这段时间，先只做一件事'}</h1>
      <p className="focus-subtitle">桌宠会安静地在这里。完成后只需要告诉我：完成，或下次继续。</p>
      <div className="focus-clock" aria-live="polite">
        <strong>{formatMinutes(remaining)}</strong>
        <span>剩余</span>
      </div>
      {error && <p className="focus-error">{error}</p>}
      <div className="focus-actions">
        <button type="button" className="primary" disabled={phase !== 'running'} onClick={() => void finish('done')}>
          完成
        </button>
        <button type="button" disabled={phase !== 'running'} onClick={() => void finish('continue')}>
          下次继续
        </button>
      </div>
      <p className="focus-meta">已专注 {formatMinutes(elapsed)} · 计划 {session?.plannedMinutes ?? requestedMinutes} 分钟</p>
    </section>
  )
}

function clampMinutes(value: number): number {
  if (!Number.isFinite(value)) return 25
  return Math.max(1, Math.min(24 * 60, Math.round(value)))
}

function formatMinutes(minutes: number): string {
  const safe = Math.max(0, Math.round(minutes))
  const hours = Math.floor(safe / 60)
  const rest = safe % 60
  return hours > 0 ? `${hours} 小时 ${String(rest).padStart(2, '0')} 分钟` : `${rest} 分钟`
}

function toMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
