import { useEffect, useRef } from 'react'
import { FRAGMENT, MOODS, VERTEX, type Mood } from './shader.ts'
import './pebble.css'

/**
 * 「隅」。主窗口里它是装饰——固定表情，不承担任何功能入口。
 *
 * 判据是可执行的：把它整块删掉，应用的每个动作仍然做得到。它只会眨眼和跟着
 * 光标看人，这两样是「在桌面上不突兀」的来源：完全不动的形象像一张贴纸。
 *
 * 表情走 prop 而不是内部状态，桌宠窗口拿去装进另一个容器时不用改内部——
 * 同一个组件，两个容器。
 */
export function Pebble({ size = 128, mood = 'calm' }: { size?: number; mood?: Mood }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const moodRef = useRef<Mood>(mood)
  moodRef.current = mood

  useEffect(() => {
    const el = canvas.current
    if (!el) throw new Error('形象的画布没挂上')

    // premultipliedAlpha 关掉，片元里就可以直接写「颜色 + 透明度」，
    // 未命中的像素只出阴影浓度，底色留给页面（以及 Electron 的窗口毛玻璃）。
    const gl = el.getContext('webgl', {
      alpha: true, premultipliedAlpha: false, antialias: true, powerPreference: 'low-power',
    })
    // 拿不到上下文就不画。形象是装饰，没有它整页照常工作，不必让它把页面拖垮
    if (!gl) return

    const program = link(gl)
    if (!program) return

    const buffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW)
    const position = gl.getAttribLocation(program, 'position')
    gl.enableVertexAttribArray(position)
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)

    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)

    const U = Object.fromEntries(
      ['resolution', 'center', 'ground', 'unit', 'blink', 'gaze', 'bodyColor', 'shadowStrength', 'eyeStyle']
        .map((name) => [name, gl.getUniformLocation(program, name)]),
    )

    const reduced = matchMedia('(prefers-reduced-motion: reduce)')
    // 颜色在绘制时从 token 读，所以主题一变必须重画一帧，否则它停在上一套配色里
    const dark = matchMedia('(prefers-color-scheme: dark)')

    let frame = 0
    let blinkAt = 0
    let blinkTimer = 0
    const gazeTo = { x: 0, y: 0 }
    const gazeAt = { x: 0, y: 0 }
    const eyes = [...MOODS[moodRef.current]] as number[]

    function draw(now: number) {
      frame = 0
      if (!gl) return

      const dpr = Math.min(devicePixelRatio || 1, 2)
      const side = Math.round(size * dpr)
      if (el!.width !== side) { el!.width = side; el!.height = side; gl.viewport(0, 0, side, side) }

      // 身体颜色与阴影浓度从 token 读，不在这里写死，深色模式跟着一起变
      const style = getComputedStyle(el!)
      const body = hexToRgb(style.getPropertyValue('--pebble').trim())
      const shadow = Number(style.getPropertyValue('--pebble-shadow')) || 0

      const unit = size / 2.5
      const groundY = size * 0.86
      const centerY = groundY - 0.81 * unit

      let blink = 1
      if (blinkAt) {
        const t = (now - blinkAt) / 1000
        if (t < 0.22) blink = 1 - 0.96 * Math.sin(Math.PI * Math.min(t / 0.22, 1))
        else blinkAt = 0
      }

      gazeAt.x += (gazeTo.x - gazeAt.x) * 0.08
      gazeAt.y += (gazeTo.y - gazeAt.y) * 0.08

      const target = MOODS[moodRef.current]
      for (let i = 0; i < 4; i++) eyes[i]! += (target[i]! - eyes[i]!) * 0.12

      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.uniform2f(U.resolution!, side, side)
      gl.uniform2f(U.center!, size * 0.5 * dpr, centerY * dpr)
      gl.uniform2f(U.ground!, size * 0.5 * dpr, groundY * dpr)
      gl.uniform1f(U.unit!, unit * dpr)
      gl.uniform1f(U.blink!, blink)
      gl.uniform2f(U.gaze!, gazeAt.x, gazeAt.y)
      gl.uniform3fv(U.bodyColor!, body)
      gl.uniform1f(U.shadowStrength!, shadow)
      gl.uniform4fv(U.eyeStyle!, eyes)
      gl.drawArrays(gl.TRIANGLES, 0, 6)

      const settling = blinkAt !== 0
        || Math.abs(gazeAt.x - gazeTo.x) + Math.abs(gazeAt.y - gazeTo.y) > 0.0004
        || eyes.some((e, i) => Math.abs(e - target[i]!) > 0.0008)
      if (settling) frame = requestAnimationFrame(draw)
    }

    /** 只在有事发生时转起来。一直空转是拿电池换一个没人看的循环 */
    function wake() {
      if (!frame && !document.hidden) frame = requestAnimationFrame(draw)
    }

    function scheduleBlink() {
      blinkTimer = window.setTimeout(() => {
        if (!document.hidden && !reduced.matches) { blinkAt = performance.now(); wake() }
        scheduleBlink()
      }, 4800 + Math.random() * 4400)
    }

    function onPointer(e: PointerEvent) {
      if (reduced.matches) return
      const box = el!.getBoundingClientRect()
      const cx = box.left + box.width / 2
      const cy = box.top + box.height * 0.55
      gazeTo.x = clamp((e.clientX - cx) / innerWidth * 0.13, -0.045, 0.045)
      gazeTo.y = clamp((cy - e.clientY) / innerHeight * 0.08, -0.028, 0.028)
      wake()
    }

    function onVisibility() {
      if (document.hidden) { cancelAnimationFrame(frame); frame = 0 } else wake()
    }

    wake()
    scheduleBlink()
    window.addEventListener('pointermove', onPointer)
    document.addEventListener('visibilitychange', onVisibility)
    reduced.addEventListener('change', wake)
    dark.addEventListener('change', wake)

    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(blinkTimer)
      window.removeEventListener('pointermove', onPointer)
      document.removeEventListener('visibilitychange', onVisibility)
      reduced.removeEventListener('change', wake)
      dark.removeEventListener('change', wake)
      // 不主动 loseContext：getContext 对同一个 canvas 返回同一个对象，
      // 主动丢掉之后再挂载拿到的就是那个已失效的上下文，着色器全部编译不过。
      // 画布随组件一起从 DOM 里走，上下文交给 GC。
    }
  }, [size])

  return (
    <canvas
      ref={canvas}
      className="pebble"
      style={{ width: size, height: size }}
      aria-hidden
    />
  )
}

function link(gl: WebGLRenderingContext): WebGLProgram | null {
  const program = gl.createProgram()
  if (!program) return null
  for (const [type, source] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, FRAGMENT]] as const) {
    const shader = gl.createShader(type)
    if (!shader) return null
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      // 编译错误是我们写错了着色器，不是运行环境的问题——要看得见
      throw new Error(`形象着色器编译失败：${gl.getShaderInfoLog(shader)}`)
    }
    gl.attachShader(program, shader)
  }
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`形象着色器链接失败：${gl.getProgramInfoLog(program)}`)
  }
  gl.useProgram(program)
  return program
}

/** token 里的 --pebble 是十六进制，着色器要 0–1 的三个分量 */
function hexToRgb(hex: string): Float32Array {
  const n = Number.parseInt(hex.replace('#', ''), 16)
  if (!Number.isFinite(n)) throw new Error(`--pebble 不是十六进制颜色：${hex}`)
  return new Float32Array([(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255])
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))
