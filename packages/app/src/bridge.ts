/**
 * window.flowpal —— 主进程暴露的四个方法，加一份浏览器 mock。
 *
 * 有 mock 的意义是界面全程可以在普通浏览器标签页里开发，不启动 Electron，
 * 于是界面这条线不被主进程那条线阻塞。
 */
export type Unsubscribe = () => void

export type FlowpalBridge = {
  onHotkeyOpen: (cb: () => void) => Unsubscribe
  onFilesDropped: (cb: (paths: string[]) => void) => Unsubscribe
  onFocusSessionChanged?: (cb: (change: {
    sessionId?: string
    status: 'running' | 'completed' | 'continued' | 'ended'
    itemId?: string
  }) => void) => () => void
  readClipboard: () => Promise<string>
  hideWindow: () => Promise<void>
  openMain?: (hash?: string) => Promise<void>
  setPetStatus?: (status: 'idle' | 'receiving' | 'processing' | 'done' | 'error' | 'focus', meta?: { message?: string }) => void
  pet?: {
    setStatus: (status: 'idle' | 'receiving' | 'processing' | 'done' | 'error' | 'focus', meta?: { message?: string }) => void
    onCommand: (cb: (command: { type: 'open-main' | 'hide' | 'set-status'; status?: 'idle' | 'receiving' | 'processing' | 'done' | 'error' | 'focus'; meta?: { message?: string }; hash?: string }) => void) => () => void
    reportHit: (inside: boolean) => void
    beginDrag: (point: { x: number; y: number; pointerId: number }) => void
    moveDrag: (point: { x: number; y: number; pointerId: number }) => void
    endDrag: () => Promise<unknown>
    cancelDrag: () => void
  }
}

declare global {
  interface Window { flowpal?: FlowpalBridge }
}

const browserMock: FlowpalBridge = {
  onHotkeyOpen: () => () => {},
  onFilesDropped: () => () => {},
  onFocusSessionChanged: () => () => {},
  readClipboard: () => navigator.clipboard.readText(),
  hideWindow: async () => {},
  openMain: async () => {},
  setPetStatus: () => {},
  pet: undefined,
}

export const bridge: FlowpalBridge = window.flowpal ?? browserMock
export const inElectron = window.flowpal !== undefined
