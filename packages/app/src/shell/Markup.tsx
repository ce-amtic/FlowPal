import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { parseMarkup, type MarkupBlock } from '@flowpal/shared'
import { api, queryKeys, type ItemWithSources } from '../api.ts'
import { ItemRow } from './ItemRow.tsx'
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
  // 引用的条目从这里查。这份清单别处也在用，通常已经在缓存里
  const { data } = useQuery({ queryKey: queryKeys.items, queryFn: api.listItems })
  const byId = new Map((data?.items ?? []).map((i) => [i.id, i]))

  const blocks = parseMarkup(text)
  return <div className="markup">{blocks.map((b, i) => renderBlock(b, i, byId))}</div>
}

function renderBlock(
  block: MarkupBlock, key: number, byId: Map<string, ItemWithSources>,
): React.ReactNode {
  if (block.kind === 'text') {
    return (
      <p className="markup-text" key={key}>
        {block.spans.map((span, i) => {
          if (span.kind === 'text') return span.text
          const item = byId.get(span.subject)
          // 查不到就整段不提它。这里最不能出的是屏幕上留一个光秃秃的 id
          if (!item) return null
          return (
            <Link className="markup-ref" to={`/items/${item.id}`} key={i}>
              {item.title}
            </Link>
          )
        })}
      </p>
    )
  }

  if (block.kind === 'group') {
    return (
      <section className="markup-group" key={key}>
        {block.title && <h3 className="group-label">{block.title}</h3>}
        {block.blocks.map((b, i) => renderBlock(b, i, byId))}
      </section>
    )
  }

  // 连着的同类已经在解析那一层并好了，这里直接当一组画
  const rows = block.items
    .map((el) => ({ el, item: el.subject ? byId.get(el.subject) : undefined }))
    .filter((r) => r.item !== undefined)
  if (rows.length === 0) return null

  return (
    <ul className="plain-list markup-run" key={key}>
      {rows.map(({ el, item }, i) => <ItemRow item={item!} note={el.body} key={i} />)}
    </ul>
  )
}
