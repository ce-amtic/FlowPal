import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { SCHEMA } from './schema.ts'

/**
 * node:sqlite 是 Node 内置的，不装原生模块、不走 electron-rebuild。
 * 已验证 Electron 44（Node 24.20）的主进程里可用。
 */
/**
 * schema 版本。表形状变了就 +1——现在库里还没有真实数据，旧形状的库直接拒绝并提示
 * 重建，不做迁移（demo:reset 上线后它就是重建工具）。内存库（':memory:'）供断言用。
 */
const SCHEMA_VERSION = 3

export function openDb(dataDir: string): DatabaseSync {
  const db = dataDir === ':memory:'
    ? new DatabaseSync(':memory:')
    : (() => {
        mkdirSync(dataDir, { recursive: true })
        return new DatabaseSync(join(dataDir, 'flowpal.db'))
      })()

  const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
  const hasTables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'fragments'",
  ).get() !== undefined
  if (hasTables && version !== SCHEMA_VERSION) {
    // 先关再抛：Windows 上开着句柄抛错，文件删不掉，连「删库重建」都会卡住。
    db.close()
    throw new Error(
      `数据库是旧形状（schema v${version}，当前 v${SCHEMA_VERSION}），不做静默迁移。` +
      `库里还没有真实数据，删掉 ${join(dataDir, 'flowpal.db')} 重启即可（demo:reset 上线后用它重建）。`,
    )
  }

  db.exec(SCHEMA)
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
  return db
}

/** 不用时间戳做 id：时钟只在请求入口读一次，其余地方一律不碰。 */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`
}
