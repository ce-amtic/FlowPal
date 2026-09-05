import {
  PET_STATUS_LABELS,
  PetStateMachine,
  type PetStatus,
  type PetStatusMeta,
} from './state-machine.ts'
import {
  PET_FRAGMENT_SHADER_HIGH,
  PET_FRAGMENT_SHADER_MEDIUM,
  PET_VERTEX_SHADER,
} from './shader.ts'

export type PetSize = 96 | 224

export interface PetPointer {
  x: number
  y: number
  pointerId: number
}

export type PetInteraction =
  | { type: 'hit'; inside: boolean }
  | { type: 'pointerdown'; pointer: PetPointer }
  | { type: 'longpress'; pointer: PetPointer }
  | { type: 'dragstart'; pointer: PetPointer }
  | { type: 'dragmove'; pointer: PetPointer }
  | { type: 'pointerup'; pointer: PetPointer; dragged: boolean }
  | { type: 'pointercancel'; pointer: PetPointer }
  | { type: 'keyboard'; key: string }

export interface PetRendererOptions {
  canvas: HTMLCanvasElement
  fallback?: HTMLElement | null
  size?: PetSize
  reducedMotion?: boolean
  onInteraction?: (event: PetInteraction) => void
}

export interface PetRenderer {
  mount(): void
  setStatus(status: PetStatus, meta?: PetStatusMeta): void
  setTheme(theme: { color?: PetColor; size?: PetSize; reducedMotion?: boolean }): void
  hitTest(localPoint: { x: number; y: number }): boolean
  startDrag(pointer: PetPointer): void
  updatePointer(pointer: PetPointer): void
  endDrag(): void
  dispose(): void
}

export type PetColor = 'chalk' | 'fog' | 'stone'

const PALETTE: Record<PetColor, readonly [number, number, number]> = {
  chalk: [0.83, 0.823, 0.792],
  fog: [0.72, 0.768, 0.777],
  stone: [0.60, 0.635, 0.595],
}

const STATUS_COLOR: Record<PetStatus, readonly [number, number, number]> = {
  idle: [0.78, 0.70, 0.59],
  receiving: [0.90, 0.66, 0.40],
  processing: [0.68, 0.69, 0.67],
  done: [0.67, 0.78, 0.55],
  error: [0.83, 0.52, 0.47],
  focus: [0.58, 0.66, 0.74],
}

type EyeStyle = readonly [number, number, number, number]

const EYE_STYLE: Record<PetStatus, EyeStyle> = {
  idle: [1.0, 0.0, 0.0, 0.0],
  receiving: [0.78, 0.12, 0.0, 0.0],
  processing: [0.68, 0.0, 0.08, 0.03],
  done: [0.78, 0.58, 0.0, 0.0],
  error: [0.48, 0.0, 0.0, 0.08],
  focus: [0.64, 0.0, 0.0, -0.12],
}

type Uniforms = {
  resolution: WebGLUniformLocation | null
  center: WebGLUniformLocation | null
  ground: WebGLUniformLocation | null
  unit: WebGLUniformLocation | null
  squash: WebGLUniformLocation | null
  lean: WebGLUniformLocation | null
  yaw: WebGLUniformLocation | null
  blink: WebGLUniformLocation | null
  gaze: WebGLUniformLocation | null
  bodyColor: WebGLUniformLocation | null
  statusColor: WebGLUniformLocation | null
  elevation: WebGLUniformLocation | null
  eyeStyle: WebGLUniformLocation | null
}

type Point = { x: number; y: number }

type Gesture = {
  id: number
  start: Point
  offsetX: number
  offsetY: number
  dragging: boolean
  previousStatus: PetStatus
  previousMeta: PetStatusMeta
}

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value))

const spring = (
  position: number,
  velocity: number,
  target: number,
  stiffness: number,
  damping: number,
  dt: number,
): [number, number] => {
  const nextVelocity = velocity + ((target - position) * stiffness - velocity * damping) * dt
  return [position + nextVelocity * dt, nextVelocity]
}

/**
 * A renderer-only WebGL pet.  It intentionally knows nothing about Electron,
 * HTTP, SQLite, or the main window.  The future Electron shell can forward
 * pointer events and status commands through the small interface above.
 */
export class WebGLPetRenderer implements PetRenderer {
  readonly state: PetStateMachine

  private readonly canvas: HTMLCanvasElement
  private readonly fallback: HTMLElement | null
  private readonly onInteraction?: (event: PetInteraction) => void
  private readonly listeners: Array<() => void> = []
  private readonly now = () => performance.now()
  private gl: WebGLRenderingContext | null = null
  private program: WebGLProgram | null = null
  private buffer: WebGLBuffer | null = null
  private uniforms: Uniforms | null = null
  private resizeObserver: ResizeObserver | null = null
  private mediaQuery: MediaQueryList | null = null
  private raf = 0
  private blinkTimer = 0
  private pressTimer = 0
  private actionTimer = 0
  private actionPreviousStatus: PetStatus | null = null
  private actionPreviousMeta: PetStatusMeta = {}
  private blinkStartedAt = 0
  private lastFrame = 0
  private lastDrawAt = 0
  private disposed = false
  private mounted = false
  private reducedMotion: boolean
  private size: PetSize
  private color: PetColor = 'chalk'
  private dpr = 1
  private width = 0
  private height = 0
  private unit = 42
  private groundY = 0
  private x = 0
  private targetX = 0
  private velocityX = 0
  private z = 0
  private targetZ = 0
  private velocityZ = 0
  private squash = 1
  private targetSquash = 1
  private velocitySquash = 0
  private lean = 0
  private targetLean = 0
  private velocityLean = 0
  private yaw = 0
  private targetYaw = 0
  private velocityYaw = 0
  private gazeX = 0
  private gazeY = 0
  private targetGazeX = 0
  private targetGazeY = 0
  private gesture: Gesture | null = null
  private statusMeta: PetStatusMeta = {}

  constructor(options: PetRendererOptions) {
    this.canvas = options.canvas
    this.fallback = options.fallback ?? null
    this.size = options.size ?? 96
    this.reducedMotion = options.reducedMotion ?? this.readReducedMotion()
    this.onInteraction = options.onInteraction
    this.state = new PetStateMachine()
  }

  mount(): void {
    if (this.disposed || this.mounted) return
    this.mounted = true
    this.canvas.setAttribute('role', 'img')
    this.canvas.setAttribute('aria-label', 'FlowPal 桌宠。点击、长按或拖动。')
    this.canvas.tabIndex = 0
    this.attachDomListeners()
    this.resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => this.resize())
    this.resizeObserver?.observe(this.canvas)
    if (!this.resizeObserver) {
      this.addListener(window, 'resize', () => this.resize())
    }
    this.mediaQuery = typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null
    if (this.mediaQuery) {
      this.reducedMotion = this.mediaQuery.matches
      const onMediaChange = (event: MediaQueryListEvent) => {
        this.reducedMotion = event.matches
        if (event.matches) window.clearTimeout(this.blinkTimer)
        else this.scheduleBlink()
        this.wake()
      }
      this.mediaQuery.addEventListener?.('change', onMediaChange)
      this.listeners.push(() => this.mediaQuery?.removeEventListener?.('change', onMediaChange))
    }
    this.resize()
    this.scheduleBlink()
    this.initializeGl()
    this.wake()
  }

  setStatus(status: PetStatus, meta: PetStatusMeta = {}): void {
    if (this.disposed) return
    this.statusMeta = meta
    this.state.set(status, meta)
    this.wake()
  }

  setTheme(theme: { color?: PetColor; size?: PetSize; reducedMotion?: boolean }): void {
    if (theme.color && theme.color in PALETTE) this.color = theme.color
    if (theme.size) this.size = theme.size
    if (theme.reducedMotion !== undefined) {
      this.reducedMotion = theme.reducedMotion
      if (this.reducedMotion) window.clearTimeout(this.blinkTimer)
      else this.scheduleBlink()
    }
    this.resize()
    this.wake()
  }

  hitTest(localPoint: Point): boolean {
    // A hidden/fallback canvas must never keep the transparent Electron window
    // above the user's other apps. Pointer passthrough is driven by this test.
    if (!this.program || this.width <= 0 || this.height <= 0) return false
    const centerY = this.groundY - this.z - this.unit * 0.81 * this.squash
    const horizontal = (localPoint.x - this.x) / (this.unit * 1.18 / Math.sqrt(this.squash))
    const vertical = (localPoint.y - centerY) / (this.unit * 0.83 * this.squash)
    return horizontal ** 4 + vertical ** 4 < 1
  }

  startDrag(pointer: PetPointer): void {
    if (this.disposed) return
    const point = { x: pointer.x, y: pointer.y }
    if (!this.hitTest(point)) return
    this.beginGesture(pointer, point)
  }

  updatePointer(pointer: PetPointer): void {
    if (this.disposed || this.gesture?.id !== pointer.pointerId) return
    this.moveGesture(pointer, { x: pointer.x, y: pointer.y })
  }

  endDrag(): void {
    if (!this.gesture) return
    this.finishGesture({ x: this.gesture.start.x, y: this.gesture.start.y, pointerId: this.gesture.id }, false)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cancelAnimation()
    window.clearTimeout(this.blinkTimer)
    window.clearTimeout(this.pressTimer)
    window.clearTimeout(this.actionTimer)
    this.blinkTimer = 0
    this.pressTimer = 0
    this.actionTimer = 0
    this.actionPreviousStatus = null
    this.actionPreviousMeta = {}
    this.resizeObserver?.disconnect()
    this.resizeObserver = null
    for (const remove of this.listeners.splice(0)) remove()
    this.releaseGesture()
    if (this.gl) {
      if (this.buffer) this.gl.deleteBuffer(this.buffer)
      if (this.program) this.gl.deleteProgram(this.program)
    }
    this.buffer = null
    this.program = null
    this.uniforms = null
    this.gl = null
    this.state.dispose()
    this.showFallback(false)
    this.mounted = false
  }

  private initializeGl(): void {
    if (this.disposed) return
    const gl = this.canvas.getContext('webgl', {
      alpha: true,
      antialias: true,
      premultipliedAlpha: false,
      powerPreference: 'low-power',
      preserveDrawingBuffer: false,
    })
    if (!gl) {
      this.showFallback(true, '3D 桌宠暂时不可用；仍可继续使用 FlowPal。')
      return
    }
    this.gl = gl
    try {
      let highPrecision = false
      try {
        const precision = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT)
        highPrecision = Boolean(precision && precision.precision > 0)
      } catch {
        // Some WebGL implementations expose the method but throw for a
        // precision query.  The mediump source below is the safe fallback.
      }
      const fragments = highPrecision
        ? [PET_FRAGMENT_SHADER_HIGH, PET_FRAGMENT_SHADER_MEDIUM]
        : [PET_FRAGMENT_SHADER_MEDIUM]
      let program: WebGLProgram | null = null
      for (const fragment of fragments) {
        program = this.createProgram(gl, PET_VERTEX_SHADER, fragment)
        if (program) break
      }
      if (!program) throw new Error('pet shader program could not be linked')
      this.program = program
      this.uniforms = this.findUniforms(gl, program)
      this.buffer = gl.createBuffer()
      if (!this.buffer) throw new Error('pet vertex buffer could not be created')
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer)
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
        gl.STATIC_DRAW,
      )
      gl.useProgram(program)
      const position = gl.getAttribLocation(program, 'a_position')
      if (position < 0) throw new Error('pet position attribute is missing')
      gl.enableVertexAttribArray(position)
      gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)
      gl.clearColor(0, 0, 0, 0)
      this.showFallback(false)
    } catch (error) {
      console.error('[FlowPal] pet WebGL initialization failed', error)
      this.destroyGlResources()
      this.showFallback(true, '3D 桌宠暂时不可用；已切换到静态提示。')
    }
  }

  private createProgram(
    gl: WebGLRenderingContext,
    vertexSource: string,
    fragmentSource: string,
  ): WebGLProgram | null {
    const vertex = this.compileShader(gl, gl.VERTEX_SHADER, vertexSource)
    const fragment = this.compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource)
    if (!vertex || !fragment) {
      if (vertex) gl.deleteShader(vertex)
      if (fragment) gl.deleteShader(fragment)
      return null
    }
    const program = gl.createProgram()
    if (!program) return null
    gl.attachShader(program, vertex)
    gl.attachShader(program, fragment)
    gl.linkProgram(program)
    gl.deleteShader(vertex)
    gl.deleteShader(fragment)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error('[FlowPal] pet shader link failed', gl.getProgramInfoLog(program))
      gl.deleteProgram(program)
      return null
    }
    return program
  }

  private compileShader(
    gl: WebGLRenderingContext,
    type: number,
    source: string,
  ): WebGLShader | null {
    const shader = gl.createShader(type)
    if (!shader) return null
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error('[FlowPal] pet shader compile failed', gl.getShaderInfoLog(shader))
      gl.deleteShader(shader)
      return null
    }
    return shader
  }

  private findUniforms(gl: WebGLRenderingContext, program: WebGLProgram): Uniforms {
    const get = (name: string) => gl.getUniformLocation(program, `u_${name}`)
    return {
      resolution: get('resolution'),
      center: get('center'),
      ground: get('ground'),
      unit: get('unit'),
      squash: get('squash'),
      lean: get('lean'),
      yaw: get('yaw'),
      blink: get('blink'),
      gaze: get('gaze'),
      bodyColor: get('bodyColor'),
      statusColor: get('statusColor'),
      elevation: get('elevation'),
      eyeStyle: get('eyeStyle'),
    }
  }

  private destroyGlResources(): void {
    if (!this.gl) return
    if (this.buffer) this.gl.deleteBuffer(this.buffer)
    if (this.program) this.gl.deleteProgram(this.program)
    this.buffer = null
    this.program = null
    this.uniforms = null
  }

  private resize(): void {
    if (this.disposed) return
    const rect = this.canvas.getBoundingClientRect()
    this.width = Math.max(1, rect.width)
    this.height = Math.max(1, rect.height)
    this.dpr = Math.min(window.devicePixelRatio || 1, 1.5)
    const pixelWidth = Math.max(1, Math.round(this.width * this.dpr))
    const pixelHeight = Math.max(1, Math.round(this.height * this.dpr))
    if (this.canvas.width !== pixelWidth) this.canvas.width = pixelWidth
    if (this.canvas.height !== pixelHeight) this.canvas.height = pixelHeight
    this.groundY = this.height * 0.70
    this.unit = Math.max(18, Math.min(this.size, this.width * 0.65) / 2.27)
    if (this.x === 0) this.x = this.width * 0.5
    this.targetX = clamp(this.targetX || this.x, this.unit * 1.25, this.width - this.unit * 1.25)
    this.x = clamp(this.x, this.unit * 1.25, this.width - this.unit * 1.25)
    this.gl?.viewport(0, 0, pixelWidth, pixelHeight)
    this.wake()
  }

  private attachDomListeners(): void {
    this.addListener(this.canvas, 'pointerdown', this.handlePointerDown)
    this.addListener(this.canvas, 'pointermove', this.handlePointerMove)
    this.addListener(this.canvas, 'pointerup', this.handlePointerUp)
    this.addListener(this.canvas, 'pointercancel', this.handlePointerCancel)
    this.addListener(this.canvas, 'lostpointercapture', this.handleLostPointerCapture)
    this.addListener(this.canvas, 'pointerleave', this.handlePointerLeave)
    this.addListener(this.canvas, 'keydown', this.handleKeyDown)
    this.addListener(document, 'visibilitychange', this.handleVisibility)
    this.addListener(this.canvas, 'webglcontextlost', this.handleContextLost)
    this.addListener(this.canvas, 'webglcontextrestored', this.handleContextRestored)
  }

  private readonly handlePointerDown = (event: Event): void => {
    const pointerEvent = event as PointerEvent
    const point = this.pointFromEvent(pointerEvent)
    if (this.gesture || !this.hitTest(point)) return
    pointerEvent.preventDefault()
    this.canvas.focus({ preventScroll: true })
    try {
      this.canvas.setPointerCapture(pointerEvent.pointerId)
    } catch {
      // Pointer capture is optional in a few embedded WebView implementations.
      // The gesture still works while the pointer remains over the canvas.
    }
    this.beginGesture({ pointerId: pointerEvent.pointerId, x: point.x, y: point.y }, point)
    this.emit({ type: 'pointerdown', pointer: this.pointerFromEvent(pointerEvent, point) })
  }

  private readonly handlePointerMove = (event: Event): void => {
    const pointerEvent = event as PointerEvent
    const point = this.pointFromEvent(pointerEvent)
    if (this.gesture?.id === pointerEvent.pointerId) {
      this.moveGesture(pointerEventToPetPointer(pointerEvent, point), point)
      return
    }
    const inside = this.hitTest(point)
    this.canvas.style.cursor = inside ? 'grab' : 'default'
    this.emit({ type: 'hit', inside })
    if (!this.gesture && this.state.snapshot.status !== 'focus') {
      this.targetGazeX = clamp((point.x - this.x) / Math.max(this.width, 1) * 0.13, -0.045, 0.045)
      this.targetGazeY = clamp((this.groundY - this.unit * 0.81 - point.y) / Math.max(this.height, 1) * 0.08, -0.028, 0.028)
      this.wake()
    }
  }

  private readonly handlePointerUp = (event: Event): void => {
    const pointerEvent = event as PointerEvent
    if (this.gesture?.id !== pointerEvent.pointerId) return
    const point = this.pointFromEvent(pointerEvent)
    this.finishGesture(pointerEventToPetPointer(pointerEvent, point), true)
  }

  private readonly handlePointerCancel = (event: Event): void => {
    const pointerEvent = event as PointerEvent
    if (this.gesture?.id !== pointerEvent.pointerId) return
    const point = this.pointFromEvent(pointerEvent)
    this.cancelGesture(pointerEventToPetPointer(pointerEvent, point))
  }

  private readonly handleLostPointerCapture = (event: Event): void => {
    const pointerEvent = event as PointerEvent
    if (this.gesture?.id !== pointerEvent.pointerId) return
    const point = this.pointFromEvent(pointerEvent)
    this.cancelGesture(pointerEventToPetPointer(pointerEvent, point))
  }

  private readonly handlePointerLeave = (): void => {
    this.emit({ type: 'hit', inside: false })
    if (!this.gesture) {
      this.targetGazeX = 0
      this.targetGazeY = 0
      this.wake()
    }
  }

  private readonly handleKeyDown = (event: Event): void => {
    const keyboard = event as KeyboardEvent
    if (!['ArrowLeft', 'ArrowRight', ' ', 'p', 'P', 'Escape'].includes(keyboard.key)) return
    keyboard.preventDefault()
    this.emit({ type: 'keyboard', key: keyboard.key })
    if (keyboard.key === 'ArrowLeft') this.targetX = clamp(this.targetX - 30, this.unit * 1.25, this.width - this.unit * 1.25)
    else if (keyboard.key === 'ArrowRight') this.targetX = clamp(this.targetX + 30, this.unit * 1.25, this.width - this.unit * 1.25)
    else if (keyboard.key === ' ') this.bounce()
    else if (keyboard.key.toLowerCase() === 'p') this.press()
    else this.cancelGesture()
    this.wake()
  }

  private readonly handleVisibility = (): void => {
    if (document.hidden) {
      this.cancelAnimation()
      if (this.gesture) this.cancelGesture()
    } else {
      this.wake()
    }
  }

  private readonly handleContextLost = (event: Event): void => {
    event.preventDefault()
    this.cancelAnimation()
    this.destroyGlResources()
    this.showFallback(true, '3D 桌宠画面暂时中断，正在等待图形设备恢复。')
  }

  private readonly handleContextRestored = (): void => {
    if (this.disposed) return
    this.initializeGl()
    this.wake()
  }

  private beginGesture(pointer: PetPointer, point: Point): void {
    window.clearTimeout(this.pressTimer)
    this.gesture = {
      id: pointer.pointerId,
      start: point,
      offsetX: point.x - this.x,
      offsetY: point.y - (this.groundY - this.z - this.unit * 0.81 * this.squash),
      dragging: false,
      previousStatus: this.state.snapshot.status,
      previousMeta: this.state.snapshot.message
        ? { message: this.state.snapshot.message }
        : {},
    }
    this.setStatus('receiving')
    this.targetSquash = 0.88
    this.pressTimer = window.setTimeout(() => {
      this.pressTimer = 0
      const gesture = this.gesture
      if (!this.disposed && gesture && !gesture.dragging) {
        this.targetSquash = 0.72
        this.emit({ type: 'longpress', pointer })
        this.wake()
      }
    }, this.reducedMotion ? 260 : 220)
    this.wake()
  }

  private moveGesture(pointer: PetPointer, point: Point): void {
    const gesture = this.gesture
    if (!gesture || gesture.id !== pointer.pointerId) return
    if (!gesture.dragging && Math.hypot(point.x - gesture.start.x, point.y - gesture.start.y) > 6) {
      gesture.dragging = true
      window.clearTimeout(this.pressTimer)
      this.pressTimer = 0
      this.targetSquash = 1.04
      this.emit({ type: 'dragstart', pointer })
    }
    if (gesture.dragging) {
      this.targetX = clamp(point.x - gesture.offsetX, this.unit * 1.25, this.width - this.unit * 1.25)
      this.targetZ = clamp(this.groundY - (point.y - gesture.offsetY) - this.unit * 0.81, 0, Math.max(0, this.groundY - this.unit * 1.85))
      this.targetLean = clamp(-this.velocityX / 550, -0.35, 0.35)
      this.emit({ type: 'dragmove', pointer })
    }
    this.wake()
  }

  private finishGesture(pointer: PetPointer, emit: boolean): void {
    const gesture = this.gesture
    if (!gesture || gesture.id !== pointer.pointerId) return
    const dragged = gesture.dragging
    if (emit) this.emit({ type: 'pointerup', pointer, dragged })
    this.releaseGesture()
    this.targetSquash = 1
    this.targetZ = 0
    this.targetLean = 0
    if (dragged) this.bounce(0.35, false)
    this.restoreGestureStatus(gesture.previousStatus, gesture.previousMeta)
    this.wake()
  }

  private cancelGesture(pointer?: PetPointer): void {
    const gesture = this.gesture
    if (!gesture) return
    if (pointer) this.emit({ type: 'pointercancel', pointer })
    const previous = gesture.previousStatus
    this.releaseGesture()
    this.targetSquash = 1
    this.targetZ = 0
    this.targetLean = 0
    this.restoreGestureStatus(previous, gesture.previousMeta)
    this.wake()
  }

  private releaseGesture(): void {
    const gesture = this.gesture
    if (!gesture) return
    window.clearTimeout(this.pressTimer)
    this.pressTimer = 0
    // Clear the gesture before releasing capture. Browsers may synchronously
    // dispatch lostpointercapture, which must not re-enter this cleanup path.
    this.gesture = null
    try {
      if (this.canvas.hasPointerCapture(gesture.id)) this.canvas.releasePointerCapture(gesture.id)
    } catch {
      // The pointer may already have been released by the browser.
    }
    this.canvas.style.cursor = 'grab'
  }

  private restoreGestureStatus(previous: PetStatus, meta: PetStatusMeta): void {
    if (this.state.snapshot.status === 'receiving') this.setStatus(previous, meta)
  }

  private press(): void {
    this.targetSquash = 0.70
    this.scheduleReceivingReset(this.reducedMotion ? 120 : 420)
    this.wake()
  }

  private bounce(scale = 1, restoreStatus = true): void {
    if (this.reducedMotion) return
    this.velocityZ = Math.max(this.velocityZ, 180 * scale)
    if (restoreStatus) this.scheduleReceivingReset(420)
    else this.setStatus('receiving')
    this.wake()
  }

  private scheduleReceivingReset(duration: number): void {
    if (this.actionPreviousStatus === null) {
      this.actionPreviousStatus = this.state.snapshot.status
      this.actionPreviousMeta = this.state.snapshot.message
        ? { message: this.state.snapshot.message }
        : {}
    }
    this.setStatus('receiving')
    window.clearTimeout(this.actionTimer)
    this.actionTimer = window.setTimeout(() => {
      this.actionTimer = 0
      const previous = this.actionPreviousStatus
      const previousMeta = this.actionPreviousMeta
      this.actionPreviousStatus = null
      this.actionPreviousMeta = {}
      if (this.disposed) return
      this.targetSquash = 1
      if (previous && this.state.snapshot.status === 'receiving') {
        this.setStatus(previous, previousMeta)
      }
      this.wake()
    }, duration)
  }

  private scheduleBlink(): void {
    if (this.disposed) return
    window.clearTimeout(this.blinkTimer)
    if (this.reducedMotion) return
    const focusDelay = this.state.snapshot.status === 'focus' ? 9000 : 4800
    const delay = focusDelay + Math.random() * 4400
    this.blinkTimer = window.setTimeout(() => {
      this.blinkTimer = 0
      if (!this.disposed && !document.hidden && !this.gesture && !this.reducedMotion) {
        this.blinkStartedAt = this.now()
        this.wake()
      }
      this.scheduleBlink()
    }, delay)
  }

  private wake(): void {
    if (this.disposed || !this.gl || this.raf || document.hidden) return
    this.lastFrame = this.now()
    this.raf = window.requestAnimationFrame(this.frame)
  }

  private cancelAnimation(): void {
    if (this.raf) window.cancelAnimationFrame(this.raf)
    this.raf = 0
  }

  private readonly frame = (time: number): void => {
    this.raf = 0
    if (this.disposed || !this.gl || !this.program || !this.uniforms || !this.buffer || document.hidden) return
    const dt = Math.min(Math.max((time - this.lastFrame) / 1000, 0), 0.025)
    this.lastFrame = time
    const status = this.state.snapshot.status
    const slowAmbient = !this.reducedMotion && !this.gesture && (status === 'idle' || status === 'focus')
    if (slowAmbient && time - this.lastDrawAt < 1000 / 30) {
      this.raf = window.requestAnimationFrame(this.frame)
      return
    }
    const idleAmplitude = this.reducedMotion ? 0 : status === 'focus' ? 0.006 : status === 'idle' ? 0.014 : 0.004
    const breathing = Math.sin(time / (status === 'focus' ? 1450 : 1050)) * idleAmplitude
    const squashTarget = this.gesture ? this.targetSquash : this.targetSquash + breathing
    ;[this.x, this.velocityX] = spring(this.x, this.velocityX, this.targetX, 170, 22, dt)
    ;[this.z, this.velocityZ] = spring(this.z, this.velocityZ, this.targetZ, 180, 24, dt)
    ;[this.squash, this.velocitySquash] = spring(this.squash, this.velocitySquash, squashTarget, 170, 18, dt)
    ;[this.lean, this.velocityLean] = spring(this.lean, this.velocityLean, this.targetLean, 130, 17, dt)
    ;[this.yaw, this.velocityYaw] = spring(this.yaw, this.velocityYaw, this.targetYaw, 60, 16, dt)
    if (!this.gesture && this.z > 0) {
      this.velocityZ -= 900 * dt
      if (this.z <= 0) {
        this.z = 0
        this.velocityZ = 0
      }
    }
    this.gazeX += (this.targetGazeX - this.gazeX) * Math.min(1, dt * 6)
    this.gazeY += (this.targetGazeY - this.gazeY) * Math.min(1, dt * 6)
    const eyeStyle = EYE_STYLE[status]
    const blink = this.blinkValue(time)
    this.draw(blink, eyeStyle, STATUS_COLOR[status])
    this.lastDrawAt = time
    const moving =
      Math.abs(this.x - this.targetX) > 0.03 ||
      Math.abs(this.velocityX) > 0.05 ||
      this.z > 0.02 ||
      Math.abs(this.velocityZ) > 0.05 ||
      Math.abs(this.squash - squashTarget) > 0.0003 ||
      Math.abs(this.velocitySquash) > 0.001 ||
      Math.abs(this.lean - this.targetLean) > 0.0005 ||
      Math.abs(this.velocityLean) > 0.001 ||
      Math.abs(this.yaw - this.targetYaw) > 0.001 ||
      Math.abs(this.velocityYaw) > 0.001 ||
      Math.abs(this.gazeX - this.targetGazeX) + Math.abs(this.gazeY - this.targetGazeY) > 0.0002 ||
      this.blinkStartedAt > 0 ||
      Boolean(this.gesture) ||
      (!this.reducedMotion && (status === 'idle' || status === 'focus'))
    if (this.blinkStartedAt && time - this.blinkStartedAt > 260) this.blinkStartedAt = 0
    if (moving) this.raf = window.requestAnimationFrame(this.frame)
  }

  private blinkValue(time: number): number {
    if (!this.blinkStartedAt || this.reducedMotion) return 1
    const progress = clamp((time - this.blinkStartedAt) / 220, 0, 1)
    return 1 - 0.96 * Math.sin(Math.PI * progress)
  }

  private draw(blink: number, eyeStyle: EyeStyle, statusColor: readonly [number, number, number]): void {
    const gl = this.gl
    const uniforms = this.uniforms
    if (!gl || !this.program || !uniforms) return
    const pixelWidth = this.canvas.width
    const pixelHeight = this.canvas.height
    const centerY = this.groundY - this.z - this.unit * 0.81 * this.squash
    gl.useProgram(this.program)
    gl.clearColor(0, 0, 0, 0)
    gl.disable(gl.SCISSOR_TEST)
    gl.clear(gl.COLOR_BUFFER_BIT)
    const left = Math.max(0, Math.floor((this.x - this.unit * 2.3) * this.dpr))
    const right = Math.min(pixelWidth, Math.ceil((this.x + this.unit * 2.3) * this.dpr))
    const top = Math.max(0, Math.floor((centerY - this.unit * 1.8) * this.dpr))
    const bottom = Math.min(pixelHeight, Math.ceil((this.groundY + this.unit * 0.55) * this.dpr))
    gl.enable(gl.SCISSOR_TEST)
    gl.scissor(left, pixelHeight - bottom, Math.max(1, right - left), Math.max(1, bottom - top))
    gl.uniform2f(uniforms.resolution, pixelWidth, pixelHeight)
    gl.uniform2f(uniforms.center, this.x * this.dpr, centerY * this.dpr)
    gl.uniform2f(uniforms.ground, this.x * this.dpr, this.groundY * this.dpr)
    gl.uniform1f(uniforms.unit, this.unit * this.dpr)
    gl.uniform1f(uniforms.squash, clamp(this.squash, 0.55, 1.35))
    gl.uniform1f(uniforms.lean, this.lean)
    gl.uniform1f(uniforms.yaw, this.yaw)
    gl.uniform1f(uniforms.blink, blink)
    gl.uniform2f(uniforms.gaze, this.gazeX, this.gazeY)
    gl.uniform3fv(uniforms.bodyColor, new Float32Array(PALETTE[this.color]))
    gl.uniform3fv(uniforms.statusColor, new Float32Array(statusColor))
    gl.uniform1f(uniforms.elevation, this.z / Math.max(this.unit, 1))
    gl.uniform4fv(uniforms.eyeStyle, new Float32Array(eyeStyle))
    gl.drawArrays(gl.TRIANGLES, 0, 6)
    gl.disable(gl.SCISSOR_TEST)
  }

  private pointFromEvent(event: PointerEvent): Point {
    const rect = this.canvas.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  private pointerFromEvent(event: PointerEvent, point = this.pointFromEvent(event)): PetPointer {
    return { pointerId: event.pointerId, x: point.x, y: point.y }
  }

  private emit(event: PetInteraction): void {
    this.onInteraction?.(event)
  }

  private addListener<T extends EventTarget>(target: T, type: string, listener: EventListener): void {
    target.addEventListener(type, listener)
    this.listeners.push(() => target.removeEventListener(type, listener))
  }

  private showFallback(visible: boolean, message = PET_STATUS_LABELS[this.state.snapshot.status]): void {
    if (!this.fallback) return
    this.fallback.hidden = !visible
    if (visible) this.fallback.textContent = message
    this.canvas.toggleAttribute('data-fallback', visible)
  }

  private readReducedMotion(): boolean {
    return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  }
}

function pointerEventToPetPointer(event: PointerEvent, point: Point): PetPointer {
  return { pointerId: event.pointerId, x: point.x, y: point.y }
}

export function createPetRenderer(options: PetRendererOptions): WebGLPetRenderer {
  const renderer = new WebGLPetRenderer(options)
  renderer.mount()
  return renderer
}
