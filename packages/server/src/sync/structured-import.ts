import type { DatabaseSync } from 'node:sqlite'
import type { Ctx, ExtractedItem } from '@flowpal/shared'
import { insertFragment, type NewFragment } from '../store/fragments.ts'
import { upsertByExternalId } from '../store/items.ts'
import { upsertSyncRecord } from '../store/sync.ts'
import {
  ExternalRecordSchema,
  UnsupportedExternalSourceError,
  type ExternalKind,
  type ExternalRecord,
  type ExternalSource,
  type StructuredBatch,
  type SyncIngestResult,
} from './types.ts'

/**
 * Map one normalized external fact to A's deterministic ExtractedItem shape.
 * No LLM or semantic dedupe is involved.  End times remain in the external
 * raw record because A's current wide Item table has no `ends_at` column.
 */
export function externalRecordToExtractedItem(record: ExternalRecord, rawText?: string): ExtractedItem {
  const checked = ExternalRecordSchema.parse(record)
  if (checked.kind === 'exam') {
    throw new UnsupportedExternalSourceError('RUC 考试记录 adapter 尚未接入')
  }
  const item: ExtractedItem = {
    type: 'event',
    title: checked.title,
    starts_at: checked.startsAt ?? null,
    due_at: null,
    date_precision: checked.datePrecision ?? (checked.allDay ? 'day' : checked.startsAt ? 'minute' : null),
    date_raw: checked.dateRaw ?? null,
    recurrence: checked.recurrence ?? null,
    location: checked.location ?? null,
    confidence: checked.capability === 'available' ? 'high' : 'low',
    date_confidence: checked.startsAt ? 'high' : null,
    citations: rawText ? citationsFromRecord(checked, rawText) : [],
  }
  return item
}

/** Group records into immutable fragments without changing A's Fragment schema. */
export function externalRecordsToBatches(
  records: readonly ExternalRecord[],
  options: {
    rawPayload?: unknown
    rawPayloadBySource?: Partial<Record<ExternalSource, unknown>>
  } = {},
): StructuredBatch[] {
  const groups = new Map<string, ExternalRecord[]>()
  for (const record of records) {
    const checked = ExternalRecordSchema.parse(record)
    if (checked.kind === 'exam') {
      // The current clean-room scope has no verified RUC exam endpoint or
      // normalizer. Never let a hand-crafted/partial adapter make exams look
      // imported merely because the shared enum reserves the kind.
      throw new UnsupportedExternalSourceError('RUC 考试记录 adapter 尚未接入')
    }
    if (checked.capability !== 'available') continue
    const fragmentSource = checked.kind === 'calendar' ? 'calendar' : 'timetable'
    const key = `${checked.source}:${checked.kind}:${fragmentSource}:${checked.observedAt}`
    const group = groups.get(key) ?? []
    group.push(checked)
    groups.set(key, group)
  }
  return [...groups.values()].map((group) => {
    const first = group[0]!
    const source = first.kind === 'calendar' ? 'calendar' : 'timetable'
    const payload = {
      schema: 'flowpal.ruc.external-records.v1',
      source: first.source,
      kind: first.kind,
      observedAt: first.observedAt,
      ...(options.rawPayload !== undefined
        ? { response: options.rawPayload }
        : options.rawPayloadBySource && Object.prototype.hasOwnProperty.call(options.rawPayloadBySource, first.source)
          ? { response: options.rawPayloadBySource[first.source] }
          : {}),
      records: group,
    }
    return {
      source,
      kind: first.kind,
      observedAt: first.observedAt,
      records: group,
      rawText: JSON.stringify(payload),
    }
  })
}

/** Build the exact NewFragment input used by callers that only need a batch. */
export function batchToFragmentInput(batch: StructuredBatch): NewFragment {
  return {
    source: batch.source,
    rawType: 'structured',
    rawText: batch.rawText,
    device: 'ruc-sync',
  }
}

/**
 * Persist one sync result.  The immutable structured fragment is written first;
 * every record then uses A's `upsertByExternalId` entry point.  A transaction
 * makes a malformed later record unable to leave a half-imported batch.
 */
export function ingestExternalRecords(
  db: DatabaseSync,
  ctx: Ctx,
  records: readonly ExternalRecord[],
  options: {
    projectIdFor?: (record: ExternalRecord) => string | null
    /** Preserve the exact endpoint response, including an empty response. */
    rawPayload?: unknown
    rawPayloadBySource?: Partial<Record<ExternalSource, unknown>>
    source?: ExternalSource
    kind?: ExternalKind
    emptyBatches?: Array<{ source: ExternalSource; kind: ExternalKind; rawPayload: unknown }>
  } = {},
): SyncIngestResult {
  const batches = externalRecordsToBatches(records, {
    rawPayload: options.rawPayload,
    rawPayloadBySource: options.rawPayloadBySource,
  })
  if (batches.length === 0 && options.rawPayload !== undefined && options.source && options.kind) {
    const source = options.kind === 'calendar' ? 'calendar' : 'timetable'
    batches.push({
      source,
      kind: options.kind,
      observedAt: ctx.now,
      records: [],
      rawText: JSON.stringify({
        schema: 'flowpal.ruc.external-records.v1',
        source: options.source,
        kind: options.kind,
        observedAt: ctx.now,
        response: options.rawPayload,
        records: [],
      }),
    })
  }
  for (const empty of options.emptyBatches ?? []) {
    const source = empty.kind === 'calendar' ? 'calendar' : 'timetable'
    batches.push({
      source,
      kind: empty.kind,
      observedAt: ctx.now,
      records: [],
      rawText: JSON.stringify({
        schema: 'flowpal.ruc.external-records.v1',
        source: empty.source,
        kind: empty.kind,
        observedAt: ctx.now,
        response: empty.rawPayload,
        records: [],
      }),
    })
  }
  const fragmentIds: string[] = []
  const itemIds: string[] = []
  const accepted = batches.flatMap((batch) => batch.records)
  db.exec('BEGIN')
  try {
    for (const batch of batches) {
      const fragment = insertFragment(db, ctx, batchToFragmentInput(batch))
      fragmentIds.push(fragment.id)
      for (const record of batch.records) {
        const item = externalRecordToExtractedItem(record, batch.rawText)
        const projectId = options.projectIdFor?.(record) ?? null
        const id = upsertByExternalId(db, ctx, fragment.id, record.externalId, item, { projectId })
        upsertSyncRecord(db, record, id)
        itemIds.push(id)
      }
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return { fragmentIds, itemIds, records: accepted }
}

function citationsFromRecord(record: ExternalRecord, rawText: string): ExtractedItem['citations'] {
  const candidates: Array<{ field: 'title' | 'starts_at' | 'location' | 'date_raw'; value: string | null | undefined }> = [
    { field: 'title', value: record.title },
    { field: 'starts_at', value: record.startsAt },
    { field: 'location', value: record.location },
    { field: 'date_raw', value: record.dateRaw },
  ]
  const seen = new Set<string>()
  const citations: ExtractedItem['citations'] = []
  for (const candidate of candidates) {
    if (!candidate.value || seen.has(candidate.field)) continue
    const start = rawText.indexOf(candidate.value)
    if (start < 0) continue
    seen.add(candidate.field)
    citations.push({ field: candidate.field, quote: candidate.value })
  }
  return citations
}
