import type { Ctx, Fragment } from '@flowpal/shared'
import { mapPortalSchedule, type MappedItem } from '../sync/map.ts'
import { parseSchedule } from '../sync/portal.ts'
import { ExternalRecordSchema } from '../sync/types.ts'
import { externalRecordToExtractedItem } from '../sync/structured-import.ts'

/**
 * 结构化碎片 → 条目候选，不经模型。
 *
 * 课表、校历、系统日历拉回来已经是准确的结构，喂给模型只会让它变得不准，还慢、
 * 还花钱。碎片照样落库（原始 JSON 存在 raw_text 里，满足原文永不删除），但到条目
 * 走这条确定性的路。
 *
 * 每条候选带 `externalId`，落库走 `applyMapped` → `upsertByExternalId`：同一份
 * 课表连拉两次不新增条目，字段变了写一行 item_history。定时同步和手动投放一份
 * 结构化碎片走的是同一段，所以那条不变量只有一处需要成立。
 *
 * 两种形状进得来，因为它们来自两条路：门户日程中心按周分段的原始响应，以及拖进来的
 * `.ics` 被预处理成的那份外部记录清单。后者的碎片保留 `raw_type='file'`——用户拖进来
 * 的是一个文件，来源要看得出是文件。
 */
export function mapStructured(ctx: Ctx, fragment: Fragment): MappedItem[] {
  if (fragment.rawType !== 'structured' && fragment.rawType !== 'file') {
    throw new Error(`mapStructured 只接结构化碎片或 ICS 文件碎片，收到 ${fragment.rawType}`)
  }
  if (fragment.rawText === null) {
    throw new Error(`结构化碎片 ${fragment.id} 没有 raw_text`)
  }

  let payload: unknown
  try {
    payload = JSON.parse(fragment.rawText) as unknown
  } catch (error) {
    throw new Error(`结构化碎片 ${fragment.id} 的 raw_text 不是 JSON：${String(error)}`)
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`结构化碎片 ${fragment.id} 的 payload 不是对象`)
  }

  const shape = payload as { kind?: unknown; weeks?: unknown; schema?: unknown; records?: unknown }

  if (shape.kind === 'ruc-portal-schedule') {
    // 门户的日程中心一个接口给三样：课表（-2）、校历（-5）、我的日历（0）。
    // 原文按周分段存着，因为服务端在长区间上会悄悄把课表那一类整个丢掉。
    if (!Array.isArray(shape.weeks)) {
      throw new Error(`${fragment.id} 的 weeks 不是数组`)
    }
    const events = shape.weeks.flatMap((week) => parseSchedule((week as { body: unknown }).body))
    return mapPortalSchedule(ctx, events)
  }

  if (shape.schema === 'flowpal.ruc.external-records.v1') {
    if (!Array.isArray(shape.records)) {
      throw new Error(`结构化碎片 ${fragment.id} 的 records 不是数组`)
    }
    return shape.records.map((record, index) => {
      const parsed = ExternalRecordSchema.safeParse(record)
      if (!parsed.success) {
        throw new Error(
          `结构化碎片 ${fragment.id} records[${index}] 不符合 ExternalRecord：${parsed.error.message}`,
        )
      }
      // 这一路的 externalId 由记录自己带着，覆盖语义和门户那一路是同一条
      return {
        externalId: parsed.data.externalId,
        item: externalRecordToExtractedItem(parsed.data, fragment.rawText!),
        projectName: null,
      }
    })
  }

  throw new Error(
    `未知的结构化来源（kind=${String(shape.kind)} schema=${String(shape.schema)}）。` +
    `现在认 ruc-portal-schedule 与 flowpal.ruc.external-records.v1，见 packages/server/src/sync/。`,
  )
}
