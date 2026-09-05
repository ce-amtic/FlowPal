import type { DatabaseSync } from 'node:sqlite'
import type { Ctx } from '@flowpal/shared'
import { getSetting, setSetting } from '../store/settings.ts'

/**
 * 同步的可见状态。
 *
 * **失败不重试**——下一个周期自然会再试，写重试循环只会把一个明确的失败变成一串
 * 看不见的失败。所以失败必须有个落点，就是这里：设置页读它，显示成
 * 「上次同步 09:12 · 失败：需要重新登录」。桌宠不为后台同步失败弹东西。
 */
export type SyncStatus = {
  /** never = 一次都没同步过；expired = 登录态失效，要用户重新登录 */
  state: 'never' | 'ok' | 'expired' | 'error'
  /** 上次同步的时刻，ISO8601 带 +08:00 */
  at: string | null
  /** 给用户看的一句话 */
  message: string | null
  sources: SyncSourceResult[]
  /** 有没有可用的登录态。没有时设置页显示的是「登录」而不是「同步」 */
  signedIn: boolean
  signedInAt: string | null
}

export type SyncSourceResult = {
  label: string
  created: number
  updated: number
  /** 这一路没做成时的原因。做成了为 null */
  skipped: string | null
}

const KEY = {
  state: 'sync_state',
  at: 'sync_at',
  message: 'sync_message',
  sources: 'sync_sources',
  signedInAt: 'sync_signed_in_at',
  /** 上一次拉回来的日程原文的指纹，与它对应的那条碎片 */
  scheduleHash: 'sync_schedule_hash',
  scheduleFragment: 'sync_schedule_fragment',
  /** 已经处理过的通知里最新的那条的发布时刻 */
  noticeWatermark: 'sync_notice_watermark',
  /** 已经处理过的邮件里最大的那个 UID */
  mailWatermark: 'sync_mail_watermark',
} as const

export function readSyncStatus(db: DatabaseSync, signedIn: boolean): SyncStatus {
  const state = getSetting(db, KEY.state)
  const sources = getSetting(db, KEY.sources)
  return {
    state: state === 'ok' || state === 'expired' || state === 'error' ? state : 'never',
    at: getSetting(db, KEY.at),
    message: getSetting(db, KEY.message),
    sources: sources === null ? [] : (JSON.parse(sources) as SyncSourceResult[]),
    signedIn,
    signedInAt: getSetting(db, KEY.signedInAt),
  }
}

export function writeSyncStatus(
  db: DatabaseSync, ctx: Ctx,
  state: 'ok' | 'expired' | 'error', message: string, sources: SyncSourceResult[],
): void {
  setSetting(db, ctx, KEY.state, state)
  setSetting(db, ctx, KEY.at, ctx.now)
  setSetting(db, ctx, KEY.message, message)
  setSetting(db, ctx, KEY.sources, JSON.stringify(sources))
}

export function markSignedIn(db: DatabaseSync, ctx: Ctx): void {
  setSetting(db, ctx, KEY.signedInAt, ctx.now)
}

/**
 * 上一次日程原文的指纹与碎片。
 *
 * 碎片只增、永不删，而同步每六小时跑一次。原文一个字没变还照样落一条新碎片的话，
 * 「最近」页每天会多出四条什么都没发生的记录，库也白涨。指纹相同就复用上次那条
 * 碎片——同一份原文本来就是同一条碎片。
 */
export function lastScheduleFragment(db: DatabaseSync, hash: string): string | null {
  if (getSetting(db, KEY.scheduleHash) !== hash) return null
  return getSetting(db, KEY.scheduleFragment)
}

export function rememberScheduleFragment(
  db: DatabaseSync, ctx: Ctx, hash: string, fragmentId: string,
): void {
  setSetting(db, ctx, KEY.scheduleHash, hash)
  setSetting(db, ctx, KEY.scheduleFragment, fragmentId)
}

export function noticeWatermark(db: DatabaseSync): string | null {
  return getSetting(db, KEY.noticeWatermark)
}

export function setNoticeWatermark(db: DatabaseSync, ctx: Ctx, at: string): void {
  setSetting(db, ctx, KEY.noticeWatermark, at)
}

export function mailWatermark(db: DatabaseSync): number {
  const raw = getSetting(db, KEY.mailWatermark)
  return raw === null ? 0 : Number(raw)
}

export function setMailWatermark(db: DatabaseSync, ctx: Ctx, uid: number): void {
  setSetting(db, ctx, KEY.mailWatermark, String(uid))
}
