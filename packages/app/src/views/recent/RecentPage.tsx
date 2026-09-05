import { useQuery } from '@tanstack/react-query'
import { Image, FileText, Mic, CalendarDays } from 'lucide-react'
import { api, queryKeys, type RecentEntry } from '../../api.ts'
import { ICON } from '../../tokens/icons.ts'
import { DayLabel } from '../../shell/DayLabel.tsx'
import { ItemRow } from '../../shell/ItemRow.tsx'
import { Markup } from '../../shell/Markup.tsx'
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
            {/*
              产出的条目用全 App 那一行。待确认的行尾说「待确认」，其余交给它自己
              按日期显示——这一页原来什么都不显示，那是少给了一条已经知道的信息。
            */}
            {items.map((item) => (
              <ItemRow
                key={item.id}
                item={item}
                meta={item.status === 'needs_confirm' ? '待确认' : undefined}
              />
            ))}
          </ul>
        )}

        {/*
          零条与失败都要说话：没有落点的投放，看起来和「坏了」一模一样。
          失败这里没有「重试」——服务端没有重跑某条碎片的口，摆一个按不动的
          按钮比不摆更糟。原文已经存住了，重投一次就是。
        */}
        {items.length === 0 && run?.message && (failed
          ? <p className="drop-note drop-failed">{run.message}</p>
          /*
            零条目的另一半是「他问的不是新东西，是库里已有的事」——那条回答就住在
            这里，而它带标记。当成纯文字显示的话，屏幕上留下的是一串裸 id。
          */
          : <div className="drop-note"><Markup text={run.message} /></div>
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

/*
 * 投放的形态。原文有字的时候，这个图标是「它是图还是语音」的唯一出处，所以它
 * 不是装饰——读屏器要念得出来。
 */
function SourceIcon({ rawType }: { rawType: string }) {
  const props = {
    size: ICON.sizeSmall, strokeWidth: ICON.stroke, className: 'drop-icon', role: 'img',
  }
  if (rawType === 'image') return <Image {...props} aria-label="图片" />
  if (rawType === 'audio') return <Mic {...props} aria-label="语音" />
  if (rawType === 'structured') return <CalendarDays {...props} aria-label="同步" />
  return <FileText {...props} aria-label="文字" />
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
