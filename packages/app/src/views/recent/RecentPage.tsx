import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Image, FileText, Mic, CalendarDays } from 'lucide-react'
import { api, queryKeys, type RecentEntry } from '../../api.ts'
import { ICON } from '../../tokens/icons.ts'
import { Empty, ErrorState, Loading } from '../../shell/State.tsx'
import { formatDayLabel, formatTime } from '../../lib/format.ts'
import './recent.css'

/**
 * 最近——倒序显示每一次投放，以及它产出了什么。
 *
 * 它存在的理由是：每一次投放需要一个看得见的落点。产出的条目会散进日程或
 * 某个项目，用户得自己去找；零条目与失败的碎片则连找都找不到，而那和「坏了」
 * 长得一模一样。
 *
 * 回执那句话由语义层给（四种收场各有各的说法，都以「原文已存」结尾），这里
 * 不自己编——同一件事在气泡和这一页上必须是同一句。
 */
export function RecentPage() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: queryKeys.recent,
    queryFn: api.listRecent,
  })

  if (isLoading) return <Loading />
  if (error) return <ErrorState error={error} onRetry={() => refetch()} />

  const days = groupByDay(data?.recent ?? [])
  if (days.length === 0) return <Empty>还没有投放。</Empty>

  return (
    <>
      {days.map(([day, entries]) => (
        <section key={day} className="day">
          <h2 className="day-label">{formatDayLabel(day)}</h2>
          <ul className="drops">
            {entries.map((entry) => <Drop key={entry.fragment.id} entry={entry} />)}
          </ul>
        </section>
      ))}
    </>
  )
}

function Drop({ entry: { fragment, run, items } }: { entry: RecentEntry }) {
  const failed = run?.status === 'failed' || run?.status === 'limit'

  return (
    <li className="drop">
      <div className="drop-head">
        <span className="stamp">{formatTime(fragment.createdAt)}</span>
        <SourceIcon rawType={fragment.rawType} />
        <span className="drop-raw">{summarise(fragment.rawText, fragment.rawType)}</span>
      </div>

      {items.length > 0 && (
        <ul className="drop-out">
          {items.map((item) => (
            <li key={item.id}>
              <Link to={`/items/${item.id}`}>{item.title}</Link>
            </li>
          ))}
        </ul>
      )}

      {items.length === 0 && run?.message && (
        <p className="drop-note">
          {run.message}
          {failed && <button className="quiet">重试</button>}
        </p>
      )}
    </li>
  )
}

/** 按天分组：不分组的话，昨晚那条看起来和今天的一样。 */
function groupByDay(entries: RecentEntry[]): [string, RecentEntry[]][] {
  const byDay = new Map<string, RecentEntry[]>()

  for (const entry of entries) {
    const day = entry.fragment.createdAt.slice(0, 10)
    const bucket = byDay.get(day)
    if (bucket) bucket.push(entry)
    else byDay.set(day, [entry])
  }

  for (const bucket of byDay.values()) {
    bucket.sort((a, b) => b.fragment.createdAt.localeCompare(a.fragment.createdAt))
  }

  return [...byDay.entries()].sort((a, b) => b[0].localeCompare(a[0]))
}

function SourceIcon({ rawType }: { rawType: string }) {
  const props = { size: ICON.sizeSmall, strokeWidth: ICON.stroke, className: 'drop-icon' }
  if (rawType === 'image') return <Image {...props} />
  if (rawType === 'audio') return <Mic {...props} />
  if (rawType === 'structured') return <CalendarDays {...props} />
  return <FileText {...props} />
}

function summarise(rawText: string | null, rawType: string): string {
  if (rawText) return rawText.length > 42 ? `${rawText.slice(0, 42)}…` : rawText
  if (rawType === 'image') return '一张图片'
  if (rawType === 'audio') return '一段语音'
  if (rawType === 'structured') return '一次同步'
  return '一份文件'
}
