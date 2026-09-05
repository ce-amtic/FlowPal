/**
 * The only IPC channel names used by the desktop shell.
 *
 * Keeping the channel list in a dependency-free module makes it possible to
 * bundle the main process and preload independently while still sharing the
 * exact same string literals.  The renderer never receives a generic
 * `ipcRenderer` object; it only gets the small methods exposed by preload.
 */
export const IPC_CHANNELS = {
  readClipboard: 'flowpal:read-clipboard',
  hidePet: 'flowpal:hide-pet',
  openMain: 'flowpal:open-main',
  setPetStatus: 'flowpal:set-pet-status',
  petReportHit: 'flowpal:pet-report-hit',
  petBeginDrag: 'flowpal:pet-begin-drag',
  petMoveDrag: 'flowpal:pet-move-drag',
  petEndDrag: 'flowpal:pet-end-drag',
  petCancelDrag: 'flowpal:pet-cancel-drag',
  captureProbe: 'flowpal:capture-probe',
  hotkeyOpen: 'flowpal:hotkey-open',
  petCommand: 'flowpal:pet-command',
  focusSessionChanged: 'flowpal:focus-session-changed',
} as const

export type PetStatus =
  | 'idle'
  | 'receiving'
  | 'processing'
  | 'done'
  | 'error'
  | 'focus'

export type PetStatusMeta = { message?: string }

export type ScreenPoint = { x: number; y: number }
export type PointerPoint = ScreenPoint & { pointerId: number }

export type PetCommand =
  | { type: 'open-main'; hash?: string }
  | { type: 'hide' }
  | { type: 'set-status'; status: PetStatus; meta?: PetStatusMeta }

export type FocusSessionChange = {
  sessionId?: string
  status: 'running' | 'completed' | 'continued' | 'ended'
  itemId?: string
}

export type DragResult =
  | { ok: true }
  | { ok: false; reason: 'cancelled' | 'unsupported' | 'permission-denied' | 'not-implemented' }

export type CaptureCapability = {
  supported: boolean
  reason?: 'not-implemented' | 'permission-denied' | 'unsupported-platform'
}

export function isPetStatus(value: unknown): value is PetStatus {
  return value === 'idle'
    || value === 'receiving'
    || value === 'processing'
    || value === 'done'
    || value === 'error'
    || value === 'focus'
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function isScreenPoint(value: unknown): value is ScreenPoint {
  if (!value || typeof value !== 'object') return false
  const point = value as Record<string, unknown>
  return isFiniteNumber(point.x) && isFiniteNumber(point.y)
}

export function isPointerPoint(value: unknown): value is PointerPoint {
  if (!isScreenPoint(value)) return false
  const point = value as Record<string, unknown>
  return isFiniteNumber(point.pointerId)
    && Number.isSafeInteger(point.pointerId)
    && point.pointerId >= 0
}

export function isPetCommand(value: unknown): value is PetCommand {
  if (!value || typeof value !== 'object') return false
  const command = value as Record<string, unknown>
  if (command.type === 'hide') return true
  if (command.type === 'open-main') return command.hash === undefined || typeof command.hash === 'string'
  if (command.type !== 'set-status' || !isPetStatus(command.status)) return false
  return command.meta === undefined || (
    Boolean(command.meta)
    && typeof command.meta === 'object'
    && ((command.meta as Record<string, unknown>).message === undefined
      || typeof (command.meta as Record<string, unknown>).message === 'string')
  )
}

export function isFocusSessionChange(value: unknown): value is FocusSessionChange {
  if (!value || typeof value !== 'object') return false
  const change = value as Record<string, unknown>
  return (
    (change.sessionId === undefined || typeof change.sessionId === 'string')
    && (change.itemId === undefined || typeof change.itemId === 'string')
    && (
      change.status === 'running'
      || change.status === 'completed'
      || change.status === 'continued'
      || change.status === 'ended'
    )
  )
}

/**
 * Paths are renderer navigation hints, not arbitrary URLs.  Keep the check
 * deliberately conservative: only local hash-router paths are accepted.
 */
export function normalizeMainHash(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return '/now'
  const path = value.startsWith('/') ? value : `/${value}`
  // The main window uses a HashRouter. Keep navigation inside its known local
  // route grammar; in particular reject schemes, fragment injection,
  // backslashes, traversal, control characters, and arbitrary file paths.
  const safeRoute = /^\/(?:now|recent|agenda|thoughts|settings|focus|collection|projects(?:\/[A-Za-z0-9._~-]+)?|items\/[A-Za-z0-9._~-]+)(?:\?[A-Za-z0-9._~%&=+\-]*)?$/
  if (
    path.length > 512
    || path.includes('\\')
    || path.includes('#')
    || path.includes('..')
    || /[\u0000-\u001f\u007f]/.test(path)
    || !safeRoute.test(path)
  ) return '/now'
  return path
}
