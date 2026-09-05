import { contextBridge, ipcRenderer, webUtils } from 'electron'
import {
  IPC_CHANNELS,
  isFocusSessionChange,
  isPetCommand,
  type DragResult,
  type PetCommand,
  type PetStatus,
  type PetStatusMeta,
  type PointerPoint,
} from './ipc/channels.ts'
import type { FlowPalDesktopBridge, Unsubscribe } from './bridge.ts'

function subscribe<T>(channel: string, callback: (payload: T) => void): Unsubscribe {
  const listener = (_event: unknown, payload: T): void => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

function listenHotkey(callback: () => void): Unsubscribe {
  return subscribe<void>(IPC_CHANNELS.hotkeyOpen, callback)
}

function listenDroppedFiles(callback: (paths: string[]) => void): Unsubscribe {
  const onDrop = (event: DragEvent): void => {
    event.preventDefault()
    const paths: string[] = []
    for (const file of Array.from(event.dataTransfer?.files ?? [])) {
      try {
        const path = webUtils.getPathForFile(file)
        if (path) paths.push(path)
      } catch {
        // A File may not have an OS path in a browser-originated drop.  The
        // caller still receives the other files; no privileged error leaks.
      }
    }
    if (paths.length > 0) callback(paths)
  }
  const onDragOver = (event: DragEvent): void => event.preventDefault()
  window.addEventListener('drop', onDrop)
  window.addEventListener('dragover', onDragOver)
  return () => {
    window.removeEventListener('drop', onDrop)
    window.removeEventListener('dragover', onDragOver)
  }
}

const input = {
  onHotkey: listenHotkey,
  onFilesDropped: listenDroppedFiles,
  readClipboard: (): Promise<string> => ipcRenderer.invoke(IPC_CHANNELS.readClipboard),
}

const windows = {
  openMain: (hash?: string): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.openMain, hash),
  hidePet: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.hidePet),
}

const pet = {
  setStatus: (status: PetStatus, meta?: PetStatusMeta): void => {
    ipcRenderer.send(IPC_CHANNELS.setPetStatus, status, meta)
  },
  onCommand: (callback: (command: PetCommand) => void): Unsubscribe =>
    subscribe<unknown>(IPC_CHANNELS.petCommand, (payload) => {
      if (isPetCommand(payload)) callback(payload)
    }),
  reportHit: (inside: boolean): void => {
    ipcRenderer.send(IPC_CHANNELS.petReportHit, Boolean(inside))
  },
  beginDrag: (point: PointerPoint): void => {
    ipcRenderer.send(IPC_CHANNELS.petBeginDrag, point)
  },
  moveDrag: (point: PointerPoint): void => {
    ipcRenderer.send(IPC_CHANNELS.petMoveDrag, point)
  },
  endDrag: (): Promise<DragResult> => ipcRenderer.invoke(IPC_CHANNELS.petEndDrag),
  cancelDrag: (): void => {
    ipcRenderer.send(IPC_CHANNELS.petCancelDrag)
  },
}

const bridge: FlowPalDesktopBridge = {
  onHotkeyOpen: input.onHotkey,
  onFilesDropped: input.onFilesDropped,
  onFocusSessionChanged: (callback) => subscribe<unknown>(IPC_CHANNELS.focusSessionChanged, (payload) => {
    if (isFocusSessionChange(payload)) callback(payload)
  }),
  readClipboard: input.readClipboard,
  hideWindow: windows.hidePet,
  openMain: windows.openMain,
  setPetStatus: pet.setStatus,
  pet,
  input,
  windows,
  capture: {
    // Screen/window capture is deliberately not claimed by P0-1.  Returning
    // a structured capability lets settings and future drag code explain why
    // it is unavailable instead of guessing from platform strings.
    probe: (): Promise<{ supported: false; reason: 'not-implemented' }> =>
      ipcRenderer.invoke(IPC_CHANNELS.captureProbe),
  },
}

contextBridge.exposeInMainWorld('flowpal', bridge)
