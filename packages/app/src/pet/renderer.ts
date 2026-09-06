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

export type PetSize = 96 | 128 | 224

/** The expression presets from quiet-pebble.html. */
export type PetExpression =
  | 'calm'
  | 'happy'
  | 'sleepy'
  | 'curious'
  | 'surprised'
  | 'focus'

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
  | { type: 'doubleclick'; pointer: PetPointer }
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
  /** Re-measure a host that may have transitioned from hidden to visible. */
  refresh(): void
  setStatus(status: PetStatus, meta?: PetStatusMeta): void
  setTheme(theme: { color?: PetColor; size?: PetSize; softness?: number; reducedMotion?: boolean }): void
  setColor(color: PetColor): void
  setSize(size: PetSize): void
  setExpression(expression: PetExpression, durationMs?: number): void
  press(amount?: number): void
  tap(): void
  setNativeWindowDrag(enabled: boolean): void
  hop(): void
  turn(angle: number): void
  focus(value?: boolean): void
  reset(): void
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

const EXPRESSION_LABELS: Record<PetExpression, string> = {
  calm: '待在这里',
  happy: '有一点开心',
  sleepy: '有一点困了',
  curious: '让我想想',
  surprised: '诶？',
  focus: '安静地专注',
}

// The four values are opening, curved-closed-eye mix, per-eye asymmetry and
// tilt. These are intentionally the same presets as quiet-pebble.html.
const EXPRESSION_STYLE: Record<PetExpression, EyeStyle> = {
  calm: [1.0, 0.0, 0.0, 0.0],
  happy: [0.7, 1.0, 0.0, 0.0],
  sleepy: [0.24, 0.0, 0.0, 0.0],
  curious: [0.90, 0.0, 0.32, 0.1],
  surprised: [1.3, 0.0, 0.0, 0.0],
  // Focus keeps the idle capsule silhouette, but lowers its opening and adds
  // only a slight inward tilt.  It should read as attentive, not cheerful or
  // sleepy.
  focus: [0.88, 0.0, 0.04, -0.08],
}

const STATUS_EXPRESSION: Record<PetStatus, PetExpression> = {
  idle: 'calm',
  receiving: 'happy',
  processing: 'focus',
  done: 'happy',
  error: 'surprised',
  focus: 'focus',
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
  eyeLength: WebGLUniformLocation | null
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

// Keep a normal click comfortably below the long-press threshold. The earlier
// 220ms threshold was easy to cross while a transparent resident window was
// settling focus, which made an intended single click open the main window.
const LONG_PRESS_MS = 800

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
 * A renderer-only WebGL pet. It intentionally knows nothing about Electron,
 * HTTP, SQLite, or the main window. The shell only forwards the interaction
 * events from this class; all visual presets and physical motion stay here so
 * the inline and resident presentations cannot drift apart.
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
  private releaseTimer = 0
  private expressionTimer = 0
  private tapTimer = 0
  private nativeWindowDrag = false
  private grabbedPose = false
  private actionTimer = 0
  private longPressActive = false
  private actionPreviousStatus: PetStatus | null = null
  private actionPreviousMeta: PetStatusMeta = {}
  private blinkStartedAt = 0
  private blinkDepth = 0.96
  private lastFrame = 0
  private disposed = false
  private mounted = false
  private reducedMotion: boolean
  private size: PetSize
  private color: PetColor = 'chalk'
  /** Softness is the same 0..1 material parameter used by quiet-pebble. */
  private softness = 0.65
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
  // Keep the native transparent-window hit-test stable. Emitting `hit` on
  // every pointermove repeatedly calls setIgnoreMouseEvents(), which can race
  // the next pointerdown/drag event on macOS and make the pet impossible to
  // pick up. Only transitions (outside -> inside or inside -> outside) need a
  // native hit-test update.
  private hitInside = false
  private statusMeta: PetStatusMeta = {}
  private expression: PetExpression = 'calm'
  private transientExpression: PetExpression | null = null
  private eyeStyle: [number, number, number, number] = [...EXPRESSION_STYLE.calm]
  private targetEyeStyle: EyeStyle = EXPRESSION_STYLE.calm

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
    // The detached resident pet keeps a single click local (press/spring).
    // Opening the main window is an explicit keyboard/input action; keeping
    // that contract in the accessibility label prevents the old click-to-open
    // behavior from being reintroduced by a shell or QA harness.
    this.canvas.setAttribute('aria-label', 'FlowPal 桌宠。单击抚摸，长按读取剪贴板，拖动可移动。')
    this.canvas.dataset.expression = this.effectiveExpression
    this.canvas.setAttribute('aria-description', EXPRESSION_LABELS[this.effectiveExpression])
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
    const previousStatus = this.state.snapshot.status
    this.statusMeta = meta
    this.state.set(status, meta)
    // Work states provide a sensible expression in the resident pet, while a
    // short interaction expression (for example the happy landing pose) is
    // allowed to finish before the status becomes the visual source of truth.
    if (previousStatus !== status) {
      // Update the base expression even while a short interaction pose is
      // playing. The transient pose will expire back to this latest server
      // state instead of an outdated receiving/idle face.
      this.expression = STATUS_EXPRESSION[status]
      this.canvas.dataset.expression = this.effectiveExpression
      this.canvas.setAttribute('aria-description', EXPRESSION_LABELS[this.effectiveExpression])
      this.updateEyeTarget()
    }
    this.scheduleBlink()
    this.wake()
  }

  setTheme(theme: { color?: PetColor; size?: PetSize; softness?: number; reducedMotion?: boolean }): void {
    if (theme.color && theme.color in PALETTE) this.color = theme.color
    if (theme.size) this.size = theme.size
    if (theme.softness !== undefined) this.softness = clamp(theme.softness, 0, 1)
    if (theme.reducedMotion !== undefined) {
      this.reducedMotion = theme.reducedMotion
      if (this.reducedMotion) window.clearTimeout(this.blinkTimer)
      else this.scheduleBlink()
    }
    this.resize()
    this.wake()
  }

  refresh(): void {
    if (this.disposed) return
    this.resize()
    this.wake()
  }

  setExpression(expression: PetExpression, durationMs = 0): void {
    if (this.disposed || !(expression in EXPRESSION_STYLE)) return
    window.clearTimeout(this.expressionTimer)
    this.expressionTimer = 0
    if (durationMs > 0) {
      this.transientExpression = expression
      this.expressionTimer = window.setTimeout(() => {
        this.expressionTimer = 0
        this.transientExpression = null
        this.canvas.dataset.expression = this.effectiveExpression
        this.canvas.setAttribute('aria-description', EXPRESSION_LABELS[this.effectiveExpression])
        this.updateEyeTarget()
        this.wake()
      }, durationMs)
    } else {
      this.expression = expression
      this.transientExpression = null
    }
    this.canvas.dataset.expression = this.effectiveExpression
    this.canvas.setAttribute('aria-description', EXPRESSION_LABELS[this.effectiveExpression])
    this.updateEyeTarget()
    this.targetGazeX = 0
    this.targetGazeY = 0
    this.wake()
  }

  setColor(color: PetColor): void {
    this.setTheme({ color })
  }

  setSize(size: PetSize): void {
    this.setTheme({ size })
  }

  press(amount = 0.65): void {
    if (this.disposed) return
    window.clearTimeout(this.releaseTimer)
    this.setExpression('happy', 950)
    this.setPoseTarget(clamp(Number(amount) || 0, 0, 1))
    this.setInteractionStatus('receiving', '轻轻压一下')
    this.releaseTimer = window.setTimeout(() => {
      this.releaseTimer = 0
      this.targetSquash = 1
      this.wake()
    }, this.reducedMotion ? 120 : 480)
    this.wake()
  }

  /** Local floating-pet tap: visual feedback only, without changing work status. */
  tap(): void {
    if (this.disposed) return
    window.clearTimeout(this.tapTimer)
    this.tapTimer = 0
    const baseExpression = this.expression
    if (this.state.snapshot.status === 'focus') {
      // A shallow acknowledgement, not a full eye closure or a temporary
      // smile. No delayed expression restoration: ending the session during
      // this blink must not restore a stale focus expression later.
      this.setExpression('focus')
      if (!this.reducedMotion) {
        this.blinkDepth = 0.35
        this.blinkStartedAt = this.now()
      }
      this.wake()
      return
    }
    this.setExpression('happy', 0)
    this.setPoseTarget(0.45)
    window.clearTimeout(this.releaseTimer)
    this.releaseTimer = window.setTimeout(() => {
      this.releaseTimer = 0
      this.targetSquash = 1
      this.wake()
    }, this.reducedMotion ? 120 : 480)
    this.tapTimer = window.setTimeout(() => {
      this.tapTimer = 0
      if (this.disposed) return
      this.setExpression(baseExpression)
      this.targetSquash = 1
      this.wake()
    }, this.reducedMotion ? 420 : 900)
    this.wake()
  }

  hop(): void {
    if (this.disposed || this.gesture) return
    this.stopPress()
    this.setExpression('happy', 1000)
    this.z = Math.max(this.z, 1)
    this.velocityZ = this.reducedMotion ? 100 : 210
    this.setInteractionStatus('receiving', '轻轻弹一下')
    this.wake()
  }

  turn(angle: number): void {
    if (this.disposed || !Number.isFinite(angle)) return
    this.targetYaw = angle
    this.setInteractionStatus('receiving', '慢慢转过来')
    this.wake()
  }

  focus(value = true): void {
    this.setExpression(value ? 'focus' : 'calm')
    this.setStatus(value ? 'focus' : 'idle')
  }

  reset(): void {
    if (this.disposed) return
    if (this.gesture) this.cancelGesture()
    window.clearTimeout(this.actionTimer)
    window.clearTimeout(this.releaseTimer)
    window.clearTimeout(this.expressionTimer)
    window.clearTimeout(this.tapTimer)
    this.actionTimer = 0
    this.releaseTimer = 0
    this.expressionTimer = 0
    this.tapTimer = 0
    this.actionPreviousStatus = null
    this.actionPreviousMeta = {}
    this.targetX = this.width * 0.5
    this.targetZ = 0
    this.z = 0
    this.velocityZ = 0
    this.targetSquash = 1
    this.targetLean = 0
    this.targetYaw = 0
    this.targetGazeX = 0
    this.targetGazeY = 0
    this.setExpression('calm')
    this.setStatus('idle', { message: '回到原位' })
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
    window.clearTimeout(this.releaseTimer)
    window.clearTimeout(this.expressionTimer)
    window.clearTimeout(this.actionTimer)
    this.blinkTimer = 0
    this.pressTimer = 0
    this.releaseTimer = 0
    this.expressionTimer = 0
    this.actionTimer = 0
    this.longPressActive = false
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
      // The pet is a small ray-marched vector-like scene. Prefer the GPU so
      // high-DPI backing buffers can preserve the contour instead of forcing
      // the resident window through a blurry low-resolution path.
      powerPreference: 'high-performance',
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
      eyeLength: get('eyeLength'),
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
    const oldWidth = this.width
    // CSS teleport animations transform the host/canvas. getBoundingClientRect
    // then reports the animated (for example 0.78x) box, which would resize
    // the WebGL backing store and leave a cropped image after the transform
    // ends. offsetWidth/offsetHeight stay at the layout A-size throughout the
    // animation; use them whenever the element is laid out.
    this.width = Math.max(1, this.canvas.offsetWidth || rect.width)
    this.height = Math.max(1, this.canvas.offsetHeight || rect.height)
    // The previous 1.5x cap was visibly soft on Retina displays, especially
    // around the eyes and the contact shadow. The renderer is procedural (no
    // bitmap texture to upscale), so a 2x backing buffer gives crisp vector-
    // like edges while keeping the 224px resident window inexpensive.
    this.dpr = Math.min(Math.max(window.devicePixelRatio || 1, 1), 2)
    const pixelWidth = Math.max(1, Math.round(this.width * this.dpr))
    const pixelHeight = Math.max(1, Math.round(this.height * this.dpr))
    if (this.canvas.width !== pixelWidth) this.canvas.width = pixelWidth
    if (this.canvas.height !== pixelHeight) this.canvas.height = pixelHeight
    this.groundY = this.height * 0.70
    this.unit = Math.max(18, Math.min(this.size, this.width * 0.65) / 2.27)
    // A hidden inline host remains mounted off-flow, but older styles or a
    // browser transition can still report a transient 0/1px box. Do not scale
    // the logical position from that sentinel size.
    if (oldWidth > 2 && this.height > 2) {
      const ratio = this.width / oldWidth
      this.x *= ratio
      this.targetX *= ratio
    } else if (oldWidth <= 2 || this.x === 0) {
      this.x = this.width * 0.5
      this.targetX = this.x
    }
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
    // A transparent Electron window may still synthesize a DOM click after a
    // pointer sequence.  There is no default action for the canvas, but
    // stopping these events prevents an embedding shell (or a stale listener
    // from a previous renderer) from treating one tap as navigation.  Tap
    // Navigation is handled by the single pointerup gesture in the host;
    // hover feedback is emitted through the hit event above.
    this.addListener(this.canvas, 'click', this.blockNativeClick)
    this.addListener(this.canvas, 'dblclick', this.handleDoubleClick)
    this.addListener(this.canvas, 'keydown', this.handleKeyDown)
    this.addListener(document, 'visibilitychange', this.handleVisibility)
    this.addListener(this.canvas, 'webglcontextlost', this.handleContextLost)
    this.addListener(this.canvas, 'webglcontextrestored', this.handleContextRestored)
  }

  private readonly blockNativeClick = (event: Event): void => {
    event.preventDefault()
    event.stopPropagation()
  }

  private readonly handleDoubleClick = (event: Event): void => {
    const pointerEvent = event as MouseEvent
    if (pointerEvent.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    const point = this.pointFromEvent(pointerEvent as PointerEvent)
    if (this.hitTest(point)) {
      this.emit({ type: 'doubleclick', pointer: { x: point.x, y: point.y, pointerId: 0 } })
    }
  }

  setNativeWindowDrag(enabled: boolean): void {
    this.nativeWindowDrag = enabled
    if (enabled) {
      this.targetX = this.width * 0.5
      this.targetZ = 0
    }
    this.wake()
  }

  private readonly handlePointerDown = (event: Event): void => {
    const pointerEvent = event as PointerEvent
    // Only primary-button presses participate in tap/double-tap gestures.
    // Secondary clicks should never navigate the main window.
    if (pointerEvent.button !== 0) return
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
    if (inside !== this.hitInside) {
      this.hitInside = inside
      this.emit({ type: 'hit', inside })
    }
    if (!this.gesture) {
      // The resident pet has a lively, wide gaze.  Focus mode deliberately
      // keeps the same compact tracking envelope as the original design so
      // the eyes remain calm while the main window is active.
      const focused = this.effectiveExpression === 'focus'
      // Ambient/idle mode should visibly notice the cursor across the whole
      // pet rather than only when it is already near the eyes. Focus mode
      // keeps its deliberately small envelope so the gaze stays settled.
      const horizontalRange = focused ? 0.022 : 0.28
      const verticalRange = focused ? 0.014 : 0.16
      const horizontalGain = focused ? 0.07 : 1.05
      const verticalGain = focused ? 0.04 : 0.62
      this.targetGazeX = clamp(
        (point.x - this.x) / Math.max(this.width, 1) * horizontalGain,
        -horizontalRange,
        horizontalRange,
      )
      this.targetGazeY = clamp(
        (this.groundY - this.unit * 0.81 - point.y) / Math.max(this.height, 1) * verticalGain,
        -verticalRange,
        verticalRange,
      )
      this.wake()
    }
  }

  private readonly handlePointerUp = (event: Event): void => {
    const pointerEvent = event as PointerEvent
    if (this.gesture?.id !== pointerEvent.pointerId) return
    const point = this.pointFromEvent(pointerEvent)
    const gesture = this.gesture
    const pointer = pointerEventToPetPointer(pointerEvent, point)
    this.finishGesture(pointer, true)
    this.longPressActive = false
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
    // Treat lost capture as a normal release. This keeps the drop/bounce when
    // a pointer crosses a transparent Electron window edge.
    this.finishGesture(pointerEventToPetPointer(pointerEvent, point), true)
  }

  private readonly handlePointerLeave = (): void => {
    // Once a drag has started, pointer capture may still deliver movement
    // outside the mascot/window bounds. Do not report `inside=false` here:
    // that would re-enable transparent click-through in the main process and
    // cut off the rest of the drag session.
    if (this.gesture) return
    if (this.hitInside) {
      this.hitInside = false
      this.emit({ type: 'hit', inside: false })
    }
    this.targetGazeX = 0
    this.targetGazeY = 0
    this.wake()
  }

  private readonly handleKeyDown = (event: Event): void => {
    const keyboard = event as KeyboardEvent
    if (!['ArrowLeft', 'ArrowRight', ' ', 'p', 'P', 'Escape', '1', '2', '3', '4', '5', '6'].includes(keyboard.key)) return
    keyboard.preventDefault()
    this.emit({ type: 'keyboard', key: keyboard.key })
    const presetByKey: Record<string, PetExpression> = {
      '1': 'calm',
      '2': 'happy',
      '3': 'sleepy',
      '4': 'curious',
      '5': 'surprised',
      '6': 'focus',
    }
    const preset = presetByKey[keyboard.key]
    if (preset) {
      this.setExpression(preset)
    } else if (keyboard.key === 'ArrowLeft') {
      this.targetX = clamp(this.targetX - 30, this.unit * 1.25, this.width - this.unit * 1.25)
      this.setExpression('curious', 700)
    } else if (keyboard.key === 'ArrowRight') {
      this.targetX = clamp(this.targetX + 30, this.unit * 1.25, this.width - this.unit * 1.25)
      this.setExpression('curious', 700)
    } else if (keyboard.key === ' ') this.hop()
    else if (keyboard.key.toLowerCase() === 'p') this.press()
    else this.reset()
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
    this.longPressActive = false
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
    // Touching a focused pet is visual feedback, not a new collection task.
    // Keep the focus expression and work state through pointerdown/up.
    if (this.state.snapshot.status !== 'focus') this.setStatus('receiving')
    this.targetSquash = 0.88
    this.pressTimer = window.setTimeout(() => {
      this.pressTimer = 0
      const gesture = this.gesture
      if (!this.disposed && gesture && !gesture.dragging) {
        this.longPressActive = true
        this.targetSquash = 0.72
        this.setExpression('happy', 1200)
        this.setInteractionStatus('receiving', '轻轻抱住')
        this.emit({ type: 'longpress', pointer })
        this.wake()
      }
    }, LONG_PRESS_MS)
    this.wake()
  }

  private moveGesture(pointer: PetPointer, point: Point): void {
    const gesture = this.gesture
    if (!gesture || gesture.id !== pointer.pointerId) return
    if (!gesture.dragging && Math.hypot(point.x - gesture.start.x, point.y - gesture.start.y) > 6) {
      gesture.dragging = true
      window.clearTimeout(this.pressTimer)
      this.pressTimer = 0
      // A grabbed pet should look held, not enlarged: compress the body and
      // switch to the surprised face before native window dragging begins.
      this.targetSquash = 0.82
      this.setExpression('surprised', 1100)
      this.setInteractionStatus('receiving', '抱起来了')
      this.emit({ type: 'dragstart', pointer })
    }
    if (gesture.dragging) {
      // Keep the held/compressed pose while the native window follows the
      // pointer. The pet remains centered in the window, but its material
      // still communicates that it is being grabbed.
      this.targetSquash = 0.82
      this.grabbedPose = true
      if (!this.nativeWindowDrag) {
        this.targetX = clamp(point.x - gesture.offsetX, this.unit * 1.25, this.width - this.unit * 1.25)
        this.targetZ = clamp(this.groundY - (point.y - gesture.offsetY) - this.unit * 0.81, 0, Math.max(0, this.groundY - this.unit * 1.85))
      }
      this.emit({ type: 'dragmove', pointer })
    }
    this.wake()
  }

  private finishGesture(pointer: PetPointer, emit: boolean): void {
    const gesture = this.gesture
    if (!gesture || gesture.id !== pointer.pointerId) return
    const dragged = gesture.dragging
    // Clear the local gesture before notifying the Electron bridge. The bridge
    // ends the native window drag synchronously; leaving this set until after
    // emit would re-enter finishGesture and run the landing animation twice.
    this.releaseGesture()
    this.grabbedPose = false
    this.targetSquash = 1
    this.targetZ = 0
    this.targetLean = 0
    if (dragged) {
      // Once released, stop actively following the pointer and let gravity
      // carry the pet down. The impact is converted into squash velocity in
      // the next frame, just like quiet-pebble's physical drop.
      this.velocityZ = Math.min(this.velocityZ, 80)
      this.setExpression('happy', 900)
      this.setInteractionStatus('receiving', '轻轻放下')
    } else if (gesture.previousStatus !== 'focus') {
      this.press(0.45)
    }
    this.restoreGestureStatus(gesture.previousStatus, gesture.previousMeta)
    if (emit) this.emit({ type: 'pointerup', pointer, dragged })
    this.longPressActive = false
    this.wake()
  }

  private cancelGesture(pointer?: PetPointer): void {
    const gesture = this.gesture
    if (!gesture) return
    const previous = gesture.previousStatus
    this.releaseGesture()
    this.grabbedPose = false
    this.targetSquash = 1
    this.targetZ = 0
    this.targetLean = 0
    this.velocityZ = Math.min(this.velocityZ, 80)
    this.restoreGestureStatus(previous, gesture.previousMeta)
    this.longPressActive = false
    if (pointer) this.emit({ type: 'pointercancel', pointer })
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

  private setPoseTarget(amount: number): void {
    this.targetSquash = clamp(1 - amount * (0.14 + 0.24 * this.softness), 0.60, 1.3)
  }

  private stopPress(): void {
    window.clearTimeout(this.pressTimer)
    window.clearTimeout(this.releaseTimer)
    this.pressTimer = 0
    this.releaseTimer = 0
    this.targetSquash = 1
    this.wake()
  }

  private setInteractionStatus(status: PetStatus, message: string): void {
    this.scheduleReceivingReset(420, status, message)
  }

  private scheduleReceivingReset(
    duration: number,
    status: PetStatus = 'receiving',
    message?: string,
  ): void {
    if (this.actionPreviousStatus === null) {
      this.actionPreviousStatus = this.state.snapshot.status
      this.actionPreviousMeta = this.state.snapshot.message
        ? { message: this.state.snapshot.message }
        : {}
    }
    this.setStatus(status, message ? { message } : {})
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

  private get effectiveExpression(): PetExpression {
    return this.transientExpression ?? this.expression
  }

  private updateEyeTarget(): void {
    this.targetEyeStyle = EXPRESSION_STYLE[this.effectiveExpression]
  }

  private scheduleBlink(): void {
    if (this.disposed) return
    window.clearTimeout(this.blinkTimer)
    if (this.reducedMotion) return
    const focusDelay = this.effectiveExpression === 'focus' ? 15000 : 4800
    const delay = focusDelay + Math.random() * (this.effectiveExpression === 'focus' ? 5000 : 4400)
    this.blinkTimer = window.setTimeout(() => {
      this.blinkTimer = 0
      if (!this.disposed && !document.hidden && !this.gesture && !this.reducedMotion) {
        this.blinkDepth = 0.96
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
    let squashTarget = this.targetSquash
    ;[this.x, this.velocityX] = spring(this.x, this.velocityX, this.targetX, 170, 22, dt)
    if (this.gesture?.dragging) {
      ;[this.z, this.velocityZ] = spring(this.z, this.velocityZ, this.targetZ, 180, 24, dt)
      this.targetSquash = this.grabbedPose ? 0.82 : 1 + this.softness * 0.08
      this.targetLean = clamp(-this.velocityX / 550, -0.35, 0.35)
    } else {
      if (this.effectiveExpression === 'focus' && !this.reducedMotion) {
        // A quiet working rhythm keeps the focused pet alive without making
        // it look like it is idling or celebrating. The body alternates
        // between slightly wider/flatter and slightly taller/narrower; the
        // amplitude remains visible at the 128px inline size without becoming
        // a distraction during focused work.
        const workPulse = Math.sin(time * 0.0017)
        this.targetSquash = 1 + workPulse * 0.05
        this.targetLean = workPulse * 0.012
        squashTarget = this.targetSquash
      } else {
        if (!this.gesture && this.effectiveExpression !== 'focus') {
          this.targetSquash = 1
          squashTarget = this.targetSquash
        }
        this.targetLean = this.effectiveExpression === 'curious' ? 0.17 : 0
      }
      // In the free state the pet is a small physical body: release and hop
      // velocities are integrated under gravity instead of being critically
      // damped straight to the floor.
      if (this.z > 0 || this.velocityZ > 0) {
        this.velocityZ -= 900 * dt
        this.z += this.velocityZ * dt
        if (this.z <= 0) {
          const impact = Math.abs(this.velocityZ)
          this.z = 0
          this.velocityZ = 0
          this.velocitySquash -= Math.min(impact / 160, 3.4) * (0.3 + this.softness * 0.7)
          if (impact > 12) this.setInteractionStatus('receiving', '稳稳落下')
        }
      }
    }
    ;[this.squash, this.velocitySquash] = spring(
      this.squash,
      this.velocitySquash,
      squashTarget,
      170 - this.softness * 70,
      this.reducedMotion ? 30 : 16 - this.softness * 5,
      dt,
    )
    ;[this.lean, this.velocityLean] = spring(this.lean, this.velocityLean, this.targetLean, 130, 17, dt)
    ;[this.yaw, this.velocityYaw] = spring(this.yaw, this.velocityYaw, this.targetYaw, 60, 16, dt)
    this.gazeX += (this.targetGazeX - this.gazeX) * Math.min(1, dt * 6)
    this.gazeY += (this.targetGazeY - this.gazeY) * Math.min(1, dt * 6)
    const eyeTarget = this.targetEyeStyle
    const eyeLerp = Math.min(1, dt * 11)
    this.eyeStyle = [
      this.eyeStyle[0] + (eyeTarget[0] - this.eyeStyle[0]) * eyeLerp,
      this.eyeStyle[1] + (eyeTarget[1] - this.eyeStyle[1]) * eyeLerp,
      this.eyeStyle[2] + (eyeTarget[2] - this.eyeStyle[2]) * eyeLerp,
      this.eyeStyle[3] + (eyeTarget[3] - this.eyeStyle[3]) * eyeLerp,
    ]
    const blink = this.blinkValue(time)
    this.draw(blink, this.eyeStyle, STATUS_COLOR[status])
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
      this.eyeStyle.some((value, index) => {
        const target = eyeTarget[index]
        return target !== undefined && Math.abs(value - target) > 0.0005
      }) ||
      (this.effectiveExpression === 'focus' && !this.reducedMotion && !this.gesture) ||
      this.blinkStartedAt > 0 ||
      Boolean(this.gesture)
    if (this.blinkStartedAt && time - this.blinkStartedAt > 260) this.blinkStartedAt = 0
    if (moving) this.raf = window.requestAnimationFrame(this.frame)
  }

  private blinkValue(time: number): number {
    if (!this.blinkStartedAt || this.reducedMotion) return 1
    const progress = clamp((time - this.blinkStartedAt) / 220, 0, 1)
    return 1 - this.blinkDepth * Math.sin(Math.PI * progress)
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
    // All scissor coordinates are device-pixel coordinates. Keeping the
    // lower edge in CSS pixels while left/right are scaled by DPR clips the
    // returning pet to a small corner on Retina displays.
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
    // Stretch the open/non-focus eyes vertically while keeping focus mode at
    // the compact baseline height. This is a procedural scale in the shader,
    // so it cannot introduce bitmap blur or disturb the body bounds.
    // Keep the contrast obvious at the small resident size: idle/ambient eyes
    // are visibly taller, while focus remains the compact baseline.
    const eyeLength = this.effectiveExpression === 'focus'
      ? 1.25
      : this.effectiveExpression === 'calm' ? 1.85 : 1.65
    gl.uniform1f(uniforms.eyeLength, eyeLength)
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
