import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../api.ts'
import { transition } from '../../tokens/motion.ts'

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
 */
export function Composer({ autoFocus, floating, onHeight }: {
  autoFocus?: boolean
  floating: boolean
  /** 钉住时它脱离布局，正文末尾要留出等高的空。高度量出来往上报，不写死 */
  onHeight: (px: number) => void
}) {
  const [text, setText] = useState('')
  const queryClient = useQueryClient()
  const box = useRef<HTMLTextAreaElement>(null)
  const form = useRef<HTMLFormElement>(null)

  useEffect(() => { if (autoFocus) box.current?.focus() }, [autoFocus])

  useEffect(() => {
    const el = form.current
    if (!el) throw new Error('记录框没挂上，量不到高度')
    if (!floating) { onHeight(0); return }
    const observer = new ResizeObserver(() => onHeight(el.offsetHeight))
    observer.observe(el)
    return () => observer.disconnect()
  }, [floating, onHeight])

  const record = useMutation({
    mutationFn: (rawText: string) =>
      api.throwIn({ source: 'paste', rawType: 'text', rawText }),
    onSuccess: () => {
      setText('')
      queryClient.invalidateQueries()
    },
  })

  const submit = () => {
    const trimmed = text.trim()
    if (trimmed.length > 0 && !record.isPending) record.mutate(trimmed)
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
        placeholder="输入或粘贴"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // 回车就记。换行要按 Shift——这个框是用来接住东西的，不是用来写作的
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() }
        }}
      />

      <div className="composer-foot">
        {/*
          回执原地一行，不堆积。堆积就成了对话流，而这一页的正文永远是那一件事，
          不是你和它说过的话。要看抽出了什么，去「最近」。
        */}
        <AnimatePresence mode="wait" initial={false}>
          {record.isPending && (
            <motion.span
              key="pending" className="composer-note"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={transition.fast}
            >
              正在理解
            </motion.span>
          )}
          {!record.isPending && record.error && (
            <motion.span
              key="error" className="composer-note composer-failed"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={transition.fast}
            >
              {record.error instanceof Error ? record.error.message : '记录失败'}
            </motion.span>
          )}
          {/* run.message 可以为空，那就没有回执可显示——不编一句顶上 */}
          {!record.isPending && !record.error && record.data?.run.message && (
            <Receipt
              key="done"
              text={record.data.run.message}
              onGone={() => record.reset()}
            />
          )}
        </AnimatePresence>

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

/** 回执自己消失。留在屏幕上就变成了一条越积越多的记录，那是「最近」的活 */
function Receipt({ text, onGone }: { text: string; onGone: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onGone, 4000)
    return () => clearTimeout(timer)
  }, [onGone])

  return (
    <motion.span
      className="composer-note"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      transition={transition.fast}
    >
      {text}
    </motion.span>
  )
}
