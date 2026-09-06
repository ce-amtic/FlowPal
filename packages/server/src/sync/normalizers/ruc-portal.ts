import { ExternalRecordSchema, ExternalShapeError, type ExternalRecord } from '../types.ts'
import {
  asArray,
  asObject,
  encodeKeyPart,
  localDate,
  parseJsonInput,
  parseShanghaiDateTime,
  requiredInt,
  requiredText,
  shortHash,
} from './utils.ts'

export const DEFAULT_PORTAL_CATEGORY_IDS = Object.freeze([0, -2, -5])

export type PortalNormalizeOptions = {
  observedAt: string
  /** The endpoint returns all categories; filtering is intentionally local. */
  categoryIds?: readonly number[]
}

/** A small typed projection used by tests and by the mapper's raw provenance. */
export type PortalEvent = {
  day: string
  categoryId: number
  category: string
  id: number | string
  title: string
  startsAt: string
  endsAt: string
  location: string
  allDay: boolean
  raw: Record<string, unknown>
}

/**
 * Parse `calendarList.rst`'s array response and normalize selected categories.
 *
 * The endpoint has two intentional irregularities: an empty day may omit the
 * `events` key, and `teachingWeek`/holiday fields vary by deployment.  Those
 * are accepted; malformed event rows are rejected loudly so a server change
 * cannot be displayed as a misleading empty calendar.
 */
export function parsePortalSchedule(input: unknown, options: PortalNormalizeOptions): ExternalRecord[] {
  const root = parseJsonInput(input, 'RUC 门户日程')
  const days = asArray(root, 'RUC 门户日程顶层')
  const allowed = new Set(options.categoryIds ?? DEFAULT_PORTAL_CATEGORY_IDS)
  const records: ExternalRecord[] = []

  for (let dayIndex = 0; dayIndex < days.length; dayIndex += 1) {
    const day = asObject(days[dayIndex], `RUC 门户第 ${dayIndex + 1} 天`)
    const dayValue = requiredText(day.day, `RUC 门户第 ${dayIndex + 1} 天.day`)
    const dayDate = parseShanghaiDateTime(dayValue, `RUC 门户第 ${dayIndex + 1} 天.day`)
    const eventsValue = day.events
    // Missing events is the portal's legitimate representation of an empty day.
    if (eventsValue === undefined) continue
    const events = asArray(eventsValue, `RUC 门户 ${dayValue}.events`)

    for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
      const event = asObject(events[eventIndex], `RUC 门户 ${dayValue} 第 ${eventIndex + 1} 条事件`)
      const schedule = asObject(event.schedule, `RUC 门户 ${dayValue} 事件.schedule`)
      const category = asObject(schedule.cateGory, `RUC 门户 ${dayValue} 事件.schedule.cateGory`)
      const categoryId = requiredInt(category.id, `RUC 门户 ${dayValue} 事件.category.id`)
      if (!allowed.has(categoryId)) continue

      const starts = parseShanghaiDateTime(event.beginTime, `RUC 门户 ${dayValue} 事件.beginTime`)
      const ends = parseShanghaiDateTime(event.endTime, `RUC 门户 ${dayValue} 事件.endTime`)
      if (ends.getTime() < starts.getTime()) {
        throw new ExternalShapeError(`RUC 门户 ${dayValue} 事件结束早于开始`)
      }
      const title = requiredText(schedule.title, `RUC 门户 ${dayValue} 事件.schedule.title`)
      const categoryName = optionalText(category.name, `RUC 门户 ${dayValue} 事件.category.name`)
      const location = optionalText(schedule.location, `RUC 门户 ${dayValue} 事件.schedule.location`)
      const id = schedule.id === undefined || schedule.id === null
        ? ''
        : (typeof schedule.id === 'number' || typeof schedule.id === 'string')
          ? (typeof schedule.id === 'number' && !Number.isSafeInteger(schedule.id)
            ? (() => { throw new ExternalShapeError(`RUC 门户 ${dayValue} 事件.schedule.id 必须是安全整数`) })()
            : schedule.id)
          : (() => { throw new ExternalShapeError(`RUC 门户 ${dayValue} 事件.schedule.id 类型异常`) })()
      const allDay = isAllDay(starts, ends)
      const dayKey = localDate(dayDate)
      // Timetable rows in the real payload currently carry id=0.  A positive
      // server id is preferable; otherwise hash only stable display facts.
      const idPart = id !== '' && id !== 0 && id !== '0'
        ? encodeKeyPart(String(id))
        : shortHash({
          day: dayKey,
          categoryId,
          title,
          // Hash canonical Shanghai instants, not the endpoint's incidental
          // separator/seconds formatting, so id=0 rows remain stable across
          // equivalent responses.
          starts: formatInstant(starts),
          ends: formatInstant(ends),
          location,
        })
      const kind = categoryId === -2 ? 'timetable' : 'calendar'
      const record: ExternalRecord = {
        externalId: `ruc:portal:v1:calendar:${idPart}:${dayKey}`,
        source: 'ruc.portal',
        kind,
        observedAt: options.observedAt,
        title,
        startsAt: formatInstant(starts),
        endsAt: formatInstant(ends),
        ...(location ? { location } : {}),
        datePrecision: allDay ? 'day' : 'minute',
        dateRaw: allDay ? dayKey : undefined,
        allDay,
        metadata: {
          categoryId,
          category: categoryName,
          localDate: dayKey,
        },
        raw: { day: dayValue, event, schedule },
        capability: 'available',
      }
      records.push(ExternalRecordSchema.parse(record))
    }
  }

  records.sort((a, b) => {
    const dayDelta = (a.startsAt ?? '').slice(0, 10).localeCompare((b.startsAt ?? '').slice(0, 10))
    if (dayDelta !== 0) return dayDelta
    const allDayDelta = Number(Boolean(b.allDay)) - Number(Boolean(a.allDay))
    if (allDayDelta !== 0) return allDayDelta
    const startsDelta = (a.startsAt ?? '').localeCompare(b.startsAt ?? '')
    return startsDelta !== 0 ? startsDelta : a.externalId.localeCompare(b.externalId)
  })
  return records
}

/** Alias named after the source, useful to callers that support multiple RUC adapters. */
export const normalizePortalSchedule = parsePortalSchedule

function optionalText(value: unknown, field: string): string {
  if (value === null || value === undefined) return ''
  return requiredText(value, field, { allowEmpty: true })
}

function isAllDay(starts: Date, ends: Date): boolean {
  // Seconds vary between portal deployments; the semantic marker is the
  // local minute range, not whether the server chose `:00` or `:59`.
  const start = formatInstant(starts).slice(11, 16)
  const end = formatInstant(ends).slice(11, 16)
  return start === '00:00' && end === '23:59'
}

function formatInstant(value: Date): string {
  const shifted = new Date(value.getTime() + 8 * 3_600_000)
  return shifted.toISOString().replace(/\.\d{3}Z$/, '+08:00')
}
