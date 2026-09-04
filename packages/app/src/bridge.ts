/**
 * window.flowpal —— 主进程暴露的四个方法，加一份浏览器 mock。
 *
 * 有 mock 的意义是界面全程可以在普通浏览器标签页里开发，不启动 Electron，
 * 于是界面这条线不被主进程那条线阻塞。
 */
export type FlowpalBridge = {
  onHotkeyOpen: (cb: () => void) => void
  onFilesDropped: (cb: (paths: string[]) => void) => void
  readClipboard: () => Promise<string>
  hideWindow: () => Promise<void>
}

declare global {
  interface Window { flowpal?: FlowpalBridge }
}

const browserMock: FlowpalBridge = {
  onHotkeyOpen: () => {},
  onFilesDropped: () => {},
  readClipboard: () => navigator.clipboard.readText(),
  hideWindow: async () => {},
}

export const bridge: FlowpalBridge = window.flowpal ?? browserMock
export const inElectron = window.flowpal !== undefined
