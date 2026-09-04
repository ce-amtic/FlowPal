import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { SCHEMA } from './schema.ts'

/**
 * node:sqlite 是 Node 内置的，不装原生模块、不走 electron-rebuild。
 * 已验证 Electron 44（Node 24.20）的主进程里可用。
 */
export function openDb(dataDir: string): DatabaseSync {
  mkdirSync(dataDir, { recursive: true })
  const db = new DatabaseSync(join(dataDir, 'flowpal.db'))
  db.exec(SCHEMA)
  return db
}

/** 不用时间戳做 id：时钟只在请求入口读一次，其余地方一律不碰。 */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`
}
