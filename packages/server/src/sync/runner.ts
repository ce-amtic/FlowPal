import type { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import type { Ctx, ExternalSource } from '@flowpal/shared'
import { ExternalShapeError, UnsupportedExternalSourceError, type ExternalRecord, type SyncIngestResult } from './types.ts'
import { normalizePortalPayload } from './portal-source.ts'
import { normalizeGraduatePayload, type GraduateTerm } from './graduate-source.ts'
import { ingestExternalRecords } from './structured-import.ts'

export type FixtureSyncRequest = {
  mode: 'fixture'
  source: ExternalSource
  payload: unknown
  /** Required for the graduate source because its endpoint is term-scoped. */
  term?: GraduateTerm
}

export type OnlineSyncRequest = {
  mode: 'online'
  source: ExternalSource
  term?: GraduateTerm
}

export type RucSyncRequest = FixtureSyncRequest | OnlineSyncRequest

const BUNDLED_GRADUATE_TERM: GraduateTerm = {
  code: '20261',
  name: '2026-2027学年 第一学期',
}

/**
 * Return the checked-in, deterministic demo payload for an explicit offline
 * run.  Keeping this loader beside the runner means packaged server callers do
 * not need to guess a cwd-relative fixtures path.
 */
export function bundledFixtureRequest(source: ExternalSource): FixtureSyncRequest {
  const filename = source === 'ruc.portal' ? 'portal-schedule.json' : 'graduate-timetable.json'
  const payload = JSON.parse(readFileSync(new URL(`./fixtures/${filename}`, import.meta.url), 'utf8')) as unknown
  return source === 'ruc.portal'
    ? { mode: 'fixture', source, payload }
    : { mode: 'fixture', source, payload, term: BUNDLED_GRADUATE_TERM }
}

/**
 * The seam between the deterministic normalizers and an Electron-owned auth
 * broker.  P0 only supplies fixture mode; online implementations must be
 * injected later and cannot accidentally become a fake success.
 */
export type RucOnlineBroker = {
  portalSchedule: () => Promise<unknown>
  graduateTimetable: (term: GraduateTerm) => Promise<unknown>
  /** Optional term discovery; online graduate sync remains explicit otherwise. */
  graduateTerm?: () => Promise<GraduateTerm>
}

export async function normalizeRucRequest(
  request: RucSyncRequest,
  observedAt: string,
  broker?: RucOnlineBroker,
): Promise<ExternalRecord[]> {
  if (request.mode === 'fixture') {
    if (request.source === 'ruc.portal') {
      return normalizePortalPayload(request.payload, { observedAt })
    }
    if (!request.term) {
      throw new ExternalShapeError('研究生 fixture 同步必须提供 term')
    }
    return normalizeGraduatePayload(request.payload, request.term, observedAt)
  }

  if (!broker) {
    throw new UnsupportedExternalSourceError(
      `在线 ${request.source} adapter 尚未接入；请使用显式 mode=fixture 或完成 RUC 登录授权`,
    )
  }
  if (request.source === 'ruc.portal') {
    if (typeof broker.portalSchedule !== 'function') {
      throw new UnsupportedExternalSourceError('在线 RUC 门户 adapter 未提供 portalSchedule')
    }
    return normalizePortalPayload(await broker.portalSchedule(), { observedAt })
  }
  if (typeof broker.graduateTimetable !== 'function') {
    throw new UnsupportedExternalSourceError('在线 RUC 研究生 adapter 未提供 graduateTimetable')
  }
  const discoverTerm = typeof broker.graduateTerm === 'function' ? broker.graduateTerm : undefined
  const term = request.term ?? await discoverTerm?.()
  if (!term) throw new ExternalShapeError('在线研究生同步必须提供 term')
  return normalizeGraduatePayload(
    await broker.graduateTimetable(term), term, observedAt,
  )
}

/** Normalize and persist one explicit fixture/broker run. */
export async function runRucSync(
  db: DatabaseSync,
  ctx: Ctx,
  request: RucSyncRequest,
  broker?: RucOnlineBroker,
  options: { projectIdFor?: (record: ExternalRecord) => string | null } = {},
): Promise<SyncIngestResult> {
  const records = await normalizeRucRequest(request, ctx.now, broker)
  const kind = request.source === 'ruc.portal'
    ? (records.some((record) => record.kind === 'timetable') ? 'timetable' : 'calendar')
    : 'timetable'
  return ingestExternalRecords(db, ctx, records, {
    rawPayload: request.mode === 'fixture' ? request.payload : undefined,
    source: request.source,
    kind,
    projectIdFor: options.projectIdFor,
  })
}

/** Normalize all requested sources before writing any of them. */
export async function runRucSyncBatch(
  db: DatabaseSync,
  ctx: Ctx,
  requests: readonly RucSyncRequest[],
  broker?: RucOnlineBroker,
  options: { projectIdFor?: (record: ExternalRecord) => string | null } = {},
): Promise<SyncIngestResult> {
  const normalized = await Promise.all(requests.map(async (request) => ({
    request,
    records: await normalizeRucRequest(request, ctx.now, broker),
  })))
  const records = normalized.flatMap((entry) => entry.records)
  const rawPayloadBySource: Partial<Record<ExternalSource, unknown>> = {}
  const emptyBatches: Array<{ source: ExternalSource; kind: 'calendar' | 'timetable'; rawPayload: unknown }> = []
  for (const { request, records: sourceRecords } of normalized) {
    if (request.mode !== 'fixture') continue
    rawPayloadBySource[request.source] = request.payload
    if (sourceRecords.length === 0) {
      emptyBatches.push({
        source: request.source,
        kind: request.source === 'ruc.portal' ? 'calendar' : 'timetable',
        rawPayload: request.payload,
      })
    }
  }
  return ingestExternalRecords(db, ctx, records, {
    rawPayloadBySource,
    emptyBatches,
    projectIdFor: options.projectIdFor,
  })
}
