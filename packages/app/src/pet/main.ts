import { createPetRenderer } from './renderer.ts'
import { PET_STATUS_LABELS, type PetStatus } from './state-machine.ts'
import './pet.css'

declare global {
  interface Window {
    /** Quiet-pebble-compatible animation hooks for local demos and QA. */
    pet?: {
      press(amount?: number): void
      tap(): void
      hop(): void
      turn(angle: number): void
      focus(value?: boolean): void
      setExpression(name: 'calm' | 'happy' | 'sleepy' | 'curious' | 'surprised' | 'focus', durationMs?: number): void
      setColor(color: 'chalk' | 'fog' | 'stone'): void
      setSize(size: 96 | 128 | 224): void
      reset(): void
    }
  }
}

const canvas = document.querySelector<HTMLCanvasElement>('#pet')
const fallback = document.querySelector<HTMLElement>('#pet-fallback')
const liveLabel = document.querySelector<HTMLElement>('#pet-status')
const petRoot = document.querySelector<HTMLElement>('#pet-root')

if (!canvas) throw new Error('FlowPal pet canvas is missing')

// A long press emits before pointerup. Remember it so one gesture does not
// both capture the clipboard and merely focus the Composer.
let longPressActive = false
// Finder/Explorer file drags can produce a synthetic pointerup in a
// transparent Electron window. Keep that gesture separate from a mascot tap;
// otherwise the fallback tap handler opens the main window and the file drop
// is delivered to the window underneath.
let externalFileDropActive = false
let hoverActive = false
const tapHint = document.querySelector<HTMLElement>('#pet-hint')
let tapHintTimer = 0

function showTapHint(): void {
  if (!tapHint) return
  window.clearTimeout(tapHintTimer)
  tapHint.hidden = false
  tapHint.dataset.visible = 'true'
  tapHintTimer = window.setTimeout(() => {
    tapHintTimer = 0
    if (tapHint) {
      tapHint.dataset.visible = 'false'
      window.setTimeout(() => {
        if (tapHint.dataset.visible === 'false') tapHint.hidden = true
      }, 180)
    }
  }, 3000)
}

function hideTapHint(): void {
  window.clearTimeout(tapHintTimer)
  tapHintTimer = 0
  if (tapHint) {
    tapHint.dataset.visible = 'false'
    tapHint.hidden = true
  }
}

function forwardInput(input: {
  type: 'clipboard' | 'focus-composer' | 'files' | 'text'
  source?: 'pet' | 'hotkey' | 'drop'
  paths?: string[]
  text?: string
}): void {
  const bridge = window.flowpal
  const payload = input.type === 'files'
    ? { type: 'files' as const, paths: input.paths ?? [], source: 'drop' as const }
    : input.type === 'text'
      ? { type: 'text' as const, text: input.text ?? '', source: 'drop' as const }
      : input.type === 'clipboard'
        ? { type: 'clipboard' as const, source: (input.source === 'hotkey' ? 'hotkey' : 'pet') as 'pet' | 'hotkey' }
        : { type: 'focus-composer' as const }
  if (bridge?.input?.forwardInput) {
    void bridge.input.forwardInput(payload)
  } else if (input.type === 'files' && bridge?.input?.forwardFiles) {
    void bridge.input.forwardFiles(input.paths ?? [])
  }
}

function hasInputForwarder(): boolean {
  const input = window.flowpal?.input
  return Boolean(input?.forwardInput || input?.forwardFiles)
}

const setLiveStatus = (status: PetStatus): void => {
  if (liveLabel) liveLabel.textContent = PET_STATUS_LABELS[status]
}

const renderer = createPetRenderer({
  canvas,
  fallback,
  // The resident presentation uses quiet-pebble's enlarged 224px material;
  // the native window begins at the inline A bounds and grows to this B size
  // during the occlusion hand-off.
  size: 224,
  onInteraction: (event) => {
    const pet = window.flowpal?.pet
    if (event.type === 'hit') {
      pet?.reportHit(event.inside)
      const focusMode = renderer.state.snapshot.status === 'focus'
      if (focusMode) hideTapHint()
      else if (event.inside && !hoverActive) showTapHint()
      else if (!event.inside && hoverActive) hideTapHint()
      hoverActive = event.inside
      return
    }
    if (event.type === 'pointerdown') {
      longPressActive = false
      // Lock the resident transparent window into interactive mode for the
      // whole pointer sequence. Without this immediate transition, the
      // click-through hit-test can be reapplied between pointerdown and the
      // first movement that crosses the drag threshold, dropping the drag
      // sequence on macOS. The renderer still decides whether the point is
      // inside the mascot; this call only freezes the native hit-test after a
      // confirmed pointerdown.
      pet?.reportHit(true)
    }
    if (event.type === 'dragstart') pet?.beginDrag(event.pointer)
    if (event.type === 'dragstart') renderer.setNativeWindowDrag(true)
    if (event.type === 'dragmove') pet?.moveDrag(event.pointer)
    if (event.type === 'longpress') {
      longPressActive = true
      // A press-and-hold is an input capture gesture, not navigation. The
      // resident Electron bridge routes the clipboard payload to the main
      // renderer when it is ready; this is distinct from the one-click
      // navigation path below.
      forwardInput({ type: 'clipboard', source: 'pet' })
    }
    if (event.type === 'keyboard') {
      if (event.key === 'Escape') void window.flowpal?.hideWindow?.()
      else if (event.key === 'p' || event.key === 'P') {
        void window.flowpal?.pet?.openMain?.(hasInputForwarder() ? '/now' : '/now?capture=clipboard')
        forwardInput({ type: 'clipboard', source: 'pet' })
      } else if (event.key === ' ') {
        if (hasInputForwarder()) {
          void window.flowpal?.pet?.openMain?.('/now')
          forwardInput({ type: 'focus-composer' })
        } else {
          void window.flowpal?.pet?.openMain?.('/now?capture=focus')
        }
      }
    }
    if (event.type === 'pointerup') {
      // The native main process owns the drag session. Await its result before
      // deciding whether this was a tap: renderer-side `event.dragged` can be
      // stale when macOS delivers lostpointercapture/pointerup in a different
      // order. A committed native drag must never fall through to navigation.
      const wasLongPress = longPressActive
      const wasRendererDrag = event.dragged
      const wasExternalFileDrop = externalFileDropActive
      if (wasExternalFileDrop) {
        window.setTimeout(() => { externalFileDropActive = false }, 500)
      }
      void pet?.endDrag().then((result) => {
        const nativeDragged = Boolean(
          result && typeof result === 'object' && 'ok' in result && result.ok === true,
        )
        if (!wasRendererDrag && !nativeDragged && !wasLongPress && !wasExternalFileDrop) {
          // A floating-pet tap is a local interaction. Do not navigate the
          // main window: the resident pet stays put and answers with the
          // quiet-pebble press/spring gesture. Navigation remains available
          // through Space/P and explicit input forwarding.
          renderer.tap()
        }
      })
      renderer.setNativeWindowDrag(false)
      longPressActive = false
    }
    if (event.type === 'doubleclick') {
      renderer.setNativeWindowDrag(false)
      // Double-click restores the existing window, never a route. The pet's
      // temporary receiving/happy state is not a reliable session indicator;
      // leave the hash and React history state intact on every return.
      void window.flowpal?.pet?.openMain?.()
    }
    if (event.type === 'pointercancel') pet?.cancelDrag()
    if (event.type === 'pointercancel') renderer.setNativeWindowDrag(false)
  },
})

// Keep the approved prototype's small public animation surface available in
// the production pet page. The controls are intentionally absent from the
// resident window, but QA, accessibility tooling and future status adapters
// can still request the same expressions and physical motions without
// reaching into renderer internals.
window.pet = Object.freeze({
  press: (amount?: number) => renderer.press(amount),
  tap: () => renderer.tap(),
  hop: () => renderer.hop(),
  turn: (angle: number) => renderer.turn(angle),
  focus: (value?: boolean) => renderer.focus(value),
  setExpression: (name: 'calm' | 'happy' | 'sleepy' | 'curious' | 'surprised' | 'focus', durationMs?: number) => renderer.setExpression(name, durationMs),
  setColor: (color: 'chalk' | 'fog' | 'stone') => renderer.setColor(color),
  setSize: (size: 96 | 128 | 224) => renderer.setSize(size),
  reset: () => renderer.reset(),
})

// Gesture transitions (including cancel/restore) happen inside the renderer,
// so the accessibility label follows the same source of truth as the pixels.
const removeStateSubscription = renderer.state.subscribe(
  (snapshot) => {
    setLiveStatus(snapshot.status)
    if (snapshot.status === 'focus') hideTapHint()
  },
  true,
)

const removePetCommand = window.flowpal?.pet?.onCommand((command) => {
  if (command.type === 'set-status' && command.status) {
    renderer.setStatus(command.status, command.meta)
  } else if (command.type === 'open-main') {
    void window.flowpal?.pet?.openMain?.(command.hash)
  } else if (command.type === 'hide') {
    void window.flowpal?.hideWindow()
  } else if (command.type === 'presentation' && petRoot && command.phase) {
    // Native BrowserWindow bounds can change before ResizeObserver delivers
    // the new CSS size. Refresh before the presentation frame is shown so a
    // stale A-size WebGL backing buffer cannot flash as a cropped B-size pet.
    renderer.refresh()
    petRoot.dataset.presentation = command.phase
    const duration = command.durationMs ?? (
      command.phase === 'teleport-in' ? 360
        : command.phase === 'floating-land' ? 260
          : 280
    )
    window.setTimeout(() => {
      if (petRoot.dataset.presentation === command.phase) {
        petRoot.dataset.presentation = command.mode === 'floating' ? 'floating' : 'steady'
      }
    }, duration)
  }
})

// Drops land in the resident renderer's DOM, not the hidden main window.
// Forward them over the optional preload bridge; older shells still open the
// main window, where the user can use the Composer as a fallback.
//
// 拖过来的常常不是文件，而是从微信、网页里选中的一段通知。那种手势的
// `dataTransfer` 里没有文件，只有 text/plain——早先只读文件，于是那一拖静默消失。
const listenDrops = window.flowpal?.input?.onContentDropped ?? window.flowpal?.onContentDropped
const removeFiles = listenDrops?.(({ paths, text }) => {
  externalFileDropActive = true
  if (paths.length > 0) forwardInput({ type: 'files', paths, source: 'drop' })
  else if (text) forwardInput({ type: 'text', text, source: 'drop' })
  else return
  if (!window.flowpal?.input?.forwardInput && !window.flowpal?.input?.forwardFiles) {
    void window.flowpal?.pet?.openMain?.('/now?capture=focus')
  }
})

/*
 * 有东西悬在头上。
 *
 * 拖到一半时形象一动不动，人没法判断这个窗口收不收得着——松手之前唯一的信息就是
 * 它有没有反应。跳一下、换个好奇的表情，比任何提示语都直接。
 *
 * 悬停前是什么状态记下来，离开时放回去：拖到一个正在跑的形象上，不该把「正在提取」
 * 这句话抹掉。
 */
let statusBeforeHover: PetStatus | null = null
const removeHover = window.flowpal?.input?.onDropHover?.((over) => {
  if (over) {
    statusBeforeHover = renderer.state.snapshot.status
    renderer.setStatus('receiving', { message: '松手就收下' })
    renderer.setExpression('curious')
    renderer.hop()
    return
  }
  renderer.setExpression('calm')
  if (statusBeforeHover !== null) renderer.setStatus(statusBeforeHover)
  statusBeforeHover = null
})

window.addEventListener('beforeunload', () => {
  window.clearTimeout(tapHintTimer)
  if (window.pet) delete window.pet
  renderer.dispose()
}, { once: true })
window.addEventListener('beforeunload', () => removeStateSubscription(), { once: true })
window.addEventListener('beforeunload', () => removePetCommand?.(), { once: true })
window.addEventListener('beforeunload', () => removeFiles?.(), { once: true })
window.addEventListener('beforeunload', () => removeHover?.(), { once: true })
