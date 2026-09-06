import { contextBridge, ipcRenderer, webUtils } from 'electron'
import {
  IPC_CHANNELS,
  isDesktopInput,
  isFocusSessionChange,
  isInlinePetGeometry,
  isMainWindowFocusChange,
  isPetForwardInput,
  isPetCommand,
  type DesktopInput,
  type DragResult,
  type InlinePetGeometry,
  type MainWindowFocusChange,
  type PetForwardInput,
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

function listenMainWindowFocusChanged(
  callback: (change: MainWindowFocusChange) => void,
): Unsubscribe {
  return subscribe<unknown>(IPC_CHANNELS.mainWindowFocusChanged, (payload) => {
    if (isMainWindowFocusChange(payload)) callback(payload)
  })
}

function listenDroppedFiles(callback: (paths: string[]) => void): Unsubscribe {
  const onDrop = (event: DragEvent): void => {
    event.preventDefault()
    event.stopPropagation()
    const paths: string[] = []
    for (const file of Array.from(event.dataTransfer?.files ?? [])) {
      try {
        // Finder/Nautilus drops expose the native path through webUtils; a
        // few Chromium/Electron drag sources still populate File.path. Keep
        // both forms so a valid OS file is not silently ignored.
        const path = webUtils.getPathForFile(file) || (file as File & { path?: string }).path || ''
        if (path) paths.push(path)
      } catch {
        // A File may not have an OS path in a browser-originated drop.  The
        // caller still receives the other files; no privileged error leaks.
      }
    }
    if (paths.length > 0) callback(paths)
  }
  const onDragOver = (event: DragEvent): void => {
    event.preventDefault()
    event.stopPropagation()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
  }
  const onDragEnter = (event: DragEvent): void => {
    event.preventDefault()
    event.stopPropagation()
  }
  // Capture at document level: the WebGL canvas owns pointer events and can
  // otherwise prevent a drag event from reaching the window listener.
  document.addEventListener('drop', onDrop, true)
  document.addEventListener('dragover', onDragOver, true)
  document.addEventListener('dragenter', onDragEnter, true)
  return () => {
    document.removeEventListener('drop', onDrop, true)
    document.removeEventListener('dragover', onDragOver, true)
    document.removeEventListener('dragenter', onDragEnter, true)
  }
}

function listenDesktopInput(callback: (input: DesktopInput) => void): Unsubscribe {
  return subscribe<unknown>(IPC_CHANNELS.desktopInput, (payload) => {
    if (isDesktopInput(payload)) callback(payload)
  })
}

function forwardInput(input: PetForwardInput): Promise<void> {
  // Keep the main-process check authoritative; this guard merely avoids an
  // unnecessary IPC round-trip for a malformed JS caller in the isolated
  // renderer.  TypeScript callers already receive the narrow PetForwardInput
  // contract from the exposed bridge.
  if (!isPetForwardInput(input)) return Promise.resolve()
  return ipcRenderer.invoke(IPC_CHANNELS.petForwardInput, input)
}

const input = {
  onHotkey: listenHotkey,
  onFilesDropped: listenDroppedFiles,
  readClipboard: (): Promise<string> => ipcRenderer.invoke(IPC_CHANNELS.readClipboard),
  readClipboardImage: (): Promise<string | null> => ipcRenderer.invoke(IPC_CHANNELS.readClipboardImage),
  onDesktopInput: listenDesktopInput,
  forwardInput,
}

const windows = {
  openMain: (hash?: string): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.openMain, hash),
  openRucLogin: (): Promise<{ ok: boolean; saved?: number; message?: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.openRucLogin),
  hidePet: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.hidePet),
  onMainWindowFocusChanged: listenMainWindowFocusChanged,
  reportPetGeometry: (geometry: InlinePetGeometry): void => {
    if (isInlinePetGeometry(geometry)) ipcRenderer.send(IPC_CHANNELS.petInlineGeometry, geometry)
  },
}

const pet = {
  openMain: (hash?: string): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.petOpenMain, hash),
  setStatus: (status: PetStatus, meta?: PetStatusMeta): void => {
    ipcRenderer.send(IPC_CHANNELS.setPetStatus, status, meta)
  },
  onCommand: (callback: (command: PetCommand) => void): Unsubscribe =>
    subscribe<unknown>(IPC_CHANNELS.petCommand, (payload) => {
      if (isPetCommand(payload)) callback(payload)
    }),
  reportHit: (inside: boolean): void => {
    // This toggle controls whether the transparent resident window consumes
    // the next mouse event.  An asynchronous send leaves a small race when
    // the pointer enters the mascot and the user clicks immediately: the
    // click can pass through to the main window before Electron applies the
    // hit-test result.  Keep this one tiny state transition synchronous so a
    // single click cannot accidentally focus/navigate the window underneath.
    ipcRenderer.sendSync(IPC_CHANNELS.petReportHit, Boolean(inside))
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
  platform: process.platform,
  onHotkeyOpen: input.onHotkey,
  onFilesDropped: input.onFilesDropped,
  onDesktopInput: input.onDesktopInput,
  onFocusSessionChanged: (callback) => subscribe<unknown>(IPC_CHANNELS.focusSessionChanged, (payload) => {
    if (isFocusSessionChange(payload)) callback(payload)
  }),
  onMainWindowFocusChanged: listenMainWindowFocusChanged,
  reportPetGeometry: windows.reportPetGeometry,
  readClipboard: input.readClipboard,
  readClipboardImage: input.readClipboardImage,
  hideWindow: windows.hidePet,
  openMain: windows.openMain,
  openRucLogin: windows.openRucLogin,
  /*
   * 登录要一个真的浏览器窗口，加密要系统钥匙串，两样都只有主进程够得着。走 IPC
   * 而不是 HTTP，分界线仍是「手机端将来要不要得起」——手机端要不起这两样。
   */
  signInToRuc: () => ipcRenderer.invoke(IPC_CHANNELS.openRucLogin),
  encryptSecret: (plain: string) => ipcRenderer.invoke(IPC_CHANNELS.encryptSecret, plain),
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
    screenshot: (sourceId?: string) => ipcRenderer.invoke(IPC_CHANNELS.captureScreenshot, sourceId),
  },
}

contextBridge.exposeInMainWorld('flowpal', bridge)
