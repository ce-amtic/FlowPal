import {
  clipboard,
  ipcMain,
  screen,
  type BrowserWindow,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from 'electron'
import {
  IPC_CHANNELS,
  isPointerPoint,
  isPetStatus,
  normalizeMainHash,
  type CaptureCapability,
  type DragResult,
  type FocusSessionChange,
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

  const onReportHit = (event: IpcMainEvent, inside: unknown): void => {
    if (!senderIs(event, state.getPet())) return
    setPetPointerPassthrough(state.getPet(), inside === true)
  }

  const onBeginDrag = (event: IpcMainEvent, point: unknown): void => {
    const pet = state.getPet()
    if (!pet || !senderIs(event, pet) || !isPointerPoint(point)) return
    if (drag) return
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
    if (!senderIs(event, state.getPet())) return
    endDrag(true)
  }

  const onReadClipboard = async (event: IpcMainInvokeEvent): Promise<string> => {
    if (!senderIsKnown(event, state)) return ''
    return clipboard.readText()
  }

  const onHidePet = (event: IpcMainInvokeEvent): void => {
    if (!senderIsKnown(event, state)) return
    hidePet(state.getPet())
  }

  const onOpenMain = async (event: IpcMainInvokeEvent, hash: unknown): Promise<void> => {
    if (!senderIsKnown(event, state)) return
    const main = state.getMain()
    if (!main) return
    focusWindow(main)
    await navigateMain(main, state.getMainOptions().app, normalizeMainHash(hash))
  }

  const onEndDrag = (event: IpcMainInvokeEvent): DragResult => {
    if (!senderIs(event, state.getPet())) return { ok: false, reason: 'cancelled' }
    return endDrag(false)
  }

  const onCaptureProbe = (event: IpcMainInvokeEvent): CaptureCapability => {
    if (!senderIsKnown(event, state)) return { supported: false, reason: 'not-implemented' }
    return { supported: false, reason: 'not-implemented' }
  }

  ipcMain.on(IPC_CHANNELS.setPetStatus, onSetPetStatus)
  ipcMain.on(IPC_CHANNELS.petReportHit, onReportHit)
  ipcMain.on(IPC_CHANNELS.petBeginDrag, onBeginDrag)
  ipcMain.on(IPC_CHANNELS.petMoveDrag, onMoveDrag)
  ipcMain.on(IPC_CHANNELS.petCancelDrag, onCancelDrag)
  ipcMain.handle(IPC_CHANNELS.readClipboard, onReadClipboard)
  ipcMain.handle(IPC_CHANNELS.hidePet, onHidePet)
  ipcMain.handle(IPC_CHANNELS.openMain, onOpenMain)
  ipcMain.handle(IPC_CHANNELS.petEndDrag, onEndDrag)
  ipcMain.handle(IPC_CHANNELS.captureProbe, onCaptureProbe)

  const dispose = (): void => {
    ipcMain.removeListener(IPC_CHANNELS.setPetStatus, onSetPetStatus)
    ipcMain.removeListener(IPC_CHANNELS.petReportHit, onReportHit)
    ipcMain.removeListener(IPC_CHANNELS.petBeginDrag, onBeginDrag)
    ipcMain.removeListener(IPC_CHANNELS.petMoveDrag, onMoveDrag)
    ipcMain.removeListener(IPC_CHANNELS.petCancelDrag, onCancelDrag)
    ipcMain.removeHandler(IPC_CHANNELS.readClipboard)
    ipcMain.removeHandler(IPC_CHANNELS.hidePet)
    ipcMain.removeHandler(IPC_CHANNELS.openMain)
    ipcMain.removeHandler(IPC_CHANNELS.petEndDrag)
    ipcMain.removeHandler(IPC_CHANNELS.captureProbe)
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
