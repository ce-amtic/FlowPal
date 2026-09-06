import { useEffect, useRef, useState } from 'react'
import { bridge, inElectron } from '../bridge.ts'
import { dispatchDesktopInput } from './input-dispatcher.ts'
import { createPetRenderer, type PetInteraction, type PetSize, type WebGLPetRenderer } from './renderer.ts'
import { usePetStatus } from './context.tsx'
import { PET_STATUS_LABELS, type PetStatus } from './state-machine.ts'
import './pet-host.css'

export type PetHostProps = {
  /** Logical renderer size; the host can be larger to leave transparent padding. */
  size?: PetSize
  className?: string
  /** Main-window hosts are hidden while the native window is blurred. */
  inline?: boolean
  /** Focus-page hosts remain interactive but do not leave the current route. */
  interactive?: boolean
}

type PetTransition =
  | 'steady'
  | 'floating-start'
  | 'floating-land'
  | 'layout-closing'
  | 'teleport-in'
  | 'teleport-out'

/**
 * React host for the same WebGLPetRenderer used by pet.html.
 *
 * Keeping the renderer behind this small host means the visual state, pointer
 * hit-test and keyboard affordances do not fork between the embedded and
 * resident presentations. The native focus event only controls visibility;
 * the Electron pet window is shown/hidden by the main process itself.
 */
export function PetHost({
  size = 128,
  className,
  inline = true,
  interactive = true,
}: PetHostProps) {
  const host = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const fallback = useRef<HTMLParagraphElement>(null)
  const renderer = useRef<WebGLPetRenderer | null>(null)
  const interactionRef = useRef<((event: PetInteraction) => void) | null>(null)
  const longPress = useRef(false)
  const { status, meta } = usePetStatus()
  const [renderedStatus, setRenderedStatus] = useState<PetStatus>(status)
  const [focused, setFocused] = useState(() =>
    !inElectron || typeof document === 'undefined' || document.hasFocus(),
  )
  // In Electron the first paint starts with no inline slot.  The focus event
  // (or the mount-time focus check below) opens the slot and lets normal page
  // flow push the content down while the pet pops in, avoiding a static flash.
  const initialInlineVisible = !inline || !inElectron
  const [inlineVisible, setInlineVisibleState] = useState(initialInlineVisible)
  const [inlineSlotOpen, setInlineSlotOpenState] = useState(initialInlineVisible)
  const [presentation, setPresentation] = useState<'inline' | 'floating'>('inline')
  const [tapHintVisible, setTapHintVisible] = useState(false)
  const [transition, setTransition] = useState<PetTransition>('steady')
  const transitionTimer = useRef<number | null>(null)
  const tapHintTimer = useRef<number | null>(null)
  const inlineVisibleRef = useRef(initialInlineVisible)
  const inlineSlotOpenRef = useRef(initialInlineVisible)
  const transitionRef = useRef<PetTransition>('steady')

  const setInlineVisible = (value: boolean) => {
    inlineVisibleRef.current = value
    setInlineVisibleState(value)
  }

  const setInlineSlotOpen = (value: boolean) => {
    inlineSlotOpenRef.current = value
    setInlineSlotOpenState(value)
  }

  // Keep a synchronous copy for IPC callbacks. React state updates are batched,
  // so a replayed `steady` event can otherwise cancel an entry/exit animation
  // before the corresponding render has committed.
  const setPetTransition = (value: PetTransition) => {
    transitionRef.current = value
    setTransition(value)
  }

  const clearTransitionTimer = () => {
    if (transitionTimer.current !== null) window.clearTimeout(transitionTimer.current)
    transitionTimer.current = null
  }

  const beginInlineEntry = (duration = 360) => {
    if (transitionRef.current === 'teleport-in' && inlineSlotOpenRef.current) return
    clearTransitionTimer()
    setInlineVisible(true)
    setInlineSlotOpen(true)
    setPetTransition('teleport-in')
    transitionTimer.current = window.setTimeout(() => {
      transitionTimer.current = null
      setPetTransition('steady')
      // The slot animation and the WebGL host settle on separate paint ticks.
      // Refresh after both so the first stable frame cannot use stale bounds.
      window.requestAnimationFrame(() => renderer.current?.refresh())
    }, duration)
  }

  const beginInlineExit = (
    duration = 280,
    animation: 'floating-start' | 'teleport-out' = 'floating-start',
  ) => {
    if (transitionRef.current === animation && inlineSlotOpenRef.current) return
    clearTransitionTimer()
    if (!inlineSlotOpenRef.current) {
      // The main window can emit blur more than once while the inline host is
      // waiting for (or finishing) its first focus replay. A closed slot is
      // already out of the layout; never resurrect the fixed-size inner host
      // just to run a duplicate exit animation.
      setInlineVisible(false)
      setPetTransition('steady')
      return
    }
    if (transitionRef.current === 'teleport-in') {
      // A blur can race the entry timer. Restarting the departure keyframe at
      // opacity:1 would brighten a partially revealed pet for one frame. Cut
      // the still-entering host directly to the closed state instead.
      setInlineVisible(false)
      setInlineSlotOpen(false)
      setPetTransition('steady')
      return
    }
    // Keep the slot open while the pet performs its departure. Only after the
    // pet has vanished do we collapse the slot, allowing the page content to
    // flow back up in a separate, readable motion.
    setInlineVisible(true)
    setInlineSlotOpen(true)
    setPetTransition(animation)
    transitionTimer.current = window.setTimeout(() => {
      transitionTimer.current = null
      setPetTransition('layout-closing')
      setInlineSlotOpen(false)
      transitionTimer.current = window.setTimeout(() => {
        transitionTimer.current = null
        setInlineVisible(false)
        setPetTransition('steady')
      }, 220)
    }, duration)
  }

  const showTapHint = () => {
    if (tapHintTimer.current !== null) window.clearTimeout(tapHintTimer.current)
    setTapHintVisible(true)
    tapHintTimer.current = window.setTimeout(() => {
      tapHintTimer.current = null
      setTapHintVisible(false)
    }, 3000)
  }

  const hideTapHint = () => {
    if (tapHintTimer.current !== null) window.clearTimeout(tapHintTimer.current)
    tapHintTimer.current = null
    setTapHintVisible(false)
  }

  // A ref keeps the renderer stable while route-level callbacks change.
  interactionRef.current = (event) => {
    if (!interactive) {
      // The focus page deliberately disables navigation and drag forwarding,
      // but the mascot still acknowledges a click. Keep this visual feedback
      // local so a focus-session double click cannot accidentally route away.
      if (event.type === 'pointerup' && !event.dragged) renderer.current?.tap()
      return
    }
    if (event.type === 'hit') {
      // The inline A-size pet is part of the main layout. Hover prompts are
      // reserved for the detached resident window (pet.html), so the main
      // page remains visually quiet while the pointer moves across its pet.
    } else if (event.type === 'pointerdown') {
      longPress.current = false
    } else if (event.type === 'pointerup' && !event.dragged) {
      if (longPress.current) {
        longPress.current = false
        return
      }
      hideTapHint()
      void bridge.openMain?.('/now')
    } else if (event.type === 'longpress') {
      longPress.current = true
      dispatchDesktopInput({ type: 'clipboard', source: 'pet' })
    } else if (event.type === 'keyboard') {
      if (event.key === 'p' || event.key === 'P') {
        dispatchDesktopInput({ type: 'clipboard', source: 'pet' })
      } else if (event.key === ' ') {
        dispatchDesktopInput({ type: 'focus-composer' })
      }
    } else if (event.type === 'pointercancel') {
      longPress.current = false
    }
  }

  useEffect(() => {
    const element = canvas.current
    if (!element) return
    const instance = createPetRenderer({
      canvas: element,
      fallback: fallback.current,
      size,
      onInteraction: (event) => interactionRef.current?.(event),
    })
    renderer.current = instance
    const removeStateSubscription = instance.state.subscribe(
      (snapshot) => setRenderedStatus(snapshot.status),
      true,
    )
    return () => {
      removeStateSubscription()
      if (renderer.current === instance) renderer.current = null
      instance.dispose()
      if (tapHintTimer.current !== null) window.clearTimeout(tapHintTimer.current)
      tapHintTimer.current = null
    }
  }, [size])

  useEffect(() => {
    renderer.current?.setStatus(status, meta)
  }, [meta, status])

  useEffect(() => {
    if (!inline || !bridge.reportPetGeometry) return
    const report = () => {
      const element = host.current
      if (!element) return
      const rect = element.getBoundingClientRect()
      bridge.reportPetGeometry?.({
        x: window.screenX + rect.left,
        y: window.screenY + rect.top,
        // The host may be in a teleport transform. Use layout dimensions for
        // native window bounds so an animated 0.78x/1.04x box never becomes
        // the next floating window's permanent size.
        width: element.offsetWidth || rect.width,
        height: element.offsetHeight || rect.height,
      })
    }
    report()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(report)
    if (host.current) observer?.observe(host.current)
    window.addEventListener('resize', report)
    // Window moves do not emit a DOM resize event. A low-frequency heartbeat
    // keeps the native transition's starting point aligned with the page.
    const timer = window.setInterval(report, 300)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', report)
      window.clearInterval(timer)
    }
  }, [inline])

  // A route-level PetHost can mount after the main window has already emitted
  // its focus event. In that case document.hasFocus() is the authoritative
  // local signal for starting the same hidden-slot -> pop-in sequence.
  useEffect(() => {
    if (!inline || !inElectron || !document.hasFocus() || inlineSlotOpenRef.current) return
    beginInlineEntry()
  }, [inline])

  useEffect(() => {
    if (!inline) return
    const unsubscribe = bridge.onMainWindowFocusChanged?.(({ focused: next, presentation: change }) => {
      setFocused(next)
      if (!change) return
      setPresentation(change.mode)
      const hideInline = () => {
        clearTransitionTimer()
        setInlineVisible(false)
        setInlineSlotOpen(false)
        setPetTransition('steady')
      }

      // `focused` is the authoritative native lifecycle signal. A delayed
      // minimize/blur replay can carry mode:inline; it must never reopen the
      // inline slot while the main window is actually unfocused.
      if (!next) {
        if (change.phase === 'floating-start') {
          beginInlineExit(change.durationMs ?? 280, 'floating-start')
        } else {
          hideInline()
        }
        return
      }

      // Focused main windows only accept the inline entry phase. In particular,
      // teleport-out belongs to the resident source and must leave this host
      // closed until the following teleport-in event.
      if (change.phase === 'teleport-in') {
        beginInlineEntry(change.durationMs ?? 360)
      } else if (change.phase === 'teleport-out') {
        hideInline()
      } else if (change.mode === 'inline' && change.phase === 'steady') {
        // `steady/inline` is replayed after a renderer reload. If the slot is
        // closed, treat it as an entry request so the first frame is hidden.
        if (!inlineSlotOpenRef.current) beginInlineEntry(change.durationMs ?? 360)
        else if (
          transitionRef.current !== 'teleport-in'
          && transitionRef.current !== 'teleport-out'
          && transitionRef.current !== 'floating-start'
          && transitionRef.current !== 'layout-closing'
        ) {
          setInlineVisible(true)
          setInlineSlotOpen(true)
          setPetTransition('steady')
        }
      } else {
        hideInline()
      }
    })
    return () => {
      unsubscribe?.()
      clearTransitionTimer()
      if (tapHintTimer.current !== null) window.clearTimeout(tapHintTimer.current)
    }
  }, [inline])

  // Electron can deliver the native focus event before React has mounted this
  // host on the first paint. Keep a renderer-level fallback so a missed IPC
  // replay cannot leave the inline pet hidden until the next reload. Native
  // and DOM events are intentionally idempotent through the refs above.
  useEffect(() => {
    if (!inline || !inElectron) return
    const onFocus = () => {
      setFocused(true)
      if (!inlineSlotOpenRef.current) beginInlineEntry()
    }
    const onBlur = () => {
      setFocused(false)
      if (inlineSlotOpenRef.current) beginInlineExit()
    }
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
    }
  }, [inline])

  // The hidden host keeps its A-size layout box, so WebGL never receives a
  // transient 0x0 viewport while the native pet is floating. Refresh on the
  // next paint after teleport-in to cover browser resize coalescing.
  useEffect(() => {
    if (!inline || !inlineVisible) return
    let secondFrame = 0
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => renderer.current?.refresh())
    })
    return () => {
      window.cancelAnimationFrame(firstFrame)
      if (secondFrame) window.cancelAnimationFrame(secondFrame)
    }
  }, [inline, inlineVisible])

  const classes = [className].filter(Boolean).join(' ')
  const visible = !inline || inlineVisible
  return (
    <div
      className={`pet-host-slot ${classes}`}
      data-pet-slot-open={(!inline || inlineSlotOpen) ? 'true' : 'false'}
      data-pet-visible={visible ? 'true' : 'false'}
      data-pet-focused={focused ? 'true' : 'false'}
      data-pet-presentation={presentation}
      data-pet-transition={transition}
      aria-hidden={!visible}
    >
      <div ref={host} className="pet-host">
        <canvas ref={canvas} className="pet-host-canvas" />
        <p ref={fallback} className="pet-host-fallback" hidden />
        {tapHintVisible && (
          <p className="pet-host-hint" role="status" aria-live="polite">
            有新点子吗？告诉我吧，或者把任务拖给我～
          </p>
        )}
        <span className="pet-host-status" role="status" aria-live="polite">
          {meta.message ?? PET_STATUS_LABELS[renderedStatus]}
        </span>
      </div>
    </div>
  )
}
