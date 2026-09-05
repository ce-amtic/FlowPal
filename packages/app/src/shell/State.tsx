/**
 * 载入、出错、空——五页共用这三个。
 *
 * 空态由每一页自己给文案：用户看到的每个状态都必须是被设计过的，
 * 空白页不算被设计过。
 */
export function Loading({ label = '载入中' }: { label?: string }) {
  return <p className="state">{label}</p>
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="state state-empty">{children}</p>
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="state-error">
      <div>加载失败。</div>
      <pre>{error instanceof Error ? error.message : String(error)}</pre>
      {onRetry && <button onClick={onRetry}>重试</button>}
    </div>
  )
}
