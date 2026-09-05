import { ExternalRecordSchema, type ExternalRecord } from '../types.ts'
import {
  addLocalDays,
  asArray,
  asObject,
  encodeKeyPart,
  formatDateOnly,
  isoShanghai,
  localDateFromYmd,
  optionalText,
  parseJsonInput,
  parseShanghaiDay,
  requiredInt,
  requiredText,
} from './utils.ts'
import { ExternalShapeError } from '../types.ts'

export type GraduateTerm = {
  code: string
  name: string
}

export type GraduatePeriod = {
  index: number
  name: string
  fromMinutes: number
  toMinutes: number
}

export type GraduateCourse = {
  classCode: string
  courseCode: string
  courseName: string
  className: string
  teachers: string
  department: string
  campus: string
  mode: string
  placement: string
  firstDay: string | null
  remark: string
}

export type GraduateMeeting = {
  classCode: string
  weekday: number
  fromPeriod: number
  toPeriod: number
  room: string
  roomCode: string
  weeksLabel: string
  weeks: string
  planCode: string
}

export type NormalizedGraduateTimetable = {
  term: GraduateTerm
  courses: GraduateCourse[]
  meetings: GraduateMeeting[]
  periodPlans: Record<string, GraduatePeriod[]>
  weekCount: number
  firstMonday: string | null
}

/** Parse `modules/xskcb/kfdxnxqcx.do` without accepting a deceptive empty shape. */
export function parseGraduateTerms(input: unknown): GraduateTerm[] {
  const body = asObject(parseJsonInput(input, 'RUC 研究生学期列表'), 'RUC 研究生学期列表')
  assertGsappCode(body, '研究生学期列表')
  const datas = asObject(body.datas, '研究生学期列表.datas')
  const section = asObject(datas.kfdxnxqcx, 'RUC 研究生学期列表.datas.kfdxnxqcx')
  return asArray(section.rows, 'RUC 研究生学期列表.rows').map((row, index) => {
    const object = asObject(row, `RUC 研究生学期列表第 ${index + 1} 行`)
    return {
      code: requiredText(object.XNXQDM, `学期 ${index + 1}.XNXQDM`),
      name: requiredText(object.XNXQDM_DISPLAY, `学期 ${index + 1}.XNXQDM_DISPLAY`),
    }
  })
}

/**
 * Normalize `bykb/loadXskbData.do` into a graph whose joins are checked before
 * anything reaches UI or storage. Empty rwList/jgList is a valid empty term.
 */
export function parseGraduateTimetable(input: unknown, term: GraduateTerm): NormalizedGraduateTimetable {
  const body = asObject(parseJsonInput(input, 'RUC 研究生课表'), 'RUC 研究生课表')
  // The timetable endpoint is the one gsapp endpoint whose successful envelope
  // is numeric 1 (not the string "0" used by paged endpoints).
  if (body.code !== 1) {
    throw new ExternalShapeError(`研究生课表返回 code=${String(body.code)}，预期整数 1`)
  }

  const rawPlans = asArray(body.jcfaList, '研究生课表.jcfaList')
  // A server-controlled plan code is data, not a property name.  Own-property
  // checks plus defineProperty keep values such as `toString`/`__proto__`
  // from being mistaken for an existing plan or mutating the lookup object,
  // while returning the ordinary Record shape expected by callers.
  const periodPlans: Record<string, GraduatePeriod[]> = {}
  for (let i = 0; i < rawPlans.length; i += 1) {
    const plan = asObject(rawPlans[i], `研究生课表.jcfaList[${i}]`)
    const planCode = requiredText(plan.DM, `研究生课表.jcfaList[${i}].DM`)
    if (Object.prototype.hasOwnProperty.call(periodPlans, planCode)) {
      throw new ExternalShapeError(`重复的节次方案 ${planCode}`)
    }
    const rawPeriods = asArray(plan.skjcList, `研究生课表.jcfaList[${i}].skjcList`)
    const periods = rawPeriods.map((value, periodIndex) => parsePeriod(value, `节次方案 ${planCode}[${periodIndex}]`))
    const duplicatePeriods = periods.map((period) => period.index)
      .filter((index, indexAt, all) => all.indexOf(index) !== indexAt)
    if (duplicatePeriods.length > 0) {
      throw new ExternalShapeError(`节次方案 ${planCode} 存在重复节次：${[...new Set(duplicatePeriods)].join(', ')}`)
    }
    periods.sort((a, b) => a.index - b.index)
    Object.defineProperty(periodPlans, planCode, {
      value: periods, enumerable: true, configurable: true, writable: true,
    })
  }

  const rawCourses = asArray(body.rwList, '研究生课表.rwList')
  const courses = rawCourses.map((value, index) => parseCourse(value, `研究生课表.rwList[${index}]`))
  const duplicateClasses = courses.map((course) => course.classCode)
    .filter((code, index, all) => all.indexOf(code) !== index)
  if (duplicateClasses.length > 0) {
    throw new ExternalShapeError(`rwList 中存在重复班级：${[...new Set(duplicateClasses)].join(', ')}`)
  }
  const rawMeetings = asArray(body.jgList, '研究生课表.jgList')
  const meetings = mergeGraduateMeetings(rawMeetings.map((value, index) =>
    parseMeeting(value, `研究生课表.jgList[${index}]`)))

  const courseCodes = new Set(courses.map((course) => course.classCode))
  const planCodes = new Set<string>()
  for (const meeting of meetings) {
    if (!courseCodes.has(meeting.classCode)) {
      throw new ExternalShapeError(`排课的班级 ${meeting.classCode} 不在 rwList 教学任务中`)
    }
    if (!Object.prototype.hasOwnProperty.call(periodPlans, meeting.planCode)) {
      throw new ExternalShapeError(`排课引用了不存在的节次方案 ${meeting.planCode}`)
    }
    planCodes.add(meeting.planCode)
  }
  if (planCodes.size > 1) {
    throw new ExternalShapeError(`同一学期使用了多套节次方案：${[...planCodes].join(', ')}`)
  }

  const firstMonday = deriveFirstMonday(courses, meetings)
  const weekCount = meetings.reduce((max, meeting) => Math.max(max, meeting.weeks.length), 0)
  return { term, courses, meetings, periodPlans, weekCount, firstMonday }
}

/** Convert the normalized graph to stable, idempotent records for the store. */
export function graduateTimetableRecords(
  timetable: NormalizedGraduateTimetable,
  observedAt: string,
): ExternalRecord[] {
  const byClass = new Map(timetable.courses.map((course) => [course.classCode, course]))
  const records: ExternalRecord[] = []
  for (const meeting of timetable.meetings) {
    const course = byClass.get(meeting.classCode)
    if (!course) throw new ExternalShapeError(`规范化后找不到班级 ${meeting.classCode}`)
    const periods = timetable.periodPlans[meeting.planCode]
    if (!Object.prototype.hasOwnProperty.call(timetable.periodPlans, meeting.planCode) || !periods) {
      throw new ExternalShapeError(`规范化后找不到节次方案 ${meeting.planCode}`)
    }
    const from = periods.find((period) => period.index === meeting.fromPeriod)
    const to = periods.find((period) => period.index === meeting.toPeriod)
    if (!from || !to) {
      throw new ExternalShapeError(`班级 ${meeting.classCode} 的节次 ${meeting.fromPeriod}-${meeting.toPeriod} 不在方案 ${meeting.planCode}`)
    }
    const firstWeek = firstSetWeek(meeting.weeks)
    const firstDay = timetable.firstMonday && firstWeek !== null
      ? addLocalDays(localDateFromYmd(timetable.firstMonday), (firstWeek - 1) * 7 + meeting.weekday - 1)
      : null
    const start = firstDay ? isoWithMinutes(firstDay, from.fromMinutes) : undefined
    const end = firstDay ? isoWithMinutes(firstDay, to.toMinutes) : undefined
    const recurrence = recurrenceFor(meeting, timetable.firstMonday, timetable.weekCount, firstDay)
    const title = course.className || course.courseName
    if (!title) throw new ExternalShapeError(`班级 ${course.classCode} 没有课程名或班级名`)
    // Keep the human/searchable namespace readable; only user/server fields
    // are URI-encoded so colons in a class/room name cannot create extra key
    // segments.  This also keeps the same `ruc:graduate:v1:` prefix used by
    // the portal adapter and by sync-record diagnostics.
    const externalId = [
      'ruc:graduate:v1', timetable.term.code, 'meeting', meeting.classCode,
      String(meeting.weekday), `${meeting.fromPeriod}-${meeting.toPeriod}`,
      meeting.roomCode || meeting.room || '-', meeting.weeks,
    ].map((part, index) => index === 0 ? part : encodeKeyPart(part)).join(':')
    const record: ExternalRecord = {
      externalId,
      source: 'ruc.graduate',
      kind: 'timetable',
      observedAt,
      title,
      ...(start ? { startsAt: start } : {}),
      ...(end ? { endsAt: end } : {}),
      ...(meeting.room ? { location: meeting.room } : {}),
      ...(start ? { datePrecision: 'minute' as const } : {}),
      dateRaw: meeting.weeksLabel || meeting.weeks,
      ...(recurrence ? { recurrence } : {}),
      metadata: {
        termCode: timetable.term.code,
        classCode: meeting.classCode,
        courseCode: course.courseCode,
        weekday: meeting.weekday,
        fromPeriod: meeting.fromPeriod,
        toPeriod: meeting.toPeriod,
        weeks: meeting.weeks,
        scheduled: true,
      },
      raw: { term: timetable.term, course, meeting, periods: { from, to } },
      capability: 'available',
    }
    records.push(ExternalRecordSchema.parse(record))
  }

  // No-schedule tasks are real enrollment facts. Keep one stable record so a
  // sync never silently loses a course merely because it has no meeting rows.
  const coursesByStableKey = [...timetable.courses]
    .sort((a, b) => a.classCode.localeCompare(b.classCode))
  for (const course of coursesByStableKey) {
    if (timetable.meetings.some((meeting) => meeting.classCode === course.classCode)) continue
    const title = course.className || course.courseName
    if (!title) throw new ExternalShapeError(`班级 ${course.classCode} 没有课程名或班级名`)
    const externalId = ['ruc:graduate:v1', timetable.term.code, 'course', course.classCode]
      .map((part, index) => index === 0 ? part : encodeKeyPart(part)).join(':')
    records.push(ExternalRecordSchema.parse({
      externalId,
      source: 'ruc.graduate',
      kind: 'timetable',
      observedAt,
      title,
      dateRaw: '无排课',
      metadata: {
        termCode: timetable.term.code,
        classCode: course.classCode,
        courseCode: course.courseCode,
        scheduled: false,
      },
      raw: { term: timetable.term, course, scheduled: false },
      capability: 'available',
    }))
  }
  return records
}

/** One-call adapter used by sync orchestration and offline tests. */
export function normalizeGraduateTimetable(
  input: unknown,
  term: GraduateTerm,
  observedAt: string,
): ExternalRecord[] {
  return graduateTimetableRecords(parseGraduateTimetable(input, term), observedAt)
}

function parsePeriod(value: unknown, label: string): GraduatePeriod {
  const row = asObject(value, label)
  const index = requiredInt(row.DM, `${label}.DM`)
  if (index < 1) throw new ExternalShapeError(`${label}.DM 必须从 1 开始`)
  const fromMinutes = clockMinutes(row.KSSJ, `${label}.KSSJ`)
  const toMinutes = clockMinutes(row.JSSJ, `${label}.JSSJ`)
  if (toMinutes < fromMinutes) throw new ExternalShapeError(`${label} 结束早于开始`)
  return { index, name: optionalText(row.MC, `${label}.MC`), fromMinutes, toMinutes }
}

function clockMinutes(value: unknown, field: string): number {
  const raw = requiredInt(value, field)
  const hour = Math.floor(raw / 100); const minute = raw % 100
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new ExternalShapeError(`${field} 的 ${raw} 不是 HHmm 时刻`)
  }
  return hour * 60 + minute
}

function parseCourse(value: unknown, label: string): GraduateCourse {
  const row = asObject(value, label)
  const firstDayText = optionalText(row.SCSKRQ, `${label}.SCSKRQ`)
  return {
    classCode: requiredText(row.BJDM, `${label}.BJDM`),
    courseCode: optionalText(row.KCDM, `${label}.KCDM`),
    courseName: optionalText(row.KCMC, `${label}.KCMC`),
    className: optionalText(row.BJMC, `${label}.BJMC`),
    teachers: optionalText(row.RKJS, `${label}.RKJS`),
    department: optionalText(row.KKDWMC, `${label}.KKDWMC`),
    campus: optionalText(row.XQMC, `${label}.XQMC`),
    mode: optionalText(row.SKFSMC, `${label}.SKFSMC`),
    placement: optionalText(row.PKSJDD, `${label}.PKSJDD`),
    firstDay: firstDayText === ''
      ? null
      : formatDateOnly(parseShanghaiDay(firstDayText, `${label}.SCSKRQ`)),
    remark: optionalText(row.XKBZ, `${label}.XKBZ`),
  }
}

function parseMeeting(value: unknown, label: string): GraduateMeeting {
  const row = asObject(value, label)
  const weekday = requiredInt(row.XQ, `${label}.XQ`)
  const fromPeriod = requiredInt(row.KSJCDM, `${label}.KSJCDM`)
  const toPeriod = requiredInt(row.JSJCDM, `${label}.JSJCDM`)
  const weeks = requiredText(row.ZCBH, `${label}.ZCBH`)
  if (weekday < 1 || weekday > 7) throw new ExternalShapeError(`${label}.XQ 必须在 1..7`)
  if (fromPeriod < 1 || toPeriod < fromPeriod) throw new ExternalShapeError(`${label} 节次范围无效`)
  if (!/^[01]+$/.test(weeks)) throw new ExternalShapeError(`${label}.ZCBH 不是 0/1 周次位图`)
  return {
    classCode: requiredText(row.BJDM, `${label}.BJDM`),
    weekday,
    fromPeriod,
    toPeriod,
    room: optionalText(row.JASMC, `${label}.JASMC`),
    roomCode: optionalText(row.JASDM, `${label}.JASDM`),
    weeksLabel: optionalText(row.ZCMC, `${label}.ZCMC`),
    weeks,
    planCode: requiredText(row.JCFADM, `${label}.JCFADM`),
  }
}

/** Group only rows that describe the same room/week/plan and touch in period space. */
export function mergeGraduateMeetings(rows: GraduateMeeting[]): GraduateMeeting[] {
  const groups = new Map<string, GraduateMeeting[]>()
  for (const row of rows) {
    const key = JSON.stringify([row.classCode, row.weekday, row.weeks, row.roomCode, row.room, row.planCode])
    const group = groups.get(key) ?? []
    group.push(row)
    groups.set(key, group)
  }
  const merged: GraduateMeeting[] = []
  for (const group of groups.values()) {
    group.sort((a, b) => a.fromPeriod - b.fromPeriod)
    let block = group[0]
    if (!block) continue
    for (const next of group.slice(1)) {
      if (next.fromPeriod <= block.toPeriod + 1) {
        block = { ...block, toPeriod: Math.max(block.toPeriod, next.toPeriod) }
      } else {
        merged.push(block)
        block = next
      }
    }
    merged.push(block)
  }
  merged.sort((a, b) => a.weekday - b.weekday
    || a.fromPeriod - b.fromPeriod
    || a.classCode.localeCompare(b.classCode)
    || a.roomCode.localeCompare(b.roomCode)
    || a.room.localeCompare(b.room)
    || a.weeks.localeCompare(b.weeks)
    || a.planCode.localeCompare(b.planCode))
  return merged
}

function deriveFirstMonday(courses: GraduateCourse[], meetings: GraduateMeeting[]): string | null {
  const byClass = new Map<string, GraduateMeeting[]>()
  for (const meeting of meetings) {
    const group = byClass.get(meeting.classCode) ?? []
    group.push(meeting)
    byClass.set(meeting.classCode, group)
  }
  let agreed: string | null = null
  let agreedBy = ''
  for (const course of courses) {
    if (!course.firstDay) continue
    const own = byClass.get(course.classCode)
    if (!own?.length) continue
    let offset: number | null = null
    for (const meeting of own) {
      const week = firstSetWeek(meeting.weeks)
      if (week === null) continue
      const candidate = (week - 1) * 7 + meeting.weekday - 1
      offset = offset === null ? candidate : Math.min(offset, candidate)
    }
    if (offset === null) continue
    const candidate = formatDateOnly(addLocalDays(localDateFromYmd(course.firstDay), -offset))
    if (agreed === null) { agreed = candidate; agreedBy = course.className || course.classCode; continue }
    if (agreed !== candidate) {
      throw new ExternalShapeError(`不同课程推导出不一致的第一教学周：${agreedBy}=${agreed}，${course.className || course.classCode}=${candidate}`)
    }
  }
  return agreed
}

function firstSetWeek(bits: string): number | null {
  const index = bits.indexOf('1')
  return index < 0 ? null : index + 1
}

function recurrenceFor(
  meeting: GraduateMeeting,
  firstMonday: string | null,
  weekCount: number,
  firstDay: Date | null,
): string | null {
  if (!firstMonday || !firstDay || !isContiguousFromFirst(meeting.weeks, weekCount)) return null
  const dayCodes = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']
  const lastWeek = lastSetWeek(meeting.weeks)
  if (lastWeek === null) return null
  const until = addLocalDays(localDateFromYmd(firstMonday), (lastWeek - 1) * 7 + meeting.weekday - 1)
  return `FREQ=WEEKLY;BYDAY=${dayCodes[meeting.weekday - 1]};WKST=MO;UNTIL=${formatDateOnly(until).replaceAll('-', '')}T235959`
}

function isContiguousFromFirst(bits: string, weekCount: number): boolean {
  const first = firstSetWeek(bits)
  if (first === null) return false
  const last = lastSetWeek(bits)
  if (last === null || last > weekCount) return false
  return bits.slice(first - 1, last).split('').every((bit) => bit === '1') && bits.slice(last).split('').every((bit) => bit === '0')
}

function lastSetWeek(bits: string): number | null {
  const index = bits.lastIndexOf('1')
  return index < 0 ? null : index + 1
}

function isoWithMinutes(day: Date, minutes: number): string {
  return isoShanghai(new Date(day.getTime() + minutes * 60_000))
}

function assertGsappCode(body: Record<string, unknown>, label: string): void {
  if (String(body.code) !== '0') throw new ExternalShapeError(`${label} 返回 code=${String(body.code)}，预期 0`)
}
