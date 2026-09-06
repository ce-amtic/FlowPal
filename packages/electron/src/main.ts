import { app, BrowserWindow, globalShortcut, screen, type Rectangle } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer, loadConfig, type RunningServer } from '@flowpal/server'
import { signInToRuc } from './ruc/login-window.ts'
import { encryptSecret, unlockAll } from './mail/secrets.ts'
import {
  IPC_CHANNELS,
  type InlinePetGeometry,
  type MainWindowFocusChange,
  type PetPresentationChange,
  type DesktopInput,
} from './ipc/channels.ts'
import {
  registerIpcHandlers,
  broadcastFocusSession,
  type DesktopWindowState,
  type IpcHandlerController,
} from './ipc/handlers.ts'
import { acquireSingleInstance, focusWindow, hashFromArgv } from './lifecycle/single-instance.ts'
import { resolveAppLocation, assertPetEntry, type AppLocation } from './windows/app-location.ts'
import { createMainWindow, navigateMain } from './windows/main-window.ts'
import { createRucOnlineBroker } from './ruc/online-broker.ts'
import {
  createPetWindow,
  hidePet,
  sendPetPresentation,
  showPet,
  setPetFloatingDropTarget,
} from './windows/pet-window.ts'

// The name must be set before ready: macOS uses it for both the menu bar and
// the userData directory.  It also avoids exposing the workspace package name.
app.setName('FlowPal')

let mainWindow: BrowserWindow | null = null
let petWindow: BrowserWindow | null = null
let server: RunningServer | null = null
/** 本机服务的 token。局域网监听时才有，登录与解锁那两跳要带上它 */
let apiToken: string | null = null
/** 同步间隔，分钟。跟着配置走 */
let syncIntervalMinutes = 360
/** 定时同步。开机拉一次，之后按配置的间隔再拉 */
let syncTimer: ReturnType<typeof setInterval> | null = null
let appLocation: AppLocation | null = null
let ipcHandlers: IpcHandlerController | null = null
let quitting = false
let pendingSecondInstanceArgv: string[] | null = null
/**
 * `null` means that the main window has not emitted its first lifecycle state
 * yet.  Keeping the state in the main process makes the pet hand-off
 * deterministic even when focus/blur events arrive while a renderer is still
 * loading or while a window is being recreated after activation.
 */
let mainWindowFocused: boolean | null = null
const mainRenderersReady = new WeakSet<BrowserWindow>()
const pendingDesktopInputs: DesktopInput[] = []
let inlinePetGeometry: InlinePetGeometry | null = null
let presentationMode: 'inline' | 'floating' = 'inline'
// The last phase is replayed to a renderer that finishes loading while a
// hand-off is in flight. Replaying an unconditional `steady` here can cancel
// the entry/exit animation and briefly restore the pet at its final opacity.
let currentPresentation: PetPresentationChange = { mode: 'inline', phase: 'steady' }
let presentationSerial = 0
let minimizedFloatingTimer: ReturnType<typeof setTimeout> | null = null
let floatingRecoveryTimer: ReturnType<typeof setTimeout> | null = null

function initialMainHash(): string {
  const value = process.env.FLOWPAL_INITIAL_HASH
  return value === '/focus' ? '/focus' : '/now'
}

const PET_A_SIZE = 148
const PET_B_SIZE = 224
const DEPARTURE_BOUNCE_MS = 280
const FLOATING_LAND_MS = 260
const TELEPORT_OUT_MS = 280
const TELEPORT_IN_MS = 360

function preloadPath(): string {
  // main.mjs and preload.mjs are emitted together into the same dist folder;
  // resolving relative to the running module remains correct in both an
  // unpackaged workspace and an asar archive.
  return join(dirname(fileURLToPath(import.meta.url)), 'preload.mjs')
}

function resolveRepoRoot(appPath: string): string {
  const explicit = process.env.FLOWPAL_REPO_ROOT?.trim()
  const candidates = [
    explicit,
    join(appPath, '..', '..'),
    join(appPath, '..'),
    resolve(dirname(appPath), '..'),
  ].filter((candidate): candidate is string => Boolean(candidate))
  return candidates.map((candidate) => resolve(candidate)).find((candidate) =>
    existsSync(join(candidate, 'config.example.json'))
      || existsSync(join(candidate, 'packages', 'app')),
  ) ?? resolve(appPath)
}

function startServerIfConfigured(repoRoot: string): RunningServer | null {
  // Mock desktop runs are intentionally self-contained: the renderer uses
  // mockApi and must not start a real HTTP server that could reach a model or
  // contend for port 5123 with another development process.
  if (process.env.FLOWPAL_MOCK === '1') {
    console.info('FlowPal mock desktop：跳过真实 server/model，使用前端样例数据。')
    return null
  }
  const configPath = join(repoRoot, 'config.local.json')
  const examplePath = join(repoRoot, 'config.example.json')
  try {
    // The desktop UI always talks to the local API, including when the user
    // has not configured an LLM yet.  Falling back to the checked-in example
    // keeps the server alive for empty-state/settings/calendar reads; model
    // backed actions remain safely unavailable until config.local.json is
    // supplied.  The standalone server keeps its strict loadConfig contract.
    const config = existsSync(configPath)
      ? loadConfig(repoRoot, {
        dataDir: join(app.getPath('userData'), 'data'),
      })
      : (() => {
        if (!existsSync(examplePath)) throw new Error(`找不到 ${configPath} 或 ${examplePath}`)
        const example = JSON.parse(readFileSync(examplePath, 'utf8')) as Record<string, unknown>
        return {
          ...example,
          dataDir: join(app.getPath('userData'), 'data'),
          promptsDir: join(repoRoot, 'prompts'),
          calendarPath: join(repoRoot, 'data', 'calendar.json'),
        }
      })()
    const running = createServer(config, { rucBroker: createRucOnlineBroker() })
    const typed = config as { token?: string | null; sync?: { intervalMinutes?: number } }
    apiToken = typed.token ?? null
    syncIntervalMinutes = typed.sync?.intervalMinutes ?? syncIntervalMinutes
    console.info(`FlowPal server: ${running.url}${existsSync(configPath) ? '' : ' (offline config)'}`)
    return running
  } catch (error) {
    console.error('FlowPal server 启动失败；继续打开桌面 UI。', error)
    return null
  }
}

/**
 * 现在就同步一次。
 *
 * **失败不重试，也不弹任何东西。** 下一个周期自然会再试；写重试循环只会把一个明确
 * 的失败变成一串看不见的失败。失败的落点是设置页上那一行状态。
 */
async function syncNow(): Promise<void> {
  if (!server) return
  const res = await fetch(`${server.url}/api/sync`, {
    method: 'POST',
    headers: apiToken === null ? {} : { Authorization: `Bearer ${apiToken}` },
  }).catch((e: unknown) => {
    console.error('同步没能发出：', e)
    return null
  })
  // 409 是「已经有一轮在跑」，不是失败：开机那一次和定时器会撞上
  if (res !== null && res.status !== 409) console.info(`同步：${await res.text()}`)
}

/**
 * 先解锁邮箱再同步，顺序不能反：库里存的是密文，只有这一侧解得开。反过来的话，
 * 开机那一次同步会把每个邮箱都跳过，状态行上写着「需要在桌面应用里解锁」，
 * 而用户就在桌面应用里。
 *
 * 解锁失败也照样同步——门户那两路跟邮箱没关系，不该被它拖住。
 */
function startSyncLoop(): void {
  if (!server) return
  unlockAll(server.url, apiToken)
    .then((n) => { if (n > 0) console.info(`已解锁 ${n} 个邮箱账号`) })
    .catch((e: unknown) => console.error('解锁邮箱账号失败：', e))
    .finally(() => void syncNow())
  syncTimer = setInterval(() => void syncNow(), syncIntervalMinutes * 60_000)
}

function windowState(): DesktopWindowState {
  return {
    getMain: () => mainWindow,
    getPet: () => petWindow,
    getInlinePetGeometry: () => inlinePetGeometry,
    setInlinePetGeometry: (geometry) => { inlinePetGeometry = geometry },
    /*
     * 登录窗口只能开在这里：它需要一个真的浏览器，而全仓库只有这一侧有。
     * 采到的 Cookie 立刻交给 server，之后取数全由 server 自己发出——它照旧只认
     * 一批 Cookie，不知道有过一个窗口。
     */
    openRucLogin: async () => {
      if (!server) return { ok: false as const, message: '本机服务还没起来' }
      const result = await signInToRuc(server.url, apiToken)
      // 刚拿到登录态，立刻同步一次：让用户在设置页上当场看见结果，而不是等六小时
      if (result.ok) void syncNow()
      return result
    },
    /*
     * 加密同样只能在这里：钥匙在系统钥匙串里，渲染进程和 server 都够不着。
     * 界面拿回密文之后连同明文一起 POST 给 server——落库的是密文，明文只进内存。
     */
    encryptSecret: (plain) => {
      try {
        return { ok: true as const, cipher: encryptSecret(plain) }
      } catch (e) {
        return { ok: false as const, message: e instanceof Error ? e.message : String(e) }
      }
    },
    forwardDesktopInput: (input) => {
      const win = mainWindow
      if (!win || win.isDestroyed() || !mainRenderersReady.has(win)) {
        if (pendingDesktopInputs.length < 32) pendingDesktopInputs.push(input)
        return
      }
      try {
        win.webContents.send(IPC_CHANNELS.desktopInput, input)
      } catch {
        if (pendingDesktopInputs.length < 32) pendingDesktopInputs.push(input)
      }
    },
    getMainOptions: () => {
      if (!appLocation) throw new Error('FlowPal app location is not ready')
      return { preloadPath: preloadPath(), app: appLocation }
    },
  }
}

function attachPetLifecycle(win: BrowserWindow): void {
  // createPetWindow's own ready-to-show handler runs first and calls
  // showInactive(). Re-apply the current presentation mode afterwards so a
  // pet created during activation/reload cannot flash above a focused main
  // window for one frame.
  win.on('closed', () => {
    // A close/recreate race must not let an old BrowserWindow clear the new
    // reference. This also makes the helper safe for activation/shortcut
    // paths that recreate the pet after an OS-level close.
    if (petWindow !== win) return
    ipcHandlers?.resetDrag()
    petWindow = null
  })
}

function notifyMainWindowFocus(
  win: BrowserWindow,
  focused: boolean,
  presentation?: PetPresentationChange,
): void {
  if (mainWindow !== win || win.isDestroyed()) return
  if (presentation) currentPresentation = presentation
  if (!mainRenderersReady.has(win)) return
  try {
    const payload: MainWindowFocusChange = { focused, ...(presentation ? { presentation } : {}) }
    win.webContents.send(IPC_CHANNELS.mainWindowFocusChanged, payload)
  } catch {
    // A renderer can disappear between the lifecycle event and this send
    // during reload/quit.  The latest state is replayed on the next
    // `did-finish-load`, so there is no reason to let this race abort startup.
  }
}

function broadcastPresentation(win: BrowserWindow, change: PetPresentationChange): void {
  currentPresentation = change
  notifyMainWindowFocus(win, mainWindowFocused === true, change)
  sendPetPresentation(petWindow, change)
}

function fallbackInlineBounds(win: BrowserWindow): Rectangle {
  const bounds = win.getBounds()
  return {
    x: bounds.x + 28,
    y: bounds.y + 70,
    width: PET_A_SIZE,
    height: PET_A_SIZE,
  }
}

function inlineBounds(win: BrowserWindow): Rectangle {
  const geometry = inlinePetGeometry
  if (!geometry) return fallbackInlineBounds(win)
  return {
    x: Math.round(geometry.x),
    y: Math.round(geometry.y),
    width: Math.round(geometry.width),
    height: Math.round(geometry.height),
  }
}

function floatingTargetBounds(start: Rectangle): Rectangle {
  const display = screen.getDisplayMatching(start)
  const workArea = display.workArea
  return {
    x: Math.round(workArea.x + workArea.width - PET_B_SIZE - 32),
    y: Math.round(workArea.y + workArea.height - PET_B_SIZE - 32),
    width: PET_B_SIZE,
    height: PET_B_SIZE,
  }
}

function forceFloatingPosition(win: BrowserWindow): void {
  if (quitting || mainWindow !== win || win.isDestroyed()) return
  if (floatingRecoveryTimer !== null) clearTimeout(floatingRecoveryTimer)
  floatingRecoveryTimer = null
  presentationSerial += 1
  const start = inlineBounds(win)
  hidePet(petWindow)
  const pet = ensurePetWindow({ size: PET_B_SIZE })
  if (!pet) return
  presentationMode = 'floating'
  setPetFloatingDropTarget(true)
  try {
    pet.setBounds(floatingTargetBounds(start))
  } catch {
    return
  }
  broadcastPresentation(win, {
    mode: 'floating',
    phase: 'floating-land',
    durationMs: FLOATING_LAND_MS,
  })
  showPet(pet)
}

function scheduleFloatingRecovery(win: BrowserWindow): void {
  if (floatingRecoveryTimer !== null) clearTimeout(floatingRecoveryTimer)
  floatingRecoveryTimer = setTimeout(() => {
    floatingRecoveryTimer = null
    if (
      quitting
      || mainWindow !== win
      || win.isDestroyed()
      || mainWindowFocused !== false
      || (petWindow && !petWindow.isDestroyed() && petWindow.isVisible())
    ) return
    forceFloatingPosition(win)
  }, 700)
}

function scheduleMinimizedFloating(win: BrowserWindow): void {
  if (minimizedFloatingTimer !== null) clearTimeout(minimizedFloatingTimer)
  if (floatingRecoveryTimer !== null) clearTimeout(floatingRecoveryTimer)
  floatingRecoveryTimer = null
  presentationSerial += 1
  presentationMode = 'inline'
  setPetFloatingDropTarget(false)
  // The one-second minimized grace period is not itself an animation phase.
  // Reset the cached phase so a restore during that window can legitimately
  // request the normal inline entry instead of being blocked by a stale
  // `floating-land` replay from the previous presentation.
  currentPresentation = { mode: 'inline', phase: 'steady' }
  hidePet(petWindow)
  minimizedFloatingTimer = setTimeout(() => {
    minimizedFloatingTimer = null
    if (
      quitting
      || mainWindow !== win
      || win.isDestroyed()
      || !win.isMinimized()
    ) return
    forceFloatingPosition(win)
  }, 1000)
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function transitionToFloating(win: BrowserWindow): Promise<void> {
  if (quitting || mainWindow !== win) return
  if (presentationMode === 'floating') {
    if (petWindow && !petWindow.isDestroyed() && petWindow.isVisible()) return
    // Recover from an interrupted hand-off that left the logical mode ahead
    // of the native window visibility.
    presentationMode = 'inline'
  }
  const serial = ++presentationSerial
  const start = inlineBounds(win)
  const target = floatingTargetBounds(start)
  // Create/reuse the resident window at its final B-size destination while it
  // is hidden. The old A->B setBounds sequence exposed stale WebGL frames.
  hidePet(petWindow)
  const pet = ensurePetWindow({ bounds: target, size: PET_B_SIZE })
  if (!pet) return
  presentationMode = 'floating'
  setPetFloatingDropTarget(true)
  const startChange: PetPresentationChange = {
    mode: 'floating',
    phase: 'floating-start',
    durationMs: DEPARTURE_BOUNCE_MS,
  }
  broadcastPresentation(win, startChange)
  await wait(DEPARTURE_BOUNCE_MS)
  if (serial !== presentationSerial || mainWindow !== win || pet.isDestroyed()) return
  // The native window was already laid out at B/target. There is no visible
  // move or resize here: the source pet has disappeared, then the destination
  // pet is revealed with its landing animation.
  if (serial !== presentationSerial || mainWindow !== win || pet.isDestroyed()) return
  broadcastPresentation(win, {
    mode: 'floating',
    phase: 'floating-land',
    durationMs: FLOATING_LAND_MS,
  })
  showPet(pet)
  await wait(FLOATING_LAND_MS)
  if (serial !== presentationSerial || mainWindow !== win) return
  broadcastPresentation(win, { mode: 'floating', phase: 'steady' })
}

async function transitionToInline(win: BrowserWindow): Promise<void> {
  if (quitting || mainWindow !== win || presentationMode === 'inline') return
  const serial = ++presentationSerial
  presentationMode = 'inline'
  setPetFloatingDropTarget(false)
  broadcastPresentation(win, {
    mode: 'floating',
    phase: 'teleport-out',
    durationMs: TELEPORT_OUT_MS,
  })
  await wait(TELEPORT_OUT_MS)
  if (serial !== presentationSerial || mainWindow !== win) return
  hidePet(petWindow)
  broadcastPresentation(win, {
    mode: 'inline',
    phase: 'teleport-in',
    durationMs: TELEPORT_IN_MS,
  })
  // Keep the process-side phase in sync with the renderer animation. Without
  // this terminal event, a later renderer reload would replay teleport-in and
  // run the entry animation again even though the pet had already settled.
  await wait(TELEPORT_IN_MS)
  if (serial !== presentationSerial || mainWindow !== win) return
  broadcastPresentation(win, { mode: 'inline', phase: 'steady' })
}

/**
 * The native pet is the always-on-top presentation whenever the main window is
 * not focused. Focus transitions are the single source of truth; there is no
 * compositor/screen-recording permission dependency in this path.
 */
function setMainWindowFocus(win: BrowserWindow, focused: boolean, force = false): void {
  if (quitting || mainWindow !== win || win.isDestroyed()) return
  const changed = mainWindowFocused !== focused
  // Capture this before transitionToInline mutates presentationMode. The
  // resident pet can already be hidden by an IPC handler, so visibility alone
  // cannot tell us whether teleport-out has just started.
  const enteringInline = focused && presentationMode === 'floating'
  mainWindowFocused = focused

  if (focused) {
    if (minimizedFloatingTimer !== null) clearTimeout(minimizedFloatingTimer)
    minimizedFloatingTimer = null
    if (floatingRecoveryTimer !== null) clearTimeout(floatingRecoveryTimer)
    floatingRecoveryTimer = null
    if (presentationMode === 'floating') void transitionToInline(win)
    else hidePet(petWindow)
  } else {
    // Losing focus always starts the departure animation. Minimize/hide events
    // can arrive before/after blur; force the final dock position in that case
    // so an in-flight transition cannot leave the pet at its old inline point.
    if (win.isMinimized()) scheduleMinimizedFloating(win)
    else if (!win.isVisible()) forceFloatingPosition(win)
    else {
      presentationSerial += 1
      void transitionToFloating(win)
      scheduleFloatingRecovery(win)
    }
  }

  if (
    (changed || force)
    && presentationMode === 'inline'
    // transitionToInline has already emitted teleport-out; do not overwrite
    // that phase with an eager steady notification in the same focus tick.
    && !(focused && petWindow?.isVisible())
    && !enteringInline
    // The resident window may have been hidden by the input handler before the
    // native focus event arrives. In that case the in-flight teleport-out is
    // still authoritative; sending inline/steady here would reopen the slot
    // one animation early and reintroduce the first-frame flash.
    && currentPresentation.phase === 'steady'
  ) {
    notifyMainWindowFocus(win, focused, { mode: 'inline', phase: 'steady' })
  }
}

function ensurePetWindow(options: { bounds?: Rectangle; size?: 148 | 224 } = {}): BrowserWindow | null {
  if (petWindow && !petWindow.isDestroyed()) {
    if (options.bounds) {
      try { petWindow.setBounds(options.bounds) } catch { /* closing */ }
    }
    return petWindow
  }
  // Recover from a stale JS reference after an activation/reload race. There
  // must be exactly one resident pet window in the process; otherwise each
  // overlapping creation can remain always-on-top at the same corner.
  const existing = BrowserWindow.getAllWindows().find((candidate) =>
    candidate !== mainWindow
      && !candidate.isDestroyed()
      && candidate.getTitle() === 'FlowPal Pet',
  )
  if (existing) {
    petWindow = existing
    if (options.bounds) {
      try { existing.setBounds(options.bounds) } catch { /* closing */ }
    }
    // Reusing a resident window must preserve the current presentation
    // invariant. In particular, focus returning to the main window must hide
    // this window immediately instead of reviving it through a stale callback.
    if (presentationMode === 'floating') showPet(existing)
    else hidePet(existing)
    return existing
  }
  if (quitting || !appLocation) return null
  if (petWindow?.isDestroyed()) {
    ipcHandlers?.resetDrag()
    petWindow = null
  }
  let win: BrowserWindow
  try {
    win = createPetWindow({
      preloadPath: preloadPath(),
      app: appLocation,
      size: options.size ?? PET_B_SIZE,
      bounds: options.bounds,
    })
  } catch (error) {
    console.error('FlowPal 桌宠窗口重建失败。', error)
    return null
  }
  petWindow = win
  attachPetLifecycle(win)
  // `createPetWindow` waits for `ready-to-show` before presenting.  Apply the
  // current desired mode immediately as well, so a newly-created pet cannot
  // flash over a focused main window during activation/reload.
  if (presentationMode === 'floating') showPet(win)
  else hidePet(win)
  return win
}

function focusExistingInstance(argv: string[]): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    pendingSecondInstanceArgv = argv
    return
  }
  focusWindow(mainWindow)
  // Native `focus` is normally synchronous enough to emit the event below,
  // but explicitly applying the desired state closes the small race where a
  // second-instance launch arrives while the old window is transitioning.
  setMainWindowFocus(mainWindow, true)
  const hash = hashFromArgv(argv)
  if (hash && mainWindow && appLocation) void navigateMain(mainWindow, appLocation, hash)
}

function attachMainLifecycle(win: BrowserWindow): void {
  // `createMainWindow` registers its own ready-to-show listener before this
  // function is called. That listener invokes `show()`, and Electron may emit
  // the corresponding `show` event synchronously while the native window is
  // still unfocused. Treating that transient state as a real blur starts a
  // floating hand-off during the very first paint (the visible "flash").
  // Keep the first show event behind this gate; ready-to-show below establishes
  // the authoritative initial focus state.
  let readyToShow = false

  // The listeners are attached immediately after construction, before the
  // asynchronous page load can finish.  Events from an old window are ignored
  // by setMainWindowFocus's identity check.
  const applyLifecycleFocus = (focused: boolean, force = false): void => {
    // Do not let pre-paint native events start a hand-off. The initial
    // ready-to-show callback below owns the first state transition; otherwise
    // a transient blur while Electron is constructing the window can reveal
    // the resident pet before the main page has painted.
    if (!readyToShow) return
    setMainWindowFocus(win, focused, force)
  }

  win.on('focus', () => applyLifecycleFocus(true))
  win.on('blur', () => applyLifecycleFocus(false))
  win.on('minimize', () => applyLifecycleFocus(false))
  win.on('restore', () => {
    if (!readyToShow) return
    // On macOS `restore` is emitted before the window-manager focus bit is
    // settled. Treating that transient false value as a blur can restart the
    // minimized-float timer (or briefly expose a second presentation). Let the
    // normal focus event win; the deferred check only repairs platforms that
    // omit it altogether.
    setTimeout(() => {
      if (mainWindow !== win || win.isDestroyed() || !win.isFocused()) return
      applyLifecycleFocus(true, true)
    }, 0)
  })
  win.on('show', () => {
    if (!readyToShow) return
    // A show event is not itself proof that the window owns focus (for
    // example, `showInactive`/activation races on macOS). Only promote the
    // inline presentation here when the native focus bit is already true;
    // genuine loss of focus is handled by the dedicated blur event.
    if (win.isFocused()) applyLifecycleFocus(true, true)
  })
  win.on('hide', () => applyLifecycleFocus(false, true))
  win.once('ready-to-show', () => {
    // createMainWindow's listener is registered first and calls show(); this
    // is the app's initial presentation.  Treat it as focused even if the
    // platform delays the native `focus` event by a tick; a later blur/focus
    // event will reconcile the state with the OS.
    readyToShow = true
    if (mainWindow === win && !win.isDestroyed()) setMainWindowFocus(win, true, true)
  })
  win.webContents.on('did-finish-load', () => {
    if (mainWindow !== win || win.isDestroyed()) return
    mainRenderersReady.add(win)
    while (pendingDesktopInputs.length > 0 && mainWindow === win && !win.isDestroyed()) {
      const input = pendingDesktopInputs.shift()
      if (!input) break
      try {
        win.webContents.send(IPC_CHANNELS.desktopInput, input)
      } catch {
        pendingDesktopInputs.unshift(input)
        break
      }
    }
    if (mainWindowFocused !== null) {
      // Replay the actual current phase. A load/reload during teleport-out or
      // teleport-in must not receive a synthetic steady event that reveals the
      // inline canvas for one frame and defeats the slot choreography.
      notifyMainWindowFocus(win, mainWindowFocused, currentPresentation)
    }
  })
  win.on('closed', () => {
    mainRenderersReady.delete(win)
    // Ignore a delayed close notification from an old window after activate
    // has already created its replacement.
    if (mainWindow !== win) return
    mainWindow = null
    mainWindowFocused = null
    if (!quitting && petWindow && !petWindow.isDestroyed()) {
      petWindow.close()
      app.quit()
    }
  })
}

if (!acquireSingleInstance({ focusExisting: focusExistingInstance })) {
  // The losing process must not register ready listeners or start a server.
  // `app.quit()` was issued by acquireSingleInstance; returning at module
  // scope is not possible in ESM, so the guarded bootstrap below is skipped.
} else {
  void app.whenReady().then(() => {
    appLocation = resolveAppLocation(app.getAppPath(), app.isPackaged)
    assertPetEntry(appLocation)

    const repoRoot = resolveRepoRoot(app.getAppPath())
    server = startServerIfConfigured(repoRoot)
    startSyncLoop()

    const preload = preloadPath()
    if (!existsSync(preload)) throw new Error(`preload 文件缺失：${preload}`)
    // Register before loading either renderer so preload calls made during
    // first paint cannot race an IPC handler registration.
    ipcHandlers = registerIpcHandlers(windowState())
    mainWindow = createMainWindow({ preloadPath: preload, app: appLocation, initialHash: initialMainHash() })
    attachMainLifecycle(mainWindow)
    ensurePetWindow()

    if (pendingSecondInstanceArgv) {
      const argv = pendingSecondInstanceArgv
      pendingSecondInstanceArgv = null
      focusExistingInstance(argv)
    }

    const shortcutRegistered = globalShortcut.register(
      'CommandOrControl+Shift+Space',
      () => {
        const pet = ensurePetWindow()
        // A focused main window owns the presentation.  The shortcut still
        // reaches both renderers, but does not violate the embedded/floating
        // mutual exclusion invariant.
        if (presentationMode === 'floating') showPet(pet)
        for (const win of [pet, mainWindow]) {
          if (win && !win.isDestroyed()) win.webContents.send(IPC_CHANNELS.hotkeyOpen)
        }
      },
    )
    if (!shortcutRegistered) console.warn('FlowPal 全局快捷键注册失败：CommandOrControl+Shift+Space')

    app.on('activate', () => {
      if (!mainWindow || mainWindow.isDestroyed()) {
        mainWindow = createMainWindow({ preloadPath: preload, app: appLocation!, initialHash: initialMainHash() })
        attachMainLifecycle(mainWindow)
      }
      ensurePetWindow()
      focusWindow(mainWindow)
      setMainWindowFocus(mainWindow, true, true)
      if (pendingSecondInstanceArgv) {
        const argv = pendingSecondInstanceArgv
        pendingSecondInstanceArgv = null
        focusExistingInstance(argv)
      }
    })
  }).catch((error: unknown) => {
    console.error('FlowPal Electron 初始化失败。', error)
    app.quit()
  })
}

function cleanup(): void {
  if (quitting) return
  quitting = true
  globalShortcut.unregisterAll()
  if (minimizedFloatingTimer !== null) clearTimeout(minimizedFloatingTimer)
  minimizedFloatingTimer = null
  if (floatingRecoveryTimer !== null) clearTimeout(floatingRecoveryTimer)
  floatingRecoveryTimer = null
  if (syncTimer !== null) clearInterval(syncTimer)
  syncTimer = null
  ipcHandlers?.dispose()
  ipcHandlers = null
  try {
    server?.close()
  } catch (error) {
    console.error('关闭 FlowPal server 失败。', error)
  }
  server = null
  hidePet(petWindow)
  mainWindowFocused = null
}

app.on('before-quit', cleanup)
app.on('will-quit', cleanup)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Kept as a named export for smoke tests that import the shell in a mocked
// Electron environment.  Runtime startup still happens from the module above.
export { broadcastFocusSession }
