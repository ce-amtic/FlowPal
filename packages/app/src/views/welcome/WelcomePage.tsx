import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api, queryKeys } from '../../api.ts'
import { CHRONOTYPE } from '../../lib/chronotype.ts'
import { transition } from '../../tokens/motion.ts'
import { Pebble } from '../../pebble/Pebble.tsx'
import { ErrorState } from '../../shell/State.tsx'
import './welcome.css'

/**
 * 首次启动。三屏：形象出场、两个问题、进去。
 *
 * 只问作息这两个，不问别的。别的东西不该在这里问：产品的前提是用户只维护一份状态，
 * 开场先来一张表单等于一上来就违约。这两问之后只在设置页里能改，两处共用同一份题目
 * 与选项。
 */
type Step = 'hello' | 'workday' | 'restday'

export function WelcomePage() {
  const [step, setStep] = useState<Step>('hello')
  const [workday, setWorkday] = useState<string | null>(null)
  const queryClient = useQueryClient()

  const finish = useMutation({
    mutationFn: (restday: string) =>
      api.patchSettings({
        chronotype_workday_wake: workday ?? '',
        chronotype_restday_wake: restday,
        onboarded_at: new Date().toISOString(),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.settings }),
  })

  return (
    <div className="welcome">
      <motion.div
        className="welcome-figure"
        layout
        transition={transition.slow}
        data-step={step}
      >
        <Pebble size={step === 'hello' ? 176 : 96} />
      </motion.div>

      <AnimatePresence mode="wait" initial={false}>
        {step === 'hello' && (
          <Panel key="hello">
            <h1 className="welcome-title">让开始变容易，让专注变自然。</h1>
            <p className="welcome-lead">
              一段话、一张群聊截图、一封邮件，都可以直接放进来。
              它替你记住时间、地点和要做的事；在你不知道先做哪件的时候，告诉你先做这一件。
            </p>
            <button className="primary welcome-go" onClick={() => setStep('workday')}>
              开始
            </button>
            <p className="welcome-aside">先回答两个问题，一共十秒。</p>
          </Panel>
        )}

        {step === 'workday' && (
          <Panel key="workday">
            <p className="welcome-step">第一个问题</p>
            <h1 className="welcome-title">{CHRONOTYPE.workday.question}</h1>
            <Choices
              options={CHRONOTYPE.workday.options}
              onPick={(value) => { setWorkday(value); setStep('restday') }}
            />
            <p className="welcome-aside">大概就行。它用来估你一天里精力在哪个位置。</p>
          </Panel>
        )}

        {step === 'restday' && (
          <Panel key="restday">
            <p className="welcome-step">第二个问题</p>
            <h1 className="welcome-title">{CHRONOTYPE.restday.question}</h1>
            <Choices
              options={CHRONOTYPE.restday.options}
              disabled={finish.isPending}
              onPick={(value) => finish.mutate(value)}
            />
            {/*
              这两个的差值才是有用的信号：差得越多，说明平时越是被闹钟叫醒的，
              而不是睡到自然醒。这句话不写在界面上——它是我们怎么用，不是用户要读的。
            */}
            <p className="welcome-aside">
              {finish.isPending ? '正在记下' : '这两个时间之间的差别，比它们各自是几点更有用。'}
            </p>
            {finish.error && <ErrorState error={finish.error} />}
          </Panel>
        )}
      </AnimatePresence>
    </div>
  )
}

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <motion.div
      className="welcome-panel"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -12 }}
      transition={transition.base}
    >
      {children}
    </motion.div>
  )
}

function Choices({ options, onPick, disabled }: {
  options: readonly string[]
  onPick: (value: string) => void
  disabled?: boolean
}) {
  return (
    <div className="choices welcome-choices">
      {options.map((option) => (
        <button key={option} className="choice" disabled={disabled} onClick={() => onPick(option)}>
          {option}
        </button>
      ))}
    </div>
  )
}
