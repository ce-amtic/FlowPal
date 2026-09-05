import type { ExternalRecord } from './types.ts'
import {
  graduateTimetableRecords,
  normalizeGraduateTimetable,
  parseGraduateTerms,
  parseGraduateTimetable,
  type GraduateTerm,
  type NormalizedGraduateTimetable,
} from './normalizers/ruc-graduate.ts'

/** Clean-room, fixture-first adapter for the RUCGO-verified graduate endpoints. */
export function normalizeGraduatePayload(
  input: unknown,
  term: GraduateTerm,
  observedAt: string,
): ExternalRecord[] {
  return normalizeGraduateTimetable(input, term, observedAt)
}

export {
  graduateTimetableRecords,
  parseGraduateTerms,
  parseGraduateTimetable,
}
export type { GraduateTerm, NormalizedGraduateTimetable }
