import type { ExternalRecord } from './types.ts'
import { parsePortalSchedule, type PortalNormalizeOptions } from './normalizers/ruc-portal.ts'

/** Clean-room, offline-capable adapter for my.ruc.edu.cn calendarList.rst. */
export function normalizePortalPayload(input: unknown, options: PortalNormalizeOptions): ExternalRecord[] {
  return parsePortalSchedule(input, options)
}

export { parsePortalSchedule }
