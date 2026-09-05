import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Image, FileText, Mic, CalendarDays } from 'lucide-react'
import { api, queryKeys, type Drop } from '../../api.ts'
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
 * 四种收场各有各的话，并且都以「原文已存」结尾——只要用户相信东西没丢，
 * 失败就只是没理解。
 */
const OUTCOME: Record<Exclude<Drop['outcome'], 'ok'>, { text: string; retry: boolean }> = {
  empty: { text: '没找到需要记的东西。原文已存。', retry: false },
  over_steps: { text: '这条太复杂，没能处理完。原文已存。', retry: true },
  failed: { text: '没能理解这条。原文已存。', retry: true },
  offline: { text: '连不上模型。原文已存。', retry: true },
}

export function RecentPage() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: queryKeys.recent,
    queryFn: api.listRecent,
  })

  if (isLoading) return <Loading />
  if (error) return <ErrorState error={error} onRetry={() => refetch()} />

  const days = groupByDay(data?.drops ?? [])
  if (days.length === 0) return <Empty>还没有投放。</Empty>

  return (
    <>
      {days.map(([day, drops]) => (
        <section key={day} className="day">
          <h2 className="day-label">{formatDayLabel(day)}</h2>
          <DropList drops={drops} />
        </section>
      ))}
    </>
  )
}

function DropList({ drops }: { drops: Drop[] }) {
  return (
    <ul className="drops">
      {drops.map(({ fragment, items, outcome }) => (
        <li key={fragment.id} className="drop">
          <div className="drop-head">
            <span className="stamp">{formatTime(fragment.createdAt)}</span>
            <SourceIcon rawType={fragment.rawType} />
            <span className="drop-raw">{summarise(fragment.rawText, fragment.rawType)}</span>
          </div>

          {outcome === 'ok' ? (
            <ul className="drop-out">
              {items.map((item) => (
                <li key={item.id}>
                  <Link to={`/items/${item.id}`}>{item.title}</Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="drop-note">
              {OUTCOME[outcome].text}
              {OUTCOME[outcome].retry && <button className="quiet">重试</button>}
            </p>
          )}
        </li>
      ))}
    </ul>
  )
}

/** 按天分组：不分组的话，昨晚那条看起来和今天的一样。 */
function groupByDay(drops: Drop[]): [string, Drop[]][] {
  const byDay = new Map<string, Drop[]>()

  for (const drop of drops) {
    const day = drop.fragment.createdAt.slice(0, 10)
    const bucket = byDay.get(day)
    if (bucket) bucket.push(drop)
    else byDay.set(day, [drop])
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
