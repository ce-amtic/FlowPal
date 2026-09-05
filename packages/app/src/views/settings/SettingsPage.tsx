import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, queryKeys, type Settings, type SyncStatus } from '../../api.ts'
import { bridge } from '../../bridge.ts'
import { CHRONOTYPE } from '../../lib/chronotype.ts'
import { formatDay, formatTime } from '../../lib/format.ts'
import { ErrorState, Loading } from '../../shell/State.tsx'
import './settings.css'

/**
 * 设置。
 *
 * 只放真的能改的东西。作息两问在首次启动时问过一次，之后就只有这里能改；改完会让
 * 「此刻」重新判断，它算处境时读的正是这两个答案。
 *
 * 另一半是外部来源：登录一次学校门户，之后课表、校历、通知自己进来。这一段在这里
 * 而不在别处，是因为同步**失败时不重试也不弹东西**，那它就必须有一个用户想起来
 * 会去看的地方。
 */
export function SettingsPage() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: queryKeys.settings,
    queryFn: api.getSettings,
  })
  const queryClient = useQueryClient()

  const save = useMutation({
    mutationFn: (patch: Partial<Record<keyof Settings, string>>) => api.patchSettings(patch),
    onSuccess: () => queryClient.invalidateQueries(),
  })

  return (
    <>
      <h1 className="page-title">设置</h1>

      {isLoading && <Loading />}
      {error && <ErrorState error={error} onRetry={() => refetch()} />}

      {data && (
        <section className="group">
          <h2 className="group-label">作息</h2>
          {/*
            说它拿去做什么，不说它怎么算。用户要判断的是「值不值得答」，
            而不是我们内部怎么用这两个数。
          */}
          <p className="settings-note">用来估你一天里精力在哪个位置。</p>

          {[CHRONOTYPE.workday, CHRONOTYPE.restday].map((q) => (
            <div className="settings-field" key={q.key}>
              <p className="settings-question">{q.question}</p>
              <div className="choices">
                {q.options.map((option) => (
                  <button
                    key={option}
                    className={data.settings[q.key] === option ? 'choice picked' : 'choice'}
                    disabled={save.isPending}
                    onClick={() => save.mutate({ [q.key]: option })}
                  >
                    {option}
                  </button>
                ))}
              </div>
            </div>
          ))}

          {/*
            差值才是有用的那个信号：差得越多，说明平时越是被闹钟叫醒的。
            这句话不写在界面上——它是我们怎么用，不是用户要读的。
          */}
          <p className="settings-note">
            {save.isPending ? '正在记下' : '这两个时间之间的差别，比它们各自是几点更有用。'}
          </p>
          {save.error && <ErrorState error={save.error} />}
        </section>
      )}

      <SyncSection />
    </>
  )
}

function SyncSection() {
  const queryClient = useQueryClient()
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: queryKeys.sync,
    queryFn: api.getSyncStatus,
  })

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
    <section className="group">
      <h2 className="group-label">外部来源</h2>
      {/*
        说它会拿到什么，不说它怎么拿。用户要判断的是「值不值得登录」。
      */}
      <p className="settings-note">
        登录一次学校门户，课表、校历与通知就会自己进来，之后每几小时对一次。
      </p>

      {isLoading && <Loading />}
      {error && <ErrorState error={error} onRetry={() => refetch()} />}

      {data && (
        <>
          <p className="settings-status">{describe(data)}</p>

          <div className="choices">
            <button className="choice" disabled={busy} onClick={() => signIn.mutate()}>
              {data.signedIn ? '重新登录' : '登录人大门户'}
            </button>
            {data.signedIn && (
              <button className="choice" disabled={busy} onClick={() => sync.mutate()}>
                现在同步
              </button>
            )}
            {data.signedIn && (
              <button className="choice" disabled={busy} onClick={() => signOut.mutate()}>
                退出登录
              </button>
            )}
          </div>

          {/*
            逐条列出来，因为三路来源各自会因为不同的原因停下：邮件没配、通知配额
            用完、门户登录态过期。只报一句总的「同步失败」，用户查不出该动哪一处。
          */}
          {data.sources.length > 0 && (
            <ul className="settings-sources">
              {data.sources.map((source) => (
                <li key={source.label}>
                  <span>{source.label}</span>
                  <span className={source.skipped === null ? '' : 'settings-source-idle'}>
                    {source.skipped ?? `新增 ${source.created} · 更新 ${source.updated}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {signIn.error && <ErrorState error={signIn.error} />}
      {sync.error && <ErrorState error={sync.error} />}
      {signOut.error && <ErrorState error={signOut.error} />}
    </section>
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
