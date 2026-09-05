import { useEffect, useState } from 'react'
import { api } from '../../api.ts'

/**
 * 一次投放的进展。
 *
 * 播的是它在看什么，不是它走到第几步——「在对照数学建模组会材料」对用户有意义，
 * 「第 3 步 updateItem」没有。所以工具名与参数在这里就地翻成一句人话，服务端
 * 不管这件事：同一条流将来桌宠那边也要用，两处的说法可以不一样。
 */
export type RunStep = { at: string; verb: string; target: string }

export type RunState = {
  steps: RunStep[]
  /** 跑完之后那句话。带标记，交给 Markup 渲染 */
  message: string | null
  done: boolean
  failed: boolean
  /** 流断在半路。跟「跑完了但没说话」是两回事，界面上不能混为一谈 */
  disconnected: boolean
}

type ToolEvent = { tool: string; args: Record<string, unknown> }

/** 拿不到标题时退回 id 的后六位——总比一整串好认 */
const shortId = (id: string): string => id.slice(-6)

/**
 * 一步做的事，拆成动词与它动的那个对象。
 *
 * 拆开是因为同一步在跑的时候和跑完之后要说两句话，而工具名到人话的对应只该写一遍
 * ——抄成两份 switch，迟早只有一份跟着新工具改。
 */
function actFor(e: ToolEvent, titleOf: (id: string) => string | undefined): Omit<RunStep, 'at'> {
  const id = typeof e.args.id === 'string' ? e.args.id : undefined
  const named = id ? titleOf(id) ?? shortId(id) : undefined
  switch (e.tool) {
    case 'getItem': return { verb: '读取', target: named ? `「${named}」` : '已有条目' }
    case 'searchItems': return {
      verb: '查找',
      target: typeof e.args.query === 'string' && e.args.query ? `「${e.args.query}」` : '相关条目',
    }
    case 'getProject': return { verb: '读取', target: '项目' }
    case 'createItem': return {
      verb: '记下',
      target: typeof e.args.title === 'string' ? `「${e.args.title}」` : '一条',
    }
    case 'updateItem': return { verb: '更新', target: named ? `「${named}」` : '一条' }
    case 'dropItem': return { verb: '丢弃', target: named ? `「${named}」` : '一条' }
    default: return { verb: '处理', target: '' }
  }
}

/** 组句。时态由界面定：一步收没收，只有界面知道 */
export const stepText = (s: RunStep, finished: boolean): string =>
  `${finished ? '已' : '正在'}${s.verb}${s.target}`

const idle: RunState = { steps: [], message: null, done: false, failed: false, disconnected: false }

export function useRunStream(runId: string | null, titleOf: (id: string) => string | undefined): RunState {
  const [state, setState] = useState<RunState>(idle)

  useEffect(() => {
    if (!runId) return
    setState(idle)
    const source = new EventSource(`${api.serverUrl}/api/runs/${runId}/events`)

    source.onmessage = (ev) => {
      const e = JSON.parse(ev.data) as Record<string, unknown>
      if (e.type === 'tool_call') {
        const act = actFor(
          { tool: String(e.tool), args: (e.args ?? {}) as Record<string, unknown> },
          titleOf,
        )
        setState((s) => ({ ...s, steps: [...s.steps, { at: String(e.at), ...act }] }))
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
    // 连不上就停在最后看到的那一步，不装作还在跑；也不能当成「跑完了没说话」
    source.onerror = () => {
      source.close()
      setState((s) => ({ ...s, done: true, disconnected: true }))
    }

    return () => source.close()
    // titleOf 每次渲染都是新函数，进依赖会把这条流反复重连
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId])

  return state
}
