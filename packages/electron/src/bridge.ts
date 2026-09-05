import type {
  CaptureCapability,
  DragResult,
  FocusSessionChange,
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
  onHotkeyOpen(callback: () => void): Unsubscribe
  onFilesDropped(callback: (paths: string[]) => void): Unsubscribe
  onFocusSessionChanged(callback: (change: FocusSessionChange) => void): Unsubscribe
  readClipboard(): Promise<string>
  hideWindow(): Promise<void>
  openMain(hash?: string): Promise<void>
  setPetStatus(status: PetStatus, meta?: PetStatusMeta): void

  pet: {
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
  }
  windows: {
    openMain(hash?: string): Promise<void>
    hidePet(): Promise<void>
  }
  capture: {
    probe(): Promise<CaptureCapability>
  }
}

// Exporting the point type here gives renderer-side integrations one stable
// import path without making them depend on Electron itself.
export type { PetStatus, PetStatusMeta, PointerPoint, ScreenPoint }
