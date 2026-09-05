import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Image, FileText, Mic, CalendarDays } from 'lucide-react'
import { api, queryKeys, type RecentEntry } from '../../api.ts'
import { ICON } from '../../tokens/icons.ts'
import { DayLabel } from '../../shell/DayLabel.tsx'
import { Empty, ErrorState, Loading } from '../../shell/State.tsx'
import { formatTime } from '../../lib/format.ts'
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

  const days = groupByDay(data?.recent ?? [])

  return (
    <>
      {isLoading && <Loading />}
      {error && <ErrorState error={error} onRetry={() => refetch()} />}
      {!isLoading && !error && days.length === 0 && <Empty>还没有记录。</Empty>}

      {days.map(([day, entries]) => (
        <section key={day} className="day">
          <DayLabel day={day} />
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
        <span className="drop-raw">{oneLine(fragment.rawText, fragment.rawType)}</span>
      </div>

      <div className="drop-body">
        {items.length > 0 && (
          <ul className="plain-list">
            {items.map((item) => (
              <li key={item.id}>
                <Link className="row" to={`/items/${item.id}`}>
                  <span className="row-title">{item.title}</span>
                  {item.status === 'needs_confirm' && <span className="row-meta">待确认</span>}
                </Link>
              </li>
            ))}
          </ul>
        )}

        {/*
          零条与失败都要说话：没有落点的投放，看起来和「坏了」一模一样。
          失败这里没有「重试」——服务端没有重跑某条碎片的口，摆一个按不动的
          按钮比不摆更糟。原文已经存住了，重投一次就是。
        */}
        {items.length === 0 && run?.message && (
          <p className={failed ? 'drop-note drop-failed' : 'drop-note'}>{run.message}</p>
        )}
      </div>
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

/**
 * 投放进来的东西，压成一行。
 *
 * 换行符换成空格，超出的部分由 CSS 截断——按字数截会在窗口宽的时候留下一截
 * 空白，按宽度截才总是正好一行。
 */
function oneLine(rawText: string | null, rawType: string): string {
  const text = rawText?.replace(/\s+/g, ' ').trim()
  if (text) return text
  if (rawType === 'image') return '一张图片'
  if (rawType === 'audio') return '一段语音'
  if (rawType === 'structured') return '一次同步'
  return '一份文件'
}
