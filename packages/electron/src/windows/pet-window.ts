import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import { isAllowedAppNavigation, type AppLocation } from './app-location.ts'
import { IPC_CHANNELS, type PetStatus, type PetStatusMeta } from '../ipc/channels.ts'

export type PetWindowOptions = {
  preloadPath: string
  app: AppLocation
  size?: 96 | 224
}

const pendingStatuses = new WeakMap<BrowserWindow, { status: PetStatus; meta?: PetStatusMeta }>()
let latestStatus: { status: PetStatus; meta?: PetStatusMeta } | undefined

function petUrl(app: AppLocation): string {
  if (app.mode === 'dev') {
    const url = new URL('/pet.html', app.url)
    return url.toString()
  }
  return join(app.distDir, 'pet.html')
}

export function createPetWindow(options: PetWindowOptions): BrowserWindow {
  // quiet-pebble's “桌面 96” preset is the resident size. 224 remains an
  // explicit opt-in for an enlarged presentation or future accessibility UI.
  const size = options.size ?? 96
  const display = screen.getPrimaryDisplay()
  const workArea = display.workArea
  const x = Math.round(workArea.x + workArea.width - size - 32)
  const y = Math.round(workArea.y + workArea.height - size - 32)

  const win = new BrowserWindow({
    x,
    y,
    width: size,
    height: size,
    useContentSize: true,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    focusable: false,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: options.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      // See main-window.ts: the typed preload is an ESM bundle. Keep the
      // renderer isolated even though the preload itself is unsandboxed.
      sandbox: false,
      spellcheck: false,
    },
  })

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event: { preventDefault: () => void }, url: string) => {
    if (!isAllowedAppNavigation(options.app, url)) event.preventDefault()
  })

  // Keep the pet above ordinary windows without forcing it above fullscreen
  // spaces.  Not all platforms support every level, so failure is harmless.
  try {
    win.setAlwaysOnTop(true, 'floating', 1)
  } catch {
    win.setAlwaysOnTop(true)
  }
  try {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false })
  } catch {
    // Older Linux window managers may not implement workspace visibility.
  }

  win.setSkipTaskbar(true)
  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return
    // showInactive avoids stealing focus from the user's current document.
    win.showInactive()
  })
  void loadPet(win, options.app).catch((error: unknown) => {
    console.error('FlowPal 桌宠窗口加载失败。', error)
  })
  return win
}

export async function loadPet(win: BrowserWindow, app: AppLocation): Promise<void> {
  if (app.mode === 'dev') await win.loadURL(petUrl(app))
  else await win.loadFile(petUrl(app))
  const pending = pendingStatuses.get(win) ?? latestStatus
  if (pending && !win.isDestroyed()) {
    win.webContents.send(IPC_CHANNELS.petCommand, { type: 'set-status', ...pending })
  }
}

export function setPetStatus(
  win: BrowserWindow | null,
  status: PetStatus,
  meta?: PetStatusMeta,
): void {
  latestStatus = { status, meta }
  if (!win || win.isDestroyed()) return
  pendingStatuses.set(win, latestStatus)
  win.webContents.send(IPC_CHANNELS.petCommand, { type: 'set-status', status, meta })
}

export function setPetPointerPassthrough(win: BrowserWindow | null, inside: boolean): void {
  if (!win || win.isDestroyed()) return
  // Forwarding keeps pointer movement available to the renderer while the
  // cursor is outside the ray-marched shape. The renderer's hitTest, not the
  // rectangular BrowserWindow bounds, decides whether the pet is interactive.
  try {
    win.setIgnoreMouseEvents(!inside, { forward: true })
  } catch {
    // A platform window manager may not support forwarding; leave the window
    // interactive rather than letting a pointer event crash the main process.
  }
}

export function showPet(win: BrowserWindow | null): void {
  if (!win || win.isDestroyed()) return
  // A hidden pet may have been left in pointer-passthrough mode. Reset to an
  // interactive state for the first frame so it can report its shape hit-test
  // again; the renderer will immediately restore passthrough outside the form.
  try {
    win.setIgnoreMouseEvents(false)
  } catch {
    // Some window managers do not expose this toggle.
  }
  win.showInactive()
}

export function hidePet(win: BrowserWindow | null): void {
  if (!win || win.isDestroyed()) return
  win.hide()
}
