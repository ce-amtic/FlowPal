import { useQuery } from '@tanstack/react-query'
import { api } from '../../api.ts'
import { Empty, ErrorState, Loading } from '../../shell/State.tsx'

/**
 * 最近——倒序显示每一次投放，以及它产出了什么。
 *
 * 它存在的理由是：每一次投放需要一个看得见的落点。产出的条目会散进日程或
 * 某个项目，用户得自己去找；零条目与失败的碎片则连找都找不到，而那和「坏了」
 * 长得一模一样。
 *
 * 每条投放的产出与四种失败的话术随最近页那一步补上，届时接的是带产出的接口。
 */
export function RecentPage() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['fragments'],
    queryFn: () => api.listFragments(),
  })

  if (isLoading) return <Page><Loading /></Page>
  if (error) return <Page><ErrorState error={error} onRetry={() => refetch()} /></Page>

  const fragments = data?.fragments ?? []
  if (fragments.length === 0) return <Page><Empty>还没有投放。</Empty></Page>

  return (
    <Page>
      <ul className="plain-list">
        {fragments.map((f) => (
          <li key={f.id}>
            <span className="stamp">{f.createdAt.slice(11, 16)}</span>
            <span>{f.rawText ?? sourceLabel(f.rawType)}</span>
          </li>
        ))}
      </ul>
    </Page>
  )
}

function sourceLabel(rawType: string): string {
  return rawType === 'image' ? '一张图片' : rawType === 'audio' ? '一段语音' : '一份文件'
}

function Page({ children }: { children: React.ReactNode }) {
  return (
    <>
      <h1 className="page-title">最近</h1>
      {children}
    </>
  )
}
