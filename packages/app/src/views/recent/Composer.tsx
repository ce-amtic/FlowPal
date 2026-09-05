import { useEffect, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../api.ts'

/**
 * 主窗口里的投放口。四个采集入口里归主窗口的那一个，另外三个（全局快捷键、
 * 桌宠拖拽、截图）在桌面侧。
 *
 * 它落在「最近」页顶上，因为这一页本来就是「每次投放去了哪」的账：打完字回车，
 * 结果就出现在正下方第一条。放浮层里要多一次开合，而投放必须比记下来更省事，
 * 否则用户就不投了。
 *
 * 提交后不清空、不跳页——回执自己会出现在下面。清空要等用户确认它接住了。
 */
export function Composer({ autoFocus }: { autoFocus?: boolean }) {
  const [text, setText] = useState('')
  const queryClient = useQueryClient()
  const box = useRef<HTMLTextAreaElement>(null)

  useEffect(() => { if (autoFocus) box.current?.focus() }, [autoFocus])

  const throwIn = useMutation({
    mutationFn: (rawText: string) =>
      api.throwIn({ source: 'paste', rawType: 'text', rawText }),
    onSuccess: () => {
      setText('')
      queryClient.invalidateQueries()
    },
  })

  const submit = () => {
    const trimmed = text.trim()
    if (trimmed.length > 0 && !throwIn.isPending) throwIn.mutate(trimmed)
  }

  return (
    <form
      className="composer"
      onSubmit={(e) => { e.preventDefault(); submit() }}
    >
      <textarea
        ref={box}
        className="composer-box"
        rows={2}
        value={text}
        placeholder="输入或粘贴"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // 回车就投。换行要按 Shift——投放是这个框的主用途，不是写作
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() }
        }}
      />

      <div className="composer-foot">
        {/*
          正在理解的时候要说话。这一步会调模型，可能几秒钟；不说话的话，
          用户以为回车没生效，于是再按一次。
        */}
        {throwIn.isPending && <span className="composer-note">正在理解</span>}
        {throwIn.error && (
          <span className="composer-note composer-failed">
            {throwIn.error instanceof Error ? throwIn.error.message : '记录失败'}
          </span>
        )}
        <button className="primary composer-send" disabled={text.trim().length === 0 || throwIn.isPending}>
          记录
        </button>
      </div>
    </form>
  )
}
