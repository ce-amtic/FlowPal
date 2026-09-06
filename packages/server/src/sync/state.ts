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

/**
 * 一路来源这一轮的结果。
 *
 * **`idle` 与 `failed` 必须分开。** 邮件没配、通知配额设成 0、第一次同步只记水位
 * ——这些都是「这一路这次没做事」，是正常状态；登录过期、接口变了才是失败。
 * 用同一个字段表示两者的话，第一次同步就会把整轮报成失败，而它其实一切正常。
 */
export type SyncSourceResult = {
  label: string
  created: number
  updated: number
  state: 'ok' | 'idle' | 'failed'
  /** 非 ok 时的那一句话。ok 时为 null */
  note: string | null
}

export function ok(label: string, created: number, updated: number): SyncSourceResult {
  return { label, created, updated, state: 'ok', note: null }
}

export function idle(label: string, note: string): SyncSourceResult {
  return { label, created: 0, updated: 0, state: 'idle', note }
}

export function failed(label: string, note: string): SyncSourceResult {
  return { label, created: 0, updated: 0, state: 'failed', note }
}

/**
 * 一轮的总状态与那一句话。
 *
 * 只有 `failed` 才算这一轮失败——第一次同步里通知那一路只记水位、邮件根本没配，
 * 两者都是 `idle`，而它们本不该让用户在设置页上看到「同步失败」。
 *
 * 坏了的时候报第一条的原因而不是「有 1 路失败」：用户要的是下一步该动哪儿。
 */
export function summarize(sources: SyncSourceResult[]): { state: 'ok' | 'error'; message: string } {
  const broken = sources.filter((s) => s.state === 'failed')
  if (broken.length > 0) return { state: 'error', message: broken[0]!.note! }

  const created = sources.reduce((n, s) => n + s.created, 0)
  const updated = sources.reduce((n, s) => n + s.updated, 0)
  return { state: 'ok', message: `新增 ${created} 条 · 更新 ${updated} 条` }
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

