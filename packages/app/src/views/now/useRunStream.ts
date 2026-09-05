import { useEffect, useState } from 'react'
import { api } from '../../api.ts'

/**
 * 一次投放的进展。
 *
 * 播的是它在看什么，不是它走到第几步——「在对照数学建模组会材料」对用户有意义，
 * 「第 3 步 updateItem」没有。所以工具名与参数在这里就地翻成一句人话，服务端
 * 不管这件事：同一条流将来桌宠那边也要用，两处的说法可以不一样。
 */
export type RunStep = { at: string; text: string }

export type RunState = {
  steps: RunStep[]
  /** 跑完之后那句话。带标记，交给 Markup 渲染 */
  message: string | null
  done: boolean
  failed: boolean
}

type ToolEvent = { tool: string; args: Record<string, unknown> }

/** 拿不到标题时退回 id 的后六位——总比一整串好认 */
const shortId = (id: string): string => id.slice(-6)

function phraseFor(e: ToolEvent, titleOf: (id: string) => string | undefined): string {
  const id = typeof e.args.id === 'string' ? e.args.id : undefined
  const named = id ? titleOf(id) ?? shortId(id) : undefined
  switch (e.tool) {
    case 'getItem': return named ? `正在读取「${named}」` : '正在读取已有条目'
    case 'searchItems': return typeof e.args.query === 'string' && e.args.query
      ? `正在查找「${e.args.query}」`
      : '正在查找相关条目'
    case 'getProject': return '正在读取项目'
    case 'createItem': return typeof e.args.title === 'string' ? `正在记下「${e.args.title}」` : '正在记下一条'
    case 'updateItem': return named ? `正在更新「${named}」` : '正在更新一条'
    case 'dropItem': return named ? `正在丢弃「${named}」` : '正在丢弃一条'
    default: return '正在处理'
  }
}

export function useRunStream(runId: string | null, titleOf: (id: string) => string | undefined): RunState {
  const [state, setState] = useState<RunState>({ steps: [], message: null, done: false, failed: false })

  useEffect(() => {
    if (!runId) return
    setState({ steps: [], message: null, done: false, failed: false })
    const source = new EventSource(`${api.serverUrl}/api/runs/${runId}/events`)

    source.onmessage = (ev) => {
      const e = JSON.parse(ev.data) as Record<string, unknown>
      if (e.type === 'tool_call') {
        const text = phraseFor(
          { tool: String(e.tool), args: (e.args ?? {}) as Record<string, unknown> },
          titleOf,
        )
        setState((s) => ({ ...s, steps: [...s.steps, { at: String(e.at), text }] }))
      } else if (e.type === 'run_finished') {
        setState((s) => ({
          ...s,
          message: typeof e.message === 'string' ? e.message : null,
          done: true,
          failed: e.status === 'failed',
        }))
        source.close()
      }
    }
    // 连不上就停在最后看到的那一步，不装作还在跑
    source.onerror = () => { source.close(); setState((s) => ({ ...s, done: true })) }

    return () => source.close()
    // titleOf 每次渲染都是新函数，进依赖会把这条流反复重连
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId])

  return state
}
