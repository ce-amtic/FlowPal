import type { Api } from '../api.ts'
import { AGENDA, FRAGMENTS, HISTORY, ITEMS, NOW, PROJECTS, PROJECT_CARDS, RECENT } from './data.ts'
import type { FocusSession } from '@flowpal/shared'

/**
 * 样例模式下的接口实现。它和真实实现共用同一个 Api 类型——语义层的形状一变，
 * 这里编译不过，所以样例数据不会悄悄落后于契约。
 *
 * 写操作不落任何地方：样例模式是用来对版式的，不是用来试流程的。
 */
/** 只用来表示「向导早就走完了」，具体是哪天不重要，界面上也不显示 */
const SETTLED_LONG_AGO = '2026-08-16T09:00:00+08:00'

const delay = <T>(value: T): Promise<T> =>
  new Promise((resolve) => setTimeout(() => resolve(value), 120))

export const mockApi: Api = {
  listItems: () => delay({ items: ITEMS }),

  getItem: (id) => {
    const item = ITEMS.find((i) => i.id === id)
    if (!item) return Promise.reject(new Error(`样例数据里没有条目 ${id}`))
    return delay({ item, history: HISTORY[id] ?? [] })
  },

  getFragment: (id) => {
    const fragment = FRAGMENTS.find((f) => f.id === id)
    if (!fragment) return Promise.reject(new Error(`样例数据里没有碎片 ${id}`))
    return delay({ fragment })
  },

  patchItem: (id) => {
    const item = ITEMS.find((i) => i.id === id)
    if (!item) return Promise.reject(new Error(`样例数据里没有条目 ${id}`))
    return delay({ item })
  },

  throwIn: () => Promise.reject(new Error('样例模式下不写入数据。')),
  // 样例模式下投放本身就被挡住了，不会有 run 可等
  awaitRun: () => Promise.reject(new Error('样例模式下不写入数据。')),

  getNow: () => delay(NOW),

  refreshNow: () => Promise.reject(new Error('样例模式下不重新判断。')),

  listRecent: () => delay({ recent: RECENT }),

  getRecent: () => delay({ recent: RECENT }),

  getAgenda: () => delay(AGENDA),

  getAgendaRange: () => delay(AGENDA),

  listProjects: () => delay({
    projects: PROJECT_CARDS,
    unclassified: ITEMS.filter(
      (i) => i.projectId === null && i.type !== 'thought' && i.status === 'active',
    ),
  }),

  getProject: (id) => {
    const project = PROJECTS.find((p) => p.id === id)
    if (!project) return Promise.reject(new Error(`样例数据里没有项目 ${id}`))
    return delay({ project, items: ITEMS.filter((i) => i.projectId === id) })
  },

  listConfirmations: () => {
    const items = ITEMS.filter((i) => i.status === 'needs_confirm')
    return delay({ items, count: items.length })
  },

  // 样例模式下向导已经走完，否则一开界面就是欢迎页，对不了版式
  patchSettings: () => Promise.reject(new Error('样例模式下不写入数据。')),

  // 样例模式下当作已经登录、刚同步过：这一页的版式要在有内容时对得上。
  getSyncStatus: () => delay({
    state: 'ok' as const,
    at: SETTLED_LONG_AGO,
    message: '新增 0 条 · 更新 24 条',
    sources: [
      { label: '课表与校历', created: 0, updated: 24, state: 'ok' as const, note: null },
      { label: '通知公告', created: 1, updated: 0, state: 'ok' as const, note: null },
      { label: '邮件（2021xxxxxx@ruc.edu.cn）', created: 2, updated: 0, state: 'ok' as const, note: null },
    ],
    signedIn: true,
    signedInAt: SETTLED_LONG_AGO,
  }),

  syncNow: () => Promise.reject(new Error('样例模式下不写入数据。')),

  signOutOfRuc: () => Promise.reject(new Error('样例模式下不写入数据。')),

  // 两个账号，一个正常一个锁着——这一页要在两种状态并存时也对得上版式。
  listMailAccounts: () => delay({
    accounts: [
      {
        id: 'mal_ruc', host: 'imap.ruc.edu.cn', port: 993,
        username: '2021xxxxxx@ruc.edu.cn', perRun: 3, enabled: true, unlocked: true,
      },
      {
        id: 'mal_gmail', host: 'imap.gmail.com', port: 993,
        username: 'me@gmail.com', perRun: 2, enabled: true, unlocked: false,
      },
    ],
  }),

  addMailAccount: () => Promise.reject(new Error('样例模式下不写入数据。')),
  patchMailAccount: () => Promise.reject(new Error('样例模式下不写入数据。')),
  removeMailAccount: () => Promise.reject(new Error('样例模式下不写入数据。')),
  testMailAccount: () => Promise.reject(new Error('样例模式下不写入数据。')),

  postFocusSession: () => Promise.reject(new Error('样例模式下不写入数据。')),

  uploadImage: () => Promise.reject(new Error('样例模式下不写入数据。')),

  listThoughts: () => delay({
    thoughts: ITEMS.filter((i) => i.type === 'thought' && i.status === 'active'),
  }),

  listFocusSessions: () => delay({ sessions: [] as FocusSession[] }),

  startFocus: () => Promise.reject(new Error('样例模式不写入。要试专注请关掉它。')),

  endFocus: () => Promise.reject(new Error('样例模式不写入。要试专注请关掉它。')),

  getSettings: () => delay({
    settings: {
      revision: 0,
      updatedAt: null,
      text: { baseUrl: '', model: '', apiKeyConfigured: false },
      vision: { baseUrl: '', model: '', apiKeyConfigured: false },
      ruc: { authorized: false, role: null, lastSessionAt: null },
      chronotype: { workdayWakeTime: null, freeDayWakeTime: null },
      sync: { enabled: false, intervalMinutes: 360 },
      chronotype_workday_wake: '07:30',
      chronotype_restday_wake: '10:00',
      onboarded_at: SETTLED_LONG_AGO,
    },
    sync: { runningRunId: null, nextRunAt: null, capabilities: [], recentRuns: [] },
  }),

  saveSettings: () => Promise.reject(new Error('样例模式不写入。要试设置请关掉它。')),

  getSyncRunStatus: () => delay({
    status: { runningRunId: null, nextRunAt: null, capabilities: [], recentRuns: [] },
  }),

  runSync: () => Promise.reject(new Error('样例模式不写入。要试同步请关掉它。')),

  serverUrl: '',
}
