import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { Calendar, Run } from '@flowpal/shared'
import { createCtx, nowInShanghai, occursOn, supportsRrule, FragmentSource, RawType, NowChoice, NowOutput, nowJsonSchema } from '@flowpal/shared'
import type { ServerConfig } from '../config.ts'
import { newId } from '../store/db.ts'
import { insertFragment, getFragment, listFragments } from '../store/fragments.ts'
import {
  getItem, itemHistory, listItems, updateItemFields,
} from '../store/items.ts'
import type { ItemWithSources } from '../store/items.ts'
import {
  createProject, dropProject, getProject, listProjects, projectCards, updateProjectFields,
} from '../store/projects.ts'
import {
  appendRunEvent, finishRun, getRun, listRunEvents, listRuns, startRun,
} from '../store/runs.ts'
import { insertFocusSession, listFocusSessions } from '../store/focus.ts'
import { clearNowCache, getNowCache, setNowCache } from '../store/now-cache.ts'
import { getSetting, setSetting } from '../store/settings.ts'
import { extract } from '../pipeline/extract.ts'
import { mapStructured } from '../pipeline/map-structured.ts'
import { applyMapped } from '../sync/apply.ts'
import { markSignedIn, readSyncStatus, RucCookies, runSync } from '../sync/index.ts'
import { buildContext } from '../context/build.ts'
import { callJson } from '../llm/client.ts'
import { runAgentLoop, type AgentLoopEvent } from '../agent/loop.ts'

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

  /** 学校系统的登录态。落在 dataDir 里，冷启动不用重新登录。 */
  const cookies = RucCookies.open(join(config.dataDir, 'ruc-cookies.json'))
  let syncing = false

  // ── 跨窗口广播 ──────────────────────────────────────────────────────
  // 任何写操作后广播一条粗粒度的「变了」。事件不携带内容：实体在库里另有真相，
  // 再带一份就是第二套数据模型。客户端收到就 invalidateQueries。
  type SseClient = { write: (data: string) => void }
  const sseClients = new Set<SseClient>()
  function broadcastChanged(at: string): void {
    // 库有写入 = 「此刻」缓存失效。现在缓存单行，直接删；将来有增量再改成版本号。
    clearNowCache(db)
    const data = JSON.stringify({ type: 'changed', at })
    for (const client of sseClients) {
      try { client.write(data) } catch { sseClients.delete(client) }
    }
  }

  // ── 单次投放的进行中事件流 ───────────────────────────────────────────
  // 工具调用先落库再推：客户端中途连上也能回放完整过程。只带工具名与参数，
  // 不带工具结果——碎片原文不进渲染进程，气泡用不到。
  type RunStreamState = { clients: Set<SseClient>; finished: Run | null }
  const runStreams = new Map<string, RunStreamState>()

  function stateFor(runId: string): RunStreamState {
    let state = runStreams.get(runId)
    if (!state) {
      state = { clients: new Set(), finished: null }
      runStreams.set(runId, state)
    }
    return state
  }

  function emitRunToolCall(runId: string, event: AgentLoopEvent, at: string): void {
    appendRunEvent(db, runId, event.step, at, event.tool, event.args)
    const data = JSON.stringify({ type: 'tool_call', at, step: event.step, tool: event.tool, args: event.args })
    for (const client of stateFor(runId).clients) {
      try { client.write(data) } catch { stateFor(runId).clients.delete(client) }
    }
  }

  function emitRunFinished(runId: string, run: Run): void {
    const state = stateFor(runId)
    state.finished = run
    const data = JSON.stringify({
      type: 'run_finished',
      at: run.finishedAt ?? run.startedAt,
      status: run.status,
      counts: run.counts,
      message: run.message,
    })
    for (const client of state.clients) {
      try { client.write(data) } catch { state.clients.delete(client) }
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

  /** 浏览器窗口里那次真人登录留下的 Cookie。形状照 Electron 的 cookies API。 */
  const SessionBody = z.object({
    cookies: z.array(z.object({
      name: z.string(),
      value: z.string(),
      domain: z.string(),
      path: z.string(),
      secure: z.boolean(),
      httpOnly: z.boolean(),
      /** Unix 秒。会话 Cookie 没有这一项 */
      expirationDate: z.number().optional(),
    })),
  })

  app.get('/api/fragments', (c) => c.json({ fragments: listFragments(db) }))

  app.get('/api/fragments/:id', (c) => {
    const fragment = getFragment(db, c.req.param('id'))
    if (!fragment) return c.json({ error: '碎片不存在' }, 404)
    return c.json({ fragment })
  })

  /**
   * 扔一条东西进来：落碎片 → 建 run → agent 循环 → 入库 → 广播。
   * 零条与失败都是业务常态不是 HTTP 错误：碎片已落库，结果一律记在 run 里，
   * 界面看 run.status 渲染四种话术。
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
    try {
      if (fragment.rawType === 'structured') {
        // 结构化来源不经模型，也不走循环：判定靠 external_id 这个主键。定时同步
        // 走的是同一段（applyMapped），所以「连拉两次不新增条目」只有一处要成立。
        const applied = applyMapped(db, ctx, fragment.id, mapStructured(ctx, fragment))
        items = applied.itemIds.map((id) => getItem(db, id) as ItemWithSources)
        const counts = {
          created: applied.created,
          updated: applied.updated,
          dropped: 0,
          needsConfirm: items.filter((i) => i.status === 'needs_confirm').length,
        }
        const message = items.length === 0 ? '没找到需要记的东西。原文已存。' : '接住了。原文已存。'
        finishRun(db, ctx, run.id, 'done', message, counts)
        emitRunFinished(run.id, getRun(db, run.id) as Run)
      } else {
        const result = await runAgentLoop(config, db, ctx, fragment, (e) => {
          emitRunToolCall(run.id, e, nowInShanghai())
        })
        finishRun(db, ctx, run.id, result.status, result.message, result.counts)
        emitRunFinished(run.id, getRun(db, run.id) as Run)
        items = listItems(db).filter((i) => i.sourceFragmentIds.includes(fragment.id))
      }
    } catch (e) {
      const message = isConnectionError(e)
        ? '连不上模型。原文已存。'
        : '没能理解这条。原文已存。'
      finishRun(db, ctx, run.id, 'failed', message, null)
      emitRunFinished(run.id, getRun(db, run.id) as Run)
    }
    broadcastChanged(ctx.now)

    // plans 字段保留为空数组：循环里没有 MergePlan 这一层，但旧客户端仍会读这个键。
    return c.json({ fragment, run: getRun(db, run.id), items, plans: [] })
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
   * 「此刻」：一次只读生成。主推 + 备选一次返回，结果落库缓存；
   * 失效三选一：跨半小时、库有写入（broadcastChanged 已清）、用户按重新想一个。
   */
  app.get('/api/now', async (c) => {
    const ctx = ctxOf()
    const cached = getNowCache(db)
    if (cached && !isNowStale(cached.createdAt, ctx.now)) {
      return c.json(JSON.parse(cached.payload) as unknown)
    }

    const active = listItems(db).filter(
      (i) => (i.type === 'event' || i.type === 'task') && i.status === 'active',
    )
    if (active.length === 0) return c.json(emptyNow())

    try {
      const context = buildContext(db, ctx)
      const raw = await callJson(config.llm.text, {
        system: readFileSync(join(config.promptsDir, 'now.md'), 'utf8'),
        user: context.formatted,
        schemaName: 'now_output',
        jsonSchema: nowJsonSchema(),
        // 这一页是首屏，人正等着它出来。而且这里量过：关掉思考，梯子反而更准。
        effort: 'none',
      })
      /*
       * 逐项验，不整份验。
       *
       * 观测到的失败：模型偶尔在某个 alternate 上漏掉 steps，三次里约一次。整份
       * 校验是全有或全无，于是「此刻」整页退成空态——首屏因为一个次要候选而空白。
       * alternates 为空本来就是合法形状，扔掉坏的不破坏契约；为了它扔掉写对了的
       * primary 才破坏。primary 自己不合契约仍然走空态，那是真没有可推的。
       *
       * 送给模型的 json_schema 仍然是完整的 NowOutput，要求没有放松，放松的只是
       * 收到坏输出时的处置。
       */
      const shell = raw as Partial<Record<keyof NowOutput, unknown>>
      const primary = NowChoice.safeParse(shell.primary)
      if (!primary.success) {
        throw new Error(`「此刻」的 primary 不符合契约：${JSON.stringify(primary.error.issues)}`)
      }
      const candidates = Array.isArray(shell.alternates) ? shell.alternates : []
      const alternates = candidates
        .map((a) => NowChoice.safeParse(a))
        .filter((r) => r.success)
        .map((r) => r.data)
      if (alternates.length !== candidates.length) {
        console.warn(`「此刻」丢弃了 ${candidates.length - alternates.length} 个不合契约的候选`)
      }

      const payload = {
        primary: primary.data,
        alternates,
        energy: typeof shell.energy_reading === 'string' ? shell.energy_reading || null : null,
        basis: Array.isArray(shell.basis) ? shell.basis.filter((b) => typeof b === 'string') : [],
      }
      setNowCache(db, ctx, JSON.stringify(payload))
      return c.json(payload)
    } catch (e) {
      console.error('/api/now 生成失败，返回空态', e)
      return c.json(emptyNow())
    }
  })

  /** 用户按「重新想一个」：只清缓存，下一次 GET 重新生成。 */
  app.post('/api/now/refresh', (c) => {
    clearNowCache(db)
    return c.json({ ok: true })
  })

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
    /*
     * 重复项归到它真正发生的那几天，不堆在页顶。
     *
     * 页顶一条总的细带在库里只有几条重复项时读得过去，教务同步一接上就不行了：
     * 一学期十几门课全挤在那一条里，而「今天有没有课、几点」——日程页上最该一眼
     * 看到的东西——反倒一个字都没有。
     */
    /*
     * `recurrence` 是模型写的自由字符串，随时会出现一条我们放不下的规则。
     * **放不下不等于不存在**：那种条目退回按 startsAt 当成一条普通的事，落在它
     * 第一次发生的那天。既不让整页 500，也不让它悄悄从日程上消失。
     */
    const placeable = (i: ItemWithSources) =>
      i.rrule !== null && i.startsAt !== null && supportsRrule(i.rrule)
    const recurring = candidates.filter(placeable)
    const withDate = candidates
      .filter((i) => !placeable(i) && (i.startsAt ?? i.dueAt))
      .map((i) => ({ item: i, day: (i.startsAt ?? i.dueAt)!.slice(0, 10) }))
      .filter((x) => x.day >= from && x.day <= to)
      .sort((a, b) => a.day.localeCompare(b.day)
        || (a.item.startsAt ?? a.item.dueAt ?? '').localeCompare(b.item.startsAt ?? b.item.dueAt ?? ''))

    const byDay = new Map<string, { items: unknown[]; recurring: unknown[] }>()
    const bucket = (day: string) => {
      let b = byDay.get(day)
      if (!b) { b = { items: [], recurring: [] }; byDay.set(day, b) }
      return b
    }
    for (const x of withDate) bucket(x.day).items.push(withProject(x.item))
    for (const day of daysInRange(from, to)) {
      for (const item of recurring) {
        if (occursOn(item.rrule!, item.startsAt!, day)) bucket(day).recurring.push(withProject(item))
      }
    }

    // 只有课的那天照样是一天。少了这一步，「今天三节课、没有别的事」在日程上是空的。
    const days = [...byDay.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, b]) => ({ day, ...b }))
    return c.json({ from, to, days })

    function withProject(item: ItemWithSources) {
      return {
        item,
        project: item.projectId
          ? { id: item.projectId, name: projectNames.get(item.projectId) ?? null }
          : null,
      }
    }
  })

  /**
   * 应用设置。首次启动的向导与设置页写这里，buildContext 从这里读作息。
   *
   * 键是白名单：设置是给人填的少数几项，不是一个任人写的键值仓库；写错一个键
   * 不会报错、只会让读它的那一侧永远读到空，而那种错很难被发现。
   */
  const SETTING_KEYS = ['chronotype_workday_wake', 'chronotype_restday_wake', 'onboarded_at'] as const

  app.get('/api/settings', (c) => c.json({
    settings: Object.fromEntries(SETTING_KEYS.map((k) => [k, getSetting(db, k)])),
  }))

  app.patch('/api/settings', async (c) => {
    const ctx = ctxOf()
    const body = z.record(z.string(), z.string()).safeParse(await c.req.json())
    if (!body.success) return c.json({ error: '设置参数不对', issues: body.error.issues }, 400)

    const unknown = Object.keys(body.data).filter((k) => !SETTING_KEYS.includes(k as never))
    if (unknown.length > 0) return c.json({ error: `没有这些设置项：${unknown.join(', ')}` }, 400)

    for (const [key, value] of Object.entries(body.data)) setSetting(db, ctx, key, value)
    // 作息变了，「此刻」的判断依据就变了，那份缓存不再作数
    clearNowCache(db)
    broadcastChanged(ctx.now)
    return c.json({
      settings: Object.fromEntries(SETTING_KEYS.map((k) => [k, getSetting(db, k)])),
    })
  })

  // ── 和外部来源同步 ──────────────────────────────────────────────────
  /*
   * 登录不在这里发生，也不可能在这里发生：CAS 的登录页带验证码、短信码和一段前端
   * 加密的密码，无头重放那套表单是在猜一个会变的东西，猜错的代价是真实账号被锁。
   * 所以密码从不进入本程序——用户在 desktop 开的一个真浏览器窗口里登录一次，那次
   * 登录留下的 Cookie POST 到下面这个口，之后取数全由 server 自己发出。
   *
   * server 因此仍然不知道 Electron 存在：它只认一批 Cookie。
   */
  app.get('/api/sync', (c) => c.json(readSyncStatus(db, !cookies.isEmpty)))

  app.post('/api/sync/session', async (c) => {
    const ctx = ctxOf()
    const body = SessionBody.safeParse(await c.req.json())
    if (!body.success) return c.json({ error: '登录态参数不对', issues: body.error.issues }, 400)

    const saved = cookies.importFromBrowser(body.data.cookies)
    if (saved === 0) return c.json({ error: '这次登录没有带回任何 Cookie' }, 400)
    markSignedIn(db, ctx)
    broadcastChanged(ctx.now)
    return c.json({ saved, status: readSyncStatus(db, !cookies.isEmpty) })
  })

  app.delete('/api/sync/session', (c) => {
    cookies.clear()
    broadcastChanged(ctxOf().now)
    return c.json({ status: readSyncStatus(db, false) })
  })

  /**
   * 同步一次。启动、六小时的定时、设置页的按钮，三个触发点都打这一个口。
   *
   * **同一时刻只跑一轮。** 三个触发点会撞上——开机时定时器和启动那一次几乎同时
   * 到——两轮并行地往同一批 external_id 上写，得到的是一堆本不该有的 item_history。
   * 撞上时回 409，调用方不重试：正在跑的那一轮会把活干完。
   */
  app.post('/api/sync', async (c) => {
    if (syncing) return c.json({ error: '正在同步' }, 409)
    syncing = true
    const ctx = ctxOf()
    try {
      const result = await runSync({
        db, ctx, config, cookies, onChanged: () => broadcastChanged(ctx.now),
      })
      return c.json({ ...result, status: readSyncStatus(db, !cookies.isEmpty) })
    } finally {
      syncing = false
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

  // ── 图片落盘 ────────────────────────────────────────────────────────
  /**
   * 粘贴进来的截图只有字节，没有磁盘路径，而碎片存的是路径。先落到库目录里，
   * 把绝对路径回给调用方，它再拿去发 POST /api/fragments。
   *
   * 拖进来的文件不走这里：它本来就在磁盘上，直接给路径即可，不必再搬一份。
   */
  const BlobBody = z.object({
    contentType: z.string().regex(/^image\/(png|jpeg|webp|gif)$/),
    base64: z.string().min(1),
  })

  app.post('/api/blobs', async (c) => {
    const parsed = BlobBody.safeParse(await c.req.json())
    if (!parsed.success) {
      return c.json({ error: '图片参数不对', issues: parsed.error.issues }, 400)
    }
    const dir = join(config.dataDir, 'blobs')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `${newId('blob')}.${parsed.data.contentType.slice('image/'.length)}`)
    writeFileSync(path, Buffer.from(parsed.data.base64, 'base64'))
    return c.json({ path }, 201)
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
    // 一次专注是处境的一部分，尤其是「下次继续」。不清缓存的话下一次「此刻」
    // 还是刚才那一份判断，那件没做完的事永远排不到前面。
    clearNowCache(db)
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
   * 一次投放的进行中事件。先回放 run_started 与已落库的 tool_call，再流式推新增；
   * 结束后补一条 run_finished。形状见 shared/run.ts 的 RunEvent。
   */
  app.get('/api/runs/:id/events', (c) => {
    const run = getRun(db, c.req.param('id'))
    if (!run) return c.json({ error: '没有这次投放' }, 404)
    return streamSSE(c, async (stream) => {
      await stream.writeSSE({ data: JSON.stringify({ type: 'run_started', at: run.startedAt, runId: run.id }) })
      for (const e of listRunEvents(db, run.id)) {
        await stream.writeSSE({ data: JSON.stringify({ type: 'tool_call', at: e.at, step: e.step, tool: e.tool, args: e.args }) })
      }

      if (run.status !== 'running') {
        await stream.writeSSE({ data: JSON.stringify({
          type: 'run_finished',
          at: run.finishedAt ?? run.startedAt,
          status: run.status,
          counts: run.counts,
          message: run.message,
        }) })
        return
      }

      const state = stateFor(run.id)
      const client: SseClient = {
        write: (data) => { void stream.writeSSE({ data }) },
      }
      state.clients.add(client)
      stream.onAbort(() => { state.clients.delete(client) })
      try {
        for (;;) {
          await stream.sleep(500)
          const cur = runStreams.get(run.id)
          if (!cur || cur.finished) return
        }
      } finally {
        state.clients.delete(client)
        if (state.clients.size === 0) runStreams.delete(run.id)
      }
    })
  })

  return app
}

function emptyNow() {
  return { primary: null, alternates: [], energy: null, basis: [] }
}

function isNowStale(createdAt: string, now: string): boolean {
  return new Date(now).getTime() - new Date(createdAt).getTime() > 30 * 60_000
}

function isConnectionError(e: unknown): boolean {
  return e instanceof Error &&
    /APIConnection|fetch failed|ECONN|ENOTFOUND|ETIMEDOUT|Connection error/i.test(e.message)
}

/** 从 ISO 时刻字符串（带 +08:00）往后推 n 天，返回 YYYY-MM-DD。 */
/** 区间里的每一天，两端都含。 */
function daysInRange(from: string, to: string): string[] {
  const days: string[] = []
  for (let day = from; day <= to; day = daysFrom(`${day}T12:00:00+08:00`, 1)) days.push(day)
  return days
}

function daysFrom(iso: string, n: number): string {
  const d = new Date(iso)
  d.setDate(d.getDate() + n)
  const pad = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

