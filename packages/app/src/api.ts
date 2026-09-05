import type { Citation, Item, Project, Run } from '@flowpal/shared'

export type { Citation, Item, Project, Run }
import { mockApi } from './mock/mockApi.ts'

/**
 * 主窗口消费的 HTTP 接口。
 *
 * 形状由语义层冻结，这里只是照抄一份类型——改形状要三方一起改，不是这个文件
 * 单方面说了算。五页各自一个取数接口而不是一个通用查询加前端分组：同一条东西
 * 在不同页里的形状不同（日程按天分组、项目要带「多久没动」、最近要带那次投放的
 * 回执），把分组放在前端等于把同一份逻辑写五遍。
 */

/**
 * 一条字段变更。改期那几行是处境信号，所以历史要看得见。
 *
 * 这一处是下划线命名：服务端把库里的行原样返出来，没有转换。跟着它写，
 * 不在前端悄悄改名——改名会让人以为两边是同一套命名，然后在别处踩空。
 */
export type ItemHistoryRow = {
  id: string
  item_id: string
  changed_at: string
  field: string
  old_value: string | null
  new_value: string | null
  actor: string
  fragment_id: string | null
}

export type ItemWithSources = Item & {
  sourceFragmentIds: string[]
  citations: Citation[]
}

export type Fragment = {
  id: string
  createdAt: string
  device: string
  source: string
  rawType: string
  rawText: string | null
  rawBlobPath: string | null
}

/** 项目卡：一次取数就够画一张卡，不用为每个项目再打一次接口 */
export type ProjectCard = {
  project: Project
  unfinished: number
  done: number
  /** 接下来最近的两件 */
  next: { id: string; type: string; title: string; at: string }[]
  /** 用户说过的话 */
  said: string[]
  /** 多久没动。它测的是回避而非进展，是这一页的核心 */
  idleDays: number | null
  lastActivityAt: string | null
}

/**
 * 「此刻」。语义层已冻形状、第 7 步填实现，所以这一页现在能照着写，之后零改动接上。
 * primary 为 null 表示库里没有可推的：不调模型，页面显示投放入口。
 */
export type NowPick = {
  itemId: string
  title: string
  /** 为什么是它。必须落在具体的处境上 */
  reason: string
  /** 第一步；其后是更小的切口。「更小的一步」在这里面往后走。语义层保证至少两级 */
  steps: string[]
}

export type NowView = {
  primary: NowPick | null
  alternates: NowPick[]
  /** 模型的一句判断，必须引用一条给它的事实 */
  energy: string | null
  /** 这次输出用了哪些材料：条目 id，或逐字事实 */
  basis: string[]
}

/** 一次投放：碎片 + 它的回执 + 抽出或更新到的条目。零条与失败都是常态 */
export type RecentEntry = {
  fragment: Fragment
  run: Run | null
  items: ItemWithSources[]
}

export type AgendaEntry = {
  item: ItemWithSources
  project: { id: string; name: string | null } | null
}

export type AgendaView = {
  from: string
  to: string
  days: { day: string; items: AgendaEntry[] }[]
  /** 重复项不占某一天，界面压成每天顶上的细带 */
  recurring: AgendaEntry[]
}

/**
 * 应用设置。键由服务端白名单，写错的键会被 400 挡回来。
 *
 * 作息两问的出处是 MCTQ 那两道题，`buildContext` 读它们；没填时「此刻」只能拿到
 * 「作息时间未知（先验，猜的）」。`onboarded_at` 有值就表示向导走完了。
 */
export type Settings = {
  chronotype_workday_wake: string | null
  chronotype_restday_wake: string | null
  onboarded_at: string | null
}

/**
 * 一次专注时段。四个数在时段结束时一次写入：开始时刻、计划时长、实际时长、
 * 是否提前结束。「下次继续」就是 endedEarly。
 *
 * `startedAt` 用 `nowInShanghai()` 那种带 +08:00 的写法，和库里其余时刻同一套——
 * 发 UTC 的话，凌晨那几个小时的时段会被算进前一天。
 */
export type NewFocusSession = {
  startedAt: string
  plannedMinutes: number
  actualMinutes: number
  endedEarly: boolean
  itemId: string | null
}

export type Api = {
  listItems: () => Promise<{ items: ItemWithSources[] }>
  getItem: (id: string) => Promise<{ item: ItemWithSources; history: ItemHistoryRow[] }>
  getFragment: (id: string) => Promise<{ fragment: Fragment }>
  patchItem: (id: string, patch: Record<string, string | null>) => Promise<{ item: ItemWithSources }>
  throwIn: (body: {
    source: string
    rawType: string
    rawText?: string
    rawBlobPath?: string
  }) => Promise<{ fragment: Fragment; run: Run; items: ItemWithSources[] }>
  getNow: () => Promise<NowView>
  /** 「重新想一个」：只清缓存，下一次取数重新生成 */
  refreshNow: () => Promise<{ ok: boolean }>
  listRecent: () => Promise<{ recent: RecentEntry[] }>
  getAgenda: () => Promise<AgendaView>
  listProjects: () => Promise<{ projects: ProjectCard[]; unclassified: ItemWithSources[] }>
  getProject: (id: string) => Promise<{ project: Project; items: ItemWithSources[] }>
  listConfirmations: () => Promise<{ items: ItemWithSources[]; count: number }>
  listThoughts: () => Promise<{ thoughts: ItemWithSources[] }>
  getSettings: () => Promise<{ settings: Settings }>
  patchSettings: (patch: Partial<Record<keyof Settings, string>>) => Promise<{ settings: Settings }>
  postFocusSession: (session: NewFocusSession) => Promise<{ session: { id: string } }>
  /**
   * 把一张图的字节存进库目录，拿回它的绝对路径。
   *
   * 只有粘贴的截图需要它——剪贴板里没有磁盘路径。拖进来的文件本来就在盘上，
   * 直接把路径给 throwIn 即可。
   */
  uploadImage: (contentType: string, base64: string) => Promise<{ path: string }>
  serverUrl: string
}

const BASE = import.meta.env.VITE_SERVER_URL ?? 'http://127.0.0.1:5123'

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  })
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path} → ${res.status} ${await res.text()}`)
  return res.json() as Promise<T>
}

const realApi: Api = {
  listItems: () => call('/api/items'),
  getItem: (id) => call(`/api/items/${id}`),
  getFragment: (id) => call(`/api/fragments/${id}`),
  patchItem: (id, patch) => call(`/api/items/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  throwIn: (body) => call('/api/fragments', { method: 'POST', body: JSON.stringify(body) }),
  getNow: () => call('/api/now'),
  refreshNow: () => call('/api/now/refresh', { method: 'POST' }),
  listRecent: () => call('/api/recent'),
  getAgenda: () => call('/api/agenda'),
  listProjects: () => call('/api/projects'),
  getProject: (id) => call(`/api/projects/${id}`),
  listConfirmations: () => call('/api/confirmations'),
  listThoughts: () => call('/api/thoughts'),
  getSettings: () => call('/api/settings'),
  patchSettings: (patch) => call('/api/settings', { method: 'PATCH', body: JSON.stringify(patch) }),
  postFocusSession: (session) =>
    call('/api/focus-sessions', { method: 'POST', body: JSON.stringify(session) }),
  uploadImage: (contentType, base64) =>
    call('/api/blobs', { method: 'POST', body: JSON.stringify({ contentType, base64 }) }),
  serverUrl: BASE,
}

/**
 * 样例数据模式。默认关闭，靠 `pnpm dev:mock` 显式打开。
 *
 * 打开时标题栏上有一个拿不掉的标记——最怕的失败是拿着样例数据演了却不知道，
 * 所以这件事必须是看得见的，而不是藏在一个环境变量里。
 */
export const usingMock = import.meta.env.VITE_MOCK === '1'

export const api: Api = usingMock ? mockApi : realApi

/** 各页与角标的缓存键。SSE 广播「变了」时整棵失效。 */
export const queryKeys = {
  items: ['items'] as const,
  item: (id: string) => ['items', id] as const,
  fragment: (id: string) => ['fragments', id] as const,
  now: ['now'] as const,
  recent: ['recent'] as const,
  agenda: ['agenda'] as const,
  projects: ['projects'] as const,
  project: (id: string) => ['projects', id] as const,
  confirmations: ['confirmations'] as const,
  thoughts: ['thoughts'] as const,
  settings: ['settings'] as const,
}
