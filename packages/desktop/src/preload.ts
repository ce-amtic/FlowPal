import { contextBridge, ipcRenderer, webUtils } from 'electron'

/**
 * 冻结的 preload 面：只有这四个方法。
 *
 * 界面（C）用它，主进程（B）实现它。冻下来之后 C 全程可以在浏览器标签页里开发——
 * 不在 Electron 里时 packages/app/src/bridge.ts 有一份 mock。
 */
contextBridge.exposeInMainWorld('flowpal', {
  onHotkeyOpen: (cb: () => void) => ipcRenderer.on('flowpal:hotkey-open', () => cb()),
  onFilesDropped: (cb: (paths: string[]) => void) => {
    window.addEventListener('drop', (e) => {
      e.preventDefault()
      const files = Array.from(e.dataTransfer?.files ?? [])
      cb(files.map((f) => webUtils.getPathForFile(f)))
    })
    window.addEventListener('dragover', (e) => e.preventDefault())
  },
  readClipboard: (): Promise<string> => ipcRenderer.invoke('flowpal:read-clipboard'),
  hideWindow: (): Promise<void> => ipcRenderer.invoke('flowpal:hide-window'),
})
