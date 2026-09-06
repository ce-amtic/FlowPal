import {
  ExternalKind,
  ExternalRecord as SharedExternalRecord,
  ExternalSource,
  CapabilityStatus,
} from '@flowpal/shared'
import type { FragmentSource } from '@flowpal/shared'

/**
 * A normalized fact coming from an explicitly authorized external source.
 *
 * This is deliberately smaller than an Item.  External systems often expose
 * an end time or a week bitmap while the local Item schema does not; those
 * facts stay in `raw`/`metadata` instead of being silently discarded or
 * forced into a misleading Item column.
 */
/** Shared is the single contract; this alias keeps server imports readable. */
export const ExternalRecordSchema = SharedExternalRecord
export const ExternalRecord = SharedExternalRecord
export const ExternalCapability = CapabilityStatus
export type ExternalRecord = import('@flowpal/shared').ExternalRecord
export type ExternalCapability = import('@flowpal/shared').CapabilityStatus

/**
 * A batch is the unit represented by one immutable structured Fragment.  The
 * existing FragmentSource enum has no `ruc.*` member, so source/kind are
 * mapped to the closest local provenance without changing A's schema.
 */
export type StructuredBatch = {
  source: Extract<FragmentSource, 'calendar' | 'timetable'>
  kind: ExternalKind
  observedAt: string
  records: ExternalRecord[]
  rawText: string
}

export type SyncIngestResult = {
  fragmentIds: string[]
  itemIds: string[]
  records: ExternalRecord[]
}

export class ExternalShapeError extends Error {
  readonly code = 'external_shape_error'

  constructor(message: string) {
    super(message)
    this.name = 'ExternalShapeError'
  }
}

export class UnsupportedExternalSourceError extends Error {
  readonly code = 'unsupported_external_source'

  constructor(message: string) {
    super(message)
    this.name = 'UnsupportedExternalSourceError'
  }
}

/** Keep the local Item mapping in one place for callers that need the type. */
export type ExternalDatePrecision = 'day' | 'minute'

export { ExternalKind, ExternalSource, CapabilityStatus }
