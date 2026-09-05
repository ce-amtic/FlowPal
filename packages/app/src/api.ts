import type {
  Citation,
  FocusResponse,
  FocusSession,
  Item,
  Project,
  Run,
  SettingsPatch,
  SettingsPublic,
  SyncRun,
  SyncStatus,
} from '@flowpal/shared'

export type { Citation, Item, Project, Run }
import { mockApi } from './mock/mockApi.ts'

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

export type ProjectCard = {
  project: Project
  unfinished: number
  done: number
  next: { id: string; type: string; title: string; at: string }[]
  said: string[]
  idleDays: number | null
  lastActivityAt: string | null
}

export type NowPick = {
  itemId: string
  title: string
  reason: string
  /** 第一步；其后是更小的切口。「更小的一步」在这里面往后走。语义层保证至少两级 */
  steps: string[]
}

export type NowView = {
  primary: NowPick | null
  alternates: NowPick[]
  energy: string | null
  /** 这次输出用了哪些材料：条目 id，或逐字事实 */
  basis: string[]
}

export type NowResponse = NowView

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
  recurring: AgendaEntry[]
}

export type AgendaResponse = AgendaView

export type FocusStartInput = {
  plannedMinutes: number
  itemId?: string | null
  projectId?: string | null
  idempotencyKey?: string | null
}

export type FocusEndInput = {
  outcome: 'done' | 'continue' | 'early_end'
  actualMinutes?: number | null
}
/**
 * 应用设置。键由服务端白名单，写错的键会被 400 挡回来。
 *
 * 作息两问的出处是 MCTQ 那两道题，`buildContext` 读它们；没填时「此刻」只能拿到
 * 「作息时间未知（先验，猜的）」。`onboarded_at` 有值就表示向导走完了。
 */
export type Settings = SettingsPublic & {
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
  }) => Promise<{ fragment: Fragment; run: Run; items: ItemWithSources[]; plans?: unknown[] }>
  getNow: () => Promise<NowView>
  /** 「重新想一个」：只清缓存，下一次取数重新生成 */
  refreshNow: () => Promise<{ ok: boolean }>
  listRecent: () => Promise<{ recent: RecentEntry[] }>
  getRecent: () => Promise<{ recent: RecentEntry[] }>
  getAgenda: () => Promise<AgendaView>
  getAgendaRange: (from?: string, to?: string) => Promise<AgendaView>
  listProjects: () => Promise<{ projects: ProjectCard[]; unclassified: ItemWithSources[] }>
  getProject: (id: string) => Promise<{ project: Project; items: ItemWithSources[] }>
  listConfirmations: () => Promise<{ items: ItemWithSources[]; count: number }>
  listThoughts: () => Promise<{ thoughts: ItemWithSources[] }>
  listFocusSessions: () => Promise<{ sessions: FocusSession[] }>
  startFocus: (input: FocusStartInput) => Promise<{ session: FocusSession }>
  endFocus: (id: string, input: FocusEndInput) => Promise<FocusResponse>
  getSettings: () => Promise<{ settings: Settings; sync: SyncStatus }>
  saveSettings: (patch: SettingsPatch) => Promise<{ settings: SettingsPublic; sync: SyncStatus }>
  getSyncStatus: () => Promise<{ status: SyncStatus }>
  runSync: (
    source?: 'ruc.portal' | 'ruc.graduate' | null,
    mode?: 'online' | 'fixture',
    options?: { payload?: unknown; term?: { code: string; name: string } },
  ) => Promise<{ run?: SyncRun; runId?: string; imported?: number }>
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

export class ApiError extends Error {
  readonly status: number
  readonly body: unknown

  constructor(method: string, path: string, status: number, body: unknown) {
    const detail = body && typeof body === 'object'
      ? ((body as Record<string, unknown>).message ?? (body as Record<string, unknown>).error)
      : undefined
    super(`${method} ${path} → ${status}${typeof detail === 'string' ? ` ${detail}` : ''}`)
    this.name = 'ApiError'
    this.status = status
    this.body = body
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  })
  const text = await res.text()
  let body: unknown = undefined
  if (text) {
    try { body = JSON.parse(text) as unknown } catch { body = text }
  }
  if (!res.ok) throw new ApiError(init?.method ?? 'GET', path, res.status, body)
  return body as T
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
  getRecent: () => call('/api/recent'),
  getAgenda: () => call('/api/agenda'),
  getAgendaRange: (from, to) => call(`/api/agenda${from || to ? `?${new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}) })}` : ''}`),
  listProjects: () => call('/api/projects'),
  getProject: (id) => call(`/api/projects/${id}`),
  listConfirmations: () => call('/api/confirmations'),
  listThoughts: () => call('/api/thoughts'),
  listFocusSessions: () => call('/api/focus'),
  startFocus: (input) => call('/api/focus', { method: 'POST', body: JSON.stringify(input) }),
  endFocus: (id, input) => call(`/api/focus/${id}/end`, { method: 'POST', body: JSON.stringify(input) }),
  getSettings: () => call('/api/settings'),
  saveSettings: (patch) => call('/api/settings', { method: 'PUT', body: JSON.stringify(patch) }),
  getSyncStatus: () => call('/api/sync/status'),
  runSync: (source = null, mode = 'online', options = {}) => call('/api/sync/run', {
    method: 'POST', body: JSON.stringify({ source, mode, ...options }),
  }),
  patchSettings: (patch) => call('/api/settings', { method: 'PATCH', body: JSON.stringify(patch) }),
  postFocusSession: (session) =>
    call('/api/focus-sessions', { method: 'POST', body: JSON.stringify(session) }),
  uploadImage: (contentType, base64) =>
    call('/api/blobs', { method: 'POST', body: JSON.stringify({ contentType, base64 }) }),
  serverUrl: BASE,
}

export const usingMock = import.meta.env.VITE_MOCK === '1'
export const api: Api = usingMock ? mockApi : realApi

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
