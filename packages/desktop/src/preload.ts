import { contextBridge, ipcRenderer, webUtils } from 'electron'

/**
 * 冻结的 preload 面：四个方法加一个平台标识。
 *
 * 界面（C）用它，主进程（B）实现它。冻下来之后 C 全程可以在浏览器标签页里开发——
 * 不在 Electron 里时 packages/app/src/bridge.ts 有一份 mock。
 *
 * 两个订阅都是「换掉那一个」而不是「再加一个」：界面里的 effect 会重跑（热更新、
 * 组件重挂），每跑一次挂一个监听的话，拖一次文件会被处理好几遍。
 *
 * 监听器在第一次订阅时才挂上，不在模块顶层挂——这是个 ESM preload，顶层求值的
 * 时机早于文档，那时候碰 window 会直接把整个 preload 打断，窗口连出现都不会出现。
 */
let onFiles: ((paths: string[]) => void) | null = null
let onHotkey: (() => void) | null = null
let dropWired = false

function wireDrop(): void {
  if (dropWired) return
  dropWired = true
  window.addEventListener('dragover', (e) => e.preventDefault())
  window.addEventListener('drop', (e) => {
    e.preventDefault()
    const files = Array.from(e.dataTransfer?.files ?? [])
    if (files.length > 0) onFiles?.(files.map((f) => webUtils.getPathForFile(f)))
  })
}

ipcRenderer.on('flowpal:hotkey-open', () => onHotkey?.())

contextBridge.exposeInMainWorld('flowpal', {
  // 界面要知道自己站在哪：只有 macOS 有窗口毛玻璃与左上角红绿灯，
  // 其余平台的底色和窗口按钮位置都不一样。
  platform: process.platform,
  onHotkeyOpen: (cb: () => void) => { onHotkey = cb },
  onFilesDropped: (cb: (paths: string[]) => void) => { onFiles = cb; wireDrop() },
  readClipboard: (): Promise<string> => ipcRenderer.invoke('flowpal:read-clipboard'),
  hideWindow: (): Promise<void> => ipcRenderer.invoke('flowpal:hide-window'),
  // 登录要一个真的浏览器窗口，只有主进程开得出来。设置页调它。
  signInToRuc: () => ipcRenderer.invoke('flowpal:sign-in-ruc'),
  // 邮箱授权码在离开界面之前先加密：钥匙在系统钥匙串里，只有主进程够得着。
  encryptSecret: (plain: string) => ipcRenderer.invoke('flowpal:encrypt-secret', plain),
})
