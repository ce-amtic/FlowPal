import { useEffect, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../api.ts'

/**
 * 主窗口里的记录口。四个采集入口里归主窗口的那一个，另外三个（全局快捷键、
 * 桌宠拖拽、截图）在桌面侧。
 *
 * 它住在「此刻」，因为跟它说话和听它说话是同一件事，劈成两页读起来就是两个对象。
 * 排在卡片下面而不是上面：产品先说话这条，靠的就是这个顺序——输入框在最上面，
 * 这一页就变成了「请提问」。
 *
 * 有内容时钉在窗口底部，正文在它上方滚动，所以这一页的任何位置记一条都是零点击；
 * 库里没有可推的东西时它留在流里，跟在问候语下面——底下挂个框、上面一片空，
 * 看起来像坏了。
 *
 * 它只管把东西送出去。送出去之后发生了什么在这一页末尾的记录里，不在这个框上——
 * 一段带好几行的答案挤在钉底的框里会长上来盖住正文。
 */
/** 这个框接得住的三样东西。文字与图片走的是同一条管道，只是原文的形态不同 */
type Recording =
  | { kind: 'text'; text: string }
  | { kind: 'pastedImage'; file: File }
  | { kind: 'droppedImage'; path: string }

export function Composer({
  autoFocus, floating, onHeight, placeholder = '输入或粘贴', droppedPaths, onStarted,
}: {
  autoFocus?: boolean
  floating: boolean
  /** 拖进窗口的图片路径。只有 Electron 里有——浏览器给不出磁盘路径 */
  droppedPaths?: string[]
  /** 钉住时它脱离布局，正文末尾要留出等高的空。高度量出来往上报，不写死 */
  onHeight: (px: number) => void
  /** 专注中这个框是用来接住杂念的，说法跟着变——同一个东西，两种在场理由 */
  placeholder?: string
  /** 送出去了。asked 是这一条在记录里显示成什么，runId 用来订阅它的进展 */
  onStarted?: (asked: string, runId: string) => void
}) {
  const [text, setText] = useState('')
  const queryClient = useQueryClient()
  const box = useRef<HTMLTextAreaElement>(null)
  const form = useRef<HTMLFormElement>(null)

  useEffect(() => { if (autoFocus) box.current?.focus() }, [autoFocus])

  /*
   * 跟着内容长高。
   *
   * 粘一条群通知进来常常是七八行，固定一行等于让人在一条缝里读自己刚投的东西。
   * 先归零再按 scrollHeight 量，否则删字时它只会长不会缩；上限交给 CSS 的
   * max-height，超过之后框内自己滚，这个框不会长到把正文顶掉。
   */
  useEffect(() => {
    const el = box.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [text])

  const record = useMutation({
    mutationFn: async (input: Recording) => {
      if (input.kind === 'text') {
        return api.throwIn({ source: 'paste', rawType: 'text', rawText: input.text })
      }
      // 拖进来的文件本来就在盘上，把路径给出去就行，不必再搬一份
      if (input.kind === 'droppedImage') {
        return api.throwIn({ source: 'drop', rawType: 'image', rawBlobPath: input.path })
      }
      // 粘贴的截图只有字节没有路径，先让它落盘
      const { path } = await api.uploadImage(input.file.type, await toBase64(input.file))
      return api.throwIn({ source: 'paste', rawType: 'image', rawBlobPath: path })
    },
    onSuccess: (data, input) => {
      setText('')
      queryClient.invalidateQueries()
      onStarted?.(input.kind === 'text' ? input.text : '一张图片', data.run.id)
    },
  })

  /*
   * 从「此刻」拖进来的文件。判重靠路径：这个 prop 每次渲染都是同一个数组引用，
   * 但换一页再回来会重新触发，不记下来就会把同一张图记两遍。
   */
  const dropped = useRef(new Set<string>())
  useEffect(() => {
    for (const path of droppedPaths ?? []) {
      if (dropped.current.has(path)) continue
      dropped.current.add(path)
      record.mutate({ kind: 'droppedImage', path })
    }
    // record 每次渲染都是新对象，放进依赖会把这个 effect 变成每帧都跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [droppedPaths])

  useEffect(() => {
    const el = form.current
    if (!el) throw new Error('记录框没挂上，量不到高度')
    if (!floating) { onHeight(0); return }
    const observer = new ResizeObserver(() => onHeight(el.offsetHeight))
    observer.observe(el)
    return () => observer.disconnect()
  }, [floating, onHeight])

  const submit = () => {
    const trimmed = text.trim()
    if (trimmed.length > 0 && !record.isPending) record.mutate({ kind: 'text', text: trimmed })
  }

  /*
   * 粘贴一张截图。这是这条产品线上最短的一个动作：截完图直接 Cmd+V，
   * 不用先存成文件再拖进来。
   *
   * 剪贴板里同时有图和文字时（很多截图工具会附带一段说明）以图为准——
   * 那段文字通常是文件名之类的噪音。
   */
  const paste = (e: React.ClipboardEvent) => {
    const image = Array.from(e.clipboardData.files).find((f) => f.type.startsWith('image/'))
    if (!image || record.isPending) return
    e.preventDefault()
    record.mutate({ kind: 'pastedImage', file: image })
  }

  return (
    <form
      ref={form}
      className={floating ? 'composer composer-floating' : 'composer'}
      onSubmit={(e) => { e.preventDefault(); submit() }}
    >
      <textarea
        ref={box}
        className="composer-box"
        rows={1}
        value={text}
        placeholder={placeholder}
        onPaste={paste}
        onChange={(e) => {
          setText(e.target.value)
        }}
        onKeyDown={(e) => {
          // 回车就记。换行要按 Shift——这个框是用来接住东西的，不是用来写作的
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() }
        }}
      />

      <div className="composer-foot">
        <button
          className="primary composer-send"
          disabled={text.trim().length === 0 || record.isPending}
        >
          记录
        </button>
      </div>
    </form>
  )
}

/**
 * 图片字节转 base64。分段拼而不是一次 apply：一张截图有几百万字节，
 * 整个铺开当参数传会把调用栈撑爆。
 */
async function toBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const CHUNK = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}
