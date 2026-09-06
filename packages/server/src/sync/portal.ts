import { asJson, RucHttp, SessionExpired, type Hop, type Landing } from './http.ts'

/**
 * 微人大门户（my.ruc.edu.cn）的接口与解析。
 *
 * 这一个站点回答了同步要的绝大部分问题，因为门户的**日程中心**把三样东西并在
 * 一处，一个接口全给：
 *
 *   - **课表**（分类 -2）：教务同步过来的，一节课一条，带教室与教师。
 *   - **校历**（分类 -5）：开学、放假、调课、考试周这类整天的事。
 *   - **我的日历**（分类 0）：用户自己加的日程。
 *
 * 从这里取课表而不是直接连教务系统，还多拿到一样东西：**调课只在这里看得见**。
 * 教务那边的周次位图是排课时定死的，学校把某个周日定成「上星期二的课」时位图
 * 不会变，日程中心里会多出一条。
 *
 * 字段名、参数、以及下面每一条「不能省」都来自既有 Flutter/Dart 实现的实测结论。
 */

const HOST = 'https://my.ruc.edu.cn'

/**
 * 门户各模块的调用来源标识，Base64 编的。**必须逐个模块给对。**
 *
 * 传错不报错：通知模块不带它会返回 HTTP 200、`resultCode: 1`、`result: null`，
 * 既不报错也不给数据；办事大厅传错则照样回成功，只是把 `data` 换成空数组。
 * 所以这类参数一律照抄浏览器里的真实请求，不跨模块复用。
 */
const SOURCE_NOTICE = 'YXM9Mw=='          // as=3
const SOURCE_CALENDAR = 'YXQ9MSZwPTEmbT1OJg__'  // at=1&p=1&m=N&

/** 通知公告所在的栏目。 */
const NOTICE_FOLDER = '597'

/** 会话是否可用的探针。只回登录信息，是门户里最轻的一个。 */
const PROBE = `${HOST}/sopplus/_web/portal/api/user/loginInfo.rst`

/**
 * 未登录的样子：重定向链的终点停在 CAS 的登录页。
 *
 * **判据必须作用于终点。** 持有效凭据访问门户时，链条同样会经过 CAS，只是立刻
 * 带着票据跳回来；以「是否跳向登录页」作判据会把正常的换票过程当成失效。
 */
function assertAuthenticated(landing: Landing, url: string): void {
  const stalled =
    landing.terminal.host === 'cas.ruc.edu.cn' && landing.terminal.pathname === '/cas/login'
  if (stalled) throw new SessionExpired(url, landing.terminal.toString())
}

async function get(http: RucHttp, url: string, hops?: Hop[]): Promise<Landing> {
  const landing = await http.follow(url, hops)
  assertAuthenticated(landing, url)
  return landing
}

/** 探一次会话。可用则返回门户给的登录信息原文，不可用则抛 SessionExpired。 */
export async function probePortal(http: RucHttp, hops?: Hop[]): Promise<string> {
  return (await get(http, PROBE, hops)).body
}

// ── 日程中心 ──────────────────────────────────────────────────────────

/** 分类标识。数值是服务端定的，不是我们编的。 */
export const CATEGORY = { mine: 0, timetable: -2, academicCalendar: -5 } as const

export type PortalEvent = {
  title: string
  /** 课表同步过来的是教室；校历与个人日程通常是空的 */
  location: string
  /** 服务端拼好的一句说明，形如「课程:网络与通信01;上课时间：星期1 第7～9节;老师:鄂金龙」 */
  note: string
  category: string
  categoryId: number
  /** `2026-09-07 14:00:00`，**保持原样**。引用要逐字对上原始 JSON，不能存换算过的 */
  beginRaw: string
  endRaw: string
  /** 这条属于哪一天，YYYY-MM-DD。跨天的事被服务端按天切开了，所以这一天就是它的全部 */
  day: string
  /**
   * 整天的事。
   *
   * **接口没有这个标记，是看出来的**：整天的事一律 00:00 到 23:59，有具体时刻的
   * 课不会正好落在这个区间。
   */
  allDay: boolean
}

/**
 * 解析日程接口的返回。
 *
 * **顶层就是数组，没有信封。** 门户其余接口都裹着 `{result, resultCode}`，唯独
 * 这个模块直接给数组——按信封去解会得到「响应体不是对象」，看起来像认证出了问题。
 */
export function parseSchedule(body: unknown): PortalEvent[] {
  if (!Array.isArray(body)) {
    throw new Error(`日程接口返回的不是数组，而是 ${typeof body}`)
  }
  const events: PortalEvent[] = []
  for (const raw of body) {
    if (raw === null || typeof raw !== 'object') {
      throw new Error(`日程里有一天不是对象，而是 ${typeof raw}`)
    }
    const day = asDay(text((raw as Record<string, unknown>).day), 'day')
    // **没有事的那天根本没有 events 这个键**，不是空数组。这是全文件唯一一处
    // 「取不到就当成空」，因为那正是它的意思：那天确实没有事。
    const list = (raw as Record<string, unknown>).events ?? []
    if (!Array.isArray(list)) throw new Error(`${day} 的 events 不是数组`)

    for (const entry of list) {
      if (entry === null || typeof entry !== 'object') {
        throw new Error(`${day} 的日程里有一项不是对象`)
      }
      const e = entry as Record<string, unknown>
      const schedule = e.schedule
      if (schedule === null || typeof schedule !== 'object') {
        throw new Error(`${day} 的日程条目里 schedule 是 ${typeof schedule}，不是对象`)
      }
      const s = schedule as Record<string, unknown>
      const category = s.cateGory
      const cat = category !== null && typeof category === 'object'
        ? (category as Record<string, unknown>)
        : {}

      const beginRaw = text(e.beginTime)
      const endRaw = text(e.endTime)
      if (beginRaw === '' || endRaw === '') {
        throw new Error(`${day} 有一条日程没有起止时刻`)
      }
      events.push({
        title: text(s.title),
        location: text(s.location),
        note: text(s.content),
        category: text(cat.name),
        categoryId: typeof cat.id === 'number' ? cat.id : 0,
        beginRaw,
        endRaw,
        day,
        allDay: beginRaw.endsWith(' 00:00:00') && endRaw.endsWith(' 23:59:00'),
      })
    }
  }
  return events
}

/**
 * 取一段日期区间的日程，两端都含。
 *
 * **区间不能拉长。** 实测把区间拉到半年时，返回里只剩校历，课表那一类整个消失；
 * 按周取则两类都有，而且分周取到的每一条都能在长区间那一份里找到。所以调用方
 * 一周一周地取，见 index.ts。
 *
 * `categoryIds` 与 `_p` 这个模块其实都不看（传单个分类、传错来源、整个不传，返回
 * 的都是同一份全量），仍然照原样带上——门户别的模块里传错这两个会静默返回空，
 * 而带对了不花什么代价。
 */
export async function fetchSchedule(
  http: RucHttp, fromDay: string, toDay: string, hops?: Hop[],
): Promise<unknown> {
  const url = new URL(`${HOST}/calendar/mgr/api/ruc/calendarList.rst`)
  url.search = new URLSearchParams({
    _p: SOURCE_CALENDAR,
    queryType: '2',
    categoryIds: '0,-2,-5',
    fromDate: utcOf(fromDay, '00:00:00'),
    endDate: utcOf(toDay, '23:59:59'),
    type: '0',
  }).toString()

  // 返回的是服务端原样给的那份，不是解析结果：它要原封不动地落成碎片，
  // 引用逐字指向它。解析在 parseSchedule 里另做一次。
  const landing = await get(http, url.toString(), hops)
  return asJson(landing, '日程中心')
}

// ── 通知公告 ──────────────────────────────────────────────────────────

export type PortalNotice = {
  /** `siteArticleId`，不是 `articleId`：详情接口与详情页认的都是前者 */
  id: number
  title: string
  /** 发布部门，如「财务处」 */
  org: string
  publishedAt: string
  read: boolean
  /** 指向站外的通知。为空表示正文在门户自己这里 */
  url: string | null
}

export function parseNotices(body: unknown): PortalNotice[] {
  const rows = unwrap(body, '通知列表').data
  if (!Array.isArray(rows)) throw new Error(`通知列表的 result.data 是 ${typeof rows}，不是数组`)

  return rows.map((raw) => {
    if (raw === null || typeof raw !== 'object') throw new Error('通知列表里有一项不是对象')
    const n = raw as Record<string, unknown>
    const id = n.siteArticleId
    if (typeof id !== 'number') throw new Error(`通知缺 siteArticleId，实得 ${typeof id}`)
    const external = text(n.url)
    return {
      id,
      // 实测有的标题带前导空格。
      title: text(n.title),
      org: text(n.createOrgName),
      publishedAt: text(n.publishTime),
      read: n.read === 1,
      url: external === '' ? null : external,
    }
  })
}

export async function fetchNotices(
  http: RucHttp, rows: number, hops?: Hop[],
): Promise<PortalNotice[]> {
  const url = new URL(`${HOST}/mnews/_web/apps/notice/view/api/notices.rst`)
  url.search = new URLSearchParams({
    _p: SOURCE_NOTICE,
    siteFolderId: NOTICE_FOLDER,
    enabledCache: '1',
    page: '1',
    rows: String(rows),
  }).toString()

  const landing = await get(http, url.toString(), hops)
  return parseNotices(asJson(landing, '通知列表'))
}

/** 一条通知的正文。取不到正文时返回 null——那条通知指向站外，门户自己没有内容。 */
export async function fetchNoticeBody(
  http: RucHttp, id: number, hops?: Hop[],
): Promise<string | null> {
  const url = new URL(`${HOST}/mnews/_web/apps/notice/view/api/${id}/detail.rst`)
  url.search = new URLSearchParams({ _p: SOURCE_NOTICE, domainId: '1' }).toString()

  const landing = await get(http, url.toString(), hops)
  const detail = unwrap(asJson(landing, `通知 ${id} 详情`), `通知 ${id} 详情`).data
  if (detail === null || typeof detail !== 'object') {
    throw new Error(`通知 ${id} 详情的 result.data 是 ${typeof detail}，不是对象`)
  }
  const content = text((detail as Record<string, unknown>).content)
  return content === '' ? null : stripHtml(content)
}

// ── 共用的小工具 ──────────────────────────────────────────────────────

/**
 * 门户大部分接口裹着 `{resultCode, result, errorMsg}` 这层信封，数据在
 * `result.data` 里。
 *
 * **`resultCode` 必须查。** 这个模块失败时不改 HTTP 状态码，也不改响应形状：
 * 少带一个 `_p`（调用来源标识）就回 HTTP 200、`resultCode: 1`、`result: null`，
 * 既不报错也不给数据。不查这一位的话，那种失败在上层看起来是「今天没有通知」。
 */
function unwrap(body: unknown, what: string): Record<string, unknown> {
  if (body === null || typeof body !== 'object') {
    throw new Error(`${what}返回的不是对象，而是 ${typeof body}`)
  }
  const envelope = body as Record<string, unknown>
  if (envelope.resultCode !== 0) {
    throw new Error(
      `${what}返回 resultCode=${envelope.resultCode}（成功为 0），errorMsg=${envelope.errorMsg}`,
    )
  }
  const result = envelope.result
  if (result === null || typeof result !== 'object') {
    throw new Error(`${what} resultCode 为 0，但 result 是 ${typeof result}`)
  }
  return result as Record<string, unknown>
}

function text(value: unknown): string {
  return value === null || value === undefined ? '' : String(value).trim()
}

function asDay(value: string, field: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value)
  if (!match) throw new Error(`${field} 的「${value}」不是可解析的日期`)
  return match[1]!
}

/**
 * 接口收的是 UTC 时刻，`2026-09-07T00:00:00+08:00` 换过去正好是它要的区间。
 * 格式照抄浏览器里的真实请求，带毫秒与 Z。
 */
function utcOf(day: string, time: string): string {
  const at = new Date(`${day}T${time}+08:00`)
  if (Number.isNaN(at.getTime())) throw new Error(`日期区间的「${day}」不是可解析的日期`)
  return at.toISOString()
}

/**
 * 通知正文是一段 HTML。丢进管道的是给模型读的文本，标签只会占 token。
 * 不求还原排版：模型要的是那句话里的日期和事，不是它加粗了没有。
 */
function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
