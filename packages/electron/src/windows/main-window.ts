import { BrowserWindow } from 'electron'
import { join } from 'node:path'
import { isAllowedAppNavigation, type AppLocation } from './app-location.ts'
import { normalizeMainHash } from '../ipc/channels.ts'

export type MainWindowOptions = {
  preloadPath: string
  app: AppLocation
  initialHash?: string
}

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
    titleBarOverlay: isMac ? undefined : { color: '#00000000', symbolColor: '#888', height: 44 },
    vibrancy: isMac ? 'under-window' : undefined,
    visualEffectState: isMac ? 'active' : undefined,
    backgroundColor: isMac ? '#00000000' : '#faf9f7',
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

  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.show()
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
