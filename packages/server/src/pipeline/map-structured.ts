import type { Ctx, Fragment } from '@flowpal/shared'
import { mapPortalSchedule, type MappedItem } from '../sync/map.ts'
import { parseSchedule } from '../sync/portal.ts'

/**
 * 结构化碎片 → 条目候选，不经模型。
 *
 * 课表、校历、系统日历拉回来已经是准确的结构，喂给模型只会让它变得不准，还慢、
 * 还花钱。碎片照样落库（raw_type='structured'，原始 JSON 存在 raw_text 里，满足
 * 原文永不删除），但到条目走这条确定性的路。
 *
 * 每条候选带 `externalId`，落库走 `applyMapped` → `upsertByExternalId`：同一份
 * 课表连拉两次不新增条目，字段变了写一行 item_history。定时同步和手动投放一份
 * 结构化碎片走的是同一段，所以那条不变量只有一处需要成立。
 */
export function mapStructured(ctx: Ctx, fragment: Fragment): MappedItem[] {
  if (fragment.rawType !== 'structured') {
    throw new Error(`mapStructured 只接结构化碎片，收到 ${fragment.rawType}`)
  }
  if (fragment.rawText === null) {
    throw new Error(`结构化碎片 ${fragment.id} 没有 raw_text`)
  }

  const payload = JSON.parse(fragment.rawText) as { kind?: string; weeks?: unknown }
  switch (payload.kind) {
    case 'ruc-portal-schedule': {
      // 门户的日程中心一个接口给三样：课表（-2）、校历（-5）、我的日历（0）。
      // 原文按周分段存着，因为服务端在长区间上会悄悄把课表那一类整个丢掉。
      if (!Array.isArray(payload.weeks)) {
        throw new Error(`${fragment.id} 的 weeks 不是数组`)
      }
      const events = payload.weeks.flatMap((week) =>
        parseSchedule((week as { body: unknown }).body),
      )
      return mapPortalSchedule(ctx, events)
    }
    default:
      throw new Error(
        `未知的结构化来源 kind=${payload.kind}。` +
        `现在只认 ruc-portal-schedule（见 packages/server/src/sync/）。`,
      )
  }
}
