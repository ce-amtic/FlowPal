/**
 * window.flowpal —— 主进程暴露的四个方法，加一份浏览器 mock。
 *
 * 有 mock 的意义是界面全程可以在普通浏览器标签页里开发，不启动 Electron，
 * 于是界面这条线不被主进程那条线阻塞。
 */
export type Unsubscribe = () => void

export type DesktopInputBridgeEvent =
  | { type: 'focus-composer' }
  | { type: 'clipboard'; source: 'pet' | 'hotkey' }
  | { type: 'files'; paths: string[]; source: 'drop' }
  | { type: 'text'; text: string; source: 'drop' }

/** 一次拖放交出来的东西：有文件就是文件，没有文件才看文字。 */
export type DroppedContent = { paths: string[]; text: string }

export type PetPresentationBridgeEvent = {
  mode: 'inline' | 'floating'
  phase: 'steady' | 'floating-start' | 'floating-land' | 'teleport-out' | 'teleport-in'
  durationMs?: number
}

export type SignInResult = { ok: true; saved: number } | { ok: false; message: string }

export type FlowpalBridge = {
  platform: string
  onHotkeyOpen: (cb: () => void) => Unsubscribe
  onContentDropped: (cb: (content: DroppedContent) => void) => Unsubscribe
  /** 有东西被拖到窗口上方 / 离开了。形象据此变个样子 */
  onDropHover?: (cb: (over: boolean) => void) => Unsubscribe
  onDesktopInput?: (cb: (input: DesktopInputBridgeEvent) => void) => Unsubscribe
  /** Native main-window focus drives the inline/floating pet hand-off. */
  onMainWindowFocusChanged?: (cb: (change: {
    focused: boolean
    presentation?: PetPresentationBridgeEvent
  }) => void) => Unsubscribe
  reportPetGeometry?: (geometry: { x: number; y: number; width: number; height: number }) => void
  onFocusSessionChanged?: (cb: (change: {
    sessionId?: string
    status: 'running' | 'completed' | 'continued' | 'ended'
    itemId?: string
  }) => void) => () => void
  readClipboard: () => Promise<string>
  readClipboardImage?: () => Promise<string | null>
  capture?: {
    probe: () => Promise<{ supported: boolean; reason?: string }>
    screenshot?: (sourceId?: string) => Promise<{ ok: boolean; path?: string; sourceId?: string; reason?: string }>
  }
  hideWindow: () => Promise<void>
  openMain?: (hash?: string) => Promise<void>
  openRucLogin?: () => Promise<void>
  setPetStatus?: (status: 'idle' | 'receiving' | 'processing' | 'done' | 'error' | 'focus', meta?: { message?: string }) => void
  pet?: {
    openMain?: (hash?: string) => Promise<void>
    setStatus: (status: 'idle' | 'receiving' | 'processing' | 'done' | 'error' | 'focus', meta?: { message?: string }) => void
    onCommand: (cb: (command: {
      type: 'open-main' | 'hide' | 'presentation' | 'set-status'
      status?: 'idle' | 'receiving' | 'processing' | 'done' | 'error' | 'focus'
      meta?: { message?: string }
      hash?: string
      mode?: 'inline' | 'floating'
      phase?: 'steady' | 'floating-start' | 'floating-land' | 'teleport-out' | 'teleport-in'
      durationMs?: number
    }) => void) => () => void
    reportHit: (inside: boolean) => void
    beginDrag: (point: { x: number; y: number; pointerId: number }) => void
    moveDrag: (point: { x: number; y: number; pointerId: number }) => void
    endDrag: () => Promise<unknown>
    cancelDrag: () => void
  }
  /** Optional cross-window forwarding used when a file is dropped on pet.html. */
  input?: {
    onHotkey?: (cb: () => void) => Unsubscribe
    onContentDropped?: (cb: (content: DroppedContent) => void) => Unsubscribe
    onDropHover?: (cb: (over: boolean) => void) => Unsubscribe
    readClipboard?: () => Promise<string>
    readClipboardImage?: () => Promise<string | null>
    forwardFiles?: (paths: string[]) => Promise<void>
    forwardInput?: (input: DesktopInputBridgeEvent) => Promise<void>
    onDesktopInput?: (cb: (input: DesktopInputBridgeEvent) => void) => Unsubscribe
  }
  /**
   * 开一个真的浏览器窗口登录人大门户，把那次登录留下的 Cookie 交给 server。
   *
   * 走 IPC 而不是 HTTP，是因为它需要一个浏览器窗口——分界线仍是「手机端将来要不要
   * 得起」，而手机端要不起这个。同步本身要得起，所以那条走 HTTP。
   */
  signInToRuc: () => Promise<SignInResult>
  /**
   * 把邮箱授权码交给系统钥匙串加密，拿回一段 base64 密文。
   *
   * 界面拿到密文之后，连同明文一起 POST 给 server：**落库的是密文，明文只进内存**。
   * 同一条请求里两样都有看着多余，其实不是——加密防的是盘上被读走，不是这一跳。
   */
  encryptSecret: (plain: string) => Promise<EncryptResult>
}

export type EncryptResult = { ok: true; cipher: string } | { ok: false; message: string }

declare global {
  interface Window { flowpal?: FlowpalBridge }
}

const browserMock: FlowpalBridge = {
  platform: 'browser',
  onHotkeyOpen: () => () => {},
  onContentDropped: () => () => {},
  onMainWindowFocusChanged: () => () => {},
  onFocusSessionChanged: () => () => {},
  readClipboard: () => navigator.clipboard.readText(),
  hideWindow: async () => {},
  openMain: async () => {},
  setPetStatus: () => {},
  pet: undefined,
  input: undefined,
  // 浏览器标签页里开不出登录窗口。说清楚而不是假装成功——设置页据此显示
  // 「登录要在桌面应用里做」，而不是转一圈之后仍然没有登录态。
  signInToRuc: async () => ({ ok: false, message: '登录要在桌面应用里做' }),
  // 浏览器标签页里没有系统钥匙串。说清楚而不是退回明文——用户看见的「已加密」
  // 是我们说的，悄悄降级等于说了谎。
  encryptSecret: async () => ({ ok: false, message: '邮箱要在桌面应用里配置' }),
}

export const bridge: FlowpalBridge = window.flowpal ?? browserMock
export const inElectron = window.flowpal !== undefined
export const onMac = bridge.platform === 'darwin'
