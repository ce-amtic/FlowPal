import { useEffect, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AnimatePresence, motion } from 'framer-motion'
import { RefreshCw } from 'lucide-react'
import { api, queryKeys } from '../../api.ts'
import { ICON } from '../../tokens/icons.ts'
import { transition } from '../../tokens/motion.ts'
import { ErrorState, Loading } from '../../shell/State.tsx'
import { PetHost } from '../../pet/PetHost.tsx'
import { usePetStatus } from '../../pet/context.tsx'
import { daysBetween, formatAt, formatDay, formatDue } from '../../lib/format.ts'
import { Composer } from './Composer.tsx'
import './now.css'

/**
 * 此刻——第一眼不是列表，是一件事。
 *
 * 「不知道先干哪个」正是用户卡住的原因，给他一张表等于把问题原样退回。
 *
 * 「换一件」在候选之间走，「更小的一步」在同一候选的切口里往后走。两者都是
 * 本地切换：这一组是一次调用返回的，点击零延迟、零费用。刷新不是——它要清缓存、
 * 重新调模型，所以它不在动作行里，在页面右上角。
 */
export function NowPage() {
  const { setStatus: setPetStatus } = usePetStatus()
  useEffect(() => { setPetStatus('idle') }, [setPetStatus])
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: queryKeys.now,
    queryFn: api.getNow,
  })

  const [pickIndex, setPickIndex] = useState(0)
  const [stepIndex, setStepIndex] = useState(0)
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  // 标题栏那个加号、以及全局快捷键，把焦点一起带过来，省掉一次点击
  const navState = useLocation().state
  const focusComposer = navState?.focusComposer === true
  // 拖进窗口的图片。壳把路径带到这里，由记录框提交并显示回执
  const droppedPaths = navState?.droppedPaths as string[] | undefined

  // 记录框钉在底部时脱离布局，正文末尾要留出它那么高的空，否则最后一行被压住
  const [composerHeight, setComposerHeight] = useState(0)

  const refresh = useMutation({
    mutationFn: api.refreshNow,
    onSuccess: () => {
      setPickIndex(0)
      return queryClient.invalidateQueries({ queryKey: queryKeys.now })
    },
  })

  // 换了一件事，切口从最粗的那一个重新开始
  useEffect(() => setStepIndex(0), [pickIndex])

  const candidates = data?.primary ? [data.primary, ...data.alternates] : []
  const candidate = candidates[pickIndex] ?? candidates[0]
  const step = candidate?.steps[stepIndex] ?? candidate?.steps[0] ?? candidate?.title
  const hasSmaller = candidate ? stepIndex < candidate.steps.length - 1 : false
  const hasOther = candidates.length > 1

  return (
    <div
      className="now"
      style={composerHeight > 0
        ? { paddingBottom: `calc(${composerHeight}px + var(--space-10))` }
        : undefined}
    >
      <header className="now-head">
        <PetHost size={128} />
        <div className="now-greeting">
          <p className="greeting">{greeting()}</p>
          {/*
            精力是模型对处境的那一句判断，凭据在它自己那句话里。它是这一页除了
            那件事以外最重要的一行，所以不能是页面上最淡的字。
          */}
          {data?.energy && <p className="energy">{data.energy}</p>}
        </div>

        {/* 页级动作：把这一页重算一遍。它要花几秒和一次调用，所以不和三个本地切换并排 */}
        <button
          className="icon-button now-refresh"
          aria-label="刷新"
          disabled={refresh.isPending}
          onClick={() => refresh.mutate()}
        >
          <RefreshCw
            size={ICON.size}
            strokeWidth={ICON.stroke}
            className={refresh.isPending ? 'spinning' : undefined}
          />
        </button>
      </header>

      {isLoading && <Loading />}
      {error && <ErrorState error={error} onRetry={() => refetch()} />}
      {refresh.error && <ErrorState error={refresh.error} />}

      {/*
        primary 为 null 是库里没有可推的，不是出错。这时不写空态文案——下面那个
        记录框本身就说明了该干什么，一句解释是多余的。
      */}
      {candidate && (
        <motion.div layout transition={transition.base} className="card now-card">
          {/*
            事情的名字。没有它，卡片上就只剩一个孤零零的动作——按过「更小的一步」
            之后尤其如此。它同时是通往条目详情的入口，和全 App 别处点标题一样。
          */}
          <Link className="now-title" to={`/items/${candidate.itemId}`}>{candidate.title}</Link>

          <AnimatePresence mode="wait" initial={false}>
            <motion.p
              key={step}
              className="now-step"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={transition.fast}
            >
              {step}
            </motion.p>
          </AnimatePresence>

          <motion.p layout="position" className="now-reason">{candidate.reason}</motion.p>

          <motion.div layout="position" className="now-actions">
            {/*
              带过去的是屏幕上此刻这一步，不是第一步——按过「更小的一步」之后，
              专注屏上还写着原来那句就等于那几下白按了。
            */}
            <button
              className="primary"
              onClick={() => navigate('/focus', {
                state: { focus: { itemId: candidate.itemId, title: candidate.title, step } },
              })}
            >
              开始
            </button>
            {hasSmaller && (
              <button className="quiet" onClick={() => setStepIndex((i) => i + 1)}>
                更小的一步
              </button>
            )}
            {hasOther && (
              <button className="quiet" onClick={() => setPickIndex((i) => (i + 1) % candidates.length)}>
                换一件
              </button>
            )}
          </motion.div>
        </motion.div>
      )}

      {/*
        有内容时钉到窗口底部；空库时留在流里，否则底下挂个框、上面一片空。
        载入中按「会有卡片」算，否则数据回来的那一刻记录框要从流里跳到底部。
      */}
      <Composer
        autoFocus={focusComposer}
        floating={isLoading || candidate !== undefined}
        onHeight={setComposerHeight}
        droppedPaths={droppedPaths}
      />

      <Upcoming />
    </div>
  )
}

/** 「接下来」的窗口。和 buildContext 算处境用的窗口是同一个，界面与判断才对得上 */
const UPCOMING_DAYS = 7

/**
 * 接下来。它不是装饰，是「剩下的没丢」的凭据——只显示一件事而不给这个凭据，
 * 用户不敢信。
 *
 * 只列 7 天，更远的收成一行通向日程：这一段是安心用的，日程才是完整的轴。
 * 两边用同一个窗口，用户看到的「剩下的」就是模型看到的「剩下的」。
 */
function Upcoming() {
  const { data } = useQuery({ queryKey: queryKeys.agenda, queryFn: api.getAgenda })

  const today = new Date()
  const all = (data?.days ?? []).flatMap((d) => d.items.map((entry) => ({ day: d.day, item: entry.item })))
  const within = all.filter((u) => daysBetween(today, new Date(u.day)) <= UPCOMING_DAYS)
  const beyond = all.length - within.length

  if (within.length === 0 && beyond === 0) return null

  return (
    <section className="upcoming">
      <h2 className="group-label">接下来</h2>
      <ul className="plain-list">
        {within.map(({ day, item }) => (
          <li key={item.id}>
            <Link className="row" to={`/items/${item.id}`}>
              <span className="stamp">{formatDay(day)}</span>
              <span className="row-title">{item.title}</span>
              <span className="row-meta">
                {item.dueAt ? formatDue(item.dueAt) : formatAt(item.startsAt ?? day, item.datePrecision)}
              </span>
            </Link>
          </li>
        ))}
        {beyond > 0 && (
          <li>
            <Link className="row" to="/agenda">
              <span className="stamp" />
              <span className="row-title row-more">还有 {beyond} 件</span>
            </Link>
          </li>
        )}
      </ul>
    </section>
  )
}

/** 问候语按本机时刻算。它不是判断，所以不必等模型 */
function greeting(): string {
  const hour = new Date().getHours()
  if (hour < 6) return '还没睡。'
  if (hour < 11) return '早上好。'
  if (hour < 14) return '中午好。'
  if (hour < 18) return '下午好。'
  return '晚上好。'
}
