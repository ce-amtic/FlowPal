/**
 * window.flowpal —— 主进程暴露的四个方法，加一份浏览器 mock。
 *
 * 有 mock 的意义是界面全程可以在普通浏览器标签页里开发，不启动 Electron，
 * 于是界面这条线不被主进程那条线阻塞。
 */
export type Unsubscribe = () => void

export type DesktopInputBridgeEvent =
  | { type: 'focus-composer' }
  | { type: 'clipboard'; source: 'pet' | 'hotkey' }
  | { type: 'files'; paths: string[]; source: 'drop' }

export type PetPresentationBridgeEvent = {
  mode: 'inline' | 'floating'
  phase: 'steady' | 'floating-start' | 'floating-land' | 'teleport-out' | 'teleport-in'
  durationMs?: number
}

export type FlowpalBridge = {
  platform: string
  onHotkeyOpen: (cb: () => void) => Unsubscribe
  onFilesDropped: (cb: (paths: string[]) => void) => Unsubscribe
  onDesktopInput?: (cb: (input: DesktopInputBridgeEvent) => void) => Unsubscribe
  /** Native main-window focus drives the inline/floating pet hand-off. */
  onMainWindowFocusChanged?: (cb: (change: {
    focused: boolean
    presentation?: PetPresentationBridgeEvent
  }) => void) => Unsubscribe
  reportPetGeometry?: (geometry: { x: number; y: number; width: number; height: number }) => void
  onFocusSessionChanged?: (cb: (change: {
    sessionId?: string
    status: 'running' | 'completed' | 'continued' | 'ended'
    itemId?: string
  }) => void) => () => void
  readClipboard: () => Promise<string>
  readClipboardImage?: () => Promise<string | null>
  capture?: {
    probe: () => Promise<{ supported: boolean; reason?: string }>
    screenshot?: (sourceId?: string) => Promise<{ ok: boolean; path?: string; sourceId?: string; reason?: string }>
  }
  hideWindow: () => Promise<void>
  openMain?: (hash?: string) => Promise<void>
  openRucLogin?: () => Promise<void>
  setPetStatus?: (status: 'idle' | 'receiving' | 'processing' | 'done' | 'error' | 'focus', meta?: { message?: string }) => void
  pet?: {
    openMain?: (hash?: string) => Promise<void>
    setStatus: (status: 'idle' | 'receiving' | 'processing' | 'done' | 'error' | 'focus', meta?: { message?: string }) => void
    onCommand: (cb: (command: {
      type: 'open-main' | 'hide' | 'presentation' | 'set-status'
      status?: 'idle' | 'receiving' | 'processing' | 'done' | 'error' | 'focus'
      meta?: { message?: string }
      hash?: string
      mode?: 'inline' | 'floating'
      phase?: 'steady' | 'floating-start' | 'floating-land' | 'teleport-out' | 'teleport-in'
      durationMs?: number
    }) => void) => () => void
    reportHit: (inside: boolean) => void
    beginDrag: (point: { x: number; y: number; pointerId: number }) => void
    moveDrag: (point: { x: number; y: number; pointerId: number }) => void
    endDrag: () => Promise<unknown>
    cancelDrag: () => void
  }
  /** Optional cross-window forwarding used when a file is dropped on pet.html. */
  input?: {
    onHotkey?: (cb: () => void) => Unsubscribe
    onFilesDropped?: (cb: (paths: string[]) => void) => Unsubscribe
    readClipboard?: () => Promise<string>
    readClipboardImage?: () => Promise<string | null>
    forwardFiles?: (paths: string[]) => Promise<void>
    forwardInput?: (input: DesktopInputBridgeEvent) => Promise<void>
    onDesktopInput?: (cb: (input: DesktopInputBridgeEvent) => void) => Unsubscribe
  }
}

declare global {
  interface Window { flowpal?: FlowpalBridge }
}

const browserMock: FlowpalBridge = {
  platform: 'browser',
  onHotkeyOpen: () => () => {},
  onFilesDropped: () => () => {},
  onMainWindowFocusChanged: () => () => {},
  onFocusSessionChanged: () => () => {},
  readClipboard: () => navigator.clipboard.readText(),
  hideWindow: async () => {},
  openMain: async () => {},
  setPetStatus: () => {},
  pet: undefined,
  input: undefined,
}

export const bridge: FlowpalBridge = window.flowpal ?? browserMock
export const inElectron = window.flowpal !== undefined
export const onMac = bridge.platform === 'darwin'
