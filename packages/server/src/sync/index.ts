import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { Ctx } from '@flowpal/shared'
import { termEnd } from '@flowpal/shared'
import type { ServerConfig } from '../config.ts'
import { insertFragment } from '../store/fragments.ts'
import { finishRun, startRun } from '../store/runs.ts'
import { runAgentLoop } from '../agent/loop.ts'
import { applyMapped } from './apply.ts'
import { RucCookies } from './cookies.ts'
import { RucHttp, SessionExpired } from './http.ts'
import { fetchNoticeBody, fetchNotices, fetchSchedule, parseSchedule, probePortal } from './portal.ts'
import { mapPortalSchedule } from './map.ts'
import { fetchMail, describeMailbox } from './mail.ts'
import {
  lastScheduleFragment, mailWatermark, noticeWatermark, rememberScheduleFragment,
  setMailWatermark, setNoticeWatermark, writeSyncStatus, type SyncSourceResult,
} from './state.ts'

export { RucCookies } from './cookies.ts'
export { SessionExpired } from './http.ts'
export { readSyncStatus, markSignedIn, type SyncStatus } from './state.ts'

/**
 * 和外部来源同步一次。
 *
 * 启动时拉一次，之后每六小时一次，外加设置页上的手动按钮。定时读系统通知是监控
 * 用户行为；定时拉学校的系统是从**用户明确授权的数据源**同步他自己的数据，采集
 * 原则原文就允许。课表与考试变化很慢，六小时绰绰有余。
 *
 * **失败不重试。** 下一个周期自然会再试。唯一的例外是登录态失效——那要用户去
 * 重新登录，不是等下一个周期，所以它是一个单独的状态而不是一句错误。
 *
 * 三路来源在这里汇合，判定方式各不相同：
 *
 *   - **日程中心**（课表 / 校历 / 我的日历）：结构化，走确定性映射与 `external_id`
 *     覆盖，完全不经过 agent 循环。这条路上没有模型判断，也不该有。
 *   - **通知公告**：是散文，日期藏在句子里，只能走 agent 循环。因此有配额。
 *   - **邮件**：同上。
 */
export type SyncDeps = {
  db: DatabaseSync
  ctx: Ctx
  config: ServerConfig
  cookies: RucCookies
  /** 每写一批就广播一次「变了」，让两个窗口跟着刷新 */
  onChanged: () => void
}

export type SyncResult = {
  state: 'ok' | 'expired' | 'error'
  message: string
  sources: SyncSourceResult[]
}

export async function runSync(deps: SyncDeps): Promise<SyncResult> {
  const { db, ctx, cookies } = deps

  if (cookies.isEmpty) {
    const sources: SyncSourceResult[] = [
      { label: '人大门户', created: 0, updated: 0, skipped: '还没有登录' },
    ]
    writeSyncStatus(db, ctx, 'expired', '还没有登录人大门户', sources)
    return { state: 'expired', message: '还没有登录人大门户', sources }
  }

  const http = new RucHttp(cookies)
  const sources: SyncSourceResult[] = []

  try {
    // 先探一次会话。探针只回登录信息、不含要解析的业务数据，所以「登录态没了」
    // 这件事在这里就说清楚，不会伪装成某个接口的解析失败。
    await probePortal(http)
    cookies.save()

    sources.push(await syncSchedule(deps, http))
    deps.onChanged()
    sources.push(await syncNotices(deps, http))
    deps.onChanged()
  } catch (e) {
    if (e instanceof SessionExpired) {
      const message = '需要重新登录人大门户'
      sources.push({ label: '人大门户', created: 0, updated: 0, skipped: message })
      const withMail = [...sources, await syncMail(deps)]
      writeSyncStatus(db, ctx, 'expired', message, withMail)
      deps.onChanged()
      return { state: 'expired', message, sources: withMail }
    }
    const message = e instanceof Error ? e.message : String(e)
    sources.push({ label: '人大门户', created: 0, updated: 0, skipped: message })
    writeSyncStatus(db, ctx, 'error', message, sources)
    deps.onChanged()
    return { state: 'error', message, sources }
  }

  sources.push(await syncMail(deps))
  deps.onChanged()

  const failed = sources.filter((s) => s.skipped !== null && s.skipped !== '未配置')
  const created = sources.reduce((n, s) => n + s.created, 0)
  const updated = sources.reduce((n, s) => n + s.updated, 0)
  const message = failed.length > 0
    ? failed[0]!.skipped!
    : `新增 ${created} 条 · 更新 ${updated} 条`

  writeSyncStatus(db, ctx, failed.length > 0 ? 'error' : 'ok', message, sources)
  return { state: failed.length > 0 ? 'error' : 'ok', message, sources }
}

// ── 日程中心：课表、校历、我的日历 ────────────────────────────────────

async function syncSchedule(deps: SyncDeps, http: RucHttp): Promise<SyncSourceResult> {
  const { db, ctx } = deps

  /*
   * 一周一周地取，不一次拉整个学期。
   *
   * 实测：同一个接口，区间拉到半年时返回里只剩校历，课表那一类整个消失；按周取
   * 则两类都有，而且分周取到的每一条都能在长区间那一份里找到。服务端在长区间上
   * 自己有一套说不清的取舍，我们不去猜它，只按它给得全的那种粒度问。
   *
   * 取满整学期而不是只取眼前几周：课表压成一条带 RRULE 的条目，UNTIL 要的是这门
   * 课最后一次上课的日期。只取一个窗口的话，那个日期会被窗口边界截断，课表上会
   * 显示这门课下个月就结束了。
   */
  const start = ctx.term.startMonday
  const end = isoDay(termEnd(ctx.term))
  const weeks: unknown[] = []

  for (let from = start; from <= end; from = addDays(from, 7)) {
    const to = minDay(addDays(from, 6), end)
    weeks.push({ from, to, body: await fetchSchedule(http, from, to) })
  }
  deps.cookies.save()

  // 原文永不删除：落库的是服务端原样给的那几份 JSON，不是解析结果。引用逐字指向它，
  // 所以条目上的每一个时刻、每一个教室都能在这条碎片里找到出处。
  const rawText = JSON.stringify({
    kind: 'ruc-portal-schedule',
    term: ctx.term.id,
    range: { from: start, to: end },
    weeks,
  })
  const hash = createHash('sha256').update(rawText).digest('hex')

  const reused = lastScheduleFragment(db, hash)
  const fragmentId = reused ?? insertFragment(db, ctx, {
    source: 'timetable', rawType: 'structured', rawText,
  }).id
  if (reused === null) rememberScheduleFragment(db, ctx, hash, fragmentId)

  const events = weeks.flatMap((week) => parseSchedule((week as { body: unknown }).body))
  const { created, updated } = applyMapped(db, ctx, fragmentId, mapPortalSchedule(ctx, events))
  return { label: '课表与校历', created, updated, skipped: null }
}

// ── 通知公告 ──────────────────────────────────────────────────────────

/**
 * 通知是散文：「请于本周五前提交」这句话里的日期只有模型算得出来，所以这一路
 * 走 agent 循环，与用户自己扔进来的一段文字走同一条管道。
 *
 * **因此有配额。** 门户上通知每天几十条，全跑一遍既慢又花钱，而且这件事发生在
 * 早上九点、没有人看着的时候。只处理比上次水位更新的，且每次至多几条；剩下的
 * 留给下一个周期，或者用户自己扔进来。
 */
async function syncNotices(deps: SyncDeps, http: RucHttp): Promise<SyncSourceResult> {
  const { db, ctx, config } = deps
  const quota = config.sync.noticesPerRun
  if (quota === 0) return { label: '通知公告', created: 0, updated: 0, skipped: '未开启' }

  const notices = await fetchNotices(http, Math.max(quota * 4, 20))
  deps.cookies.save()
  if (notices.length === 0) return { label: '通知公告', created: 0, updated: 0, skipped: null }

  const watermark = noticeWatermark(db)
  const newest = notices.reduce((max, n) => (n.publishedAt > max ? n.publishedAt : max), '')

  if (watermark === null) {
    // 第一次同步不倒灌历史：门户上躺着几百条旧通知，把它们全跑一遍既不是用户要的，
    // 也会在第一天就烧掉大半额度。从现在这条水位往后看。
    setNoticeWatermark(db, ctx, newest)
    return { label: '通知公告', created: 0, updated: 0, skipped: '已记下当前进度，从下次起处理新通知' }
  }

  const fresh = notices
    .filter((n) => n.publishedAt > watermark)
    .sort((a, b) => a.publishedAt.localeCompare(b.publishedAt))
    .slice(0, quota)

  let created = 0
  for (const notice of fresh) {
    const body = notice.url === null ? await fetchNoticeBody(http, notice.id) : null
    const rawText = [
      `${notice.org} · ${notice.publishedAt}`,
      notice.title,
      body ?? (notice.url === null ? '' : `原文在站外：${notice.url}`),
    ].filter((line) => line !== '').join('\n\n')

    created += await runThroughLoop(deps, 'notice', rawText)
    setNoticeWatermark(db, ctx, notice.publishedAt)
  }
  deps.cookies.save()

  return { label: '通知公告', created, updated: 0, skipped: null }
}

// ── 邮件 ──────────────────────────────────────────────────────────────

async function syncMail(deps: SyncDeps): Promise<SyncSourceResult> {
  const { config } = deps
  if (config.mail === null) {
    return { label: describeMailbox(null), created: 0, updated: 0, skipped: '未配置' }
  }
  const label = describeMailbox(config.mail)
  try {
    const messages = await fetchMail(config.mail, mailWatermark(deps.db))
    let created = 0
    for (const message of messages) {
      created += await runThroughLoop(deps, 'email', message.text)
      setMailWatermark(deps.db, deps.ctx, message.uid)
    }
    return { label, created, updated: 0, skipped: null }
  } catch (e) {
    return { label, created: 0, updated: 0, skipped: e instanceof Error ? e.message : String(e) }
  }
}

// ── 散文来源共用的那一段 ──────────────────────────────────────────────

/**
 * 一条文本走完 agent 循环，返回它新建了几条条目。
 *
 * 与 POST /api/fragments 里的那一段是同一件事，但这里不推进行中事件：同步发生在
 * 后台，气泡只在用户刚对它做了一个动作时出现。**桌宠不为后台同步弹东西。**
 * 落点是「最近」页——这条 run 和用户自己扔进来的那些并排躺在那里。
 */
async function runThroughLoop(
  deps: SyncDeps, source: 'notice' | 'email', rawText: string,
): Promise<number> {
  const { db, ctx, config } = deps
  const fragment = insertFragment(db, ctx, { source, rawType: 'text', rawText })
  const run = startRun(db, ctx, fragment.id)
  try {
    const result = await runAgentLoop(config, db, ctx, fragment, () => {})
    finishRun(db, ctx, run.id, result.status, result.message, result.counts)
    return result.counts?.created ?? 0
  } catch (e) {
    // 这一层拥有这个错误，别处不再包一次。一条通知读不懂不该把整轮同步带下去：
    // 碎片已经落库，这次处理以 failed 记在「最近」页上，用户点重试就是对同一条
    // 碎片再跑一次。终端里同时留一行原因，否则「失败」二字查不出是哪一种失败。
    console.error(`同步的一条${source === 'notice' ? '通知' : '邮件'}没能处理：`, e)
    finishRun(db, ctx, run.id, 'failed', '没能理解这条。原文已存。', null)
    return 0
  }
}

// ── 日期 ──────────────────────────────────────────────────────────────

function isoDay(at: Date): string {
  return new Date(at.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
}

function addDays(day: string, n: number): string {
  const at = new Date(`${day}T00:00:00+08:00`)
  return isoDay(new Date(at.getTime() + n * 86_400_000))
}

function minDay(a: string, b: string): string {
  return a < b ? a : b
}
