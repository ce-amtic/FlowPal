import { BrowserWindow, screen, type Rectangle } from 'electron'
import { join } from 'node:path'
import { isAllowedAppNavigation, type AppLocation } from './app-location.ts'
import {
  IPC_CHANNELS,
  type PetPresentationChange,
  type PetStatus,
  type PetStatusMeta,
} from '../ipc/channels.ts'

export type PetWindowOptions = {
  preloadPath: string
  app: AppLocation
  size?: 148 | 224
  bounds?: Rectangle
}

const pendingStatuses = new WeakMap<BrowserWindow, { status: PetStatus; meta?: PetStatusMeta }>()
// `ready-to-show` is asynchronous.  Record the latest native visibility
// intent so a main-window focus transition that hides the pet before its first
// paint cannot be undone by the default ready callback.
const pendingVisibility = new WeakMap<BrowserWindow, boolean>()
let latestStatus: { status: PetStatus; meta?: PetStatusMeta } | undefined
let latestPresentation: PetPresentationChange = { mode: 'inline', phase: 'steady' }
// Native file drags do not participate in Chromium's forwarded pointer
// stream. While the pet is detached, keep its small 224px window interactive
// so Finder/Explorer can deliver dragenter/drop instead of targeting the
// window underneath. The renderer still owns ordinary pointer gestures.
let floatingDropTarget = false

function petUrl(app: AppLocation): string {
  if (app.mode === 'dev') {
    const url = new URL('/pet.html', app.url)
    return url.toString()
  }
  return join(app.distDir, 'pet.html')
}

export function createPetWindow(options: PetWindowOptions): BrowserWindow {
  // A=148 is the in-page presentation bounds; B=224 is the always-on-top
  // resident presentation used during a focus hand-off.
  const size = options.size ?? 224
  const display = screen.getPrimaryDisplay()
  const workArea = display.workArea
  const initialBounds = options.bounds ?? {
    x: Math.round(workArea.x + workArea.width - size - 32),
    y: Math.round(workArea.y + workArea.height - size - 32),
    width: size,
    height: size,
  }

  const win = new BrowserWindow({
    ...initialBounds,
    useContentSize: true,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'FlowPal Pet',
    skipTaskbar: true,
    show: false,
    // The resident pet must be focusable while floating. On macOS a
    // non-focusable transparent window can activate the window underneath
    // when clicked, which looks like a pet click navigating back to main.
    // `showInactive()` still keeps presentation changes from stealing focus;
    // once clicked, the pet itself owns the event instead of the main window.
    focusable: true,
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
    if (pendingVisibility.get(win) === false) return
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
  if (!win.isDestroyed()) {
    win.webContents.send(IPC_CHANNELS.petCommand, { type: 'presentation', ...latestPresentation })
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

export function sendPetPresentation(
  win: BrowserWindow | null,
  change: PetPresentationChange,
): void {
  latestPresentation = change
  if (!win || win.isDestroyed()) return
  try {
    win.webContents.send(IPC_CHANNELS.petCommand, { type: 'presentation', ...change })
  } catch {
    // Renderer teardown can race a presentation transition.
  }
}

export function setPetPointerPassthrough(win: BrowserWindow | null, inside: boolean): void {
  if (!win || win.isDestroyed()) return
  // Forwarding keeps pointer movement available to the renderer while the
  // cursor is outside the ray-marched shape. The renderer's hitTest, not the
  // rectangular BrowserWindow bounds, decides whether the pet is interactive.
  try {
    win.setIgnoreMouseEvents(floatingDropTarget ? false : !inside, { forward: true })
  } catch {
    // A platform window manager may not support forwarding; leave the window
    // interactive rather than letting a pointer event crash the main process.
  }
}

export function setPetFloatingDropTarget(enabled: boolean): void {
  floatingDropTarget = enabled
}

export function showPet(win: BrowserWindow | null): void {
  if (!win || win.isDestroyed()) return
  pendingVisibility.set(win, true)
  try { win.setFocusable(true) } catch { /* closing */ }
  // A hidden pet may have been left in pointer-passthrough mode. Reset to an
  // interactive state for the first frame so it can report its shape hit-test
  // again; the renderer will immediately restore passthrough outside the form.
  try {
    win.setIgnoreMouseEvents(false)
  } catch {
    // Some window managers do not expose this toggle.
  }
  try {
    // Reassert the level after a focus hand-off or a child-window interaction;
    // macOS can otherwise retain the window's old ordering for one cycle.
    win.setAlwaysOnTop(true, 'floating', 1)
  } catch {
    try { win.setAlwaysOnTop(true) } catch { /* closing */ }
  }
  win.showInactive()
}

export function hidePet(win: BrowserWindow | null): void {
  if (!win || win.isDestroyed()) return
  pendingVisibility.set(win, false)
  win.hide()
}
