import type {
  CaptureCapability,
  DesktopInput,
  DragResult,
  FocusSessionChange,
  InlinePetGeometry,
  MainWindowFocusChange,
  PetForwardInput,
  PetPresentationChange,
  PetCommand,
  PetStatus,
  PetStatusMeta,
  PointerPoint,
  ScreenPoint,
} from './ipc/channels.ts'

export type Unsubscribe = () => void

/**
 * Public preload contract.  This type intentionally contains both the flat
 * methods used by the first app shell and the grouped methods from the B-line
 * contract.  They point at the same IPC implementation; keeping the aliases
 * here lets the shell migrate without making old browser mocks stale.
 */
export interface FlowPalDesktopBridge {
  platform: NodeJS.Platform
  onHotkeyOpen(callback: () => void): Unsubscribe
  onFilesDropped(callback: (paths: string[]) => void): Unsubscribe
  onDesktopInput(callback: (input: DesktopInput) => void): Unsubscribe
  onFocusSessionChanged(callback: (change: FocusSessionChange) => void): Unsubscribe
  onMainWindowFocusChanged(callback: (change: MainWindowFocusChange) => void): Unsubscribe
  reportPetGeometry(geometry: InlinePetGeometry): void
  readClipboard(): Promise<string>
  readClipboardImage(): Promise<string | null>
  hideWindow(): Promise<void>
  openMain(hash?: string): Promise<void>
  /** 开登录窗口并把 Cookie 交给 server。返回这次登录成没成 */
  openRucLogin(): Promise<{ ok: boolean; saved?: number; message?: string }>
  signInToRuc(): Promise<{ ok: boolean; saved?: number; message?: string }>
  encryptSecret(plain: string): Promise<{ ok: boolean; cipher?: string; message?: string }>
  setPetStatus(status: PetStatus, meta?: PetStatusMeta): void

  pet: {
    openMain(hash?: string): Promise<void>
    setStatus(status: PetStatus, meta?: PetStatusMeta): void
    onCommand(callback: (command: PetCommand) => void): Unsubscribe
    reportHit(inside: boolean): void
    beginDrag(point: PointerPoint): void
    moveDrag(point: PointerPoint): void
    endDrag(): Promise<DragResult>
    cancelDrag(): void
  }
  input: {
    onHotkey(callback: () => void): Unsubscribe
    onFilesDropped(callback: (paths: string[]) => void): Unsubscribe
    readClipboard(): Promise<string>
    readClipboardImage(): Promise<string | null>
    onDesktopInput(callback: (input: DesktopInput) => void): Unsubscribe
    forwardInput(input: PetForwardInput): Promise<void>
  }
  windows: {
    openMain(hash?: string): Promise<void>
    hidePet(): Promise<void>
    onMainWindowFocusChanged(callback: (change: MainWindowFocusChange) => void): Unsubscribe
    reportPetGeometry(geometry: InlinePetGeometry): void
  }
  capture: {
    probe(): Promise<CaptureCapability>
    screenshot(sourceId?: string): Promise<import('./ipc/channels.ts').CaptureScreenshotResult>
  }
}

// Exporting the point type here gives renderer-side integrations one stable
// import path without making them depend on Electron itself.
export type {
  DesktopInput,
  InlinePetGeometry,
  PetForwardInput,
  PetPresentationChange,
  PetStatus,
  PetStatusMeta,
  PointerPoint,
  ScreenPoint,
}
