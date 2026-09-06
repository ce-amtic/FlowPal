import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api, type SyncStatus } from '../../api.ts'
import { bridge } from '../../bridge.ts'
import { formatDay, formatTime } from '../../lib/format.ts'
import { ErrorState } from '../../shell/State.tsx'

/**
 * 人大门户：登录一次，之后课表、校历、通知自己进来。
 *
 * 这一段在设置页而不在别处，是因为同步**失败时不重试也不弹东西**。一个没人被
 * 告知的失败，必须有一个用户想得起来去看的地方。
 */
export function PortalGroup({ status }: { status: SyncStatus }) {
  const queryClient = useQueryClient()

  const signIn = useMutation({
    mutationFn: async () => {
      const result = await bridge.signInToRuc()
      if (!result.ok) throw new Error(result.message)
      return result
    },
    onSuccess: () => queryClient.invalidateQueries(),
  })

  const sync = useMutation({
    mutationFn: api.syncNow,
    onSuccess: () => queryClient.invalidateQueries(),
  })

  const signOut = useMutation({
    mutationFn: api.signOutOfRuc,
    onSuccess: () => queryClient.invalidateQueries(),
  })

  const busy = signIn.isPending || sync.isPending || signOut.isPending

  return (
    <>
      <p className="settings-note">
        登录一次学校门户，课表、校历与通知就会自己进来，之后每几小时对一次。
      </p>

      {/*
        一轮同步要按周打十几次门户，几十秒才回来。不说这一句的话，那几十秒里
        页面上什么都不动，与坏掉了长得一样。
      */}
      <p className="settings-status">
        {busy ? (signIn.isPending ? '登录窗口已经打开，在那里完成登录。' : '正在对课表与校历，要几十秒。')
          : describe(status)}
      </p>

      <div className="choices">
        <button className="choice" disabled={busy} onClick={() => signIn.mutate()}>
          {status.signedIn ? '重新登录' : '登录人大门户'}
        </button>
        {status.signedIn && (
          <>
            <button className="choice" disabled={busy} onClick={() => sync.mutate()}>现在同步</button>
            <button className="choice" disabled={busy} onClick={() => signOut.mutate()}>退出登录</button>
          </>
        )}
      </div>

      {/*
        逐条列出来，因为各路会因为不同的原因停下：某个邮箱没解锁、通知配额没开、
        门户登录态过期。只报一句总的「同步失败」，用户查不出该动哪一处。
      */}
      {status.sources.length > 0 && (
        <ul className="settings-sources">
          {status.sources.map((source) => (
            <li key={source.label}>
              <span>{source.label}</span>
              {/* 没开的那一路弱化，坏了的那一路不弱化——一个不用管，一个要管 */}
              <span className={source.state === 'idle' ? 'settings-source-idle' : ''}>
                {source.note ?? `新增 ${source.created} · 更新 ${source.updated}`}
              </span>
            </li>
          ))}
        </ul>
      )}

      {signIn.error && <ErrorState error={signIn.error} />}
      {sync.error && <ErrorState error={sync.error} />}
      {signOut.error && <ErrorState error={signOut.error} />}
    </>
  )
}

/**
 * 一行状态。
 *
 * 「还没登录」与「登录过但过期了」要分开说：前者是用户还没做过这件事，后者是他做过
 * 而它失效了——两句话之后要按的按钮不一样，合成一句「未登录」就把这个区别丢了。
 */
function describe(status: SyncStatus): string {
  const when = status.at === null ? null : `${formatDay(status.at)} ${formatTime(status.at)}`

  switch (status.state) {
    case 'never':
      return status.signedIn ? '已登录，还没有同步过。' : '还没有登录。'
    case 'expired':
      return status.signedIn ? `上次同步 ${when} · 登录已过期，重新登录一次即可。` : '还没有登录。'
    case 'error':
      return `上次同步 ${when} · ${status.message ?? '没能完成'}`
    case 'ok':
      return `上次同步 ${when} · ${status.message ?? ''}`
  }
}
