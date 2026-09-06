import test from 'node:test'
import assert from 'node:assert/strict'
import { createSyncScheduler } from '../scheduler.ts'

test('sync scheduler is single-flight and does not retry a failed run immediately', async () => {
  let calls = 0
  let release: (() => void) | undefined
  const scheduler = createSyncScheduler({
    runOnStart: false,
    intervalMs: 60_000,
    run: async () => {
      calls += 1
      await new Promise<void>((resolve) => { release = resolve })
      throw new Error('expected test outage')
    },
  })
  scheduler.start()
  const first = scheduler.trigger('manual')
  const second = await scheduler.trigger('manual')
  assert.equal(second, false)
  release?.()
  assert.equal(await first, false)
  assert.equal(calls, 1)
  scheduler.stop()
})
