import { serve } from '@hono/node-server'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CalendarSchema } from '@flowpal/shared'
import { assertLanBindingIsAuthenticated, ServerConfig } from './config.ts'
import { openDb } from './store/db.ts'
import { createRoutes } from './routes/index.ts'

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
export function createServer(input: unknown): RunningServer {
  const config = ServerConfig.parse(input)
  assertLanBindingIsAuthenticated(config)

  const calendar = CalendarSchema.parse(JSON.parse(readFileSync(config.calendarPath, 'utf8')))
  const db = openDb(config.dataDir)
  const app = createRoutes(db, config, calendar)

  const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port })
  return {
    url: `http://${config.host}:${config.port}`,
    close: () => { server.close(); db.close() },
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
