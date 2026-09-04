import { z } from 'zod'

/** 五类条目。分类由系统做，用户看到的只是理解后的一句话。 */
export const ItemType = z.enum(['event', 'task', 'thought', 'progress', 'state'])
export type ItemType = z.infer<typeof ItemType>

export const Confidence = z.enum(['high', 'medium', 'low'])
export type Confidence = z.infer<typeof Confidence>

/** 无时刻的日期（「10.15 期中考试」）与有时刻的必须分开，否则前者会被当成午夜。 */
export const DatePrecision = z.enum(['day', 'minute'])
export type DatePrecision = z.infer<typeof DatePrecision>

export const ItemStatus = z.enum(['active', 'done', 'dropped', 'needs_confirm'])
export type ItemStatus = z.infer<typeof ItemStatus>

export const FragmentSource = z.enum([
  'paste', 'hotkey', 'drop', 'share', 'screenshot', 'email', 'calendar', 'timetable',
])
export type FragmentSource = z.infer<typeof FragmentSource>

export const RawType = z.enum(['text', 'image', 'audio', 'file', 'structured'])
export type RawType = z.infer<typeof RawType>

/**
 * 可被引用的条目字段。做成枚举而不是自由字符串，是为了让模型无法引用一个不存在的字段——
 * 否则逐字校验会通过，但那条引用挂在空处。
 */
export const CitableField = z.enum([
  'title', 'starts_at', 'due_at', 'date_raw', 'recurrence', 'location', 'type',
])
export type CitableField = z.infer<typeof CitableField>

/** 原始碎片。只增，永不改、永不删。 */
export type Fragment = {
  id: string
  createdAt: string
  device: string
  source: FragmentSource
  rawType: RawType
  /** 文本原文 / 语音转写 / 结构化来源的原始 JSON */
  rawText: string | null
  /** 图片、文件落盘的相对路径 */
  rawBlobPath: string | null
}

/** 条目。LLM 或确定性映射的产物，用户可改、可合并、可丢弃，改动记录保留。 */
export type Item = {
  id: string
  type: ItemType
  title: string
  startsAt: string | null
  dueAt: string | null
  datePrecision: DatePrecision | null
  /** 原始表达，如「第8周周三」。解析错了用户照着它改。 */
  dateRaw: string | null
  /** RFC 5545 RRULE 串；startsAt 同时是 DTSTART。课表 ICS 进来的就是这个格式。 */
  rrule: string | null
  dateConfidence: Confidence | null
  confidence: Confidence
  location: string | null
  status: ItemStatus
  createdAt: string
  updatedAt: string
}

export type Citation = {
  itemId: string
  field: CitableField
  fragmentId: string
  /** 必须是 fragment.rawText 里的逐字片段——这是模型有没有瞎编的机器判据。 */
  quote: string
  startOffset: number
  endOffset: number
}
