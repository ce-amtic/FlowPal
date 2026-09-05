import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, queryKeys, type Settings } from '../../api.ts'
import { CHRONOTYPE } from '../../lib/chronotype.ts'
import { ErrorState, Loading } from '../../shell/State.tsx'
import './settings.css'

/**
 * 设置。
 *
 * 只放真的能改的东西。教务凭据、校历、同步状态那几项归桌面侧那条线，它们还没接进来——
 * 与其摆一排点不动的行，不如让这一页只有它现在真有的内容。
 *
 * 作息两问在首次启动时问过一次，之后就只有这里能改。改完会让「此刻」重新判断：
 * 它算处境时读的正是这两个答案。
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
    </>
  )
}
