import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { Calendar, Run } from '@flowpal/shared'
import {
  createCtx, nowInShanghai, occursOn, supportsRrule,
  FragmentSource, RawType, NowChoice, NowOutput, nowJsonSchema,
  EndFocusRequest, SettingsPatch, StartFocusRequest, SyncRunRequest,
} from '@flowpal/shared'
import type { RucExternalSource } from '@flowpal/shared'
import type { ServerConfig } from '../config.ts'
import { newId } from '../store/db.ts'
import { insertFragment, getFragment, listFragments } from '../store/fragments.ts'
import {
  addItemCitations, addItemSource, getItem, insertItem, itemHistory, listItems, updateItemFields,
  upsertByExternalId,
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
import { getSetting, setSetting } from '../store/settings.ts'
import { extract } from '../pipeline/extract.ts'
import { mapStructured } from '../pipeline/map-structured.ts'
import { applyMapped } from '../sync/apply.ts'
import { markSignedIn, readSyncStatus, RucCookies, runSync } from '../sync/index.ts'
import { MailSecrets } from '../sync/secrets.ts'
import { testMailbox } from '../sync/mail.ts'
import {
  createMailAccount, deleteMailAccount, getMailAccount, listMailAccounts, updateMailAccount,
} from '../store/mail-accounts.ts'
import type { MailAccount } from '../store/mail-accounts.ts'
import { buildContext } from '../context/build.ts'
import { callJson } from '../llm/client.ts'
import { runAgentLoop, type AgentLoopEvent } from '../agent/loop.ts'
import {
  LocalFileError,
  localIcsPayload,
  parseIcsRecords,
  readLocalFile,
  type LocalFileContents,
} from '../input/local-file.ts'

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

  /** 学校系统的登录态。落在 dataDir 里，冷启动不用重新登录。 */
  const cookies = RucCookies.open(join(config.dataDir, 'ruc-cookies.json'))
  /** 邮箱授权码的明文。只在内存里，进程退出即无。 */
  const secrets = new MailSecrets()
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
    rawBlobPath: z.string().max(4096).refine((value) => !/[\u0000]/.test(value), '文件路径包含非法字符').nullable().optional(),
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

    let localFile: LocalFileContents | null = null
    let localIcsRecords: ReturnType<typeof parseIcsRecords> | null = null
    let rawText = parsed.data.rawText ?? null
    if (parsed.data.rawType === 'file') {
      if (!parsed.data.rawBlobPath) {
        return c.json({ error: 'file_requires_path', message: '文件碎片必须带本机路径。' }, 400)
      }
      try {
        localFile = await readLocalFile(parsed.data.rawBlobPath)
        rawText = localFile.text
      } catch (error) {
        if (error instanceof LocalFileError) {
          return c.json({ error: error.code, message: error.message }, error.status)
        }
        throw error
      }
    }

    // ICS remains raw_type=file so the original dropped path is visible in
    // Recent/Item provenance. Its validated records are stored as the same
    // structured payload consumed by mapStructured, avoiding an LLM call.
    if (localFile?.kind === 'ics') {
      try {
        localIcsRecords = parseIcsRecords(localFile.text, ctx.now)
        rawText = localIcsPayload(localIcsRecords, ctx.now, localFile.text)
      } catch (error) {
        // A malformed calendar is still useful provenance. Preserve the raw
        // bytes and a terminal run rather than silently dropping the file.
        const fragment = insertFragment(db, ctx, {
          ...parsed.data,
          rawText: localFile.text,
          rawBlobPath: localFile.originalPath,
        })
        const run = startRun(db, ctx, fragment.id)
        const message = error instanceof LocalFileError
          ? `${error.message}原文已存。`
          : 'ICS 文件无法解析；原文已存。'
        finishRun(db, ctx, run.id, 'failed', message, null)
        emitRunFinished(run.id, getRun(db, run.id) as Run)
        broadcastChanged(ctx.now)
        return c.json({ fragment, run: getRun(db, run.id), items: [], plans: [] })
      }
    }

    const fragment = insertFragment(db, ctx, {
      ...parsed.data,
      ...(localFile ? { rawText, rawBlobPath: localFile.originalPath } : {}),
    })
    const run = startRun(db, ctx, fragment.id)
    broadcastChanged(ctx.now)

    /*
     * 结构化来源（同步来的课表、拖进来的 ICS）不经模型：解析加入库是几毫秒的事，
     * 中间没有任何值得播的进展。这一条当场跑完，条目随响应一起回去。
     */
    if (fragment.rawType === 'structured' || localFile?.kind === 'ics') {
      const items = importStructured()
      broadcastChanged(ctx.now)
      return c.json({ fragment, run: getRun(db, run.id), items })
    }

    /*
     * 模型那条路要几十秒，放到后台跑，这里立刻把 run 交出去。
     *
     * 同步等到跑完的话，调用方在这几十秒里唯一能显示的就是一句「正在理解」——而这
     * 期间它其实一直在看具体的东西。拿到 run.id 才订阅得了 /api/runs/:id/events，
     * 那条流里逐步播的正是它在看什么。
     */
    void process()
    return c.json({ fragment, run }, 202)

    /**
     * 不经模型的那条路。
     *
     * 判定靠 `external_id` 这个主键，落库走 `applyMapped`——定时同步用的是同一段，
     * 所以「同一份课表连拉两次不新增条目」这条不变量只有一处需要成立。
     */
    function importStructured(): ItemWithSources[] {
      try {
        const applied = applyMapped(db, ctx, fragment.id, mapStructured(ctx, fragment))
        const items = applied.itemIds.map((id) => getItem(db, id) as ItemWithSources)
        finishRun(db, ctx, run.id, 'done', items.length === 0
          ? '没有需要记录的内容。原文已存。'
          : '已记下。原文已存。', {
          created: applied.created,
          updated: applied.updated,
          dropped: 0,
          needsConfirm: items.filter((i) => i.status === 'needs_confirm').length,
        })
        emitRunFinished(run.id, getRun(db, run.id) as Run)
        return items
      } catch {
        finishRun(db, ctx, run.id, 'failed', '这份数据没能读懂。原文已存。', null)
        emitRunFinished(run.id, getRun(db, run.id) as Run)
        return []
      }
    }

    async function process(): Promise<void> {
      try {
        const result = await runAgentLoop(config, db, ctx, fragment, (e) => {
          emitRunToolCall(run.id, e, nowInShanghai())
        })
        finishRun(db, ctx, run.id, result.status, result.message, result.counts)
        emitRunFinished(run.id, getRun(db, run.id) as Run)
      } catch (e) {
        const message = isConnectionError(e)
          ? '无法连接模型。原文已存。'
          : '未能理解这条。原文已存。'
        finishRun(db, ctx, run.id, 'failed', message, null)
        emitRunFinished(run.id, getRun(db, run.id) as Run)
      }
      // 抽出来的条目由这一条广播让各页自己重取，不随响应回去：那时响应早已发走
      broadcastChanged(ctx.now)
    }
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
      settings: {
        ...settings,
        chronotype_workday_wake: settings.chronotype.workdayWakeTime,
        chronotype_restday_wake: settings.chronotype.freeDayWakeTime,
        onboarded_at: getSetting(db, 'onboarded_at'),
      },
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
    /*
     * 这个口只跑教务那两个来源。`local.ics` 也是外部来源，但它是用户拖进来的一份
     * 文件，没有会话也没有轮询——放它进来的话，下面每一处「是 portal 还是 graduate」
     * 的判断都会把它当成 graduate，无声地按课表处理。
     */
    if (parsed.data.source === 'local.ics') {
      return c.json({ error: 'source_not_syncable', message: 'ICS 文件请直接拖进窗口。' }, 400)
    }
    const sourceList: RucExternalSource[] = parsed.data.source
      ? [parsed.data.source]
      : ['ruc.portal', 'ruc.graduate']
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

  // ── 邮箱账号 ────────────────────────────────────────────────────────
  /*
   * 账号住在库里而不是配置文件里，因为它要能在设置页上随时增删改。
   *
   * **盘上只有密文，内存里才有明文。** 密文由桌面端用系统钥匙串加好再送来，
   * 这个进程解不开它——server 不依赖 Electron，钥匙也不在库里。明文单独走一趟，
   * 落在 secrets 那个 Map 里，进程退出即无。所以：
   *
   *   - 新加 / 改密码：界面同时送密文与明文。同一条 localhost 请求里两样都有，
   *     看着多余，其实不是——加密防的是**盘上**被读走，不是这一跳。
   *   - 冷启动：桌面端把库里的密文解开一批，POST 到 /unlock。
   *   - `pnpm dev:server` 单跑：没有能解钥匙串的东西，于是没有明文，邮箱那一路
   *     明说「需要在桌面应用里解锁」。这是对的，不是缺陷。
   */
  const MailAccountBody = z.object({
    host: z.string().min(1),
    port: z.number().int().positive(),
    username: z.string().min(1),
    /** base64，系统钥匙串加密后的密文。落库的是它 */
    passwordCipher: z.string().min(1),
    /** 同一串授权码的明文。只进内存，不落库 */
    password: z.string().min(1),
    perRun: z.number().int().nonnegative(),
  })

  /** 返回给界面的账号。**永远不带密文，也永远不带明文。** */
  const publicAccount = (a: MailAccount) => ({
    id: a.id,
    host: a.host,
    port: a.port,
    username: a.username,
    perRun: a.perRun,
    enabled: a.enabled,
    /** 这个进程手上有没有它的明文。没有就是「需要在桌面应用里解锁」 */
    unlocked: secrets.has(a.id),
  })

  app.get('/api/mail-accounts', (c) =>
    c.json({ accounts: listMailAccounts(db).map(publicAccount) }))

  /**
   * 桌面端专用：连密文一起拿走，好把它交给系统钥匙串解开。
   *
   * 与上面那条分开，是为了让「界面要的」和「桌面端要的」在类型上就不是一回事——
   * 密文没有任何理由出现在渲染进程里。
   */
  app.get('/api/mail-accounts/locked', (c) => c.json({
    accounts: listMailAccounts(db)
      .filter((a) => a.enabled && !secrets.has(a.id))
      .map((a) => ({ id: a.id, passwordCipher: a.passwordCipher })),
  }))

  app.post('/api/mail-accounts/unlock', async (c) => {
    const body = z.record(z.string(), z.string()).safeParse(await c.req.json())
    if (!body.success) return c.json({ error: '解锁参数不对', issues: body.error.issues }, 400)

    for (const [id, password] of Object.entries(body.data)) {
      if (getMailAccount(db, id) === null) return c.json({ error: `邮箱账号不存在：${id}` }, 404)
      secrets.unlock(id, password)
    }
    broadcastChanged(ctxOf().now)
    return c.json({ accounts: listMailAccounts(db).map(publicAccount) })
  })

  app.post('/api/mail-accounts', async (c) => {
    const ctx = ctxOf()
    const body = MailAccountBody.safeParse(await c.req.json())
    if (!body.success) return c.json({ error: '邮箱参数不对', issues: body.error.issues }, 400)

    const { password, ...stored } = body.data
    let account: MailAccount
    try {
      account = createMailAccount(db, ctx, stored)
    } catch (e) {
      // 唯一索引撞了：同一个邮箱加两遍会把每封信喂两次模型，而那只在账单上看得出来。
      const message = e instanceof Error && e.message.includes('UNIQUE')
        ? `${stored.username} 已经加过了`
        : e instanceof Error ? e.message : String(e)
      return c.json({ error: message }, 409)
    }
    secrets.unlock(account.id, password)
    broadcastChanged(ctx.now)
    return c.json({ account: publicAccount(account) })
  })

  app.patch('/api/mail-accounts/:id', async (c) => {
    const ctx = ctxOf()
    const id = c.req.param('id')
    if (getMailAccount(db, id) === null) return c.json({ error: '邮箱账号不存在' }, 404)

    // 改密码时两样一起给；只改端口之类时两样都不给。给一半是错的，说清楚。
    // `enabled` 只在这里出现，不在新建那份里：新加的账号一定是启用的。
    const body = MailAccountBody.partial().extend({ enabled: z.boolean().optional() })
      .safeParse(await c.req.json())
    if (!body.success) return c.json({ error: '邮箱参数不对', issues: body.error.issues }, 400)
    const { password, ...patch } = body.data
    if ((password === undefined) !== (patch.passwordCipher === undefined)) {
      return c.json({ error: '改授权码要同时给密文与明文' }, 400)
    }

    const account = updateMailAccount(db, ctx, id, patch)
    if (password !== undefined) secrets.unlock(id, password)
    broadcastChanged(ctx.now)
    return c.json({ account: publicAccount(account) })
  })

  app.delete('/api/mail-accounts/:id', (c) => {
    const id = c.req.param('id')
    deleteMailAccount(db, id)
    secrets.forget(id)
    broadcastChanged(ctxOf().now)
    return c.json({ accounts: listMailAccounts(db).map(publicAccount) })
  })

  /**
   * 连一次试试。
   *
   * 加账号的时候当场问一次，比等六小时后在状态行上看见一句「同步失败」有用得多：
   * 主机写错、端口不对、授权码填成了登录密码，三种在状态行上长得一模一样，而
   * 下一步完全不同。
   */
  app.post('/api/mail-accounts/:id/test', async (c) => {
    const account = getMailAccount(db, c.req.param('id'))
    if (account === null) return c.json({ error: '邮箱账号不存在' }, 404)
    const password = secrets.get(account.id)
    if (password === null) return c.json({ error: '需要在桌面应用里解锁' }, 409)
    try {
      return c.json({ ok: true, ...(await testMailbox(account, password)) })
    } catch (e) {
      return c.json({ ok: false, message: e instanceof Error ? e.message : String(e) })
    }
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
        db, ctx, config, cookies, secrets, onChanged: () => broadcastChanged(ctx.now),
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
    // 一次专注是处境的一部分，尤其是「下次继续」。不清缓存的话下一次「此刻」
    // 还是刚才那一份判断，那件没做完的事永远排不到前面。
    clearNowCache(db)
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
