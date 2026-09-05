/**
 * window.flowpal —— 主进程暴露的四个方法，加一份浏览器 mock。
 *
 * 有 mock 的意义是界面全程可以在普通浏览器标签页里开发，不启动 Electron，
 * 于是界面这条线不被主进程那条线阻塞。
 */
export type FlowpalBridge = {
  /** 主进程的 process.platform。窗口底色与窗口按钮的位置按平台分，不能一概而论 */
  platform: string
  onHotkeyOpen: (cb: () => void) => void
  onFilesDropped: (cb: (paths: string[]) => void) => void
  readClipboard: () => Promise<string>
  hideWindow: () => Promise<void>
}

declare global {
  interface Window { flowpal?: FlowpalBridge }
}

const browserMock: FlowpalBridge = {
  platform: 'browser',
  onHotkeyOpen: () => {},
  onFilesDropped: () => {},
  readClipboard: () => navigator.clipboard.readText(),
  hideWindow: async () => {},
}

export const bridge: FlowpalBridge = window.flowpal ?? browserMock
export const inElectron = window.flowpal !== undefined
/** 只有 macOS 有窗口毛玻璃和左上角红绿灯。其余平台两样都没有，界面得知道 */
export const onMac = bridge.platform === 'darwin'
