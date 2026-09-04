import { app, BrowserWindow, clipboard, globalShortcut, ipcMain } from 'electron'
import { join } from 'node:path'
import { createServer, loadConfig } from '@flowpal/server'

/**
 * 这是全仓库唯一 import electron 的地方。
 *
 * Electron 只负责它非做不可的三件事：窗口、全局快捷键、系统级入口（拖拽 / 剪贴板）。
 * 业务逻辑全在 server 里，渲染进程走 HTTP 调它，不走 IPC——
 * 分界线是「手机端将来要不要得起」：要得起的全在 HTTP 侧。
 */
// 开发时 getAppPath() 是 packages/desktop，所以往上两级是仓库根。
// 一旦开始用 electron-builder 打包，这个假设就不成立了——prompts 与 calendar.json
// 要作为 extraResources 打进去，这一行要跟着改。
const repoRoot = join(app.getAppPath(), '..', '..')
const isDev = !app.isPackaged

let win: BrowserWindow | null = null

app.whenReady().then(() => {
  // dataDir 由这一侧算好传进去；server 自己不知道 app.getPath 存在。
  const server = createServer(loadConfig(repoRoot, {
    dataDir: join(app.getPath('userData'), 'data'),
  }))
  console.log(`FlowPal server: ${server.url}`)

  win = new BrowserWindow({
    width: 1100,
    height: 720,
    webPreferences: { preload: join(import.meta.dirname, 'preload.mjs'), sandbox: false },
  })

  if (isDev) win.loadURL('http://localhost:5173')
  else win.loadFile(join(repoRoot, 'packages/app/dist/index.html'))

  // 专注中冒出杂念时用：任意界面按快捷键弹出输入框，打字回车消失。
  globalShortcut.register('CommandOrControl+Shift+Space', () => {
    if (!win) return
    win.show()
    win.webContents.send('flowpal:hotkey-open')
  })

  ipcMain.handle('flowpal:read-clipboard', () => clipboard.readText())
  ipcMain.handle('flowpal:hide-window', () => { win?.hide() })

  app.on('will-quit', () => { globalShortcut.unregisterAll(); server.close() })
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
