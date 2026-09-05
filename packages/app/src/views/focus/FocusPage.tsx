import { useEffect, useState, type CSSProperties } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { nowInShanghai } from '@flowpal/shared'
import { api, queryKeys } from '../../api.ts'
import { transition } from '../../tokens/motion.ts'
import { PetHost } from '../../pet/PetHost.tsx'
import { usePetStatus } from '../../pet/context.tsx'
import { ErrorState } from '../../shell/State.tsx'
import { Composer } from '../now/Composer.tsx'
import './focus.css'

/**
 * 专注是模式不是页：进来之后整个窗口换一副样子，出去回到原处。所以这一屏没有
 * 导航条——顺带，时段里到达的东西也就不会从角标上冒出来打断人。
 *
 * 三段：定时长、走计时、结束。结束只有两个按钮、零打字：已完成的意思是那件事
 * 做完了；下次继续把它留着，并且直接改变下一次「此刻」——那条记录带着事情的
 * 名字进处境，模型接得上。
 *
 * 时长与目标只活在内存里，时段结束才写库。中途刷新页面会丢掉这一段。
 */
/*
 * 五分钟起：梯子能把一件事切到二十秒，最短还要十五分钟的话，门槛等于又抬回去了。
 * 九十分钟封顶：那是这个项目采用的超日节律先验的长度，不是随手取的整数。
 */
const MIN_MINUTES = 5
const MAX_MINUTES = 90
const STEP_MINUTES = 5
const DEFAULT_MINUTES = 25

/** 开场白留多久。够读完并照着做一次，不够久到变成屏幕上的一件摆设 */
const OPENING_FADES_AFTER_MS = 60_000

/** 从「此刻」带过来的目标。带的是当时屏幕上那一步，不是第一步——按过「更小的一步」就该算数 */
type Target = { itemId: string; title: string; step: string }

type Phase =
  | { name: 'ready' }
  | { name: 'running'; startedAt: string; startedMs: number }
  | { name: 'ending'; startedAt: string; startedMs: number; endedMs: number }

export function FocusPage() {
  const { setStatus: setPetStatus } = usePetStatus()
  const target = useLocation().state?.focus as Target | undefined
  const [minutes, setMinutes] = useState(DEFAULT_MINUTES)
  const [phase, setPhase] = useState<Phase>({ name: 'ready' })
  const [openingShown, setOpeningShown] = useState(true)

  /*
   * 开场那一句在一分钟后退场。它的职责是把人送进来，而人已经进来了；再留着
   * 就成了噪音——这一屏此后只该有那件事和时间。
   */
  useEffect(() => {
    if (phase.name !== 'running') return
    const id = setTimeout(() => setOpeningShown(false), OPENING_FADES_AFTER_MS)
    return () => clearTimeout(id)
  }, [phase.name])

  useEffect(() => {
    setPetStatus(phase.name === 'running' ? 'focus' : phase.name === 'ending' ? 'done' : 'idle')
  }, [phase.name, setPetStatus])

  if (!target) return <Blank />

  return (
    <div className="focus">
      <PetHost className="focus-pet" size={128} interactive={false} />

      {/*
        这一段是关于那件事的，不是关于那一步的。那一步的职责是把开始的门槛降下来，
        所以它退成一行小字，写成「从……开始」——一句开场白，不是这一段的内容。
        事情的名字接管主体，「已完成」问的也就名正言顺地是那件事。
      */}
      <p className="focus-title">{target.title}</p>
      <AnimatePresence initial={false}>
        {phase.name !== 'ending' && openingShown && (
          <motion.p
            className="focus-step"
            exit={{ opacity: 0, height: 0, marginTop: 0 }}
            transition={transition.slow}
          >
            从「{target.step}」开始
          </motion.p>
        )}
      </AnimatePresence>

      <AnimatePresence mode="wait" initial={false}>
        {phase.name === 'ready' && (
          <Panel key="ready">
            <Dial minutes={minutes} onChange={setMinutes} />
            <button
              className="primary focus-go"
              onClick={() => setPhase({
                // 库里其余时刻都是 +08:00 的写法，这里跟着来：发 UTC 的话，
                // 凌晨那几个小时的时段会被算进前一天。
                name: 'running', startedAt: nowInShanghai(), startedMs: Date.now(),
              })}
            >
              开始
            </button>
          </Panel>
        )}

        {phase.name === 'running' && (
          <Panel key="running">
            <Countdown
              endsAtMs={phase.startedMs + minutes * 60_000}
              onDone={() => setPhase({ ...phase, name: 'ending', endedMs: Date.now() })}
            />
            <button
              className="quiet focus-stop"
              onClick={() => setPhase({ ...phase, name: 'ending', endedMs: Date.now() })}
            >
              结束
            </button>
          </Panel>
        )}

        {phase.name === 'ending' && (
          <Panel key="ending">
            <Ending
              target={target}
              startedAt={phase.startedAt}
              plannedMinutes={minutes}
              actualMinutes={Math.max(1, Math.round((phase.endedMs - phase.startedMs) / 60_000))}
            />
          </Panel>
        )}
      </AnimatePresence>

      {/*
        专注中冒出的杂念要有地方放，否则它要么占着脑子，要么把人拽出这一段。
        记下的东西在结束那一屏原样列出来——记了就看得见，这是这个框存在的理由。
      */}
      {phase.name === 'running' && (
        <div className="focus-composer">
          <Composer
            floating={false}
            onHeight={() => {}}
            placeholder="想到别的，先记在这里"
            linkItems={false}
          />
        </div>
      )}
    </div>
  )
}

/**
 * 时长。一条连续的轨，不是几个格子——梯子能把一件事切到二十秒，也可以是一下午，
 * 中间没有理由只留三个停靠点。
 *
 * 颜色沿着轨走：同一个强调色，从最淡到最实。它说的是这一段有多重，不是「长的更好」。
 * 五分钟那一头照样是被认可的选择——这个产品的整件事就是让开始变容易。
 */
function Dial({ minutes, onChange }: { minutes: number; onChange: (m: number) => void }) {
  // 0 到 1 的位置。宽度与颜色都从它算，两者才不会各走各的
  const at = (minutes - MIN_MINUTES) / (MAX_MINUTES - MIN_MINUTES)
  return (
    <div className="dial" style={{ '--dial-at': at } as CSSProperties}>
      {/*
        这个数字站的位置，就是待会儿倒计时出现的位置。按下「开始」之后它留在原地
        开始走——设定和计时是同一个数，不该在屏幕上换个地方重新登场。
      */}
      <p className="dial-value">
        {minutes}<span className="dial-unit">分钟</span>
      </p>
      <input
        className="dial-range"
        type="range"
        min={MIN_MINUTES}
        max={MAX_MINUTES}
        step={STEP_MINUTES}
        value={minutes}
        aria-label="这一段做多久"
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  )
}

/**
 * 时长与表情联动。越长越沉：五分钟是笑的，一小时是眯着眼的。
 *
 * 短的那一头必须是正面的表情。它是门槛最低的那个选择，产品在这里皱一下眉，
 * 就等于在劝人选长的——而劝人正是这个产品说好不做的事。
 */
/** 直接开 /focus 而不是从「此刻」进来。这时它不是一个模式，只是一条走空了的路 */
function Blank() {
  return (
    <>
      <h1 className="page-title">专注</h1>
      <p className="state state-empty">
        <Link to="/now">先在「此刻」选一件事。</Link>
      </p>
    </>
  )
}

/**
 * 倒计时。每一秒从时刻差重算，不累加计数器——后者在标签页被挂起后会走慢。
 */
function Countdown({ endsAtMs, onDone }: { endsAtMs: number; onDone: () => void }) {
  const [left, setLeft] = useState(() => endsAtMs - Date.now())

  useEffect(() => {
    const id = setInterval(() => setLeft(endsAtMs - Date.now()), 1000)
    return () => clearInterval(id)
  }, [endsAtMs])

  // 归零就是这一段走完了，落到结束那一屏上问同样的两个问题。不响铃：
  // 一段安静的时间不该以一声惊动收尾。
  useEffect(() => { if (left <= 0) onDone() }, [left, onDone])

  const total = Math.max(0, Math.ceil(left / 1000))
  const mm = String(Math.floor(total / 60)).padStart(2, '0')
  const ss = String(total % 60).padStart(2, '0')
  return <p className="focus-clock">{mm}:{ss}</p>
}

/**
 * 结束。两个按钮，零打字：已完成 ｜ 下次继续。
 *
 * 「已完成」把那件事记成完成，「此刻」从此不再推它；「下次继续」把它留着，
 * 并且让下一次「此刻」重新判断——那件没做完的事带着名字进处境。
 */
function Ending({ target, startedAt, plannedMinutes, actualMinutes }: {
  target: Target
  startedAt: string
  plannedMinutes: number
  actualMinutes: number
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const finish = useMutation({
    mutationFn: async (done: boolean) => {
      await api.postFocusSession({
        startedAt, plannedMinutes, actualMinutes, endedEarly: !done, itemId: target.itemId,
      })
      if (!done) return
      /*
       * 只有事务才有「做完」这回事。事件是外部的时间点——为一场考试专注过一段，
       * 不等于那场考试结束了，记成完成会让它从日程上消失。
       */
      const { item } = await api.getItem(target.itemId)
      if (item.type === 'task') await api.patchItem(target.itemId, { status: 'done' })
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries()
      // 这一页现在没挂着，失效不会触发重取。不把它扔掉的话，回到「此刻」会先看见
      // 刚做完的那件事停在那儿几秒，等新判断算出来才换掉。
      queryClient.removeQueries({ queryKey: queryKeys.now })
      navigate('/now')
    },
  })

  return (
    <>
      <div className="focus-end-actions">
        <button className="primary" disabled={finish.isPending} onClick={() => finish.mutate(true)}>
          已完成
        </button>
        <button className="quiet" disabled={finish.isPending} onClick={() => finish.mutate(false)}>
          下次继续
        </button>
      </div>
      {finish.error && <ErrorState error={finish.error} />}
      <Jotted since={startedAt} />
    </>
  )
}

/**
 * 这段时间记下的想法。一条没有就整块不出现——「你记下了 0 条」形式上是事实，
 * 读起来是指责。
 */
function Jotted({ since }: { since: string }) {
  const { data } = useQuery({ queryKey: queryKeys.thoughts, queryFn: api.listThoughts })
  // 两边都是同一种带 +08:00 的写法，按字符串比就是按时间比
  const jotted = (data?.thoughts ?? []).filter((t) => t.createdAt >= since)
  if (jotted.length === 0) return null

  // 不做成链接：这一屏的出口只有那两个按钮，点走了这一段就没记上
  return (
    <section className="focus-jotted">
      <h2 className="group-label">这段时间你记下了</h2>
      <ul className="focus-jotted-list">
        {jotted.map((t) => <li key={t.id}>{t.title}</li>)}
      </ul>
    </section>
  )
}

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <motion.div
      className="focus-panel"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={transition.base}
    >
      {children}
    </motion.div>
  )
}
