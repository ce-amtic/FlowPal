import { app, BrowserWindow, clipboard, globalShortcut, ipcMain, nativeTheme } from 'electron'
import { join } from 'node:path'
import { createServer, loadConfig } from '@flowpal/server'

/**
 * 这是全仓库唯一 import electron 的地方。
 *
 * Electron 只负责它非做不可的三件事：窗口、全局快捷键、系统级入口（拖拽 / 剪贴板）。
 * 业务逻辑全在 server 里，渲染进程走 HTTP 调它，不走 IPC——
 * 分界线是「手机端将来要不要得起」：要得起的全在 HTTP 侧。
 */
// 必须在 whenReady 之前：它同时决定 macOS 菜单栏里显示的名字和 userData 的目录名。
// 不设的话两者都会是包名 @flowpal/desktop。
app.setName('FlowPal')

// 开发时 getAppPath() 是 packages/desktop，所以往上两级是仓库根。
// 一旦开始用 electron-builder 打包，这个假设就不成立了——prompts 与 calendar.json
// 要作为 extraResources 打进去，这一行要跟着改。
const repoRoot = join(app.getAppPath(), '..', '..')
const isDev = !app.isPackaged

let win: BrowserWindow | null = null

/**
 * 没有毛玻璃的平台上，窗口这一层就是用户看见的底，必须跟着系统深浅走。
 * 写死一个浅色的话，深色模式下浅底会从透明的界面底下透上来。
 *
 * 这几个值是 packages/app/src/tokens/tokens.css 里 --bg-solid 与 --fg 的第二份
 * 拷贝——主进程读不到 CSS。改配色时这里要跟着改。
 */
const isDark = () => nativeTheme.shouldUseDarkColors
const windowBg = () => (isDark() ? '#1d1c1a' : '#faf9f7')

/** Windows 的窗口按钮覆盖层。高度对齐界面里的 --titlebar-h */
const windowControls = () => ({
  color: windowBg(),
  symbolColor: isDark() ? '#ece9e4' : '#1c1b19',
  height: 44,
})

app.whenReady().then(() => {
  // dataDir 由这一侧算好传进去；server 自己不知道 app.getPath 存在。
  const server = createServer(loadConfig(repoRoot, {
    dataDir: join(app.getPath('userData'), 'data'),
  }))
  console.log(`FlowPal server: ${server.url}`)

  const isMac = process.platform === 'darwin'

  win = new BrowserWindow({
    width: 880,
    height: 660,
    minWidth: 480,
    minHeight: 420,
    // 隐藏标题栏，红绿灯内缩：窗口顶部交给界面自己处理，省掉一条系统色带。
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    trafficLightPosition: isMac ? { x: 18, y: 18 } : undefined,
    // Windows 上没有 hiddenInset，用系统按钮覆盖层顶上。
    titleBarOverlay: isMac ? undefined : windowControls(),
    // 毛玻璃底，窗口背景必须透明才透得出来。
    vibrancy: isMac ? 'under-window' : undefined,
    visualEffectState: 'active',
    backgroundColor: isMac ? '#00000000' : windowBg(),
    show: false,
    webPreferences: { preload: join(import.meta.dirname, 'preload.mjs'), sandbox: false },
  })

  // 等首帧再显示，避免开窗时闪一下白。
  win.once('ready-to-show', () => win?.show())

  // 系统在运行中切深浅时，这两层不会自己跟着变。macOS 的毛玻璃会，所以不用管。
  if (!isMac) {
    nativeTheme.on('updated', () => {
      win?.setBackgroundColor(windowBg())
      win?.setTitleBarOverlay(windowControls())
    })
  }

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
