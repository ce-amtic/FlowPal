import {
  app,
  clipboard,
  desktopCapturer,
  ipcMain,
  screen,
  type BrowserWindow,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  IPC_CHANNELS,
  isInlinePetGeometry,
  isPetForwardInput,
  isPointerPoint,
  isPetStatus,
  normalizeMainHash,
  type CaptureCapability,
  type DesktopInput,
  type DragResult,
  type FocusSessionChange,
  type InlinePetGeometry,
  type PetStatusMeta,
  type PointerPoint,
} from './channels.ts'
import { hidePet, setPetPointerPassthrough, setPetStatus } from '../windows/pet-window.ts'
import { focusWindow } from '../lifecycle/single-instance.ts'
import { navigateMain, type MainWindowOptions } from '../windows/main-window.ts'

export type DesktopWindowState = {
  getMain: () => BrowserWindow | null
  getPet: () => BrowserWindow | null
  getMainOptions: () => MainWindowOptions
  getInlinePetGeometry: () => InlinePetGeometry | null
  setInlinePetGeometry: (geometry: InlinePetGeometry) => void
  openRucLogin: () => void
  forwardDesktopInput: (input: DesktopInput) => void
}

export type IpcHandlerController = {
  dispose: () => void
  resetDrag: () => void
}

type WindowRectangle = { x: number; y: number; width: number; height: number }

type DragSession = {
  pointerId: number
  startPoint: PointerPoint
  startBounds: WindowRectangle
}

function senderIs(event: IpcMainEvent | IpcMainInvokeEvent, win: BrowserWindow | null): boolean {
  return Boolean(win && !win.isDestroyed() && event.sender === win.webContents)
}

function senderIsKnown(event: IpcMainEvent | IpcMainInvokeEvent, state: DesktopWindowState): boolean {
  return senderIs(event, state.getMain()) || senderIs(event, state.getPet())
}

function safeMeta(value: unknown): PetStatusMeta | undefined {
  if (!value || typeof value !== 'object') return undefined
  const message = (value as Record<string, unknown>).message
  if (typeof message !== 'string') return undefined
  return { message: message.slice(0, 500) }
}

/** Register all renderer-facing handlers once during app startup. */
export function registerIpcHandlers(state: DesktopWindowState): IpcHandlerController {
  let drag: DragSession | null = null

  const onSetPetStatus = (
    event: IpcMainEvent,
    status: unknown,
    meta: unknown,
  ): void => {
    if (!senderIsKnown(event, state) || !isPetStatus(status)) return
    setPetStatus(state.getPet(), status, safeMeta(meta))
  }

  const onInlinePetGeometry = (event: IpcMainEvent, geometry: unknown): void => {
    if (!senderIs(event, state.getMain()) || !isInlinePetGeometry(geometry)) return
    state.setInlinePetGeometry(geometry)
  }

  const onReportHit = (event: IpcMainEvent, inside: unknown): void => {
    // `pet.reportHit` uses sendSync deliberately: the transparent-window hit
    // mode must be updated before the next click can pass through. Electron
    // requires an explicit returnValue for synchronous IPC; omitting it leaves
    // the pet renderer blocked after its first pointer-move notification.
    event.returnValue = false
    if (!senderIs(event, state.getPet())) return
    // A committed native drag owns the pointer until pointerup/cancel. A
    // delayed forwarded mousemove from before the drag threshold can still
    // report `inside=false`; never let that stale hit-test put the window back
    // into click-through mode while the drag session is active.
    if (drag) {
      event.returnValue = true
      return
    }
    setPetPointerPassthrough(state.getPet(), inside === true)
    event.returnValue = true
  }

  const onBeginDrag = (event: IpcMainEvent, point: unknown): void => {
    const pet = state.getPet()
    if (!pet || !senderIs(event, pet) || !isPointerPoint(point)) return
    if (drag) return
    // A resident pet window is normally click-through outside its ray-marched
    // silhouette (`setIgnoreMouseEvents(true, { forward: true })`).  Once the
    // renderer has crossed the drag threshold, explicitly take the window out
    // of pass-through mode for the whole native drag session.  Without this
    // transition a forwarded mousemove from the old hit-test state can race
    // the first drag IPC and macOS drops pointer events, making the pet look
    // impossible to drag even though the renderer gesture is active.
    setPetPointerPassthrough(pet, true)
    // Renderer coordinates are useful only for identifying the pointer. The
    // main process owns the screen-space cursor so a moving window, display
    // scale factor, or delayed renderer event cannot compound deltas.
    let cursor: { x: number; y: number }
    try {
      cursor = screen.getCursorScreenPoint()
    } catch {
      return
    }
    let bounds: WindowRectangle
    try {
      bounds = pet.getBounds()
    } catch {
      return
    }
    drag = {
      pointerId: point.pointerId,
      startPoint: { ...point, x: cursor.x, y: cursor.y },
      startBounds: bounds,
    }
  }

  const onMoveDrag = (event: IpcMainEvent, point: unknown): void => {
    const pet = state.getPet()
    if (!pet || !senderIs(event, pet) || !drag || !isPointerPoint(point)) return
    if (point.pointerId !== drag.pointerId) return
    // A drag owns the pointer even after it leaves the mascot silhouette;
    // never let the transparent-window hit-test switch back to passthrough
    // while this session is active.
    setPetPointerPassthrough(pet, true)
    let cursor: { x: number; y: number }
    try {
      cursor = screen.getCursorScreenPoint()
    } catch {
      return
    }
    const dx = cursor.x - drag.startPoint.x
    const dy = cursor.y - drag.startPoint.y
    const next = {
      x: Math.round(drag.startBounds.x + dx),
      y: Math.round(drag.startBounds.y + dy),
      width: drag.startBounds.width,
      height: drag.startBounds.height,
    }
    try {
      pet.setBounds(next)
    } catch {
      // A close/quit can race the final pointer event. Drop the session so a
      // newly-created pet is never blocked by a stale renderer sender.
      drag = null
    }
  }

  const endDrag = (cancelled: boolean): DragResult => {
    if (!drag) return { ok: false, reason: 'cancelled' }
    drag = null
    return cancelled ? { ok: false, reason: 'cancelled' } : { ok: true }
  }

  const onCancelDrag = (event: IpcMainEvent): void => {
    const pet = state.getPet()
    if (!senderIs(event, pet)) return
    endDrag(true)
    // The renderer may cancel before a drag threshold was committed. Keep the
    // normal hit-test mode; no native session owns the pointer.
    setPetPointerPassthrough(pet, false)
  }

  const onReadClipboard = async (event: IpcMainInvokeEvent): Promise<string> => {
    if (!senderIsKnown(event, state)) return ''
    return clipboard.readText()
  }

  const onReadClipboardImage = async (event: IpcMainInvokeEvent): Promise<string | null> => {
    if (!senderIsKnown(event, state)) return null
    const entries = await clipboard.read()
    const entry = entries.find((candidate) => candidate.types.some((type) => type === 'image/png' || type === 'image/jpeg' || type.startsWith('image/')))
    if (!entry) return null
    const mime = entry.types.find((type) => type === 'image/png' || type === 'image/jpeg' || type.startsWith('image/'))
    if (!mime) return null
    const blob = await entry.getType(mime)
    if (!(blob instanceof Blob)) return null
    const png = Buffer.from(await blob.arrayBuffer())
    if (png.length === 0) return null
    const dir = join(app.getPath('temp'), 'flowpal-clipboard')
    await mkdir(dir, { recursive: true })
    const extension = mime === 'image/jpeg' ? 'jpg' : 'png'
    const path = join(dir, `clipboard-${Date.now()}-${Math.random().toString(36).slice(2)}.${extension}`)
    await writeFile(path, png, { flag: 'wx' })
    return path
  }

  const onPetForwardInput = async (
    event: IpcMainInvokeEvent,
    payload: unknown,
  ): Promise<void> => {
    // Only the resident pet may originate this bridge call.  In particular,
    // a compromised main renderer cannot use it to forge a second input path.
    if (!senderIs(event, state.getPet()) || !isPetForwardInput(payload)) return
    const main = state.getMain()
    if (!main || main.isDestroyed()) return
    // A gesture on the resident pet is an explicit hand-off to the main
    // window. Focusing here makes the focus/blur presentation invariant hold
    // before the renderer starts processing the capture, so the inline pet
    // and receipt are visible and the resident window is hidden.
    focusWindow(main)
    // The validator narrows this to the exact desktop-input union accepted by
    // the main renderer.  Copy the object before crossing the process boundary
    // so no renderer-owned prototype or mutable reference is retained.
    const input: DesktopInput = payload.type === 'clipboard'
      ? { type: 'clipboard', source: 'pet' }
      : payload.type === 'files'
        ? { type: 'files', source: 'drop', paths: [...payload.paths] }
        : { type: 'focus-composer' }
    // The main process owns delivery. It queues while the renderer is loading,
    // so a drop during focus/restore/reload cannot disappear between windows.
    state.forwardDesktopInput(input)
  }

  const onHidePet = (event: IpcMainInvokeEvent): void => {
    if (!senderIsKnown(event, state)) return
    hidePet(state.getPet())
  }

  const onOpenMain = async (event: IpcMainInvokeEvent, hash: unknown): Promise<void> => {
    // The resident pet has a separate navigation channel. Rejecting the
    // generic channel here makes stale/accidental pet click handlers harmless.
    if (!senderIs(event, state.getMain())) return
    const main = state.getMain()
    if (!main) return
    // Hide first so a pet click cannot leave the resident window visible while
    // the native focus event is still travelling through the window manager.
    // The main lifecycle listener will publish the authoritative `focused`
    // state once the OS confirms the transition.
    hidePet(state.getPet())
    focusWindow(main)
    // No route means "restore this window", not "go to /now". In particular,
    // normalizing undefined would silently discard a running focus session.
    if (typeof hash === 'string') {
      await navigateMain(main, state.getMainOptions().app, normalizeMainHash(hash))
    }
  }

  const onPetOpenMain = async (event: IpcMainInvokeEvent, hash: unknown): Promise<void> => {
    if (!senderIs(event, state.getPet())) return
    const main = state.getMain()
    if (!main) return
    hidePet(state.getPet())
    focusWindow(main)
    if (typeof hash === 'string') {
      await navigateMain(main, state.getMainOptions().app, normalizeMainHash(hash))
    }
  }

  const onOpenRucLogin = (event: IpcMainInvokeEvent): void => {
    if (!senderIsKnown(event, state)) return
    state.openRucLogin()
  }

  const onEndDrag = (event: IpcMainInvokeEvent): DragResult => {
    const pet = state.getPet()
    if (!senderIs(event, pet)) return { ok: false, reason: 'cancelled' }
    const result = endDrag(false)
    // Release native capture only after the renderer has emitted pointerup;
    // restoring pass-through in the next macrotask avoids dropping that final
    // event on transparent window managers while keeping transparent pixels
    // click-through immediately afterwards.
    setTimeout(() => setPetPointerPassthrough(pet, false), 0)
    return result
  }

  const onCaptureProbe = (event: IpcMainInvokeEvent): CaptureCapability => {
    if (!senderIsKnown(event, state)) return { supported: false, reason: 'not-implemented' }
    // desktopCapturer is available on macOS/Windows/Linux, but macOS may
    // still deny thumbnails until Screen Recording permission is granted.
    return process.platform === 'darwin' || process.platform === 'win32' || process.platform === 'linux'
      ? { supported: true }
      : { supported: false, reason: 'unsupported-platform' }
  }

  const onCaptureScreenshot = async (event: IpcMainInvokeEvent, requestedSourceId?: unknown) => {
    if (!senderIsKnown(event, state)) return { ok: false as const, reason: 'capture-failed' as const }
    if (!['darwin', 'win32', 'linux'].includes(process.platform)) {
      return { ok: false as const, reason: 'unsupported-platform' as const }
    }
    try {
      const sources = await desktopCapturer.getSources({
        types: ['window', 'screen'],
        thumbnailSize: { width: 1920, height: 1200 },
        fetchWindowIcons: false,
      })
      const source = typeof requestedSourceId === 'string'
        ? sources.find((candidate) => candidate.id === requestedSourceId)
        : sources.find((candidate) => candidate.id.startsWith('screen:')) ?? sources[0]
      if (!source || source.thumbnail.isEmpty()) {
        return { ok: false as const, reason: 'permission-denied' as const }
      }
      const dir = join(app.getPath('temp'), 'flowpal-capture')
      await mkdir(dir, { recursive: true })
      const path = join(dir, `capture-${Date.now()}-${Math.random().toString(36).slice(2)}.png`)
      await writeFile(path, source.thumbnail.toPNG(), { flag: 'wx' })
      return { ok: true as const, path, sourceId: source.id }
    } catch {
      return { ok: false as const, reason: 'capture-failed' as const }
    }
  }

  ipcMain.on(IPC_CHANNELS.setPetStatus, onSetPetStatus)
  ipcMain.on(IPC_CHANNELS.petInlineGeometry, onInlinePetGeometry)
  ipcMain.on(IPC_CHANNELS.petReportHit, onReportHit)
  ipcMain.on(IPC_CHANNELS.petBeginDrag, onBeginDrag)
  ipcMain.on(IPC_CHANNELS.petMoveDrag, onMoveDrag)
  ipcMain.on(IPC_CHANNELS.petCancelDrag, onCancelDrag)
  ipcMain.handle(IPC_CHANNELS.readClipboard, onReadClipboard)
  ipcMain.handle(IPC_CHANNELS.readClipboardImage, onReadClipboardImage)
  ipcMain.handle(IPC_CHANNELS.petForwardInput, onPetForwardInput)
  ipcMain.handle(IPC_CHANNELS.hidePet, onHidePet)
  ipcMain.handle(IPC_CHANNELS.openMain, onOpenMain)
  ipcMain.handle(IPC_CHANNELS.petOpenMain, onPetOpenMain)
  ipcMain.handle(IPC_CHANNELS.openRucLogin, onOpenRucLogin)
  ipcMain.handle(IPC_CHANNELS.petEndDrag, onEndDrag)
  ipcMain.handle(IPC_CHANNELS.captureProbe, onCaptureProbe)
  ipcMain.handle(IPC_CHANNELS.captureScreenshot, onCaptureScreenshot)

  const dispose = (): void => {
    ipcMain.removeListener(IPC_CHANNELS.setPetStatus, onSetPetStatus)
    ipcMain.removeListener(IPC_CHANNELS.petInlineGeometry, onInlinePetGeometry)
    ipcMain.removeListener(IPC_CHANNELS.petReportHit, onReportHit)
    ipcMain.removeListener(IPC_CHANNELS.petBeginDrag, onBeginDrag)
    ipcMain.removeListener(IPC_CHANNELS.petMoveDrag, onMoveDrag)
    ipcMain.removeListener(IPC_CHANNELS.petCancelDrag, onCancelDrag)
    ipcMain.removeHandler(IPC_CHANNELS.readClipboard)
    ipcMain.removeHandler(IPC_CHANNELS.readClipboardImage)
    ipcMain.removeHandler(IPC_CHANNELS.petForwardInput)
    ipcMain.removeHandler(IPC_CHANNELS.hidePet)
    ipcMain.removeHandler(IPC_CHANNELS.openMain)
    ipcMain.removeHandler(IPC_CHANNELS.petOpenMain)
    ipcMain.removeHandler(IPC_CHANNELS.openRucLogin)
    ipcMain.removeHandler(IPC_CHANNELS.petEndDrag)
    ipcMain.removeHandler(IPC_CHANNELS.captureProbe)
    ipcMain.removeHandler(IPC_CHANNELS.captureScreenshot)
    drag = null
  }

  return {
    dispose,
    // A pet window can be closed and recreated while the main window stays
    // alive. Never let the old renderer's drag session block the new one.
    resetDrag: () => { drag = null },
  }
}

export function broadcastFocusSession(
  state: DesktopWindowState,
  change: FocusSessionChange,
): void {
  for (const win of [state.getMain(), state.getPet()]) {
    if (win && !win.isDestroyed()) win.webContents.send(IPC_CHANNELS.focusSessionChanged, change)
  }
}
