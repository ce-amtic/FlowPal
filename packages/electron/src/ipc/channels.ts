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
  readClipboardImage: 'flowpal:read-clipboard-image',
  hidePet: 'flowpal:hide-pet',
  openMain: 'flowpal:open-main',
  petOpenMain: 'flowpal:pet-open-main',
  openRucLogin: 'flowpal:open-ruc-login',
  setPetStatus: 'flowpal:set-pet-status',
  petReportHit: 'flowpal:pet-report-hit',
  petBeginDrag: 'flowpal:pet-begin-drag',
  petMoveDrag: 'flowpal:pet-move-drag',
  petEndDrag: 'flowpal:pet-end-drag',
  petCancelDrag: 'flowpal:pet-cancel-drag',
  captureProbe: 'flowpal:capture-probe',
  captureScreenshot: 'flowpal:capture-screenshot',
  hotkeyOpen: 'flowpal:hotkey-open',
  petCommand: 'flowpal:pet-command',
  focusSessionChanged: 'flowpal:focus-session-changed',
  mainWindowFocusChanged: 'flowpal:main-window-focus-changed',
  petInlineGeometry: 'flowpal:pet-inline-geometry',
  desktopInput: 'flowpal:desktop-input',
  petForwardInput: 'flowpal:pet-forward-input',
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
  | ({ type: 'presentation' } & PetPresentationChange)
  | { type: 'set-status'; status: PetStatus; meta?: PetStatusMeta }

export type FocusSessionChange = {
  sessionId?: string
  status: 'running' | 'completed' | 'continued' | 'ended'
  itemId?: string
}

/**
 * The operating-system window focus state is deliberately separate from the
 * focus-session state above.  A focused main window renders the pet in-page;
 * a blurred main window hands presentation back to the resident pet window.
 */
export type MainWindowFocusChange = {
  focused: boolean
  presentation?: PetPresentationChange
}

export type PetPresentationMode = 'inline' | 'floating'
export type PetPresentationPhase =
  | 'steady'
  | 'floating-start'
  | 'floating-land'
  | 'teleport-out'
  | 'teleport-in'

export type PetPresentationChange = {
  mode: PetPresentationMode
  phase: PetPresentationPhase
  durationMs?: number
}

export type InlinePetGeometry = {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Native input delivered to the main renderer.  The source is kept explicit
 * so the app can preserve an audit trail without trusting renderer identity.
 */
export type DesktopInput =
  | { type: 'focus-composer' }
  | { type: 'clipboard'; source: 'pet' | 'hotkey' }
  | { type: 'files'; paths: string[]; source: 'drop' }

/**
 * Input that may cross from the resident pet renderer.  A pet is never
 * allowed to impersonate the global hotkey source.
 */
export type PetForwardInput =
  | { type: 'focus-composer' }
  | { type: 'clipboard'; source: 'pet' }
  | { type: 'files'; paths: string[]; source: 'drop' }

export const DESKTOP_INPUT_LIMITS = {
  maxFiles: 32,
  maxPathLength: 4096,
} as const

export type DragResult =
  | { ok: true }
  | { ok: false; reason: 'cancelled' | 'unsupported' | 'permission-denied' | 'not-implemented' }

export type CaptureCapability = {
  supported: boolean
  reason?: 'not-implemented' | 'permission-denied' | 'unsupported-platform'
}

export type CaptureScreenshotResult =
  | { ok: true; path: string; sourceId: string }
  | { ok: false; reason: 'permission-denied' | 'unsupported-platform' | 'not-implemented' | 'capture-failed' }

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
  if (command.type === 'presentation') return isPetPresentationChange(command)
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

export function isMainWindowFocusChange(value: unknown): value is MainWindowFocusChange {
  if (!value || typeof value !== 'object') return false
  const change = value as Record<string, unknown>
  return typeof change.focused === 'boolean'
    && (change.presentation === undefined || isPetPresentationChange(change.presentation))
}

export function isPetPresentationChange(value: unknown): value is PetPresentationChange {
  if (!value || typeof value !== 'object') return false
  const change = value as Record<string, unknown>
  if (change.mode !== 'inline' && change.mode !== 'floating') return false
  if (
    change.phase !== 'steady'
    && change.phase !== 'floating-start'
    && change.phase !== 'floating-land'
    && change.phase !== 'teleport-out'
    && change.phase !== 'teleport-in'
  ) return false
  return change.durationMs === undefined
    || (isFiniteNumber(change.durationMs) && change.durationMs >= 0 && change.durationMs <= 5000)
}

export function isInlinePetGeometry(value: unknown): value is InlinePetGeometry {
  if (!value || typeof value !== 'object') return false
  const geometry = value as Record<string, unknown>
  return isFiniteNumber(geometry.x)
    && isFiniteNumber(geometry.y)
    && isFiniteNumber(geometry.width)
    && isFiniteNumber(geometry.height)
    && geometry.width >= 32
    && geometry.width <= 512
    && geometry.height >= 32
    && geometry.height <= 512
}

function isSafeDroppedPath(value: unknown): value is string {
  if (typeof value !== 'string') return false
  if (value.length === 0 || value.length > DESKTOP_INPUT_LIMITS.maxPathLength) return false
  if (/[\u0000-\u001f\u007f]/.test(value)) return false
  // webUtils.getPathForFile returns an absolute native path.  Keep the check
  // platform-neutral so a Windows path can still be forwarded when tests or a
  // remote renderer run under a different host platform.
  return value.startsWith('/')
    || value.startsWith('\\\\')
    || /^[A-Za-z]:[\\/]/.test(value)
}

function isFilesInput(value: Record<string, unknown>): value is {
  type: 'files'
  paths: string[]
  source: 'drop'
} {
  if (value.type !== 'files' || value.source !== 'drop' || !Array.isArray(value.paths)) return false
  if (value.paths.length === 0 || value.paths.length > DESKTOP_INPUT_LIMITS.maxFiles) return false
  return value.paths.every(isSafeDroppedPath)
}

export function isDesktopInput(value: unknown): value is DesktopInput {
  if (!value || typeof value !== 'object') return false
  const input = value as Record<string, unknown>
  if (input.type === 'focus-composer') return true
  if (input.type === 'clipboard') return input.source === 'pet' || input.source === 'hotkey'
  return isFilesInput(input)
}

export function isPetForwardInput(value: unknown): value is PetForwardInput {
  if (!isDesktopInput(value)) return false
  return value.type !== 'clipboard' || value.source === 'pet'
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
