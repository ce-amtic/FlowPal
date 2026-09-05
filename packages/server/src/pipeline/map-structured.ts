import type { Ctx, ExtractedItem, Fragment } from '@flowpal/shared'
import { ExternalRecordSchema } from '../sync/types.ts'
import { externalRecordToExtractedItem } from '../sync/structured-import.ts'

/**
 * 结构化碎片 → 条目候选，不经模型。
 *
 * 课表、考试安排、ICS 拉回来已经是准确的结构，喂给模型只会让它变得不准，还慢、还花钱。
 * 碎片照样落库（raw_type='structured'，原始 JSON 存在 raw_text 里），
 * 但到条目走这条确定性的路。
 *
 * RUC portal/graduate structured batches are handled below. Other structured
 * sources keep failing loudly until their own adapter is added.
 */
export function mapStructured(_ctx: Ctx, fragment: Fragment): ExtractedItem[] {
  // A local .ics import keeps raw_type='file' for provenance, but its
  // preprocessor stores the same validated external-records payload used by
  // RUC structured fragments.  Do not force the caller to lose the original
  // file kind merely to reuse this deterministic mapper.
  if (fragment.rawType !== 'structured' && fragment.rawType !== 'file') {
    throw new Error(`mapStructured 只接结构化或 ICS 文件碎片，收到 ${fragment.rawType}`)
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
  const candidate = payload as { schema?: unknown; records?: unknown }
  if (candidate.schema !== 'flowpal.ruc.external-records.v1') {
    throw new Error(
      `未知的结构化来源 schema=${String(candidate.schema)}；` +
      `课表 / 日程 / 考试的 mapper 尚未覆盖该形状。`,
    )
  }
  if (!Array.isArray(candidate.records)) {
    throw new Error(`结构化碎片 ${fragment.id} 的 records 不是数组`)
  }
  return candidate.records.map((record, index) => {
    const parsed = ExternalRecordSchema.safeParse(record)
    if (!parsed.success) {
      throw new Error(`结构化碎片 ${fragment.id} records[${index}] 不符合 ExternalRecord：${parsed.error.message}`)
    }
    return externalRecordToExtractedItem(parsed.data, fragment.rawText!)
  })
}
