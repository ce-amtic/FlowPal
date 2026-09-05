import type { Citation, Item } from '@flowpal/shared'

/**
 * 主窗口消费的 HTTP 接口。
 *
 * 目前只用已经存在的那几条。五页各自的取数接口、项目与待确认队列由语义层
 * 那条线补齐；补齐之前，日程、想法、最近先从条目与碎片列表里取，页面里已经
 * 标出各自将来要换到哪个接口。
 *
 * 换过去时改的只有这个文件——页面拿到的形状不变。
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
  /** 最后一次有动静距今多少天；「多久没动」这一行的来源 */
  idleDays: number | null
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

export const api = {
  /** 当前所有活着的条目。待确认的角标暂时从这里数，等待确认队列的接口落地后改掉。 */
  listItems: () => call<{ items: ItemWithSources[] }>('/api/items'),

  getItem: (id: string) =>
    call<{ item: ItemWithSources; history: unknown[] }>(`/api/items/${id}`),

  patchItem: (id: string, patch: Record<string, string | null>) =>
    call<{ item: ItemWithSources }>(`/api/items/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  /** 扔一条东西进来。返回的是这次循环的回执。 */
  throwIn: (body: { source: string; rawType: string; rawText?: string; rawBlobPath?: string }) =>
    call<{ fragment: { id: string }; items: ItemWithSources[] }>('/api/fragments', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  listFragments: () =>
    call<{ fragments: Fragment[] }>('/api/fragments'),

  getFragment: (id: string) =>
    call<{ fragment: Fragment }>(`/api/fragments/${id}`),

  serverUrl: BASE,
}

/** 五页与角标共用的缓存键。SSE 广播「变了」时整棵失效。 */
export const queryKeys = {
  items: ['items'] as const,
  item: (id: string) => ['items', id] as const,
}
