import { app, BrowserWindow } from 'electron'
import { normalizeMainHash } from '../ipc/channels.ts'

export type SingleInstanceOptions = {
  focusExisting: (argv: string[]) => void
}

/**
 * Acquire the lock before `whenReady`.  This prevents a second process from
 * opening a second HTTP server or scheduler.  The second invocation only
 * carries an optional hash path to the already-running main window.
 */
export function acquireSingleInstance(options: SingleInstanceOptions): boolean {
  const acquired = app.requestSingleInstanceLock()
  if (!acquired) {
    app.quit()
    return false
  }

  app.on('second-instance', (_event: unknown, argv: string[]) => options.focusExisting(argv))
  return true
}

export function focusWindow(win: BrowserWindow | null): void {
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
  win.focus()
}

export function hashFromArgv(argv: string[]): string | undefined {
  // Only accept an explicit local hash-route argument.  File paths and flags
  // from launchers must never become renderer navigation targets.
  for (const candidate of argv) {
    if (!candidate.startsWith('/') || candidate.length > 512) continue
    const normalized = normalizeMainHash(candidate)
    // Do not turn an executable path such as `/Applications/FlowPal.app` into
    // a silent `/now` navigation. Only an already-valid local route is a
    // second-instance navigation hint.
    if (normalized === candidate) return normalized
  }
  return undefined
}
