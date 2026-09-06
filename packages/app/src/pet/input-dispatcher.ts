/**
 * Renderer-local input bus.
 *
 * The main window and the resident pet are separate renderer processes, so the
 * Electron preload is responsible for crossing that boundary. Once an input
 * reaches the main renderer this tiny bus keeps the Composer and the capture
 * controller decoupled from the WebGL renderer. It is also useful in browser
 * mode, where tests can dispatch the same events without Electron.
 */
export type DesktopInput =
  | { type: 'focus-composer' }
  | { type: 'clipboard'; source: 'pet' | 'hotkey' }
  | { type: 'files'; paths: string[]; source: 'drop' }
  | { type: 'text'; text: string; source: 'drop' }
  | { type: 'receipt'; message: string; error?: boolean }

export type DesktopInputListener = (input: DesktopInput) => void

const listeners = new Set<DesktopInputListener>()

export function dispatchDesktopInput(input: DesktopInput): void {
  if (input.type === 'files' && input.paths.length === 0) return
  if (input.type === 'text' && input.text.trim() === '') return
  for (const listener of [...listeners]) listener(input)
}

export function subscribeDesktopInput(listener: DesktopInputListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
