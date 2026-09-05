import type { Api } from '../api.ts'
import { AGENDA, FRAGMENTS, HISTORY, ITEMS, NOW, PROJECTS, PROJECT_CARDS, RECENT } from './data.ts'

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

  getNow: () => delay(NOW),

  refreshNow: () => Promise.reject(new Error('样例模式下不重新判断。')),

  listRecent: () => delay({ recent: RECENT }),

  getAgenda: () => delay(AGENDA),

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
  getSettings: () => delay({
    settings: {
      chronotype_workday_wake: '07:30',
      chronotype_restday_wake: '10:00',
      onboarded_at: SETTLED_LONG_AGO,
    },
  }),

  patchSettings: () => Promise.reject(new Error('样例模式下不写入数据。')),

  // 样例模式下当作已经登录、刚同步过：这一页的版式要在有内容时对得上。
  getSyncStatus: () => delay({
    state: 'ok' as const,
    at: SETTLED_LONG_AGO,
    message: '新增 0 条 · 更新 24 条',
    sources: [
      { label: '课表与校历', created: 0, updated: 24, skipped: null },
      { label: '通知公告', created: 0, updated: 0, skipped: null },
      { label: '邮件', created: 0, updated: 0, skipped: '未配置' },
    ],
    signedIn: true,
    signedInAt: SETTLED_LONG_AGO,
  }),

  syncNow: () => Promise.reject(new Error('样例模式下不写入数据。')),

  signOutOfRuc: () => Promise.reject(new Error('样例模式下不写入数据。')),

  postFocusSession: () => Promise.reject(new Error('样例模式下不写入数据。')),

  uploadImage: () => Promise.reject(new Error('样例模式下不写入数据。')),

  listThoughts: () => delay({
    thoughts: ITEMS.filter((i) => i.type === 'thought' && i.status === 'active'),
  }),

  serverUrl: '',
}
