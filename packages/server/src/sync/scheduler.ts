/**
 * Small, dependency-free sync scheduler.  It deliberately uses a recursive
 * timeout instead of setInterval: a slow run cannot overlap the next one, and
 * a failed run schedules only the next normal cycle (no retry storm).
 */
export type SyncScheduleReason = 'startup' | 'interval' | 'manual'

export type SyncScheduler = {
  start(): void
  stop(): void
  trigger(reason?: SyncScheduleReason): Promise<boolean>
  get running(): boolean
}

export type SyncSchedulerOptions = {
  run: (reason: SyncScheduleReason) => Promise<void>
  intervalMs?: number | (() => number)
  runOnStart?: boolean
  setTimeoutFn?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>
  clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void
}

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000

export function createSyncScheduler(options: SyncSchedulerOptions): SyncScheduler {
  const interval = () => Math.max(60_000, typeof options.intervalMs === 'function'
    ? options.intervalMs()
    : options.intervalMs ?? DEFAULT_INTERVAL_MS)
  const setTimer = options.setTimeoutFn ?? ((callback, delay) => setTimeout(callback, delay))
  const clearTimer = options.clearTimeoutFn ?? ((handle) => clearTimeout(handle))
  let timer: ReturnType<typeof setTimeout> | null = null
  let started = false
  let inFlight = false

  const schedule = (delay: number): void => {
    if (!started) return
    if (timer !== null) clearTimer(timer)
    timer = setTimer(() => {
      timer = null
      void trigger('interval').finally(() => schedule(interval()))
    }, Math.max(0, delay))
  }

  const trigger = async (reason: SyncScheduleReason = 'manual'): Promise<boolean> => {
    if (!started || inFlight) return false
    inFlight = true
    try {
      await options.run(reason)
      return true
    } catch {
      // The caller persists/observes the failed run.  Scheduling itself never
      // retries immediately or turns an expected outage into a loop.
      return false
    } finally {
      inFlight = false
    }
  }

  return {
    start: () => {
      if (started) return
      started = true
      if (options.runOnStart !== false) {
        void trigger('startup').finally(() => schedule(interval()))
      } else {
        schedule(interval())
      }
    },
    stop: () => {
      started = false
      if (timer !== null) clearTimer(timer)
      timer = null
    },
    trigger,
    get running() { return inFlight },
  }
}
