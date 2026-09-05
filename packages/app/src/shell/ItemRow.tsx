import { Link } from 'react-router-dom'
import { Activity, CalendarDays, Circle, CircleCheck, Flag, Lightbulb } from 'lucide-react'
import type { Item } from '../api.ts'
import { ICON } from '../tokens/icons.ts'
import { daysBetween, formatAt, formatDue } from '../lib/format.ts'

/**
 * 一条事，全 App 共用的那一行。
 *
 * 左边的图标不是装饰：五类条目在这里第一眼就分得开，而且它给了每一行一个左端的
 * 锚点——原来一行是「文字……大片空白……文字」，读起来就是没排过。
 *
 * 临近的截止用强调色，不用红色。红色留给出错。一件明天要交的事本身不是错误，
 * 把它标红就是在催——而这个产品说好不催。
 */
const ICONS = {
  event: CalendarDays,
  task: Circle,
  thought: Lightbulb,
  progress: Flag,
  state: Activity,
} as const

/** 还剩几天算「紧」。和「接下来」那个七天窗口不是一回事：那个是列多远，这个是标多急 */
const SOON_DAYS = 2

export function ItemRow({ item, note, meta }: {
  item: Item
  /** 挂在标题下面的一句补充 */
  note?: string
  /** 行尾要显示的东西。不给就按这条自己的日期算 */
  meta?: React.ReactNode
}) {
  const Icon = item.status === 'done' ? CircleCheck : ICONS[item.type] ?? Circle
  const at = item.dueAt ?? item.startsAt
  const left = at ? daysBetween(new Date(), new Date(at)) : null

  return (
    <li className="item-row">
      <Link className="row" to={`/items/${item.id}`}>
        <Icon className="row-icon" size={ICON.size} strokeWidth={ICON.stroke} aria-hidden />
        <span className="row-title">{item.title}</span>
        <span className="row-meta" data-soon={left !== null && left <= SOON_DAYS ? '' : undefined}>
          {meta ?? (item.dueAt
            ? formatDue(item.dueAt)
            : item.startsAt ? formatAt(item.startsAt, item.datePrecision) : '')}
        </span>
      </Link>
      {note && <p className="row-note">{note}</p>}
    </li>
  )
}
