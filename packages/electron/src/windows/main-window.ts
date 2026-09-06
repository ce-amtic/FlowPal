import { BrowserWindow, nativeTheme } from 'electron'
import { join } from 'node:path'
import { isAllowedAppNavigation, type AppLocation } from './app-location.ts'
import { normalizeMainHash } from '../ipc/channels.ts'

export type MainWindowOptions = {
  preloadPath: string
  app: AppLocation
  initialHash?: string
}

/**
 * 窗口这一层的底色。
 *
 * 没有毛玻璃的平台（Windows、Linux）上，它就是用户看见的底，必须跟着系统深浅走。
 * 写死一个浅色的话，深色模式下那片浅底会从半透明的界面底下透上来——队友在
 * Windows 上看到的就是这个。
 *
 * 这几个值是 packages/app/src/tokens/tokens.css 里 --bg-solid 与 --fg 的第二份
 * 拷贝：主进程读不到 CSS。改配色时这里要跟着改。
 */
const isDark = () => nativeTheme.shouldUseDarkColors
const windowBg = () => (isDark() ? '#1d1c1a' : '#faf9f7')

/** Windows 右上角那三个系统按钮的覆盖层。高度对齐界面里的 --titlebar-h */
const windowControls = () => ({
  color: windowBg(),
  symbolColor: isDark() ? '#ece9e4' : '#1c1b19',
  height: 44,
})

export function createMainWindow(options: MainWindowOptions): BrowserWindow {
  const isMac = process.platform === 'darwin'
  const win = new BrowserWindow({
    width: 880,
    height: 660,
    minWidth: 480,
    minHeight: 420,
    title: 'FlowPal',
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    trafficLightPosition: isMac ? { x: 18, y: 18 } : undefined,
    titleBarOverlay: isMac ? undefined : windowControls(),
    vibrancy: isMac ? 'under-window' : undefined,
    visualEffectState: isMac ? 'active' : undefined,
    backgroundColor: isMac ? '#00000000' : windowBg(),
    show: false,
    webPreferences: {
      preload: options.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      // The preload is emitted as an ESM `.mjs` bundle. Electron's sandboxed
      // preload loader has platform/version differences for ESM; context
      // isolation + nodeIntegration=false still keeps the renderer boundary
      // narrow while allowing the same bundle in dev and packaged builds.
      sandbox: false,
      spellcheck: true,
    },
  })

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event: { preventDefault: () => void }, url: string) => {
    if (!isAllowedAppNavigation(options.app, url)) event.preventDefault()
  })

  // 系统在运行中切深浅时，这两层不会自己跟着变。macOS 的毛玻璃会，所以不用管
  if (!isMac) {
    const follow = () => {
      if (win.isDestroyed()) return
      win.setBackgroundColor(windowBg())
      win.setTitleBarOverlay(windowControls())
    }
    nativeTheme.on('updated', follow)
    win.on('closed', () => nativeTheme.off('updated', follow))
  }

  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.show()
  })

  /*
   * 界面加载不上时 ready-to-show 永远不触发：应用在跑、server 在跑、窗口却根本
   * 不出现，终端里一个字都没有。开发时最常见的原因是界面那条 dev server 没起来。
   * 这里必须喊出来，不能让它静悄悄地什么都不发生。
   */
  win.webContents.on('did-fail-load', (_e, code, description, url) => {
    console.error(`界面加载失败：${url} → ${description}（${code}）`)
  })
  void loadMain(win, options.app, options.initialHash).catch((error: unknown) => {
    console.error('FlowPal 主窗口加载失败。', error)
  })
  return win
}

export async function loadMain(
  win: BrowserWindow,
  app: AppLocation,
  hash = '/now',
): Promise<void> {
  const normalizedHash = normalizeMainHash(hash)
  if (app.mode === 'dev') {
    const url = new URL(app.url)
    url.hash = normalizedHash
    await win.loadURL(url.toString())
  } else {
    await win.loadFile(join(app.distDir, 'index.html'), { hash: normalizedHash.slice(1) })
  }
}

export async function navigateMain(
  win: BrowserWindow,
  app: AppLocation,
  hash = '/now',
): Promise<void> {
  if (win.isDestroyed()) return
  const normalizedHash = normalizeMainHash(hash)
  if (!win.webContents.isLoading()) {
    const navigated = await win.webContents.executeJavaScript(
      `window.location.hash = ${JSON.stringify(normalizedHash)}; void 0`,
      true,
    ).then(() => true).catch(() => false)
    if (navigated) return
  }
  await loadMain(win, app, normalizedHash)
}
