import type { DatabaseSync } from 'node:sqlite'
import type { Ctx } from '@flowpal/shared'
import { newId } from './db.ts'

/**
 * 邮箱账号。
 *
 * `passwordCipher` 是桌面端用系统钥匙串加过的密文，**这个进程解不开它**——
 * server 不依赖 Electron，钥匙也不在库里。明文由桌面端解密后单独推进来，只活在
 * 内存里（sync/secrets.ts）。这张表因此可以随库一起躺在盘上而不等于泄露授权码。
 */
export type MailAccount = {
  id: string
  host: string
  port: number
  username: string
  /** base64。给桌面端拿去解密用，server 自己只是搬运它 */
  passwordCipher: string
  perRun: number
  enabled: boolean
  /** 已经处理到的最大 IMAP UID */
  watermark: number
  createdAt: string
  updatedAt: string
}

export type NewMailAccount = {
  host: string
  port: number
  username: string
  passwordCipher: string
  perRun: number
}

export function listMailAccounts(db: DatabaseSync): MailAccount[] {
  const rows = db.prepare(
    `SELECT * FROM mail_accounts ORDER BY created_at`,
  ).all() as Record<string, any>[]
  return rows.map(rowToAccount)
}

export function getMailAccount(db: DatabaseSync, id: string): MailAccount | null {
  const row = db.prepare(`SELECT * FROM mail_accounts WHERE id = ?`).get(id) as
    Record<string, any> | undefined
  return row ? rowToAccount(row) : null
}

export function createMailAccount(
  db: DatabaseSync, ctx: Ctx, input: NewMailAccount,
): MailAccount {
  const id = newId('mal')
  db.prepare(
    `INSERT INTO mail_accounts
       (id, host, port, username, password_cipher, per_run, enabled, watermark, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`,
  ).run(id, input.host, input.port, input.username, input.passwordCipher, input.perRun, ctx.now, ctx.now)
  return getMailAccount(db, id)!
}

const PATCHABLE: Record<string, string> = {
  host: 'host',
  port: 'port',
  username: 'username',
  passwordCipher: 'password_cipher',
  perRun: 'per_run',
  enabled: 'enabled',
}

export function updateMailAccount(
  db: DatabaseSync, ctx: Ctx, id: string, patch: Record<string, string | number | boolean>,
): MailAccount {
  if (getMailAccount(db, id) === null) throw new Error(`邮箱账号不存在：${id}`)
  for (const [field, value] of Object.entries(patch)) {
    const column = PATCHABLE[field]
    if (column === undefined) throw new Error(`不可改的字段：${field}`)
    db.prepare(`UPDATE mail_accounts SET ${column} = ?, updated_at = ? WHERE id = ?`)
      .run(typeof value === 'boolean' ? Number(value) : value, ctx.now, id)
  }
  return getMailAccount(db, id)!
}

/**
 * 账号真的删掉，不是标记。
 *
 * 与条目那条「只标不删」的规矩不冲突：条目是理解出来的结果，删了就再也说不清
 * 它当初从哪来；账号是一份配置，用户说不要了就是不要了。它已经产出的碎片与条目
 * 照旧留在库里——那些是原文，本来就永不删除。
 */
export function deleteMailAccount(db: DatabaseSync, id: string): void {
  db.prepare(`DELETE FROM mail_accounts WHERE id = ?`).run(id)
}

export function setMailWatermark(db: DatabaseSync, ctx: Ctx, id: string, uid: number): void {
  db.prepare(`UPDATE mail_accounts SET watermark = ?, updated_at = ? WHERE id = ?`)
    .run(uid, ctx.now, id)
}

function rowToAccount(row: Record<string, any>): MailAccount {
  return {
    id: row.id,
    host: row.host,
    port: row.port,
    username: row.username,
    passwordCipher: row.password_cipher,
    perRun: row.per_run,
    enabled: row.enabled === 1,
    watermark: row.watermark,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
