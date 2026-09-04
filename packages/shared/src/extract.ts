import { z } from 'zod'
import { CitableField, Confidence, DatePrecision, ItemType } from './item.ts'

/**
 * 抽取输出契约。这一份 zod schema 同时是三样东西：
 *   1. 发给模型的 strict json_schema
 *   2. TS 类型
 *   3. 入库前的校验器
 * 同一个事实只在一处陈述。
 *
 * strict 模式要求每个属性都出现在 required 里、且 additionalProperties: false，
 * 所以可选字段一律 `.nullable()` 而不是 `.optional()`——写成 optional 第一次调用就会被 API 拒掉。
 */
export const ExtractedCitation = z.object({
  field: CitableField,
  /** 逐字片段。不给字符偏移：模型数偏移不可靠，偏移由我们 indexOf 出来。 */
  quote: z.string(),
}).strict()

export const ExtractedItem = z.object({
  type: ItemType,
  /** 展示给用户的那一句话。语气规则对它同样生效：在场而不评判，不责备、不催。 */
  title: z.string(),
  /** 绝对时间，由模型结合 now 与校历算好 */
  starts_at: z.string().nullable(),
  due_at: z.string().nullable(),
  date_precision: DatePrecision.nullable(),
  /** 原始表达，如「第8周周三」。算错了用户照着它改。 */
  date_raw: z.string().nullable(),
  /** RFC 5545 RRULE 串。识别到「每周 / 每两周 / 每天」时填，填了就不必编一个具体日期。 */
  recurrence: z.string().nullable(),
  location: z.string().nullable(),
  confidence: Confidence,
  /** 日期单独一个置信度：整体看得懂、但「第 8 周周三」算得没把握，是常见情况。 */
  date_confidence: Confidence.nullable(),
  citations: z.array(ExtractedCitation),
}).strict()

/** 一条碎片可产出多条条目，也可以产出零条（截图里全是废话）。零条是正常结果，不是错误。 */
export const ExtractOutput = z.object({
  items: z.array(ExtractedItem),
}).strict()

export type ExtractedItem = z.infer<typeof ExtractedItem>
export type ExtractOutput = z.infer<typeof ExtractOutput>

/** 供 response_format: { type: 'json_schema', json_schema: { strict: true, schema } } 使用。 */
export function extractJsonSchema() {
  return z.toJSONSchema(ExtractOutput, { target: 'draft-2020-12' })
}
