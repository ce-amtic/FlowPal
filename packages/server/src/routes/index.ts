import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { DatabaseSync } from 'node:sqlite'
import type { Calendar } from '@flowpal/shared'
import { createCtx, nowInShanghai } from '@flowpal/shared'
import type { ServerConfig } from '../config.ts'
import { insertFragment, getFragment, listFragments } from '../store/fragments.ts'
import { applyPlans, getItem, itemHistory, listItems, updateItemFields } from '../store/items.ts'
import { extract } from '../pipeline/extract.ts'
import { mapStructured } from '../pipeline/map-structured.ts'
import { dedupe } from '../pipeline/dedupe.ts'

/**
 * 冻结的路由清单。界面和（将来的）手机端都只认这几个口，
 * 所以三个人可以各写各的，不用等对方。
 */
export function createRoutes(db: DatabaseSync, config: ServerConfig, calendar: Calendar) {
  const app = new Hono()

  // 开发时渲染进程跑在 Vite 的端口上，跨源。
  app.use('/api/*', cors())

  // 局域网监听时必须带 token；只监听本机时 config.token 为 null，不拦。
  app.use('/api/*', async (c, next) => {
    if (config.token && c.req.header('Authorization') !== `Bearer ${config.token}`) {
      return c.json({ error: '未配对' }, 401)
    }
    await next()
  })

  /** 唯一允许读系统时钟的地方：请求入口。往下一路传 ctx.now。 */
  const ctxOf = () => createCtx(calendar, nowInShanghai())

  app.get('/api/items', (c) => c.json({ items: listItems(db) }))

  app.get('/api/items/:id', (c) => {
    const item = getItem(db, c.req.param('id'))
    if (!item) return c.json({ error: '条目不存在' }, 404)
    return c.json({ item, history: itemHistory(db, item.id) })
  })

  app.patch('/api/items/:id', async (c) => {
    const id = c.req.param('id')
    // 这一层拥有 HTTP 状态码：不存在是 404，界面据此渲染「条目不存在」而不是一段栈。
    // 更深的地方仍然直接抛——那里的错是 bug，不该被翻译成状态码。
    if (!getItem(db, id)) return c.json({ error: '条目不存在' }, 404)
    updateItemFields(db, ctxOf(), id, await c.req.json())
    return c.json({ item: getItem(db, id) })
  })

  app.get('/api/fragments', (c) => c.json({ fragments: listFragments(db) }))

  app.get('/api/fragments/:id', (c) => {
    const fragment = getFragment(db, c.req.param('id'))
    if (!fragment) return c.json({ error: '碎片不存在' }, 404)
    return c.json({ fragment })
  })

  /**
   * 扔一条东西进来：落碎片 → 理解 → 去重合并 → 入库。
   * 三段的边界就是三个人的边界：extract 与 dedupe 在语义层，applyPlans 在数据层。
   */
  app.post('/api/fragments', async (c) => {
    const ctx = ctxOf()
    const body = await c.req.json()
    const fragment = insertFragment(db, ctx, body)

    const candidates = fragment.rawType === 'structured'
      ? mapStructured(ctx, fragment)
      : (await extract(config, ctx, fragment)).items

    const planned = dedupe(ctx, candidates, listItems(db))
    const itemIds = applyPlans(db, ctx, fragment.id, planned)

    return c.json({
      fragment,
      items: itemIds.map((id) => getItem(db, id)),
      plans: planned.map((p) => p.plan),
    })
  })

  /** 只理解、不落库。调 prompt 时打这个口，不用开界面。 */
  app.post('/api/extract', async (c) => {
    const ctx = ctxOf()
    const body = await c.req.json()
    const fragment = {
      id: 'dry-run', createdAt: ctx.now, device: 'cli',
      source: body.source ?? 'paste', rawType: body.rawType ?? 'text',
      rawText: body.rawText ?? null, rawBlobPath: body.rawBlobPath ?? null,
    }
    return c.json(await extract(config, ctx, fragment))
  })

  return app
}
