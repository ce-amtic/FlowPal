import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query'
import { api } from '../../api.ts'
import { transition } from '../../tokens/motion.ts'

type RecordMutation = UseMutationResult<Awaited<ReturnType<typeof api.throwIn>>, Error, string>

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
export function Composer({
  autoFocus, floating, onHeight, placeholder = '输入或粘贴', linkItems = true,
}: {
  autoFocus?: boolean
  floating: boolean
  /** 钉住时它脱离布局，正文末尾要留出等高的空。高度量出来往上报，不写死 */
  onHeight: (px: number) => void
  /** 专注中这个框是用来接住杂念的，说法跟着变——同一个东西，两种在场理由 */
  placeholder?: string
  /** 专注中关掉：点进去就离开了这一段，而这一段还没记上。这正是这个模式要挡的事 */
  linkItems?: boolean
}) {
  const [text, setText] = useState('')
  const queryClient = useQueryClient()
  const box = useRef<HTMLTextAreaElement>(null)
  const form = useRef<HTMLFormElement>(null)

  useEffect(() => { if (autoFocus) box.current?.focus() }, [autoFocus])

  const record = useMutation({
    mutationFn: (rawText: string) =>
      api.throwIn({ source: 'paste', rawType: 'text', rawText }),
    onSuccess: () => {
      setText('')
      queryClient.invalidateQueries()
    },
  })

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
    if (trimmed.length > 0 && !record.isPending) record.mutate(trimmed)
  }

  return (
    <form
      ref={form}
      className={floating ? 'composer composer-floating' : 'composer'}
      onSubmit={(e) => { e.preventDefault(); submit() }}
    >
      <AnimatePresence initial={false}>
        {(record.isPending || record.data || record.error) && (
          <motion.div
            className="receipt"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={transition.base}
          >
            <Receipt record={record} linkItems={linkItems} />
          </motion.div>
        )}
      </AnimatePresence>

      <textarea
        ref={box}
        className="composer-box"
        rows={1}
        value={text}
        placeholder={placeholder}
        onChange={(e) => {
          setText(e.target.value)
          // 开始写下一条，上一条的回执就该让位。它不堆积，屏幕上永远只有最新那一条
          if (record.data || record.error) record.reset()
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
 * 回执。它不再是一行几秒后消失的小字——那等于没有反馈：抽出来的条目散进日程与
 * 项目，人在这一页上什么都看不到，投进去就像没了。
 *
 * 所以这里播的是「变成了什么」：那句回执，加上抽出的条目本身，点得开。
 * 它只显示最近一次，写下一条时让位，所以这里不会长成一条对话流。
 */
function Receipt({ record, linkItems }: { record: RecordMutation; linkItems: boolean }) {
  if (record.isPending) {
    return (
      <p className="receipt-line receipt-working">
        正在理解<Dots />
      </p>
    )
  }

  if (record.error) {
    return (
      <p className="receipt-line receipt-failed">
        {record.error instanceof Error ? record.error.message : '记录失败'}
      </p>
    )
  }

  if (!record.data) return null
  const { run, items } = record.data

  return (
    <>
      {/* 四种收场各有各的说法，都由服务端给——同一件事在这里和「最近」上必须同一句 */}
      {run.message && <p className="receipt-line">{run.message}</p>}
      {items.length > 0 && (
        <ul className="receipt-items">
          {items.map((item) => (
            <li key={item.id}>
              {linkItems ? <Link to={`/items/${item.id}`}>{item.title}</Link> : item.title}
              {item.status === 'needs_confirm' && <span className="receipt-tag">待确认</span>}
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

/** 三个点。等待要几秒，一行不动的字看起来像卡住了 */
function Dots() {
  return (
    <span className="dots" aria-hidden>
      <i /><i /><i />
    </span>
  )
}
