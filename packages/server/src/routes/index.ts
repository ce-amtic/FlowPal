import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'
import type { DatabaseSync } from 'node:sqlite'
import type { Calendar } from '@flowpal/shared'
import { createCtx, nowInShanghai, FragmentSource, RawType } from '@flowpal/shared'
import type { MergePlan } from '@flowpal/shared'
import type { ServerConfig } from '../config.ts'
import { insertFragment, getFragment, listFragments } from '../store/fragments.ts'
import { applyPlans, getItem, itemHistory, listItems, updateItemFields } from '../store/items.ts'
import type { ItemWithSources } from '../store/items.ts'
import {
  createProject, dropProject, getProject, listProjects, projectCards, updateProjectFields,
} from '../store/projects.ts'
import { finishRun, getRun, listRuns, startRun } from '../store/runs.ts'
import { insertFocusSession, listFocusSessions } from '../store/focus.ts'
import { extract } from '../pipeline/extract.ts'
import { mapStructured } from '../pipeline/map-structured.ts'
import { dedupe } from '../pipeline/dedupe.ts'

/**
 * 冻结的路由清单。界面和（将来的）手机端都只认这几个口，所以三个人可以各写各的，
 * 不用等对方。形状都在这里定死，改形状前先跟另外两方说。
 */
export function createRoutes(db: DatabaseSync, config: ServerConfig, calendar: Calendar) {
  const app = new Hono()

  app.use('/api/*', cors())

  app.use('/api/*', async (c, next) => {
    if (config.token && c.req.header('Authorization') !== `Bearer ${config.token}`) {
      return c.json({ error: '未配对' }, 401)
    }
    await next()
  })

  /** 唯一允许读系统时钟的地方：请求入口。往下一路传 ctx.now。 */
  const ctxOf = () => createCtx(calendar, nowInShanghai())

  // ── 跨窗口广播 ──────────────────────────────────────────────────────
  // 任何写操作后广播一条粗粒度的「变了」。事件不携带内容：实体在库里另有真相，
  // 再带一份就是第二套数据模型。客户端收到就 invalidateQueries。
  type SseClient = { write: (data: string) => void }
  const sseClients = new Set<SseClient>()
  function broadcastChanged(at: string): void {
    const data = JSON.stringify({ type: 'changed', at })
    for (const client of sseClients) {
      try { client.write(data) } catch { sseClients.delete(client) }
    }
  }

  // ── 条目 ────────────────────────────────────────────────────────────
  app.get('/api/items', (c) => c.json({ items: listItems(db) }))

  app.get('/api/items/:id', (c) => {
    const item = getItem(db, c.req.param('id'))
    if (!item) return c.json({ error: '条目不存在' }, 404)
    return c.json({ item, history: itemHistory(db, item.id) })
  })

  app.patch('/api/items/:id', async (c) => {
    const id = c.req.param('id')
    if (!getItem(db, id)) return c.json({ error: '条目不存在' }, 404)
    const ctx = ctxOf()
    updateItemFields(db, ctx, id, await c.req.json())
    broadcastChanged(ctx.now)
    return c.json({ item: getItem(db, id) })
  })

  // ── 碎片与投放 ──────────────────────────────────────────────────────
  const FragmentBody = z.object({
    source: FragmentSource,
    rawType: RawType,
    rawText: z.string().nullable().optional(),
    rawBlobPath: z.string().nullable().optional(),
    device: z.string().optional(),
  })

  app.get('/api/fragments', (c) => c.json({ fragments: listFragments(db) }))

  app.get('/api/fragments/:id', (c) => {
    const fragment = getFragment(db, c.req.param('id'))
    if (!fragment) return c.json({ error: '碎片不存在' }, 404)
    return c.json({ fragment })
  })

  /**
   * 扔一条东西进来：落碎片 → 建 run → 理解 → 去重合并 → 入库 → 广播。
   * 零条与失败都是业务常态不是 HTTP 错误：碎片已落库，结果一律记在 run 里，
   * 界面看 run.status 渲染四种话术。第 5 步循环上线后中间那段整体换掉，外层不动。
   */
  app.post('/api/fragments', async (c) => {
    const ctx = ctxOf()
    const parsed = FragmentBody.safeParse(await c.req.json())
    if (!parsed.success) {
      return c.json({ error: '碎片参数不对', issues: parsed.error.issues }, 400)
    }

    const fragment = insertFragment(db, ctx, parsed.data)
    const run = startRun(db, ctx, fragment.id)
    broadcastChanged(ctx.now)

    let items: ItemWithSources[] = []
    let plans: MergePlan[] = []
    try {
      const candidates = fragment.rawType === 'structured'
        ? mapStructured(ctx, fragment)
        : (await extract(config, ctx, fragment)).items

      const planned = dedupe(ctx, candidates, listItems(db))
      const itemIds = applyPlans(db, ctx, fragment.id, planned)
      items = itemIds.map((id) => getItem(db, id) as ItemWithSources)
      plans = planned.map((p) => p.plan)

      const counts = {
        created: plans.filter((p) => p.action === 'new').length,
        updated: plans.filter((p) => p.action !== 'new').length,
        dropped: 0,
        needsConfirm: items.filter((i) => i.status === 'needs_confirm').length,
      }
      const message = items.length === 0
        ? '没找到需要记的东西。原文已存。'
        : counts.needsConfirm > 0
          ? `接住了，${counts.needsConfirm} 条拿不准的先放待确认。原文已存。`
          : '接住了。原文已存。'
      finishRun(db, ctx, run.id, 'done', message, counts)
    } catch (e) {
      const message = isConnectionError(e)
        ? '连不上模型。原文已存。'
        : '没能理解这条。原文已存。'
      finishRun(db, ctx, run.id, 'failed', message, null)
    }
    broadcastChanged(ctx.now)

    return c.json({ fragment, run: getRun(db, run.id), items, plans })
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

  // ── 项目 ────────────────────────────────────────────────────────────
  app.get('/api/projects', (c) => {
    const cards = projectCards(db, ctxOf().now)
    const unclassified = listItems(db).filter(
      (i) => i.projectId === null && i.status !== 'done' && i.type !== 'thought',
    )
    return c.json({ projects: cards, unclassified })
  })

  app.get('/api/projects/:id', (c) => {
    const id = c.req.param('id')
    const project = getProject(db, id)
    if (!project) return c.json({ error: '项目不存在' }, 404)
    return c.json({ project, items: listItems(db).filter((i) => i.projectId === id) })
  })

  app.post('/api/projects', async (c) => {
    const ctx = ctxOf()
    const project = createProject(db, ctx, await c.req.json())
    broadcastChanged(ctx.now)
    return c.json({ project }, 201)
  })

  app.patch('/api/projects/:id', async (c) => {
    const id = c.req.param('id')
    if (!getProject(db, id)) return c.json({ error: '项目不存在' }, 404)
    const ctx = ctxOf()
    updateProjectFields(db, ctx, id, await c.req.json())
    broadcastChanged(ctx.now)
    return c.json({ project: getProject(db, id) })
  })

  app.delete('/api/projects/:id', (c) => {
    const id = c.req.param('id')
    if (!getProject(db, id)) return c.json({ error: '项目不存在' }, 404)
    const ctx = ctxOf()
    dropProject(db, ctx, id)
    broadcastChanged(ctx.now)
    return c.json({ project: getProject(db, id) })
  })


  // ── 五页取数 ────────────────────────────────────────────────────────
  /**
   * 「此刻」：第 7 步填实现，形状现在就冻死。C 对着它写页，之后零改动接上。
   *   primary    主推那件事（null = 库里没有可推的，页面显示投放入口）
   *   alternates 备选若干件
   *   energy     energy_reading 那行
   *   basis      这次输出用了哪些材料（条目 id / 引文）
   */
  app.get('/api/now', (c) => c.json({
    primary: null,
    alternates: [],
    energy: null,
    basis: [],
  }))

  /** 最近页：每一次投放（碎片）+ 它的 run 回执 + 抽出/更新到的条目。 */
  app.get('/api/recent', (c) => {
    const runs = new Map(listRuns(db).map((r) => [r.fragmentId, r]))
    const items = listItems(db)
    const recent = listFragments(db).map((fragment) => ({
      fragment,
      run: runs.get(fragment.id) ?? null,
      items: items.filter((i) => i.sourceFragmentIds.includes(fragment.id)),
    }))
    return c.json({ recent })
  })

  /**
   * 日程页：纵向按天。from/to 是 YYYY-MM-DD，两端都含；缺省给「今天起 14 天」。
   * recurring 是每周重复项（rrule），不占某一天，界面压成每天顶上的细带。
   */
  app.get('/api/agenda', (c) => {
    const now = ctxOf().now
    const from = c.req.query('from') ?? now.slice(0, 10)
    const to = c.req.query('to') ?? daysFrom(now, 13)

    const projectNames = new Map(listProjects(db).map((p) => [p.id, p.name]))
    const candidates = listItems(db).filter(
      (i) => (i.type === 'event' || i.type === 'task') && i.status === 'active',
    )
    const recurring = candidates.filter((i) => i.rrule !== null)
    const withDate = candidates
      .filter((i) => !i.rrule && (i.startsAt ?? i.dueAt))
      .map((i) => ({ item: i, day: (i.startsAt ?? i.dueAt)!.slice(0, 10) }))
      .filter((x) => x.day >= from && x.day <= to)
      .sort((a, b) => a.day.localeCompare(b.day)
        || (a.item.startsAt ?? a.item.dueAt ?? '').localeCompare(b.item.startsAt ?? b.item.dueAt ?? ''))

    const days: { day: string; items: unknown[] }[] = []
    for (const x of withDate) {
      const last = days.at(-1)
      if (last && last.day === x.day) last.items.push(withProject(x.item))
      else days.push({ day: x.day, items: [withProject(x.item)] })
    }
    return c.json({ from, to, days, recurring: recurring.map(withProject) })

    function withProject(item: ItemWithSources) {
      return {
        item,
        project: item.projectId
          ? { id: item.projectId, name: projectNames.get(item.projectId) ?? null }
          : null,
      }
    }
  })

  /** 想法页：倒序的流，既没有时间也不属于项目。 */
  app.get('/api/thoughts', (c) => c.json({
    thoughts: listItems(db).filter((i) => i.type === 'thought' && i.status === 'active'),
  }))

  /** 待确认：全局一个数字 + 逐条清单。确认走 PATCH /api/items/:id。 */
  app.get('/api/confirmations', (c) => {
    const items = listItems(db).filter((i) => i.status === 'needs_confirm')
    return c.json({ items, count: items.length })
  })

  // ── 专注时段（B 的 /focus 写这里） ───────────────────────────────────
  const FocusBody = z.object({
    startedAt: z.string(),
    plannedMinutes: z.number().int().positive(),
    actualMinutes: z.number().int().positive().nullable().optional(),
    endedEarly: z.boolean().optional(),
    itemId: z.string().nullable().optional(),
    projectId: z.string().nullable().optional(),
  })

  app.get('/api/focus-sessions', (c) => c.json({ sessions: listFocusSessions(db) }))

  app.post('/api/focus-sessions', async (c) => {
    const ctx = ctxOf()
    const parsed = FocusBody.safeParse(await c.req.json())
    if (!parsed.success) {
      return c.json({ error: '专注参数不对', issues: parsed.error.issues }, 400)
    }
    const session = insertFocusSession(db, ctx, parsed.data)
    broadcastChanged(ctx.now)
    return c.json({ session }, 201)
  })

  // ── 事件流 ──────────────────────────────────────────────────────────
  /** 粗粒度广播：任何写后推 { type:'changed', at }。连上先推一条，客户端借此刷新一次。 */
  app.get('/api/events', (c) => streamSSE(c, async (stream) => {
    const client: SseClient = {
      write: (data) => { void stream.writeSSE({ data }) },
    }
    sseClients.add(client)
    stream.writeSSE({ data: JSON.stringify({ type: 'changed', at: ctxOf().now }) })
    stream.onAbort(() => { sseClients.delete(client) })
    try {
      // 心跳保活；Vite HMR 断掉的连接由客户端重连。
      for (;;) await stream.sleep(60_000)
    } finally {
      sseClients.delete(client)
    }
  }))

  /**
   * 一次投放的进行中事件。形状见 shared/run.ts 的 RunEvent——第 5 步往里填
   * tool_call（只带工具名与参数，不带结果），形状不再改。现在循环还没上线：
   * 已结束的 run 补发一条 run_finished；running 的只发心跳。
   */
  app.get('/api/runs/:id/events', (c) => {
    const run = getRun(db, c.req.param('id'))
    if (!run) return c.json({ error: '没有这次投放' }, 404)
    return streamSSE(c, async (stream) => {
      // writeSSE 必须 await：handler 一返回流就关，悬空的写会被吞掉。
      if (run.status === 'running') {
        await stream.writeSSE({ data: JSON.stringify({ type: 'run_started', at: run.startedAt, runId: run.id }) })
        try {
          for (;;) await stream.sleep(30_000)
        } catch { /* 客户端断开 */ }
        return
      }
      await stream.writeSSE({ data: JSON.stringify({
        type: 'run_finished',
        at: run.finishedAt ?? run.startedAt,
        status: run.status,
        counts: run.counts,
        message: run.message,
      }) })
    })
  })

  return app
}

function isConnectionError(e: unknown): boolean {
  return e instanceof Error &&
    /APIConnection|fetch failed|ECONN|ENOTFOUND|ETIMEDOUT|Connection error/i.test(e.message)
}

/** 从 ISO 时刻字符串（带 +08:00）往后推 n 天，返回 YYYY-MM-DD。 */
function daysFrom(iso: string, n: number): string {
  const d = new Date(iso)
  d.setDate(d.getDate() + n)
  const pad = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

