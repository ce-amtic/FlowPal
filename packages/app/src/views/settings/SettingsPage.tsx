import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, queryKeys } from '../../api.ts'
import { ErrorState, Loading } from '../../shell/State.tsx'
import { ChronotypeGroup } from './ChronotypeGroup.tsx'
import { PortalGroup } from './PortalGroup.tsx'
import { MailGroup } from './MailGroup.tsx'
import './settings.css'

/**
 * 设置。
 *
 * 分组走左侧导航而不是一路平铺：邮箱可以有好几个，每个还能展开成一张表单，平铺
 * 之后这一页会长到要滚很久，而用户来这里通常只为改一件事。
 *
 * 三组之外不放别的。模型配置在 config.local.json 里、运行中改不了，摆一行点不动
 * 的出来只会让人以为它坏了。
 */
type GroupId = 'chronotype' | 'portal' | 'mail'

const GROUPS: { id: GroupId; label: string }[] = [
  { id: 'chronotype', label: '作息' },
  { id: 'portal', label: '人大门户' },
  { id: 'mail', label: '邮箱' },
]

export function SettingsPage() {
  const [picked, setPicked] = useState<GroupId>('chronotype')

  // 导航上的那一行小字（「已登录」「2 个邮箱」）跟内容用同一份数据，所以在这里取。
  const sync = useQuery({ queryKey: queryKeys.sync, queryFn: api.getSyncStatus })
  const mail = useQuery({ queryKey: queryKeys.mailAccounts, queryFn: api.listMailAccounts })

  const hint = (id: GroupId): string => {
    if (id === 'portal') return sync.data === undefined ? '' : sync.data.signedIn ? '已登录' : '未登录'
    if (id === 'mail') {
      const accounts = mail.data?.accounts ?? []
      if (accounts.length === 0) return '未添加'
      const locked = accounts.filter((a) => !a.unlocked).length
      return locked > 0 ? `${locked} 个待解锁` : `${accounts.length} 个`
    }
    return ''
  }

  return (
    <>
      <h1 className="page-title">设置</h1>

      <div className="settings">
        <nav className="settings-nav">
          {GROUPS.map((group) => (
            <button
              key={group.id}
              className={group.id === picked ? 'settings-tab picked' : 'settings-tab'}
              onClick={() => setPicked(group.id)}
            >
              <span>{group.label}</span>
              <span className="settings-tab-hint">{hint(group.id)}</span>
            </button>
          ))}
        </nav>

        <div className="settings-pane">
          {picked === 'chronotype' && <ChronotypeGroup />}
          {picked === 'portal' && (
            sync.isLoading ? <Loading />
              : sync.error ? <ErrorState error={sync.error} onRetry={() => void sync.refetch()} />
                : sync.data ? <PortalGroup status={sync.data} /> : null
          )}
          {picked === 'mail' && (
            mail.isLoading ? <Loading />
              : mail.error ? <ErrorState error={mail.error} onRetry={() => void mail.refetch()} />
                : <MailGroup accounts={mail.data?.accounts ?? []} />
          )}
        </div>
      </div>
    </>
  )
}
