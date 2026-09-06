import assert from 'node:assert/strict'
import { test } from 'node:test'
import { WebGLPetRenderer } from '../src/pet/renderer.ts'

function setup(t, reducedMotion = false) {
  let now = 1000
  let id = 0
  const timers = new Map()
  const previousWindow = globalThis.window
  const previousDocument = globalThis.document
  globalThis.document = { hidden: false }
  globalThis.window = {
    setTimeout(callback, delay) { timers.set(++id, { callback, at: now + delay }); return id },
    clearTimeout(key) { timers.delete(key) },
  }
  t.after(() => {
    globalThis.window = previousWindow
    globalThis.document = previousDocument
  })
  const renderer = new WebGLPetRenderer({
    reducedMotion,
    canvas: { dataset: {}, style: {}, setAttribute() {}, hasPointerCapture: () => false },
    onInteraction(event) { if (event.type === 'pointerup' && !event.dragged) renderer.tap() },
  })
  renderer.now = () => now
  const advance = (ms) => {
    const until = now + ms
    while (true) {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0]
      if (!next || next[1].at > until) break
      now = next[1].at
      timers.delete(next[0])
      next[1].callback()
    }
    now = until
  }
  return { renderer, advance, time: () => now }
}

test('focus click is a shallow blink, without changing work state or smiling', (t) => {
  const { renderer, time } = setup(t)
  renderer.setStatus('focus')
  const pointer = { pointerId: 1, x: 20, y: 20 }
  renderer.beginGesture(pointer, pointer)
  assert.equal(renderer.state.snapshot.status, 'focus')
  renderer.finishGesture(pointer, true)
  assert.equal(renderer.state.snapshot.status, 'focus')
  assert.equal(renderer.effectiveExpression, 'focus')
  assert.equal(renderer.targetEyeStyle[1], 0)
  assert.ok(renderer.blinkValue(time() + 110) >= 0.6, 'eyes should not close fully')
  assert.ok(renderer.blinkValue(time() + 110) < 0.8, 'blink must remain visible')
  assert.equal(renderer.blinkValue(time() + 220), 1)
})

test('focus taps cannot restore an obsolete expression after the session ends', (t) => {
  const { renderer, advance } = setup(t)
  renderer.setStatus('focus')
  renderer.tap()
  renderer.setStatus('idle')
  advance(1200)
  assert.equal(renderer.state.snapshot.status, 'idle')
  assert.equal(renderer.effectiveExpression, 'calm')
})

test('repeated focus clicks remain focused after feedback timers settle', (t) => {
  const { renderer, advance } = setup(t)
  renderer.setStatus('focus')
  for (let i = 0; i < 3; i++) {
    const pointer = { pointerId: i, x: 20, y: 20 }
    renderer.beginGesture(pointer, pointer)
    renderer.finishGesture(pointer, true)
    advance(1500)
    assert.equal(renderer.state.snapshot.status, 'focus')
    assert.equal(renderer.effectiveExpression, 'focus')
  }
})

test('idle taps retain the happy expression and then settle', (t) => {
  const { renderer, advance } = setup(t)
  renderer.tap()
  assert.equal(renderer.effectiveExpression, 'happy')
  advance(1200)
  assert.equal(renderer.effectiveExpression, 'calm')
})

test('reduced-motion still suppresses blink animation', (t) => {
  const { renderer, time } = setup(t, true)
  renderer.setStatus('focus')
  renderer.tap()
  assert.equal(renderer.blinkValue(time() + 110), 1)
})

test('automatic blinks retain their original full depth after a shallow tap', (t) => {
  const { renderer, advance } = setup(t)
  renderer.setStatus('focus')
  renderer.tap()
  advance(20_001)
  assert.equal(renderer.blinkDepth, 0.96)
  assert.ok(Math.abs(renderer.blinkValue(renderer.blinkStartedAt + 110) - 0.04) < 1e-6)
})
