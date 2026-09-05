import { app, BrowserWindow, globalShortcut } from 'electron'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer, loadConfig, type RunningServer } from '@flowpal/server'
import { IPC_CHANNELS } from './ipc/channels.ts'
import {
  registerIpcHandlers,
  broadcastFocusSession,
  type DesktopWindowState,
  type IpcHandlerController,
} from './ipc/handlers.ts'
import { acquireSingleInstance, focusWindow, hashFromArgv } from './lifecycle/single-instance.ts'
import { resolveAppLocation, assertPetEntry, type AppLocation } from './windows/app-location.ts'
import { createMainWindow, navigateMain } from './windows/main-window.ts'
import { createPetWindow, hidePet, showPet } from './windows/pet-window.ts'

// The name must be set before ready: macOS uses it for both the menu bar and
// the userData directory.  It also avoids exposing the workspace package name.
app.setName('FlowPal')

let mainWindow: BrowserWindow | null = null
let petWindow: BrowserWindow | null = null
let server: RunningServer | null = null
let appLocation: AppLocation | null = null
let ipcHandlers: IpcHandlerController | null = null
let quitting = false
let pendingSecondInstanceArgv: string[] | null = null

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
  const configPath = join(repoRoot, 'config.local.json')
  if (!existsSync(configPath)) {
    console.warn(`FlowPal server 未启动：找不到 ${configPath}。窗口仍可用于离线 UI 预览。`)
    return null
  }
  try {
    const running = createServer(loadConfig(repoRoot, {
      dataDir: join(app.getPath('userData'), 'data'),
    }))
    console.info(`FlowPal server: ${running.url}`)
    return running
  } catch (error) {
    console.error('FlowPal server 启动失败；继续打开桌面 UI。', error)
    return null
  }
}

function windowState(): DesktopWindowState {
  return {
    getMain: () => mainWindow,
    getPet: () => petWindow,
    getMainOptions: () => {
      if (!appLocation) throw new Error('FlowPal app location is not ready')
      return { preloadPath: preloadPath(), app: appLocation }
    },
  }
}

function attachPetLifecycle(win: BrowserWindow): void {
  win.on('closed', () => {
    // A close/recreate race must not let an old BrowserWindow clear the new
    // reference. This also makes the helper safe for activation/shortcut
    // paths that recreate the pet after an OS-level close.
    if (petWindow !== win) return
    ipcHandlers?.resetDrag()
    petWindow = null
  })
}

function ensurePetWindow(): BrowserWindow | null {
  if (petWindow && !petWindow.isDestroyed()) return petWindow
  if (quitting || !appLocation) return null
  if (petWindow?.isDestroyed()) {
    ipcHandlers?.resetDrag()
    petWindow = null
  }
  let win: BrowserWindow
  try {
    win = createPetWindow({ preloadPath: preloadPath(), app: appLocation, size: 96 })
  } catch (error) {
    console.error('FlowPal 桌宠窗口重建失败。', error)
    return null
  }
  petWindow = win
  attachPetLifecycle(win)
  return win
}

function focusExistingInstance(argv: string[]): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    pendingSecondInstanceArgv = argv
    return
  }
  focusWindow(mainWindow)
  const hash = hashFromArgv(argv)
  if (hash && mainWindow && appLocation) void navigateMain(mainWindow, appLocation, hash)
  showPet(ensurePetWindow())
}

function attachMainLifecycle(win: BrowserWindow): void {
  win.on('closed', () => {
    // Ignore a delayed close notification from an old window after activate
    // has already created its replacement.
    if (mainWindow !== win) return
    mainWindow = null
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

    const preload = preloadPath()
    if (!existsSync(preload)) throw new Error(`preload 文件缺失：${preload}`)
    // Register before loading either renderer so preload calls made during
    // first paint cannot race an IPC handler registration.
    ipcHandlers = registerIpcHandlers(windowState())
    mainWindow = createMainWindow({ preloadPath: preload, app: appLocation, initialHash: '/now' })
    ensurePetWindow()

    if (pendingSecondInstanceArgv) {
      const argv = pendingSecondInstanceArgv
      pendingSecondInstanceArgv = null
      focusExistingInstance(argv)
    }

    attachMainLifecycle(mainWindow)

    const shortcutRegistered = globalShortcut.register(
      'CommandOrControl+Shift+Space',
      () => {
        const pet = ensurePetWindow()
        showPet(pet)
        for (const win of [pet, mainWindow]) {
          if (win && !win.isDestroyed()) win.webContents.send(IPC_CHANNELS.hotkeyOpen)
        }
      },
    )
    if (!shortcutRegistered) console.warn('FlowPal 全局快捷键注册失败：CommandOrControl+Shift+Space')

    app.on('activate', () => {
      if (!mainWindow || mainWindow.isDestroyed()) {
        mainWindow = createMainWindow({ preloadPath: preload, app: appLocation!, initialHash: '/now' })
        attachMainLifecycle(mainWindow)
      }
      ensurePetWindow()
      focusWindow(mainWindow)
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
  ipcHandlers?.dispose()
  ipcHandlers = null
  try {
    server?.close()
  } catch (error) {
    console.error('关闭 FlowPal server 失败。', error)
  }
  server = null
  hidePet(petWindow)
}

app.on('before-quit', cleanup)
app.on('will-quit', cleanup)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Kept as a named export for smoke tests that import the shell in a mocked
// Electron environment.  Runtime startup still happens from the module above.
export { broadcastFocusSession }
