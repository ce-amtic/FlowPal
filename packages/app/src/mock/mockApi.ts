import type { Api } from '../api.ts'
import { DROPS, ITEMS, NOW, PROJECT_DETAILS, PROJECTS } from './data.ts'

/**
 * 样例模式下的接口实现。它和真实实现共用同一个 Api 类型——接口形状一变，
 * 这里编译不过，所以样例数据不会悄悄落后于契约。
 *
 * 写操作不落任何地方：样例模式是用来对版式的，不是用来试流程的。
 */
const delay = <T>(value: T): Promise<T> =>
  new Promise((resolve) => setTimeout(() => resolve(value), 120))

export const mockApi: Api = {
  listItems: () => delay({ items: ITEMS }),

  getItem: (id) => {
    const item = ITEMS.find((i) => i.id === id)
    if (!item) return Promise.reject(new Error(`样例数据里没有条目 ${id}`))
    return delay({ item, history: [] })
  },

  patchItem: (id) => {
    const item = ITEMS.find((i) => i.id === id)
    if (!item) return Promise.reject(new Error(`样例数据里没有条目 ${id}`))
    return delay({ item })
  },

  throwIn: () => Promise.reject(new Error('样例模式不写入。要试投放请关掉它。')),

  getNow: () => delay(NOW),

  listRecent: () => delay({ drops: DROPS }),

  listProjects: () =>
    delay({ projects: PROJECTS, unassigned: ITEMS.filter(
        (i) => i.projectId === null && i.type !== 'thought' && i.status === 'active',
      ) }),

  getProject: (id) => {
    const detail = PROJECT_DETAILS[id]
    if (detail) return delay(detail)

    const project = PROJECTS.find((p) => p.id === id)
    if (!project) return Promise.reject(new Error(`样例数据里没有项目 ${id}`))

    const mine = ITEMS.filter((i) => i.projectId === id)
    return delay({
      project,
      upcoming: mine.filter((i) => i.status === 'active' && (i.startsAt ?? i.dueAt)),
      todo: mine.filter((i) => i.status === 'active' && !i.startsAt && !i.dueAt),
      done: mine.filter((i) => i.status === 'done'),
      said: [],
    })
  },

  listPending: () => delay({ items: ITEMS.filter((i) => i.status === 'needs_confirm') }),

  serverUrl: '',
}
