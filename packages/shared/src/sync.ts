import { z } from 'zod'

export const ExternalSource = z.enum(['ruc.portal', 'ruc.graduate'])
export type ExternalSource = z.infer<typeof ExternalSource>

export const ExternalKind = z.enum(['calendar', 'timetable', 'exam'])
export type ExternalKind = z.infer<typeof ExternalKind>

export const CapabilityStatus = z.enum(['available', 'unsupported', 'unauthorized', 'error'])
export type CapabilityStatus = z.infer<typeof CapabilityStatus>

/** Adapter capability is also allowed to carry an authorization/error result. */
export const ExternalCapability = CapabilityStatus
export type ExternalCapability = z.infer<typeof ExternalCapability>

export const SourceCapability = z.object({
  source: ExternalSource,
  kinds: z.array(ExternalKind),
  status: CapabilityStatus,
  reason: z.string().nullable(),
}).strict()
export type SourceCapability = z.infer<typeof SourceCapability>

/** One normalized record returned by a source adapter. */
export const ExternalRecord = z.object({
  externalId: z.string().min(1),
  source: ExternalSource,
  kind: ExternalKind,
  observedAt: z.string(),
  title: z.string(),
  startsAt: z.string().nullable().optional(),
  endsAt: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  datePrecision: z.enum(['day', 'minute']).nullable().optional(),
  dateRaw: z.string().nullable().optional(),
  recurrence: z.string().nullable().optional(),
  allDay: z.boolean().nullable().optional(),
  metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  raw: z.unknown(),
  capability: ExternalCapability,
}).strict()
export type ExternalRecord = z.infer<typeof ExternalRecord>

export const SyncRunStatus = z.enum(['running', 'succeeded', 'partial', 'failed', 'unsupported'])
export type SyncRunStatus = z.infer<typeof SyncRunStatus>

export const SyncRun = z.object({
  id: z.string(),
  source: ExternalSource.nullable(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  status: SyncRunStatus,
  importedCount: z.number().int().nonnegative(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
}).strict()
export type SyncRun = z.infer<typeof SyncRun>

export const SyncRunRequest = z.object({
  source: ExternalSource.nullable().optional(),
  /** `online` is the production path; `fixture` is an explicit offline import. */
  mode: z.enum(['online', 'fixture']).default('online'),
  /** Optional fixture payload supplied by a local importer/test harness. */
  payload: z.unknown().optional(),
  /** Graduate timetable requests are term-scoped. */
  term: z.object({ code: z.string().min(1), name: z.string().min(1) }).strict().optional(),
}).strict()
export type SyncRunRequest = z.infer<typeof SyncRunRequest>

export const SyncStatus = z.object({
  runningRunId: z.string().nullable(),
  nextRunAt: z.string().nullable(),
  capabilities: z.array(SourceCapability),
  recentRuns: z.array(SyncRun),
}).strict()
export type SyncStatus = z.infer<typeof SyncStatus>

export const SyncStatusResponse = z.object({ status: SyncStatus }).strict()
export type SyncStatusResponse = z.infer<typeof SyncStatusResponse>
