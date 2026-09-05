import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { extname, isAbsolute } from 'node:path'
import type { ExternalRecord } from '@flowpal/shared'
import { ExternalRecord as ExternalRecordSchema } from '@flowpal/shared'

/**
 * The server only reads files explicitly handed to it by the local desktop
 * client.  Keep this limit small enough that a dropped file cannot turn a
 * local request into an unbounded memory/model call.
 */
export const LOCAL_FILE_MAX_BYTES = 8 * 1024 * 1024
export const LOCAL_ICS_MAX_EVENTS = 2_000

const TEXT_EXTENSIONS = new Set([
  '.txt', '.text', '.md', '.markdown', '.csv', '.tsv', '.log',
  '.json', '.yaml', '.yml', '.xml', '.html', '.htm', '.rst', '.tex', '.org',
])

export type LocalFileKind = 'text' | 'ics'

export type LocalFileContents = {
  /** Exactly the path supplied by the renderer; provenance must not be lost. */
  originalPath: string
  kind: LocalFileKind
  bytes: number
  text: string
}

export type LocalFileErrorCode =
  | 'missing-path'
  | 'invalid-path'
  | 'path-traversal'
  | 'unsupported-extension'
  | 'not-found'
  | 'permission-denied'
  | 'not-regular-file'
  | 'symbolic-link'
  | 'too-large'
  | 'invalid-utf8'
  | 'invalid-text'
  | 'invalid-ics'

export class LocalFileError extends Error {
  readonly code: LocalFileErrorCode
  readonly status: 400 | 403 | 404 | 413 | 415

  constructor(
    code: LocalFileErrorCode,
    message: string,
    status: 400 | 403 | 404 | 413 | 415,
  ) {
    super(message)
    this.name = 'LocalFileError'
    this.code = code
    this.status = status
  }
}

/** Classify before opening so an arbitrary binary cannot be treated as text. */
export function classifyLocalFilePath(filePath: string): LocalFileKind {
  const extension = extname(filePath).toLowerCase()
  if (extension === '.ics') return 'ics'
  if (TEXT_EXTENSIONS.has(extension)) return 'text'
  throw new LocalFileError(
    'unsupported-extension',
    '只支持 UTF-8 文本文件或 .ics 日历文件。',
    415,
  )
}

/**
 * Read one explicitly selected local file with a bounded, UTF-8-only policy.
 * `lstat` rejects symlinks before opening; O_NOFOLLOW provides the same guard
 * against the common race on platforms that expose it.
 */
export async function readLocalFile(
  filePath: string,
  options: { maxBytes?: number } = {},
): Promise<LocalFileContents> {
  const originalPath = validatePath(filePath)
  const kind = classifyLocalFilePath(originalPath)
  const maxBytes = options.maxBytes ?? LOCAL_FILE_MAX_BYTES
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > LOCAL_FILE_MAX_BYTES) {
    throw new LocalFileError('too-large', '文件大小限制配置无效。', 413)
  }

  let initial
  try {
    initial = await lstat(originalPath)
  } catch (error) {
    throw mapFsError(error)
  }
  if (initial.isSymbolicLink()) {
    throw new LocalFileError('symbolic-link', '不读取符号链接文件。', 400)
  }
  if (!initial.isFile()) {
    throw new LocalFileError('not-regular-file', '投放目标不是普通文件。', 400)
  }
  if (initial.size > maxBytes) {
    throw new LocalFileError('too-large', `文件不能超过 ${maxBytes} 字节。`, 413)
  }

  // O_NOFOLLOW is available on macOS/Linux.  Keep a zero fallback for
  // platforms where Node does not expose it; the lstat check remains active.
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
  let handle
  try {
    handle = await open(originalPath, constants.O_RDONLY | noFollow)
    const current = await handle.stat()
    if (!current.isFile()) {
      throw new LocalFileError('not-regular-file', '投放目标不是普通文件。', 400)
    }
    if (current.size > maxBytes) {
      throw new LocalFileError('too-large', `文件不能超过 ${maxBytes} 字节。`, 413)
    }
    // Do not use FileHandle.readFile(): a file can grow between lstat/open and
    // that call, which would allocate an unbounded buffer before we enforce
    // the limit. Bounded reads let us detect a growth race with maxBytes + 1
    // bytes while still handling short reads from unusual local filesystems.
    const buffer = Buffer.allocUnsafe(maxBytes + 1)
    let bytesRead = 0
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead)
      if (result.bytesRead === 0) break
      bytesRead += result.bytesRead
    }
    if (bytesRead > maxBytes) {
      throw new LocalFileError('too-large', `文件不能超过 ${maxBytes} 字节。`, 413)
    }
    const bytes = buffer.subarray(0, bytesRead)
    const text = decodeUtf8(bytes)
    return { originalPath, kind, bytes: bytes.byteLength, text }
  } catch (error) {
    if (error instanceof LocalFileError) throw error
    throw mapFsError(error)
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

/**
 * Parse a small, deliberately strict RFC 5545 subset.  We accept the forms
 * emitted by common desktop calendars (UTF-8, folded lines, UTC/Shanghai
 * DTSTART, SUMMARY/LOCATION/RRULE) and reject malformed input loudly instead
 * of silently creating a wrong appointment.
 */
export function parseIcsRecords(text: string, observedAt: string): ExternalRecord[] {
  const lines = unfoldIcs(text)
  if (lines.length === 0 || lines[0] !== 'BEGIN:VCALENDAR') {
    throw invalidIcs('必须以 BEGIN:VCALENDAR 开始。')
  }

  const stack: string[] = []
  const events: string[][] = []
  let current: string[] | null = null
  let sawCalendar = false

  for (const line of lines) {
    const property = parseIcsProperty(line)
    if (!property) throw invalidIcs('存在无法解析的属性行。')
    if (property.name === 'BEGIN') {
      const component = property.value.trim().toUpperCase()
      if (!component) throw invalidIcs('组件名称不能为空。')
      if (component === 'VCALENDAR') {
        if (sawCalendar || stack.length > 0) throw invalidIcs('日历组件嵌套或重复。')
        sawCalendar = true
      }
      if (component === 'VEVENT') {
        if (current !== null || stack.at(-1) !== 'VCALENDAR') {
          throw invalidIcs('VEVENT 必须直接位于 VCALENDAR 中。')
        }
        current = []
      } else if (current !== null && stack.at(-1) === 'VEVENT') {
        // Nested VALARM/VTIMEZONE content is valid but is not part of the
        // event's top-level fields; it is intentionally ignored.
      }
      stack.push(component)
      continue
    }
    if (property.name === 'END') {
      const component = property.value.trim().toUpperCase()
      if (stack.at(-1) !== component) throw invalidIcs('组件 BEGIN/END 不匹配。')
      if (component === 'VEVENT') {
        if (!current) throw invalidIcs('VEVENT 内容缺失。')
        events.push(current)
        current = null
      }
      stack.pop()
      continue
    }
    if (current !== null && stack.at(-1) === 'VEVENT') current.push(line)
  }

  if (!sawCalendar || stack.length !== 0 || current !== null) {
    throw invalidIcs('日历组件没有正确闭合。')
  }
  // RFC 5545 content ends at END:VCALENDAR.  Do not silently accept a
  // second/trailing payload after that boundary; otherwise an attacker could
  // hide a different interpretation in the bytes we retain as provenance.
  const lastLine = parseIcsProperty(lines.at(-1) ?? '')
  if (lastLine?.name !== 'END' || lastLine.value.trim().toUpperCase() !== 'VCALENDAR') {
    throw invalidIcs('END:VCALENDAR 后存在多余内容。')
  }
  if (events.length > LOCAL_ICS_MAX_EVENTS) {
    throw invalidIcs(`日历事件不能超过 ${LOCAL_ICS_MAX_EVENTS} 条。`)
  }

  const records: ExternalRecord[] = []
  const seen = new Set<string>()
  for (const event of events) {
    const record = eventToRecord(event, observedAt)
    if (seen.has(record.externalId)) throw invalidIcs('存在重复 UID 的日历事件。')
    seen.add(record.externalId)
    records.push(record)
  }
  records.sort((a, b) => {
    const starts = (a.startsAt ?? '').localeCompare(b.startsAt ?? '')
    return starts !== 0 ? starts : a.externalId.localeCompare(b.externalId)
  })
  return records
}

/** Build the structured payload consumed by the existing deterministic mapper. */
export function localIcsPayload(
  records: readonly ExternalRecord[], observedAt: string, originalText: string,
): string {
  return JSON.stringify({
    schema: 'flowpal.ruc.external-records.v1',
    source: 'local.ics',
    kind: 'calendar',
    observedAt,
    response: originalText,
    records,
  })
}

function validatePath(value: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new LocalFileError('missing-path', '文件路径不能为空。', 400)
  }
  // Keep provenance exact, but do not reinterpret leading/trailing whitespace
  // as a different filesystem path. Electron normally supplies a clean
  // absolute path; a hand-crafted request with padding is rejected clearly.
  const path = value
  const candidate = value.trim()
  if (candidate !== path) {
    throw new LocalFileError('invalid-path', '文件路径不能包含首尾空白。', 400)
  }
  if (candidate.length > 4_096 || !isAbsolute(candidate)) {
    throw new LocalFileError('invalid-path', '文件路径必须是本机绝对路径。', 400)
  }
  if (/[\u0000-\u001f\u007f]/.test(path)) {
    throw new LocalFileError('invalid-path', '文件路径包含非法字符。', 400)
  }
  if (/(^|[\\/])\.\.(?:[\\/]|$)/.test(candidate)) {
    throw new LocalFileError('path-traversal', '文件路径不允许包含路径回退。', 400)
  }
  return path
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '')
    if (text.includes('\u0000')) throw new Error('NUL')
    return text
  } catch {
    throw new LocalFileError('invalid-utf8', '文件必须是有效的 UTF-8 文本。', 400)
  }
}

function mapFsError(error: unknown): LocalFileError {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : ''
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return new LocalFileError('not-found', '找不到投放的文件。', 404)
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return new LocalFileError('permission-denied', '没有读取该文件的权限。', 403)
  }
  if (code === 'ELOOP') {
    return new LocalFileError('symbolic-link', '不读取符号链接文件。', 400)
  }
  return new LocalFileError('invalid-path', '无法读取投放的文件。', 400)
}

type IcsProperty = { name: string; params: Record<string, string>; value: string }

function unfoldIcs(text: string): string[] {
  const raw = text.replace(/\r\n?/g, '\n').split('\n')
  const lines: string[] = []
  for (const line of raw) {
    if (line.length > 64 * 1024) throw invalidIcs('单行长度超过限制。')
    if ((line.startsWith(' ') || line.startsWith('\t')) && lines.length > 0) {
      lines[lines.length - 1] += line.slice(1)
    } else if (line.length > 0) {
      lines.push(line)
    }
  }
  return lines
}

function parseIcsProperty(line: string): IcsProperty | null {
  const colon = line.indexOf(':')
  if (colon <= 0) return null
  const head = line.slice(0, colon)
  const value = line.slice(colon + 1)
  const parts = head.split(';')
  const name = parts.shift()?.trim().toUpperCase()
  if (!name || !/^[A-Z0-9-]+$/.test(name)) return null
  const params: Record<string, string> = {}
  for (const part of parts) {
    const equal = part.indexOf('=')
    if (equal <= 0) return null
    const key = part.slice(0, equal).trim().toUpperCase()
    const parameter = part.slice(equal + 1).trim().replace(/^"|"$/g, '')
    if (!key || !parameter) return null
    params[key] = parameter
  }
  return { name, params, value }
}

function eventToRecord(lines: readonly string[], observedAt: string): ExternalRecord {
  const properties = new Map<string, IcsProperty[]>()
  for (const line of lines) {
    const property = parseIcsProperty(line)
    if (!property) throw invalidIcs('VEVENT 中存在无法解析的属性行。')
    const values = properties.get(property.name) ?? []
    values.push(property)
    properties.set(property.name, values)
  }
  const one = (name: string): IcsProperty | undefined => properties.get(name)?.[0]
  const uid = unescapeIcs(one('UID')?.value ?? '').trim()
  const title = unescapeIcs(one('SUMMARY')?.value ?? '').trim()
  const starts = one('DTSTART')
  if (!uid) throw invalidIcs('VEVENT 缺少 UID。')
  if (!title) throw invalidIcs(`VEVENT ${uid} 缺少 SUMMARY。`)
  if (!starts) throw invalidIcs(`VEVENT ${uid} 缺少 DTSTART。`)

  const start = parseIcsDate(starts)
  const ends = one('DTEND')
  const end = ends ? parseIcsDate(ends) : null
  if (end && end.iso < start.iso) throw invalidIcs(`VEVENT ${uid} 的 DTEND 早于 DTSTART。`)
  const recurrence = unescapeIcs(one('RRULE')?.value ?? '').trim()
  const recurrenceId = unescapeIcs(one('RECURRENCE-ID')?.value ?? '').trim()
  const location = unescapeIcs(one('LOCATION')?.value ?? '').trim()
  const key = recurrenceId ? `${uid}#${recurrenceId}` : uid
  const raw = {
    uid,
    summary: title,
    dtstart: starts.value,
    ...(ends ? { dtend: ends.value } : {}),
    ...(location ? { location } : {}),
    ...(recurrence ? { rrule: recurrence } : {}),
    ...(recurrenceId ? { recurrenceId } : {}),
  }
  const record: ExternalRecord = {
    externalId: `local.ics:${encodeURIComponent(key)}`,
    source: 'local.ics',
    kind: 'calendar',
    observedAt,
    title,
    startsAt: start.iso,
    ...(end ? { endsAt: end.iso } : {}),
    ...(location ? { location } : {}),
    datePrecision: start.allDay ? 'day' : 'minute',
    ...(start.allDay ? { dateRaw: start.dateRaw } : {}),
    ...(recurrence ? { recurrence } : {}),
    allDay: start.allDay,
    metadata: {
      uid,
      ...(recurrenceId ? { recurrenceId } : {}),
      ...(starts.params.TZID ? { tzid: starts.params.TZID } : {}),
    },
    raw,
    capability: 'available',
  }
  try {
    return ExternalRecordSchema.parse(record)
  } catch {
    throw invalidIcs(`VEVENT ${uid} 不符合结构化日程契约。`)
  }
}

type ParsedIcsDate = { iso: string; allDay: boolean; dateRaw?: string }

function parseIcsDate(property: IcsProperty): ParsedIcsDate {
  const value = property.value.trim()
  const dateOnly = property.params.VALUE?.toUpperCase() === 'DATE' || /^\d{8}$/.test(value)
  if (dateOnly) {
    if (!/^\d{8}$/.test(value)) throw invalidIcs(`日期格式不正确：${value}`)
    const [year, month, day] = [Number(value.slice(0, 4)), Number(value.slice(4, 6)), Number(value.slice(6, 8))]
    assertDate(year, month, day, value)
    return { iso: toShanghaiIso(year, month, day, 0, 0, 0, 480), allDay: true, dateRaw: `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}` }
  }

  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z|[+-]\d{4})?$/.exec(value)
  if (!match) throw invalidIcs(`日期时间格式不正确：${value}`)
  const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3])
  const hour = Number(match[4]); const minute = Number(match[5]); const second = Number(match[6])
  assertDate(year, month, day, value)
  if (hour > 23 || minute > 59 || second > 59) throw invalidIcs(`日期时间超出范围：${value}`)
  const zone = match[7]
  const offset = zone === 'Z' ? 0 : zone ? parseOffset(zone) : timezoneOffset(property.params.TZID)
  return { iso: toShanghaiIso(year, month, day, hour, minute, second, offset), allDay: false }
}

function parseOffset(value: string): number {
  const sign = value[0] === '-' ? -1 : 1
  const hours = Number(value.slice(1, 3)); const minutes = Number(value.slice(3, 5))
  if (hours > 23 || minutes > 59) throw invalidIcs(`时区偏移不正确：${value}`)
  return sign * (hours * 60 + minutes)
}

function timezoneOffset(value: string | undefined): number {
  if (!value) return 480
  const normalized = value.replace(/^"|"$/g, '').toUpperCase()
  if (normalized === 'UTC' || normalized === 'GMT') return 0
  if (['ASIA/SHANGHAI', 'ASIA/BEIJING', 'ASIA/CHONGQING', 'ASIA/HARBIN', 'PRC', 'CHINA'].includes(normalized)) return 480
  throw invalidIcs(`暂不支持时区：${value}`)
}

function assertDate(year: number, month: number, day: number, value: string): void {
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) {
    throw invalidIcs(`日期超出范围：${value}`)
  }
}

function toShanghaiIso(
  year: number, month: number, day: number, hour: number, minute: number, second: number, offsetMinutes: number,
): string {
  const instant = Date.UTC(year, month - 1, day, hour, minute, second) - offsetMinutes * 60_000
  const shifted = new Date(instant + 8 * 3_600_000)
  return shifted.toISOString().replace(/\.\d{3}Z$/, '+08:00')
}

function unescapeIcs(value: string): string {
  return value
    .replace(/\\N/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
}

function invalidIcs(message: string): LocalFileError {
  return new LocalFileError('invalid-ics', `ICS 文件无法解析：${message}`, 400)
}
