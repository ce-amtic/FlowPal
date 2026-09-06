import { createHash } from 'node:crypto'
import { ExternalShapeError } from '../types.ts'

export type JsonObject = Record<string, unknown>

export function parseJsonInput(input: unknown, label: string): unknown {
  if (typeof input !== 'string') return input
  try {
    return JSON.parse(input) as unknown
  } catch (error) {
    throw new ExternalShapeError(`${label} 不是有效 JSON：${error instanceof Error ? error.message : String(error)}`)
  }
}

export function asObject(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ExternalShapeError(`${label} 应为对象，收到 ${describeType(value)}`)
  }
  return value as JsonObject
}

export function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new ExternalShapeError(`${label} 应为数组，收到 ${describeType(value)}`)
  }
  return value
}

export function requiredText(value: unknown, field: string, options: { allowEmpty?: boolean } = {}): string {
  if (value === null || value === undefined) {
    throw new ExternalShapeError(`${field} 缺失`)
  }
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new ExternalShapeError(`${field} 应为字符串，收到 ${describeType(value)}`)
  }
  const text = String(value).trim()
  const normalized = text === 'null' ? '' : text
  if (!options.allowEmpty && normalized.length === 0) {
    throw new ExternalShapeError(`${field} 不能为空`)
  }
  // Upstream occasionally serializes the literal string "null".
  return normalized
}

export function optionalText(value: unknown, field: string): string {
  if (value === null || value === undefined) return ''
  return requiredText(value, field, { allowEmpty: true })
}

export function requiredInt(value: unknown, field: string): number {
  const n = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^[-+]?\d+$/.test(value.trim())
      ? Number(value.trim())
      : Number.NaN
  if (!Number.isInteger(n)) throw new ExternalShapeError(`${field} 应为整数`)
  return n
}

export function optionalInt(value: unknown, field: string): number | null {
  if (value === null || value === undefined || value === '') return null
  return requiredInt(value, field)
}

/** Parse the RUC APIs' Asia/Shanghai `YYYY-MM-DD HH:mm:ss` form strictly. */
export function parseShanghaiDateTime(value: unknown, field: string): Date {
  const text = requiredText(value, field)
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(text)
  if (!match) throw new ExternalShapeError(`${field} 不是 YYYY-MM-DD HH:mm:ss：${text}`)
  const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3])
  const hour = Number(match[4] ?? 0); const minute = Number(match[5] ?? 0); const second = Number(match[6] ?? 0)
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month) || hour > 23 || minute > 59 || second > 59) {
    throw new ExternalShapeError(`${field} 不是有效的上海本地时刻：${text}`)
  }
  return new Date(Date.UTC(year, month - 1, day, hour - 8, minute, second))
}

export function parseShanghaiDay(value: unknown, field: string): Date {
  return parseShanghaiDateTime(value, field)
}

export function isoShanghai(date: Date): string {
  // The date is kept as an instant, but the contract deliberately exposes the
  // campus local offset so consumers do not accidentally reinterpret midnight.
  const shifted = new Date(date.getTime() + 8 * 3_600_000)
  return shifted.toISOString().replace(/\.\d{3}Z$/, '+08:00')
}

export function localDate(date: Date): string {
  return isoShanghai(date).slice(0, 10)
}

export function addLocalDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000)
}

export function localDateFromYmd(value: string): Date {
  return parseShanghaiDateTime(`${value} 00:00:00`, '日期')
}

export function formatDateOnly(date: Date): string {
  return localDate(date)
}

export function describeType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/** Stable fallback for portal rows whose legacy id is 0 or missing. */
export function shortHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16)
}

export function encodeKeyPart(value: string): string {
  // URI encoding keeps IDs readable while preventing room names/slashes from
  // changing the number of key segments.
  return encodeURIComponent(value)
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}
