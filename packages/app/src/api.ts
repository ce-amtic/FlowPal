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
  // 另一套同步实现（sync/runner.ts）的状态形状。界面用的是本文件里那个同名类型，
  // 两者不是一回事，所以这一个在这里改个名字
  SyncStatus as SyncRunnerStatus,
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
  days: {
    day: string
    items: AgendaEntry[]
    /** 那天发生的重复项。不占条目位置，界面压成这一天顶上的细带 */
    recurring: AgendaEntry[]
  }[]
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

/**
 * 一次投放的终局，只有这两样。
 *
 * 不还一个完整的 Run：结束那条事件里没有 fragmentId、没有起止时间，凑一个出来
 * 就是在类型上撒谎。要全的去 /api/recent 取。
 */
export type RunOutcome = { status: 'done' | 'failed'; message: string | null }

/**
 * 和外部来源同步的状态。
 *
 * **失败不重试，所以失败必须有个看得见的落点**，就是这里。设置页把它显示成
 * 「上次同步 09:12 · 需要重新登录」。桌宠不为后台同步失败弹东西。
 */
/**
 * 一路来源这一轮的结果。
 *
 * `idle` 与 `failed` 是两件事：邮件没配、第一次同步只记水位，都是正常状态；
 * 登录过期、接口变了才是失败。合成一个的话，第一次同步会被报成失败。
 */
export type SyncSourceResult = {
  label: string
  created: number
  updated: number
  state: 'ok' | 'idle' | 'failed'
  /** 非 ok 时的那一句话 */
  note: string | null
}

export type SyncStatus = {
  /** never = 一次都没同步过；expired = 登录态失效，要重新登录 */
  state: 'never' | 'ok' | 'expired' | 'error'
  at: string | null
  message: string | null
  sources: SyncSourceResult[]
  signedIn: boolean
  signedInAt: string | null
}

/**
 * 一个邮箱账号。
 *
 * **既没有密文也没有明文。** 密文只在桌面端与 server 之间走，界面没有任何理由
 * 见到它；明文只在用户刚打完字的那一刻存在于表单里，送出去就没了。
 */
export type MailAccount = {
  id: string
  host: string
  port: number
  username: string
  /** 一轮至多读几封。读邮件要过模型，这是花销上限 */
  perRun: number
  enabled: boolean
  /**
   * server 手上有没有这个账号的授权码明文。
   *
   * 冷启动之后由桌面端解密推进来。为假时这个账号这一轮会被跳过，设置页显示
   * 「需要在桌面应用里解锁」——那与「授权码不对」是两回事，下一步也不同。
   */
  unlocked: boolean
}

export type NewMailAccount = {
  host: string
  port: number
  username: string
  /** 系统钥匙串加密后的 base64。落库的是它 */
  passwordCipher: string
  /** 同一串授权码的明文。只进 server 的内存，不落库 */
  password: string
  perRun: number
}

export type Api = {
  listItems: () => Promise<{ items: ItemWithSources[] }>
  getItem: (id: string) => Promise<{ item: ItemWithSources; history: ItemHistoryRow[] }>
  getFragment: (id: string) => Promise<{ fragment: Fragment }>
  patchItem: (id: string, patch: Record<string, string | null>) => Promise<{ item: ItemWithSources }>
  /**
   * 投一条进去。
   *
   * 要经模型的（文字、图片）立刻返回，循环在服务端接着跑——拿 run.id 订阅
   * `/api/runs/:id/events` 才看得见它这几十秒里在看什么，抽出的条目由 SSE 那条
   * 「变了」让各页自己重取。结构化的（课表、ICS）不经模型，当场就跑完了，
   * `items` 只在这种时候有。
   */
  throwIn: (body: {
    source: string
    rawType: string
    rawText?: string
    rawBlobPath?: string
  }) => Promise<{ fragment: Fragment; run: Run; items?: ItemWithSources[] }>
  /**
   * 等这次投放跑完，拿回终局的 run。
   *
   * 投放立刻返回，所以刚拿到的那个 run 一定是 running、message 一定是空。想在
   * 一处交代「结果如何」的地方（桌宠的回执、快捷键的回执）就得等它一等。
   */
  awaitRun: (runId: string) => Promise<RunOutcome>
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
  // `sync` 这一项是另一套同步实现的运行状态，跟设置页显示的那个同步状态不是一回事
  getSettings: () => Promise<{ settings: Settings; sync: SyncRunnerStatus }>
  saveSettings: (patch: SettingsPatch) => Promise<{ settings: SettingsPublic; sync: SyncRunnerStatus }>
  /**
   * 同步运行的历史与来源能力，来自另一套同步实现（`sync/runner.ts`）。它没有接线，
   * 界面上的同步状态走下面那个 `getSyncStatus`。
   */
  getSyncRunStatus: () => Promise<{ status: SyncRunnerStatus }>
  runSync: (
    source?: 'ruc.portal' | 'ruc.graduate' | null,
    mode?: 'online' | 'fixture',
    options?: { payload?: unknown; term?: { code: string; name: string } },
  ) => Promise<{ run?: SyncRun; runId?: string; imported?: number }>
  patchSettings: (patch: Partial<Record<keyof Settings, string>>) => Promise<{ settings: Settings }>
  getSyncStatus: () => Promise<SyncStatus>
  /** 现在就同步一次。正在跑时服务端回 409，调用方不重试——那一轮会把活干完 */
  syncNow: () => Promise<{ state: string; message: string; status: SyncStatus }>
  signOutOfRuc: () => Promise<{ status: SyncStatus }>
  listMailAccounts: () => Promise<{ accounts: MailAccount[] }>
  addMailAccount: (account: NewMailAccount) => Promise<{ account: MailAccount }>
  patchMailAccount: (
    id: string, patch: Partial<NewMailAccount> & { enabled?: boolean },
  ) => Promise<{ account: MailAccount }>
  removeMailAccount: (id: string) => Promise<{ accounts: MailAccount[] }>
  /** 当场连一次。主机写错、端口不对、授权码填成登录密码，在状态行上长得一样 */
  testMailAccount: (id: string) => Promise<{ ok: boolean; unseen?: number; message?: string }>
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
  awaitRun: (runId) => new Promise((resolve, reject) => {
    // 这条流会把已经发生过的事件重放一遍，所以订阅晚了也不会错过结束那一下
    const source = new EventSource(`${BASE}/api/runs/${runId}/events`)
    source.onmessage = (ev) => {
      const e = JSON.parse(ev.data) as Record<string, unknown>
      if (e.type !== 'run_finished') return
      source.close()
      resolve({
        status: e.status === 'done' ? 'done' : 'failed',
        message: typeof e.message === 'string' ? e.message : null,
      })
    }
    // 连不上就说连不上。装作跑完了，回执上那句话就是编的
    source.onerror = () => { source.close(); reject(new Error('与本机服务的连接中断。')) }
  }),
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
  getSyncRunStatus: () => call('/api/sync/status'),
  runSync: (source = null, mode = 'online', options = {}) => call('/api/sync/run', {
    method: 'POST', body: JSON.stringify({ source, mode, ...options }),
  }),
  patchSettings: (patch) => call('/api/settings', { method: 'PATCH', body: JSON.stringify(patch) }),
  getSyncStatus: () => call('/api/sync'),
  syncNow: () => call('/api/sync', { method: 'POST' }),
  signOutOfRuc: () => call('/api/sync/session', { method: 'DELETE' }),
  listMailAccounts: () => call('/api/mail-accounts'),
  addMailAccount: (account) =>
    call('/api/mail-accounts', { method: 'POST', body: JSON.stringify(account) }),
  patchMailAccount: (id, patch) =>
    call(`/api/mail-accounts/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  removeMailAccount: (id) => call(`/api/mail-accounts/${id}`, { method: 'DELETE' }),
  testMailAccount: (id) => call(`/api/mail-accounts/${id}/test`, { method: 'POST' }),
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
  sync: ['sync'] as const,
  mailAccounts: ['mail-accounts'] as const,
}
