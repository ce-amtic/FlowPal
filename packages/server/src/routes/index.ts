import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { Calendar, Run } from '@flowpal/shared'
import {
  createCtx, nowInShanghai, FragmentSource, RawType, NowOutput, nowJsonSchema,
  EndFocusRequest, SettingsPatch, StartFocusRequest, SyncRunRequest,
} from '@flowpal/shared'
import type { ServerConfig } from '../config.ts'
import { insertFragment, getFragment, listFragments } from '../store/fragments.ts'
import {
  addItemCitations, addItemSource, getItem, insertItem, itemHistory, listItems, updateItemFields,
} from '../store/items.ts'
import type { ItemWithSources } from '../store/items.ts'
import {
  createProject, dropProject, getProject, listProjects, projectCards, updateProjectFields,
} from '../store/projects.ts'
import {
  appendRunEvent, finishRun, getRun, listRunEvents, listRuns, startRun,
} from '../store/runs.ts'
import {
  endFocusSession, getFocusSession, insertFocusSession, listFocusApiSessions, listFocusSessions,
  startFocusSessionResult,
} from '../store/focus.ts'
import { clearNowCache, getNowCache, setNowCache } from '../store/now-cache.ts'
import {
  getSettings, SecretSettingsUnsupported, SettingsRevisionConflict, updateSettings,
} from '../store/settings.ts'
import { finishSyncRun, getSyncStatus, startSyncRun } from '../store/sync.ts'
import {
  bundledFixtureRequest,
  runRucSyncBatch,
  type RucOnlineBroker,
  type RucSyncRequest,
} from '../sync/runner.ts'
import { ExternalShapeError, UnsupportedExternalSourceError } from '../sync/types.ts'
import { extract } from '../pipeline/extract.ts'
import { mapStructured } from '../pipeline/map-structured.ts'
import { buildContext } from '../context/build.ts'
import { callJson } from '../llm/client.ts'
import { runAgentLoop, type AgentLoopEvent } from '../agent/loop.ts'

/**
 * 冻结的路由清单。界面和（将来的）手机端都只认这几个口，所以三个人可以各写各的，
 * 不用等对方。形状都在这里定死，改形状前先跟另外两方说。
 */
export type RouteDependencies = {
  /** Electron-owned auth/session broker; omitted in browser/standalone mode. */
  rucBroker?: RucOnlineBroker
}

export function createRoutes(
  db: DatabaseSync, config: ServerConfig, calendar: Calendar, dependencies: RouteDependencies = {},
) {
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
    rawBlobPath: z.string().max(4096).refine((value) => !/[\u0000]/.test(value), '文件路径包含非法字符').nullable().optional(),
    device: z.string().optional(),
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

    // A path alone is not a parseable document.  Do not send an empty body to
    // the text model and then report a misleading successful extraction.  The
    // selected file remains an immutable fragment and the UI can offer a
    // future file adapter (or ask the user to paste/screenshot it).
    if (fragment.rawType === 'file') {
      const message = '当前版本暂不支持直接解析此文件；原文已存。'
      finishRun(db, ctx, run.id, 'failed', message, null)
      broadcastChanged(ctx.now)
      return c.json({ fragment, run: getRun(db, run.id), items: [], plans: [] })
    }

    let items: ItemWithSources[] = []
    try {
      if (fragment.rawType === 'structured') {
        // 结构化来源不经模型，也不走循环；B 的同步路径另有 upsertByExternalId。
        const candidates = mapStructured(ctx, fragment)
        const itemIds = candidates.map((e) => {
          const id = insertItem(db, ctx, e)
          addItemSource(db, ctx, id, fragment.id)
          addItemCitations(db, id, fragment.id, e)
          return id
        })
        items = itemIds.map((id) => getItem(db, id) as ItemWithSources)
        const counts = {
          created: itemIds.length,
          updated: 0,
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

  // ── 设置与同步 ─────────────────────────────────────────────────────
  // Settings returns only the public draft. Secret actions are deliberately
  // rejected here; Electron's safeStorage/WebView owns those credentials.
  app.get('/api/settings', (c) => {
    const settings = getSettings(db, config)
    return c.json({
      settings,
      sync: getSyncStatus(db, config, settings.ruc.authorized, Boolean(dependencies.rucBroker)),
    })
  })

  app.put('/api/settings', async (c) => {
    let body: unknown
    try { body = await c.req.json() } catch { return c.json({ error: '设置参数不是合法 JSON' }, 400) }
    const parsed = SettingsPatch.safeParse(body)
    if (!parsed.success) return c.json({ error: '设置参数不对', issues: parsed.error.issues }, 400)
    try {
      const ctx = ctxOf()
      const settings = updateSettings(db, config, ctx, parsed.data)
      broadcastChanged(ctx.now)
      return c.json({
        settings,
        sync: getSyncStatus(db, config, settings.ruc.authorized, Boolean(dependencies.rucBroker)),
      })
    } catch (error) {
      if (error instanceof SettingsRevisionConflict) {
        return c.json({ error: 'settings_revision_conflict', settings: error.settings }, 409)
      }
      if (error instanceof SecretSettingsUnsupported) {
        return c.json({
          error: 'secret_settings_unsupported',
          message: '模型密钥由桌面安全存储管理；这里只接受 keep，不接收密钥明文。',
        }, 422)
      }
      throw error
    }
  })

  app.get('/api/sync/status', (c) => {
    const settings = getSettings(db, config)
    return c.json({
      status: getSyncStatus(db, config, settings.ruc.authorized, Boolean(dependencies.rucBroker)),
    })
  })

  app.post('/api/sync/run', async (c) => {
    let body: unknown = {}
    try {
      // An omitted body is intentionally shorthand for all configured
      // sources, but malformed JSON must be a client error rather than
      // silently turning into a full sync request.
      const raw = await c.req.text()
      if (raw.trim()) {
        try { body = JSON.parse(raw) as unknown } catch {
          return c.json({ error: '同步参数不是合法 JSON' }, 400)
        }
      }
    } catch {
      return c.json({ error: '同步参数不是合法 JSON' }, 400)
    }
    const parsed = SyncRunRequest.safeParse(body)
    if (!parsed.success) return c.json({ error: '同步参数不对', issues: parsed.error.issues }, 400)
    const sourceList = parsed.data.source
      ? [parsed.data.source]
      : ['ruc.portal', 'ruc.graduate'] as const
    if (parsed.data.mode === 'fixture' && parsed.data.payload !== undefined && sourceList.length !== 1) {
      return c.json({ error: 'fixture_payload_requires_one_source' }, 400)
    }
    // `source` is optional in the shared request (undefined when omitted and
    // null when explicitly sent); a term only has meaning for the one
    // graduate source, so never silently fan it out to the portal + graduate
    // batch when the caller forgot to choose a source.
    if (parsed.data.mode === 'fixture' && parsed.data.source == null && parsed.data.term) {
      return c.json({ error: 'fixture_term_requires_one_source' }, 400)
    }
    const ctx = ctxOf()
    const started = startSyncRun(db, ctx, parsed.data.source ?? null)
    if (started.reused) {
      return c.json({ run: started.run, reused: true })
    }

    try {
      const requests: RucSyncRequest[] = sourceList.map((source) => {
        if (parsed.data.mode === 'online') {
          return {
            mode: 'online',
            source,
            ...(parsed.data.term ? { term: parsed.data.term } : {}),
          }
        }
        const bundled = bundledFixtureRequest(source)
        return {
          ...bundled,
          ...(parsed.data.payload !== undefined ? { payload: parsed.data.payload } : {}),
          ...(parsed.data.term ? { term: parsed.data.term } : {}),
        }
      })
      const result = await runRucSyncBatch(db, ctx, requests, dependencies.rucBroker, {
        projectIdFor: (record) => {
          // A course is a durable project; ordinary portal calendar entries
          // are events only.  The normalizer supplies courseCode/classCode in
          // metadata, so repeated meetings converge on one project name.
          if (record.source !== 'ruc.graduate' || record.kind !== 'timetable') return null
          const courseCode = record.metadata?.courseCode
          const projectName = typeof courseCode === 'string' && courseCode.trim()
            ? `${courseCode.trim()} ${record.title}`
            : record.title
          return createProject(db, ctx, { name: projectName }).id
        },
      })
      const run = finishSyncRun(
        db, ctx, started.run.id, 'succeeded', result.records.length, null, null,
      )
      broadcastChanged(ctx.now)
      return c.json({ run, reused: false, imported: result.records.length })
    } catch (error) {
      const unsupported = error instanceof UnsupportedExternalSourceError
      const malformed = error instanceof ExternalShapeError
      if (parsed.data.mode === 'fixture') {
        // Parsing happens before the ingest transaction. Preserve the exact
        // fixture response even when its shape is rejected, so a failed sync
        // remains inspectable and can be retried without asking the user to
        // upload the source again.
        for (const source of sourceList) {
          let payload: unknown = null
          try {
            payload = parsed.data.payload !== undefined
              ? parsed.data.payload
              : bundledFixtureRequest(source).payload
          } catch {
            // A packaged build may omit an optional bundled fixture. Keep the
            // failed run terminal and preserve a diagnostic fragment rather
            // than throwing from the error handler and leaving `running`.
          }
          insertFragment(db, ctx, {
            source: source === 'ruc.portal' ? 'calendar' : 'timetable',
            rawType: 'structured',
            rawText: JSON.stringify({
              schema: 'flowpal.ruc.external-records.v1.failed',
              source,
              observedAt: ctx.now,
              response: payload,
              error: malformed ? 'external_shape_error' : 'sync_failed',
            }),
            device: 'ruc-sync',
          })
        }
      }
      const run = finishSyncRun(
        db, ctx, started.run.id, unsupported ? 'unsupported' : 'failed', 0,
        unsupported ? 'sync_connector_not_configured' : malformed ? 'external_shape_error' : 'sync_failed',
        unsupported
          ? '在线 RUC 连接器尚未接入；请使用显式离线样例或完成桌面端授权'
          : malformed
            ? 'RUC 返回的数据格式不符合当前版本，未覆盖已有条目'
            : 'RUC 同步失败；保留上一次成功结果',
      )
      broadcastChanged(ctx.now)
      return c.json({ run, reused: false })
    }
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
      })
      const parsed = NowOutput.safeParse(raw)
      if (!parsed.success) {
        throw new Error(`「此刻」输出不符合契约：${JSON.stringify(parsed.error.issues)}`)
      }
      const payload = {
        primary: parsed.data.primary,
        alternates: parsed.data.alternates,
        energy: parsed.data.energy_reading || null,
        basis: parsed.data.basis,
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
    actualMinutes: z.number().int().nonnegative().nullable().optional(),
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

  // Target /focus lifecycle. The legacy /api/focus-sessions endpoint above is
  // kept for A's demo seed and callers that only need the historical list.
  app.get('/api/focus', (c) => c.json({ sessions: listFocusApiSessions(db) }))

  app.post('/api/focus', async (c) => {
    let body: unknown
    try { body = await c.req.json() } catch { return c.json({ error: '专注参数不是合法 JSON' }, 400) }
    const parsed = StartFocusRequest.safeParse(body)
    if (!parsed.success) return c.json({ error: '专注参数不对', issues: parsed.error.issues }, 400)
    if (parsed.data.itemId && !getItem(db, parsed.data.itemId)) {
      return c.json({ error: '条目不存在' }, 404)
    }
    if (parsed.data.projectId && !getProject(db, parsed.data.projectId)) {
      return c.json({ error: '项目不存在' }, 404)
    }
    const ctx = ctxOf()
    const started = startFocusSessionResult(db, ctx, parsed.data)
    broadcastChanged(ctx.now)
    return c.json(started.response, started.reused ? 200 : 201)
  })

  app.get('/api/focus/:id', (c) => {
    const response = getFocusSession(db, c.req.param('id'), ctxOf().now)
    if (!response) return c.json({ error: '专注时段不存在' }, 404)
    return c.json(response)
  })

  app.post('/api/focus/:id/end', async (c) => {
    let body: unknown
    try { body = await c.req.json() } catch { return c.json({ error: '结束参数不是合法 JSON' }, 400) }
    const parsed = EndFocusRequest.safeParse(body)
    if (!parsed.success) return c.json({ error: '结束参数不对', issues: parsed.error.issues }, 400)
    const ctx = ctxOf()
    const response = endFocusSession(db, ctx, c.req.param('id'), parsed.data)
    if (!response) return c.json({ error: '专注时段不存在' }, 404)
    broadcastChanged(ctx.now)
    return c.json(response)
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
function daysFrom(iso: string, n: number): string {
  const d = new Date(iso)
  d.setDate(d.getDate() + n)
  const pad = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
