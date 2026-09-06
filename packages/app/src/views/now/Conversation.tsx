import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useQuery } from '@tanstack/react-query'
import { Check, Unplug } from 'lucide-react'
import { api, queryKeys } from '../../api.ts'
import { ICON } from '../../tokens/icons.ts'
import { transition } from '../../tokens/motion.ts'
import { Markup } from '../../shell/Markup.tsx'
import { ORB_SIZE, Orbs } from '../../shell/Orbs.tsx'
import { type RunStep, stepText, useRunStream } from './useRunStream.ts'
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

  // 做过的事在上，说的话在下：那一行是这次动过什么的凭据，话是结论
  return (
    <article className="talk-turn">
      <p className="talk-asked">{turn.asked}</p>
      {/* 一步都没有又已经收尾，这一行没有内容可播，空壳比没有更差 */}
      {(run.steps.length > 0 || !run.done) && (
        <Steps steps={run.steps} running={!run.done} settled={run.done && !run.disconnected} />
      )}
      {run.done && (run.disconnected
        ? <p className="talk-note">连接中断，未能收到回复。原文已存。</p>
        // 跑失败时服务端给的就是一句交代，不是回复。走标记渲染会让它看起来像一条
        // 正常答复，而它不是
        : run.failed
          ? <p className="talk-note talk-failed">{run.message ?? '这次没有跑完。原文已存。'}</p>
          : run.message
            ? <Markup text={run.message} />
            : <p className="talk-note">这次没有生成回复。原文已存。</p>)}
    </article>
  )
}

/**
 * 这次动过哪些东西。
 *
 * 收起时只有一行，说的是它动的哪一样东西，不是它走到第几步。跑完之后这一行留下，
 * 只把球撤掉——它是这次做了什么的凭据，跟着结论一起消失就没人能对账了。
 *
 * settled 与 running 是两件事：流断在半路时，最后那一步究竟做完没有客户端并不
 * 知道，所以它停在「正在…」，不改口说「已…」。
 */
function Steps({ steps, running, settled }: { steps: RunStep[]; running: boolean; settled: boolean }) {
  const [open, setOpen] = useState(false)
  const last = steps.length - 1
  const latest = steps[last]

  return (
    <div className="talk-working">
      <button className="talk-latest" onClick={() => setOpen((v) => !v)} disabled={steps.length < 2}>
        {/*
          行首那一格始终有东西：球撤掉之后如果什么都不放，整行会往左跳一截。
          三种收场各有各的记号，也省得只靠时态去分辨。
        */}
        {running
          ? <Orbs kind={latest ? (latest.writing ? 'writing' : 'reading') : 'starting'} />
          : settled
            ? <Check className="talk-mark" size={ORB_SIZE} strokeWidth={ICON.stroke} aria-hidden />
            : <Unplug className="talk-mark" size={ORB_SIZE} strokeWidth={ICON.stroke} aria-hidden />}
        <span>{latest ? stepText(latest, settled) : '正在处理'}</span>
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
            {/* 后面还有一步，就说明这一步已经收了；只有最末一步的时态要看整次跑完没有 */}
            {steps.map((s, i) => <li key={i}>{stepText(s, i < last || settled)}</li>)}
          </motion.ol>
        )}
      </AnimatePresence>
    </div>
  )
}
