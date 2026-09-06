import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { mock, test } from 'node:test'

// Exercise the real IPC handlers without launching a native Electron process.
const handlers = new Map()
mock.module('electron', {
  namedExports: {
    app: {}, clipboard: {}, desktopCapturer: {}, screen: {},
    BrowserWindow: class {},
    ipcMain: {
      on() {}, removeListener() {},
      handle(channel, handler) { handlers.set(channel, handler) },
      removeHandler(channel) { handlers.delete(channel) },
    },
  },
})
const { registerIpcHandlers } = await import('../src/ipc/handlers.ts')
const { IPC_CHANNELS } = await import('../src/ipc/channels.ts')

function setup(t) {
  const navigation = []
  const main = {
    minimized: false, visible: false, focused: 0,
    isDestroyed: () => false,
    isMinimized() { return this.minimized },
    isVisible() { return this.visible },
    restore() { this.minimized = false },
    show() { this.visible = true },
    focus() { this.focused++ },
    webContents: {
      isLoading: () => false,
      executeJavaScript: async (script) => { navigation.push(script) },
    },
  }
  const pet = { isDestroyed: () => false, hide() {}, webContents: {} }
  const controller = registerIpcHandlers({
    getMain: () => main, getPet: () => pet,
    getMainOptions: () => ({ app: { mode: 'dev', url: 'http://localhost:5173' } }),
    getInlinePetGeometry: () => null, setInlinePetGeometry() {},
    openRucLogin() {}, forwardDesktopInput() {},
  })
  t.after(() => controller.dispose())
  return { main, pet, navigation }
}

test('pet double-click refocuses repeatedly without changing route or session', async (t) => {
  const { main, pet, navigation } = setup(t)
  for (let cycle = 0; cycle < 3; cycle++) {
    main.visible = false
    main.minimized = cycle === 1
    await handlers.get(IPC_CHANNELS.petOpenMain)({ sender: pet.webContents }, undefined)
    assert.equal(main.visible, true)
    assert.equal(main.minimized, false)
    assert.equal(main.focused, cycle + 1)
    assert.deepEqual(navigation, [], 'focusing must not touch the hash/history state')
  }
})

test('generic focus-only requests also preserve the current page', async (t) => {
  const { main, navigation } = setup(t)
  await handlers.get(IPC_CHANNELS.openMain)({ sender: main.webContents }, undefined)
  assert.equal(main.focused, 1)
  assert.deepEqual(navigation, [])
})

test('explicit input route requests still navigate', async (t) => {
  const { pet, navigation } = setup(t)
  await handlers.get(IPC_CHANNELS.petOpenMain)({ sender: pet.webContents }, '/now?capture=focus')
  assert.equal(navigation.length, 1)
  assert.match(navigation[0], /\/now\?capture=focus/)
})

test('unknown senders cannot focus or navigate the main window', async (t) => {
  const { main, navigation } = setup(t)
  await handlers.get(IPC_CHANNELS.petOpenMain)({ sender: {} }, '/now')
  assert.equal(main.focused, 0)
  assert.deepEqual(navigation, [])
})

test('actual pet entry always requests focus-only, even during a temporary expression', async (t) => {
  const { main, pet, navigation } = setup(t)
  const previousWindow = globalThis.window
  const previousDocument = globalThis.document
  let onInteraction
  const requests = []
  const state = { snapshot: { status: 'focus' }, subscribe: () => () => {} }
  const rendererModule = mock.module('../../app/src/pet/renderer.ts', {
    namedExports: {
      createPetRenderer(options) {
        onInteraction = options.onInteraction
        return { state, setNativeWindowDrag() {} }
      },
    },
  })
  const styles = registerHooks({
    load(url, context, nextLoad) {
      if (url.endsWith('/pet/pet.css')) return { format: 'module', source: '', shortCircuit: true }
      return nextLoad(url, context)
    },
  })
  globalThis.document = { querySelector: (selector) => selector === '#pet' ? {} : null }
  globalThis.window = {
    addEventListener() {},
    flowpal: { pet: {
      onCommand: () => () => {},
      openMain: (...args) => {
        assert.deepEqual(args, [], 'a pet expression must never decide the main route')
        requests.push(handlers.get(IPC_CHANNELS.petOpenMain)({ sender: pet.webContents }, ...args))
      },
    } },
  }
  t.after(() => {
    globalThis.window = previousWindow
    globalThis.document = previousDocument
    rendererModule.restore()
    styles.deregister()
  })
  await import('../../app/src/pet/main.ts')
  for (const status of ['focus', 'receiving', 'done']) {
    state.snapshot.status = status
    onInteraction({ type: 'doubleclick', pointer: { pointerId: 1, x: 20, y: 20 } })
  }
  await Promise.all(requests)
  assert.equal(main.focused, 3)
  assert.deepEqual(navigation, [])
})
