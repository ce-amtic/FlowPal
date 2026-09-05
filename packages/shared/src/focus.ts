import { z } from 'zod'

export const FocusOutcome = z.enum(['done', 'continue', 'early_end'])
export type FocusOutcome = z.infer<typeof FocusOutcome>

export const FocusSessionStatus = z.enum(['running', 'ended'])
export type FocusSessionStatus = z.infer<typeof FocusSessionStatus>

export const FocusSession = z.object({
  id: z.string(),
  startedAt: z.string(),
  plannedMinutes: z.number().int().positive(),
  actualMinutes: z.number().int().nonnegative().nullable(),
  endedEarly: z.boolean(),
  endedAt: z.string().nullable(),
  outcome: FocusOutcome.nullable(),
  itemId: z.string().nullable(),
  projectId: z.string().nullable(),
  createdAt: z.string(),
  status: FocusSessionStatus,
}).strict()
export type FocusSession = z.infer<typeof FocusSession>

export const StartFocusRequest = z.object({
  plannedMinutes: z.number().int().positive().max(24 * 60),
  itemId: z.string().nullable().optional(),
  projectId: z.string().nullable().optional(),
  /** Optional client retry key; target identity remains the default idempotency key. */
  idempotencyKey: z.string().min(1).max(200).nullable().optional(),
}).strict()
export type StartFocusRequest = z.infer<typeof StartFocusRequest>

export const EndFocusRequest = z.object({
  outcome: FocusOutcome,
  actualMinutes: z.number().int().nonnegative().nullable().optional(),
}).strict()
export type EndFocusRequest = z.infer<typeof EndFocusRequest>

export const FocusSummary = z.object({
  durationMinutes: z.number().int().nonnegative(),
  plannedMinutes: z.number().int().positive(),
  outcome: FocusOutcome.nullable(),
  itemId: z.string().nullable(),
  projectId: z.string().nullable(),
  fragmentCount: z.number().int().nonnegative(),
}).strict()
export type FocusSummary = z.infer<typeof FocusSummary>

export const FocusResponse = z.object({
  session: FocusSession,
  summary: FocusSummary,
}).strict()
export type FocusResponse = z.infer<typeof FocusResponse>
