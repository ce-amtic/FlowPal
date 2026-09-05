import type { Citation, Item } from '@flowpal/shared'
import { mockApi } from './mock/mockApi.ts'

/**
 * 主窗口消费的 HTTP 接口，以及它的形状。
 *
 * 五页各自一个取数接口，而不是一个通用查询加前端分组：同一条东西在不同页里
 * 的形状不同（日程按天分组，项目要带「多久没动」，最近要带这次投放的产出），
 * 把分组放在前端等于把同一份逻辑写五遍。
 *
 * 下面这些类型就是主窗口与语义层之间的契约。已经落地的走真实接口，还没落地的
 * 在真实模式下会以出错态呈现——不静默显示空，因为空和坏长得一模一样。
 */

export type ItemWithSources = Item & {
  projectId: string | null
  sourceFragmentIds: string[]
  citations: Citation[]
}

export type Fragment = {
  id: string
  createdAt: string
  source: string
  rawType: string
  rawText: string | null
  rawBlobPath: string | null
}

export type Project = {
  id: string
  name: string
  statusNote: string | null
  status: 'active' | 'done' | 'dropped'
  /** 最后一次有动静距今多少天。「多久没动」这一行的来源，也是这一页的核心 */
  idleDays: number | null
}

/**
 * 「此刻」的一个候选：一件事、一句依据、以及由粗到细的几个切口。
 *
 * 「换一件」在候选之间走，「更小的一步」在同一个候选的 steps 里往后走。
 * 两者都是本地切换——这一组是一次调用返回的，点击不再调模型。
 */
export type NowCandidate = {
  itemId: string
  title: string
  /** 为什么是它。必须落在具体的处境上，不是泛泛的鼓励 */
  reason: string
  /** 第一步；其后是更小的切口 */
  steps: string[]
  /** 这次判断用到的材料：条目 id 或原文引文 */
  basis: string[]
}

export type NowView =
  | { empty: true }
  | {
      empty: false
      greeting: string
      /** 模型的一句判断，必须引用一条给它的事实 */
      energyReading: string
      candidates: NowCandidate[]
      /** 底部那条日期带：只显示一件事时，它是「剩下的没丢」的凭据 */
      dateBand: { at: string; title: string }[]
    }

export type ProjectsView = {
  projects: Project[]
  /** 顶部的「未归类」组。它是正常状态，不是待办 */
  unassigned: ItemWithSources[]
}

export type ProjectDetail = {
  project: Project
  upcoming: ItemWithSources[]
  todo: ItemWithSources[]
  done: ItemWithSources[]
  /** 用户自己扔进来的进度陈述，按时间。它是几句带日期的话，不是一条进展线 */
  said: { at: string; text: string }[]
}

/** 一次投放，以及它产出了什么。零条目与失败都是正常结果，都要有落点 */
export type Drop = {
  fragment: Fragment
  items: ItemWithSources[]
  outcome: 'ok' | 'empty' | 'over_steps' | 'failed' | 'offline'
}

export type Api = {
  listItems: () => Promise<{ items: ItemWithSources[] }>
  getItem: (id: string) => Promise<{ item: ItemWithSources; history: unknown[] }>
  patchItem: (id: string, patch: Record<string, string | null>) => Promise<{ item: ItemWithSources }>
  throwIn: (body: {
    source: string
    rawType: string
    rawText?: string
    rawBlobPath?: string
  }) => Promise<{ fragment: { id: string }; items: ItemWithSources[] }>
  getNow: () => Promise<NowView>
  listRecent: () => Promise<{ drops: Drop[] }>
  listProjects: () => Promise<ProjectsView>
  getProject: (id: string) => Promise<ProjectDetail>
  listPending: () => Promise<{ items: ItemWithSources[] }>
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
  patchItem: (id, patch) => call(`/api/items/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  throwIn: (body) => call('/api/fragments', { method: 'POST', body: JSON.stringify(body) }),
  getNow: () => call('/api/now'),
  listRecent: () => call('/api/recent'),
  listProjects: () => call('/api/projects'),
  getProject: (id) => call(`/api/projects/${id}`),
  // 待确认队列的接口还没落地。角标不能因为缺一个接口就静默消失，所以先从
  // 条目列表里筛；那个接口一到，这里改一行，别处不动。
  listPending: async () => {
    const { items } = await call<{ items: ItemWithSources[] }>('/api/items')
    return { items: items.filter((i) => i.status === 'needs_confirm') }
  },
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

/** 五页与角标共用的缓存键。SSE 广播「变了」时整棵失效。 */
export const queryKeys = {
  items: ['items'] as const,
  item: (id: string) => ['items', id] as const,
  now: ['now'] as const,
  recent: ['recent'] as const,
  projects: ['projects'] as const,
  project: (id: string) => ['projects', id] as const,
  pending: ['pending'] as const,
}
