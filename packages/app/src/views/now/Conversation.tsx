import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useQuery } from '@tanstack/react-query'
import { api, queryKeys } from '../../api.ts'
import { transition } from '../../tokens/motion.ts'
import { Markup } from '../../shell/Markup.tsx'
import { ErrorState } from '../../shell/State.tsx'
import { useRunStream } from './useRunStream.ts'
import './conversation.css'

/** 一次来回。答案不存库——库里是真相，这里只是刚才说过的话 */
export type Turn = { key: string; asked: string; runId: string }

/**
 * 回复，接在「此刻」末尾。
 *
 * 不做成气泡对话：这一页的主角是上面那张卡，这里是它后面追加的记录。问题小而淡，
 * 回复是正常分量的内容——要读的是回复，不是自己刚打的那句。
 *
 * 也不落库。真相在库里，不在这段对话里；清掉它不会丢任何东西。
 */
export function Conversation({ turns, onClear }: { turns: Turn[]; onClear: () => void }) {
  if (turns.length === 0) return null
  return (
    <section className="talk">
      <div className="talk-head">
        <h2 className="group-label">回复</h2>
        <button className="quiet" onClick={onClear}>清空</button>
      </div>
      {turns.map((t) => <TurnBlock turn={t} key={t.key} />)}
    </section>
  )
}

function TurnBlock({ turn }: { turn: Turn }) {
  const { data } = useQuery({ queryKey: queryKeys.items, queryFn: api.listItems })
  const run = useRunStream(turn.runId, (id) => data?.items.find((i) => i.id === id)?.title)

  return (
    <article className="talk-turn">
      <p className="talk-asked">{turn.asked}</p>
      {run.done
        ? (run.message
          ? <Markup text={run.message} />
          : <ErrorState error={new Error('这次没有生成回复。原文已存。')} />)
        : <Working steps={run.steps} />}
    </article>
  )
}

/**
 * 进行中。
 *
 * 收起时只有一行，说的是它此刻在看哪一样东西，不是它走到第几步。走过的步骤要
 * 看得见，但那是展开之后的事。
 */
function Working({ steps }: { steps: { at: string; text: string }[] }) {
  const [open, setOpen] = useState(false)
  const latest = steps[steps.length - 1]?.text ?? '正在处理'

  return (
    <div className="talk-working">
      <button className="talk-latest" onClick={() => setOpen((v) => !v)} disabled={steps.length === 0}>
        <span className="talk-spinner" aria-hidden />
        <span>{latest}</span>
        {steps.length > 1 && <span className="talk-count">{open ? '收起' : `${steps.length} 步`}</span>}
      </button>

      <AnimatePresence initial={false}>
        {open && steps.length > 0 && (
          <motion.ol
            className="talk-steps"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={transition.base}
          >
            {steps.map((s, i) => <li key={i}>{s.text}</li>)}
          </motion.ol>
        )}
      </AnimatePresence>
    </div>
  )
}
