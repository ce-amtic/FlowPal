/**
 * The small, renderer-only state contract for the desktop pet.
 *
 * This module deliberately has no DOM or Electron dependency.  It can be used
 * by the Electron preload and focused renderer/unit tests alike.
 */

export const PET_STATUSES = [
  'idle',
  'receiving',
  'processing',
  'done',
  'error',
  'focus',
] as const

export type PetStatus = (typeof PET_STATUSES)[number]

export interface PetStatusMeta {
  message?: string
}

export interface PetStateSnapshot extends PetStatusMeta {
  status: PetStatus
  changedAt: number
  revision: number
}

export type PetStateListener = (snapshot: PetStateSnapshot) => void

/**
 * Transitions are intentionally permissive.  The server is the source of
 * truth for work state and it may recover from a crash directly into any
 * persisted state.  This table is for diagnostics/UI affordances, not a gate
 * that could strand the pet in an old visual state.
 */
const EXPECTED_TRANSITIONS: Record<PetStatus, readonly PetStatus[]> = {
  idle: ['idle', 'receiving', 'processing', 'focus', 'error'],
  receiving: ['receiving', 'processing', 'done', 'error', 'idle', 'focus'],
  processing: ['processing', 'done', 'error', 'idle', 'focus'],
  done: ['done', 'idle', 'receiving', 'processing', 'focus', 'error'],
  error: ['error', 'idle', 'receiving', 'processing', 'focus', 'done'],
  focus: ['focus', 'receiving', 'processing', 'done', 'error', 'idle'],
}

export function isPetStatus(value: unknown): value is PetStatus {
  return typeof value === 'string' && (PET_STATUSES as readonly string[]).includes(value)
}

export function canTransition(from: PetStatus, to: PetStatus): boolean {
  return EXPECTED_TRANSITIONS[from].includes(to)
}

export const PET_STATUS_LABELS: Record<PetStatus, string> = {
  idle: '在这里',
  receiving: '收到啦',
  processing: '正在看…',
  done: '完成了',
  error: '遇到一点问题',
  focus: '安静地专注',
}

interface StateMachineOptions {
  now?: () => number
  initial?: PetStateSnapshot
}

export class PetStateMachine {
  private readonly now: () => number
  private readonly listeners = new Set<PetStateListener>()
  private current: PetStateSnapshot

  constructor(options: StateMachineOptions = {}) {
    this.now = options.now ?? (() => Date.now())
    this.current = options.initial ?? {
      status: 'idle',
      changedAt: this.now(),
      revision: 0,
    }
  }

  get snapshot(): PetStateSnapshot {
    return this.current
  }

  /**
   * Set the visual state and notify subscribers.  Repeating the same state is
   * still useful when the message changes, but an identical snapshot is a
   * no-op so callers can safely replay events.
   */
  set(status: PetStatus, meta: PetStatusMeta = {}): PetStateSnapshot {
    const message = normalizeMessage(meta.message)
    if (this.current.status === status && this.current.message === message) {
      return this.current
    }

    this.current = {
      status,
      ...(message ? { message } : {}),
      changedAt: this.now(),
      revision: this.current.revision + 1,
    }
    for (const listener of this.listeners) listener(this.current)
    return this.current
  }

  subscribe(listener: PetStateListener, emitCurrent = true): () => void {
    this.listeners.add(listener)
    if (emitCurrent) listener(this.current)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    this.listeners.clear()
  }
}

function normalizeMessage(message: string | undefined): string | undefined {
  if (typeof message !== 'string') return undefined
  const trimmed = message.trim()
  return trimmed.length > 0 ? trimmed : undefined
}
