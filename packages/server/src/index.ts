import { serve } from '@hono/node-server'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CalendarSchema } from '@flowpal/shared'
import { assertLanBindingIsAuthenticated, ServerConfig } from './config.ts'
import { openDb } from './store/db.ts'
import { createRoutes, type RouteDependencies } from './routes/index.ts'
import { getSettings } from './store/settings.ts'
import { createSyncScheduler } from './sync/scheduler.ts'

export { ServerConfig } from './config.ts'

export type RunningServer = {
  url: string
  close: () => void
}

/**
 * 起 server。这是包的入口，desktop 与独立进程都调它。
 *
 * 环境相关的一切从 config 传入——所以这个包不需要知道 Electron 存在，
 * 将来把 packages/server 与 packages/shared 拷进新仓库就是一个独立后端。
 */
export function createServer(input: unknown, dependencies: RouteDependencies = {}): RunningServer {
  const config = ServerConfig.parse(input)
  assertLanBindingIsAuthenticated(config)

  const calendar = CalendarSchema.parse(JSON.parse(readFileSync(config.calendarPath, 'utf8')))
  const db = openDb(config.dataDir)
  const app = createRoutes(db, config, calendar, dependencies)

  const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port })
  // Scheduling is enabled only when the Electron-owned broker is injected.
  // Standalone/browser mode remains deterministic and manual; it never emits
  // periodic fake "unsupported" runs. Each cycle is single-flight and a
  // failed request waits for the next normal interval (no immediate retry).
  const scheduler = dependencies.rucBroker
    ? createSyncScheduler({
      intervalMs: () => getSettings(db, config).sync.intervalMinutes * 60_000,
      run: async () => {
        const settings = getSettings(db, config)
        // Do not turn an absent/expired desktop session into periodic
        // unsupported runs.  The user must explicitly authorize RUC before a
        // background cycle is allowed to touch the broker.
        if (!settings.sync.enabled || !settings.ruc.authorized) return
        const headers: Record<string, string> = { 'content-type': 'application/json' }
        if (config.token) headers.authorization = `Bearer ${config.token}`
        // 0.0.0.0 is a bind address, not a reliable client destination on all
        // platforms. Keep the internal request on the loopback interface.
        const loopbackHost = config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host
        const response = await fetch(`http://${loopbackHost}:${config.port}/api/sync/run`, {
          method: 'POST', headers, body: JSON.stringify({ source: null, mode: 'online' }),
        })
        if (!response.ok) throw new Error(`scheduled sync HTTP ${response.status}`)
      },
    })
    : null
  scheduler?.start()
  return {
    url: `http://${config.host}:${config.port}`,
    close: () => {
      scheduler?.stop()
      server.close()
      db.close()
    },
  }
}

/**
 * 从仓库根读 config.local.json，补上路径类的默认值。
 * 调用方（desktop / 独立进程）可以覆盖任何一项——例如 desktop 把 dataDir 指到 userData。
 */
export function loadConfig(repoRoot: string, overrides: Record<string, unknown> = {}): unknown {
  const path = join(repoRoot, 'config.local.json')
  let file: Record<string, unknown>
  try {
    file = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    // 大声失败：没有配置就没有模型 key，管道跑不了。不给默认值蒙混过去。
    throw new Error(`读不到 ${path}。把 config.example.json 拷成 config.local.json 再填。`)
  }
  return {
    dataDir: join(repoRoot, 'data'),
    promptsDir: join(repoRoot, 'prompts'),
    calendarPath: join(repoRoot, 'data', 'calendar.json'),
    ...file,
    ...overrides,
  }
}
