import { Fragment } from 'react'
import { Link, useNavigate, type NavigateFunction } from 'react-router-dom'
import {
  useMutation, useQuery, useQueryClient, type UseMutationResult,
} from '@tanstack/react-query'
import {
  markupSpec, parseMarkup,
  type MarkupBlock, type MarkupContainerTag, type MarkupElement, type MarkupTag,
} from '@flowpal/shared'
import { api, queryKeys, type ItemWithSources, type ProjectCard } from '../api.ts'
import { formatDay } from '../lib/format.ts'
import { DayLabel } from './DayLabel.tsx'
import { ItemRow } from './ItemRow.tsx'
// 项目在这里长成项目页上那一行的样子。那套规则住在那个文件里，不在这儿重写一份
import '../views/projects/projects.css'
import './markup.css'

/**
 * 模型说的话，就地渲染成东西。
 *
 * 话里标出来的每一条，标题、日期、状态都从库里查——模型只给了 id 和它自己那一句
 * 判断，所以它没有机会把日期写错：它根本不写日期。
 *
 * 兜底一律偏向「多显示」：不认识的标签在解析那一层就成了普通文字，这里再兜一层
 * 查不到的 id，只丢那一个元素。宁可多出一行没渲染的字，也不能因为一个标签写错
 * 就让整条回复空白。
 */
export function Markup({ text }: { text: string }) {
  const blocks = parseMarkup(text)
  const navigate = useNavigate()

  // 引用的条目从这里查。这份清单别处也在用，通常已经在缓存里
  const { data } = useQuery({ queryKey: queryKeys.items, queryFn: api.listItems })

  // 项目那张表只在这段话真的提到项目时才取——大多数回复不提，不必为它多打一次
  const { data: projectData } = useQuery({
    queryKey: queryKeys.projects,
    queryFn: api.listProjects,
    enabled: usesProjects(blocks),
  })

  // 收下 / 丢掉，和待确认浮层里那两个按钮同一次调用
  const queryClient = useQueryClient()
  const decide = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'active' | 'dropped' }) =>
      api.patchItem(id, { status }),
    onSuccess: () => queryClient.invalidateQueries(),
  })

  const ctx: Ctx = {
    items: lookup(data?.items ?? [], (i) => i.id),
    projects: lookup(projectData?.projects ?? [], (c) => c.project.id),
    navigate,
    decide,
    byDay: false,
  }

  return <div className="markup">{blocks.map((b, i) => renderBlock(b, i, ctx))}</div>
}

/** 渲染一路带下去的东西。库里查出来的事实，以及几处由上下文决定的开关 */
type Ctx = {
  items: (id: string) => ItemWithSources | undefined
  projects: (id: string) => ProjectCard | undefined
  navigate: NavigateFunction
  decide: Decide
  /** 在 `:::days` 里：条目按天排开、长出日期头。同一段 `::item`，容器变了它就变 */
  byDay: boolean
}

/** 前缀至少这么长才认。「itm_」加四位十六进制，在一个人的库里撞不上 */
const MIN_PREFIX = 8

/**
 * 按 id 取一行。先精确匹配，匹配不上再按前缀。
 *
 * 提示词要求原样照抄 id，但模型列到第七条时会开始抄短（`itm_92a41`）。那一条查不到
 * 就整个不画，一次列七条的回答于是只剩标题和一片空白——最难看、也最像坏了的一种收场。
 *
 * 前缀唯一才认，撞上两条就当没有：认错一条比不认更误导。这跟短 SHA 是同一回事，
 * 不是猜。
 */
function lookup<T>(rows: T[], idOf: (row: T) => string): (id: string) => T | undefined {
  const exact = new Map(rows.map((r) => [idOf(r), r]))
  return (id) => {
    const hit = exact.get(id)
    if (hit) return hit
    if (id.length < MIN_PREFIX) return undefined
    const matches = rows.filter((r) => idOf(r).startsWith(id))
    return matches.length === 1 ? matches[0] : undefined
  }
}

type Decide = UseMutationResult<
  { item: ItemWithSources }, Error, { id: string; status: 'active' | 'dropped' }
>


/**
 * 每个标签怎么画。
 *
 * 写成 `Record<MarkupTag, …>` 而不是一串 if：元素表里加了标签却忘了在这里画，
 * 编译就不过。这套东西的意义正在于提示词教的标签和应用会画的标签是同一份，
 * 而漏一个的症状是「回复看着正常，只是那一行变成纯文字」，没有任何地方会报错。
 *
 * 收的是一整组而不是单个元素：连着的同类在解析那一层已经并好，成组之后怎么排
 * 是各个标签自己的事——一组条目是一列，一组动作是一排。
 */
const RUNS: Record<MarkupTag, (els: MarkupElement[], ctx: Ctx) => React.ReactNode> = {
  item: renderItems,
  quote: renderLooseQuotes,
  start: renderStarts,
  project: renderProjects,
  confirm: renderConfirms,
  stat: renderStats,
}

const GROUPS: Record<
  MarkupContainerTag,
  (blocks: MarkupBlock[], ctx: Ctx) => React.ReactNode
> = {
  list: (blocks, ctx) => blocks.map((b, i) => renderBlock(b, i, ctx)),
  // 日期头由容器长出来，元素本身不变：同一段 `::item` 换个容器就换个排法
  days: (blocks, ctx) => blocks.map((b, i) => renderBlock(b, i, { ...ctx, byDay: true })),
}

function renderBlock(block: MarkupBlock, key: number, ctx: Ctx): React.ReactNode {
  if (block.kind === 'text') {
    return (
      <p className="markup-text" key={key}>
        {block.spans.map((span, i) =>
          span.kind === 'text' ? span.text : renderRef(span.tag, span.subject, ctx, i))}
      </p>
    )
  }

  if (block.kind === 'group') {
    return (
      <section className="markup-group" key={key}>
        {block.title && <h3 className="group-label">{block.title}</h3>}
        {GROUPS[block.tag](block.blocks, ctx)}
      </section>
    )
  }

  // 一组占一块。.markup-run 挂在这层，紧跟一段话时贴着它的那条间距才认得出来
  return <div className="markup-run" key={key}>{RUNS[block.tag](block.items, ctx)}</div>
}

/**
 * 句子中间提到的那一条：一枚贴着文字的小标签。
 *
 * 拿这个 id 去哪张表里查，由标签的主语类型决定，不由标签本身决定——照着标签逐个
 * 写的话，新加一个指向项目的标签就会悄悄去条目表里查、查不到、什么都不显示。
 */
function renderRef(tag: MarkupTag, subject: string, ctx: Ctx, key: number): React.ReactNode {
  const kind = markupSpec(tag).subject

  if (kind === 'item') {
    const item = ctx.items(subject)
    // 查不到就整段不提它。这里最不能出的是屏幕上留一个光秃秃的 id
    if (!item) return null
    return <Link className="markup-ref" to={`/items/${item.id}`} key={key}>{item.title}</Link>
  }

  if (kind === 'project') {
    const card = ctx.projects(subject)
    if (!card) return null
    return (
      <Link className="markup-ref" to={`/projects/${card.project.id}`} key={key}>
        {card.project.name}
      </Link>
    )
  }

  return null
}

/** 一组条目。`:::days` 里按天排开，在外面就是平铺的一列 */
function renderItems(els: MarkupElement[], ctx: Ctx): React.ReactNode {
  const rows = resolveItems(els, ctx)
  if (rows.length === 0) return null

  if (!ctx.byDay) return <ul className="plain-list">{rows.map(renderRow)}</ul>

  return groupByDay(rows).map(([day, group], i) => (
    <section className="markup-day" key={i}>
      {/* 没有日期的那一堆排在最后，不安一个假的日期头 */}
      {day && <DayLabel day={day} />}
      <ul className="plain-list">{group.map(renderRow)}</ul>
    </section>
  ))
}

/**
 * 没挂上的 `::quote`：id 和上一行对不上，或者压根没有上一行。
 *
 * 照样连着那一条画出来——一句没有出处的原文比不显示更让人费解，而这里的规矩是
 * 宁可多显示。
 */
function renderLooseQuotes(els: MarkupElement[], ctx: Ctx): React.ReactNode {
  const rows: Row[] = []
  for (const el of els) {
    const item = el.subject ? ctx.items(el.subject) : undefined
    if (item) rows.push({ el, item, quotes: [el] })
  }
  if (rows.length === 0) return null
  return <ul className="plain-list">{rows.map(renderRow)}</ul>
}

/**
 * 可以立刻动手的那一步。
 *
 * 带去专注页的是这里写着的那一句，不是条目标题——「此刻」那张卡也是这么传的，
 * 到了专注屏上还写着原来那句的话，这一下就白按了。模型没给正文时才退回标题。
 */
function renderStarts(els: MarkupElement[], ctx: Ctx): React.ReactNode {
  const rows = resolveItems(els, ctx)
  if (rows.length === 0) return null

  return rows.map(({ el, item }, i) => {
    const step = el.body || item.title
    return (
      <div className="markup-start" key={i}>
        <span className="markup-step">{step}</span>
        <button
          className="markup-go"
          onClick={() => ctx.navigate('/focus', {
            state: { focus: { itemId: item.id, title: item.title, step } },
          })}
        >
          开始
        </button>
      </div>
    )
  })
}

/**
 * 待确认的那一条，就地处理掉。
 *
 * 收下与丢掉写的是条目状态，和待确认浮层里那两个按钮是同一次调用——同一件事只有
 * 一种做法，改了那边这边不会变成另一套。
 *
 * 已经定下来的条目不摆按钮：按过之后清单会重取，那一条还在这段话里，但它已经不是
 * 待确认了，再摆着两个按钮就是让人对一件已经处理完的事再选一次。
 */
function renderConfirms(els: MarkupElement[], ctx: Ctx): React.ReactNode {
  const rows = resolveItems(els, ctx)
  if (rows.length === 0) return null

  return (
    <ul className="plain-list">
      {rows.map(({ el, item }, i) => {
        if (item.status !== 'needs_confirm') {
          return <ItemRow item={item} note={el.body} key={i} />
        }
        return (
          <li className="confirm-row" key={i}>
            <div>
              <Link to={`/items/${item.id}`}>{item.title}</Link>
              {el.body && <p className="confirm-why">{el.body}</p>}
            </div>
            <div className="confirm-actions">
              <button
                className="quiet"
                disabled={ctx.decide.isPending}
                onClick={() => ctx.decide.mutate({ id: item.id, status: 'active' })}
              >
                收下
              </button>
              <button
                className="quiet"
                disabled={ctx.decide.isPending}
                onClick={() => ctx.decide.mutate({ id: item.id, status: 'dropped' })}
              >
                丢掉
              </button>
            </div>
          </li>
        )
      })}
    </ul>
  )
}

/**
 * 一组项目，长成项目页上那一行的样子。
 *
 * 那一页刻意不做成卡片，也刻意不摆进度条——「多久没动」才是项目这一层要说的话。
 * 这里照搬那套，不另立一种项目的样子。
 */
function renderProjects(els: MarkupElement[], ctx: Ctx): React.ReactNode {
  const cards = resolveProjects(els, ctx)
  if (cards.length === 0) return null

  return cards.map(({ el, card }, i) => (
    <Link className="markup-project" to={`/projects/${card.project.id}`} key={i}>
      <span className="project-head">
        <span className="project-name">{card.project.name}</span>
        <span className="idle">{idleLabel(card.idleDays)}</span>
      </span>

      {card.next.length > 0 && (
        <span className="project-next">
          {card.next.map((n) => (
            <span key={n.id}>
              <span className="stamp">{formatDay(n.at)}</span>
              {n.title}
            </span>
          ))}
        </span>
      )}

      {/* 模型那句判断占状态说明的位置：这段话里它比库里存的那句更贴题 */}
      {el.body && <span className="project-note">{el.body}</span>}
    </Link>
  ))
}

/**
 * 一个算出来的数。
 *
 * 模型只点名指标，数由这里算——它最容易在数字上出错，所以干脆不给它写数字的位置。
 *
 * 点名了一个不认识的指标，或者那个数刚好没有（项目今天刚动过），项目本身照样显示。
 * 一个被点名的元素整个消失，正是这套东西要防的那种症状。
 */
function renderStats(els: MarkupElement[], ctx: Ctx): React.ReactNode {
  const cards = resolveProjects(els, ctx)
  if (cards.length === 0) return null

  return cards.map(({ el, card }, i) => (
    <p className="markup-stat" key={i}>
      <Link className="markup-ref" to={`/projects/${card.project.id}`}>{card.project.name}</Link>
      <span className="markup-metric">{el.attrs.metric === 'idle' ? idleLabel(card.idleDays) : ''}</span>
    </p>
  ))
}

/**
 * 「多久没动」。零天不说话——刚动过的事不需要被提醒它刚动过。
 *
 * 和项目页上那份是同一句话。两处都要用，而它现在住在那个页面里面，搬出来要动
 * 别人的文件，所以先各写一份。
 */
function idleLabel(days: number | null): string {
  if (days === null || days <= 0) return ''
  return `${days} 天没动`
}

/**
 * 这段话里有没有指向项目的东西。
 *
 * 问的是标签的主语类型，不是标签本身：往后再加指向项目的标签，这里不用跟着改，
 * 而漏改的症状是那一行查不到、悄悄不显示。
 */
function usesProjects(blocks: MarkupBlock[]): boolean {
  return blocks.some((b) => {
    if (b.kind === 'run') return markupSpec(b.tag).subject === 'project'
    if (b.kind === 'group') return usesProjects(b.blocks)
    return b.spans.some((s) => s.kind === 'ref' && markupSpec(s.tag).subject === 'project')
  })
}

type Row = { el: MarkupElement; item: ItemWithSources; quotes: MarkupElement[] }

function renderRow({ el, item, quotes }: Row, key: number): React.ReactNode {
  const cited = quotes.map((q) => citedText(item, q)).filter((t) => t !== null)
  return (
    <Fragment key={key}>
      {/* `::quote` 那一行不带正文，所以只有 `::item` 的正文会成为 note */}
      <ItemRow
        item={item}
        note={el.tag === 'item' ? el.body : undefined}
        // 「地点换到明德楼了」这种话，要紧的是地点不是日期。给不出地点就仍旧写日期
        meta={el.attrs.show === 'location' ? item.location ?? undefined : undefined}
      />
      {cited.map((text, i) => <li className="markup-quote" key={i}>「{text}」</li>)}
    </Fragment>
  )
}

/**
 * 这条引用要亮的那句原文。
 *
 * 点名的字段没有出处就什么都不画，不退回去拿别的字段那一句——那样亮出来的原文
 * 说的是另一回事，而标错比不标更误导。
 */
function citedText(item: ItemWithSources, el: MarkupElement): string | null {
  const field = el.attrs.field
  const cite = field
    ? item.citations.find((c) => c.field === field)
    : item.citations[0]
  return cite?.quote ?? null
}

/** 查不到的 id 只丢那一个，剩下的照画 */
function resolveProjects(
  els: MarkupElement[], ctx: Ctx,
): { el: MarkupElement; card: ProjectCard }[] {
  const cards: { el: MarkupElement; card: ProjectCard }[] = []
  for (const el of els) {
    const card = el.subject ? ctx.projects(el.subject) : undefined
    if (card) cards.push({ el, card })
  }
  return cards
}

/** 查不到的 id 只丢那一个，剩下的照画 */
function resolveItems(els: MarkupElement[], ctx: Ctx): Row[] {
  const rows: Row[] = []
  for (const el of els) {
    const item = el.subject ? ctx.items(el.subject) : undefined
    if (item) rows.push({ el, item, quotes: el.quotes })
  }
  return rows
}

/**
 * 按天分组。
 *
 * 取日期串的前十位，和日程、想法两页同一套做法：库里的时刻带着 +08:00，
 * 前十位就是本地日期，不必再绕一趟 Date。没有日期的条目归到最后一组。
 */
function groupByDay(rows: Row[]): [string, Row[]][] {
  const byDay = new Map<string, Row[]>()
  for (const row of rows) {
    const at = row.item.dueAt ?? row.item.startsAt
    const day = at ? at.slice(0, 10) : ''
    const bucket = byDay.get(day)
    if (bucket) bucket.push(row)
    else byDay.set(day, [row])
  }
  return [...byDay.entries()].sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)))
}
