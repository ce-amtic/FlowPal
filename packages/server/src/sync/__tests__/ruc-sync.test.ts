import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { createCtx } from '@flowpal/shared'
import { openDb } from '../../store/db.ts'
import { itemHistory, listItems } from '../../store/items.ts'
import { startSyncRun } from '../../store/sync.ts'
import { mapStructured } from '../../pipeline/map-structured.ts'
import {
  externalRecordToExtractedItem,
  externalRecordsToBatches,
  ingestExternalRecords,
} from '../structured-import.ts'
import { parsePortalSchedule } from '../normalizers/ruc-portal.ts'
import {
  normalizeGraduateTimetable,
  parseGraduateTimetable,
  type GraduateTerm,
} from '../normalizers/ruc-graduate.ts'
import { ExternalRecordSchema, type ExternalRecord } from '../types.ts'
import { UnsupportedExternalSourceError } from '../types.ts'
import { normalizeRucRequest, runRucSync, runRucSyncBatch } from '../runner.ts'

const fixture = (name: string): unknown => JSON.parse(readFileSync(
  resolve(import.meta.dirname, '..', 'fixtures', name), 'utf8',
)) as unknown

const observedAt = '2026-09-05T12:00:00+08:00'
const term: GraduateTerm = { code: '20261', name: '2026-2027学年 第一学期' }

test('portal parser filters categories locally, accepts empty days, and preserves Shanghai local time', () => {
  const records = parsePortalSchedule(fixture('portal-schedule.json'), { observedAt })
  assert.equal(records.length, 3)
  assert.equal(records[0]?.title, '学期开始')
  assert.equal(records[0]?.allDay, true)
  assert.equal(records[0]?.datePrecision, 'day')
  assert.equal(records[0]?.startsAt, '2026-09-07T00:00:00+08:00')
  assert.equal(records[1]?.title, '计算机网络01')
  assert.equal(records[1]?.startsAt, '2026-09-07T14:00:00+08:00')
  assert.equal(records[1]?.kind, 'timetable')
  assert.ok(records.every((record) => record.externalId.startsWith('ruc:portal:v1:calendar:')))
  assert.equal(new Set(records.map((record) => record.externalId)).size, records.length)

  const shuffled = structuredClone(fixture('portal-schedule.json')) as any[]
  shuffled[0].events.reverse()
  const sorted = parsePortalSchedule(shuffled, { observedAt })
  assert.deepEqual(sorted.slice(0, 2).map((record) => record.title), ['学期开始', '计算机网络01'])

  const equivalentFormatting = structuredClone(fixture('portal-schedule.json')) as any[]
  equivalentFormatting[0].events[1].beginTime = '2026-09-07T14:00:00'
  equivalentFormatting[0].events[1].endTime = '2026-09-07T16:45:00'
  const reformatted = parsePortalSchedule(equivalentFormatting, { observedAt })
  assert.equal(reformatted.find((record) => record.title === '计算机网络01')?.externalId,
    records.find((record) => record.title === '计算机网络01')?.externalId)

  const secondPrecision = structuredClone(fixture('portal-schedule.json')) as any[]
  secondPrecision[0].events[0].endTime = '2026-09-07 23:59:59'
  assert.equal(parsePortalSchedule(secondPrecision, { observedAt })[0]?.allDay, true)

  const delimiterId = structuredClone(fixture('portal-schedule.json')) as any[]
  delimiterId[0].events[0].schedule.id = 'server:1786/one'
  assert.match(parsePortalSchedule(delimiterId, { observedAt })[0]!.externalId,
    /^ruc:portal:v1:calendar:server%3A1786%2Fone:/)
})

test('portal parser rejects a malformed event instead of turning it into an empty day', () => {
  assert.throws(
    () => parsePortalSchedule([{ day: '2026-09-07 00:00:00', events: [{ schedule: {} }] }], { observedAt }),
    /beginTime|title|category/i,
  )
  assert.throws(
    () => parsePortalSchedule([{ day: 'not-a-date', events: [] }], { observedAt }),
    /不是有效|YYYY-MM-DD/i,
  )
  const badLocation = structuredClone(fixture('portal-schedule.json')) as any[]
  badLocation[0].events[0].schedule.location = { text: 'not a string' }
  assert.throws(() => parsePortalSchedule(badLocation, { observedAt }), /location.*应为字符串/i)
  const badId = structuredClone(fixture('portal-schedule.json')) as any[]
  badId[0].events[0].schedule.id = 1.25
  assert.throws(() => parsePortalSchedule(badId, { observedAt }), /id.*安全整数/i)
})

test('graduate normalizer joins rw/jg/jcfa, merges only adjacent periods, and keeps unscheduled enrollment', () => {
  const records = normalizeGraduateTimetable(fixture('graduate-timetable.json'), term, observedAt)
  assert.equal(records.length, 4, 'three scheduled blocks plus one no-schedule course')
  assert.ok(records.every((record) => record.externalId.startsWith('ruc:graduate:v1:')))
  const shuffled = structuredClone(fixture('graduate-timetable.json')) as any
  shuffled.jgList.reverse()
  assert.deepEqual(
    normalizeGraduateTimetable(shuffled, term, observedAt).map((record) => record.externalId),
    records.map((record) => record.externalId),
  )
  const scheduled = records.filter((record) => record.metadata?.scheduled === true)
  assert.equal(scheduled.length, 3)
  const joined = scheduled.find((record) => record.metadata?.fromPeriod === 3)
  assert.equal(joined?.metadata?.toPeriod, 4)
  assert.equal(joined?.startsAt, '2026-09-07T10:00:00+08:00')
  assert.equal(joined?.endsAt, '2026-09-07T11:30:00+08:00')
  assert.equal(joined?.recurrence, 'FREQ=WEEKLY;BYDAY=MO;WKST=MO;UNTIL=20261026T235959')
  const evening = scheduled.find((record) => record.metadata?.fromPeriod === 7)
  assert.equal(evening?.metadata?.toPeriod, 7, 'period 4 and 7 are separated by lunch')
  const unscheduled = records.find((record) => record.metadata?.scheduled === false)
  assert.equal(unscheduled?.title, '学术英语01')
  assert.equal(unscheduled?.startsAt, undefined)
  assert.equal(unscheduled?.dateRaw, '无排课')
})

test('graduate normalizer treats empty term as valid and rejects broken joins', () => {
  const empty = parseGraduateTimetable({ code: 1, rwList: [], jgList: [], jcfaList: [] }, term)
  assert.deepEqual(empty.meetings, [])
  assert.equal(empty.firstMonday, null)

  const source = fixture('graduate-timetable.json') as Record<string, any>
  const orphan = structuredClone(source)
  orphan.jgList.push({ ...orphan.jgList[0], BJDM: 'missing-class' })
  assert.throws(() => parseGraduateTimetable(orphan, term), /不在 rwList/)

  const unknownPlan = structuredClone(source)
  unknownPlan.jgList[0].JCFADM = '99'
  assert.throws(() => parseGraduateTimetable(unknownPlan, term), /不存在的节次方案/)

  const dataLikePlanCode = structuredClone(source)
  dataLikePlanCode.jcfaList[0].DM = 'toString'
  dataLikePlanCode.jgList.forEach((row: any) => { row.JCFADM = 'toString' })
  assert.doesNotThrow(() => parseGraduateTimetable(dataLikePlanCode, term))

  const prototypePlanCode = structuredClone(source)
  prototypePlanCode.jcfaList[0].DM = '__proto__'
  prototypePlanCode.jgList.forEach((row: any) => { row.JCFADM = '__proto__' })
  assert.doesNotThrow(() => parseGraduateTimetable(prototypePlanCode, term))

  const duplicatePeriod = structuredClone(source)
  duplicatePeriod.jcfaList[0].skjcList[1].DM = duplicatePeriod.jcfaList[0].skjcList[0].DM
  assert.throws(() => parseGraduateTimetable(duplicatePeriod, term), /重复节次/)

  const conflicting = structuredClone(source)
  conflicting.rwList.find((row: any) => row.BJDM === 'C-C').SCSKRQ = '2026-09-15'
  assert.throws(() => parseGraduateTimetable(conflicting, term), /不一致的第一教学周/)
})

test('ExternalRecord contract and mapper retain structured citations', () => {
  const records = parsePortalSchedule(fixture('portal-schedule.json'), { observedAt })
  const text = JSON.stringify({ schema: 'flowpal.ruc.external-records.v1', records })
  const record = ExternalRecordSchema.parse(records[1])
  const item = externalRecordToExtractedItem(record, text)
  assert.equal(item.type, 'event')
  assert.equal(item.confidence, 'high')
  assert.equal(item.title, '计算机网络01')
  assert.ok(item.citations.some((citation) => citation.field === 'title' && citation.quote === '计算机网络01'))
  const batches = externalRecordsToBatches(records)
  assert.equal(batches.length, 2, 'calendar and timetable are separate immutable fragments')
  assert.equal(batches[0]?.source, 'calendar')
  const mapped = mapStructured({} as any, {
    id: 'fixture-fragment', createdAt: observedAt, device: 'test', source: 'timetable',
    rawType: 'structured', rawBlobPath: null, rawText: batches[1]?.rawText ?? null,
  })
  // mapStructured 现在还的是 MappedItem：条目外面还包着一个 externalId，
  // 落库靠它做覆盖判定
  assert.equal(mapped[0]?.item.title, '计算机网络01')
})

test('exam records remain explicitly unsupported until an endpoint is verified', () => {
  const exam = {
    externalId: 'ruc:graduate:v1:20261:exam:placeholder',
    source: 'ruc.graduate' as const,
    kind: 'exam' as const,
    observedAt,
    title: '考试占位',
    raw: { fixture: true },
    capability: 'available' as const,
  }
  assert.throws(() => externalRecordsToBatches([exam]), UnsupportedExternalSourceError)
  assert.throws(() => externalRecordToExtractedItem(exam), UnsupportedExternalSourceError)
})

test('runner requires an explicit fixture/online seam and never reports an unimplemented online success', async () => {
  const portal = await normalizeRucRequest({
    mode: 'fixture', source: 'ruc.portal', payload: fixture('portal-schedule.json'),
  }, observedAt)
  assert.equal(portal.length, 3)
  await assert.rejects(
    normalizeRucRequest({ mode: 'online', source: 'ruc.portal' }, observedAt),
    /尚未接入|fixture|授权/,
  )
  await assert.rejects(
    normalizeRucRequest({ mode: 'online', source: 'ruc.portal' }, observedAt, {} as any),
    /未提供 portalSchedule/,
  )
  await assert.rejects(
    normalizeRucRequest({ mode: 'fixture', source: 'ruc.graduate', payload: fixture('graduate-timetable.json') }, observedAt),
    /必须提供 term/,
  )
})

test('empty fixture sync still creates an immutable structured fragment', async () => {
  const calendar = { terms: [{ id: '2026-fall', name: '秋季', startMonday: '2026-09-07', weeks: 18 }] }
  const ctx = createCtx(calendar, observedAt)
  const db = openDb(':memory:')
  try {
    const result = await runRucSync(
      db, ctx,
      { mode: 'fixture', source: 'ruc.portal', payload: [{ day: '2026-09-09 00:00:00' }] },
    )
    assert.equal(result.records.length, 0)
    assert.equal(result.fragmentIds.length, 1)
    const row = db.prepare('SELECT raw_type, raw_text FROM fragments WHERE id = ?').get(result.fragmentIds[0]!) as { raw_type: string; raw_text: string }
    assert.equal(row.raw_type, 'structured')
    assert.match(row.raw_text, /2026-09-09/)
  } finally {
    db.close()
  }
})

test('batch runner keeps per-source raw responses and empty-source fragments', async () => {
  const calendar = { terms: [{ id: '2026-fall', name: '秋季', startMonday: '2026-09-07', weeks: 18 }] }
  const ctx = createCtx(calendar, observedAt)
  const db = openDb(':memory:')
  try {
    const portalPayload = [{ day: '2026-09-09 00:00:00' }]
    const graduatePayload = fixture('graduate-timetable.json')
    const result = await runRucSyncBatch(db, ctx, [
      { mode: 'fixture', source: 'ruc.portal', payload: portalPayload },
      { mode: 'fixture', source: 'ruc.graduate', payload: graduatePayload, term },
    ])
    assert.equal(result.fragmentIds.length, 2)
    const rows = db.prepare('SELECT raw_text FROM fragments ORDER BY rowid').all() as Array<{ raw_text: string }>
    assert.ok(rows.some((row) => row.raw_text.includes('2026-09-09')))
    assert.ok(rows.some((row) => row.raw_text.includes('C-A')))
  } finally {
    db.close()
  }
})

test('ingest uses A upsertByExternalId: duplicate sync is idempotent and changes write sync history', () => {
  const calendar = {
    terms: [{ id: '2026-fall', name: '秋季', startMonday: '2026-09-07', weeks: 18 }],
  }
  const ctx = createCtx(calendar, observedAt)
  const db = openDb(':memory:')
  try {
    const records = parsePortalSchedule(fixture('portal-schedule.json'), { observedAt })
      .filter((record) => record.kind === 'timetable')
    const first = ingestExternalRecords(db, ctx, records)
    assert.equal(first.itemIds.length, 2)
    assert.equal(listItems(db).length, 2)
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM sync_records').get() as { n: number }).n, 2)

    const second = ingestExternalRecords(db, ctx, records)
    assert.equal(second.itemIds.length, 2)
    assert.equal(listItems(db).length, 2)
    assert.equal(itemHistory(db, second.itemIds[0]!).length, 0)

    const changed = records.map((record, index) => index === 0
      ? { ...record, title: `${record.title}（调课）` }
      : record) as ExternalRecord[]
    const third = ingestExternalRecords(db, { ...ctx, now: '2026-09-05T13:00:00+08:00' }, changed)
    assert.equal(listItems(db).length, 2)
    assert.ok(itemHistory(db, third.itemIds[0]!).some((row) => row.actor === 'sync' && row.field === 'title'))
  } finally {
    db.close()
  }
})

test('sync record storage turns an absent raw body into JSON null for SQLite', () => {
  const calendar = { terms: [{ id: '2026-fall', name: '秋季', startMonday: '2026-09-07', weeks: 18 }] }
  const ctx = createCtx(calendar, observedAt)
  const db = openDb(':memory:')
  try {
    const record = {
      externalId: 'ruc:portal:v1:calendar:missing-raw:2026-09-09',
      source: 'ruc.portal' as const,
      kind: 'calendar' as const,
      observedAt,
      title: '无原文体事件',
      raw: undefined,
      capability: 'available' as const,
    }
    const result = ingestExternalRecords(db, ctx, [record])
    assert.equal(result.itemIds.length, 1)
    assert.equal((db.prepare('SELECT raw_json FROM sync_records WHERE external_id = ?').get(record.externalId) as { raw_json: string }).raw_json, 'null')
  } finally {
    db.close()
  }
})

test('future-dated running sync is recovered instead of blocking all later runs', () => {
  const calendar = { terms: [{ id: '2026-fall', name: '秋季', startMonday: '2026-09-07', weeks: 18 }] }
  const db = openDb(':memory:')
  try {
    const future = '2026-09-05T13:00:00+08:00'
    const first = startSyncRun(db, createCtx(calendar, future), 'ruc.portal')
    const next = startSyncRun(db, createCtx(calendar, observedAt), 'ruc.portal')
    assert.equal(first.reused, false)
    assert.equal(next.reused, false)
    assert.equal((db.prepare('SELECT status FROM sync_runs WHERE id = ?').get(first.run.id) as { status: string }).status, 'failed')
    assert.equal(next.run.status, 'running')
  } finally {
    db.close()
  }
})
