import { useEffect, useState } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { useQuery } from '@tanstack/react-query'
import { api, queryKeys } from '../api.ts'
import { inElectron } from '../bridge.ts'
import { transition } from '../tokens/motion.ts'
import { TitleBar } from './TitleBar.tsx'
import { PendingOverlay } from './PendingOverlay.tsx'
import { PageBoundary } from './PageBoundary.tsx'
import { useServerEvents } from './useServerEvents.ts'
import { NowPage } from '../views/now/NowPage.tsx'
import { RecentPage } from '../views/recent/RecentPage.tsx'
import { AgendaPage } from '../views/agenda/AgendaPage.tsx'
import { ProjectsPage } from '../views/projects/ProjectsPage.tsx'
import { ProjectPage } from '../views/projects/ProjectPage.tsx'
import { ThoughtsPage } from '../views/thoughts/ThoughtsPage.tsx'
import { ItemPage } from '../views/item/ItemPage.tsx'
import { FocusPage } from '../views/focus/FocusPage.tsx'
import { SettingsPage } from '../views/settings/SettingsPage.tsx'
import { WelcomePage } from '../views/welcome/WelcomePage.tsx'
import './shell.css'

/**
 * 壳：一条标题栏（同时是导航与拖动区）加一块滚动的正文。
 *
 * 形象只出现在「此刻」与「专注」——其余三页是干活的地方，放了形象它就变成
 * 装饰，而装饰会稀释它该出现时的分量。
 */
export function App() {
  const location = useLocation()
  const [pendingOpen, setPendingOpen] = useState(false)

  useServerEvents()

  const settings = useQuery({ queryKey: queryKeys.settings, queryFn: api.getSettings })

  useEffect(() => {
    // 浏览器里没有窗口毛玻璃，body 要自己上底色；红绿灯的位置也不用留。
    document.body.classList.toggle('in-electron', inElectron)
  }, [])

  /*
   * 设置还没取到时先什么都不画。
   *
   * 猜一个默认会猜错一半：当成没走过向导，老用户每次启动都被欢迎一次；当成走过了，
   * 新用户会先看到一屏空的「此刻」再被弹去向导。取一次设置是本机的事，很快。
   */
  if (settings.isLoading) return null
  // 取失败不等于没走过向导。连不上 server 时进壳，让每一页自己把错误说出来
  if (settings.data && !settings.data.settings.onboarded_at) return <WelcomePage />

  return (
    <div className="shell">
      <TitleBar onOpenPending={() => setPendingOpen(true)} />

      <main className="page">
        <AnimatePresence mode="wait">
          <motion.div
            key={location.pathname}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={transition.base}
            className="page-inner"
          >
            <PageBoundary pathname={location.pathname}>
              <Routes location={location}>
                <Route path="/" element={<Navigate to="/now" replace />} />
                <Route path="/now" element={<NowPage />} />
                <Route path="/recent" element={<RecentPage />} />
                <Route path="/agenda" element={<AgendaPage />} />
                <Route path="/projects" element={<ProjectsPage />} />
                <Route path="/projects/:id" element={<ProjectPage />} />
                <Route path="/thoughts" element={<ThoughtsPage />} />
                <Route path="/items/:id" element={<ItemPage />} />
                <Route path="/focus" element={<FocusPage />} />
                <Route path="/settings" element={<SettingsPage />} />
              </Routes>
            </PageBoundary>
          </motion.div>
        </AnimatePresence>
      </main>

      {pendingOpen && <PendingOverlay onClose={() => setPendingOpen(false)} />}
    </div>
  )
}
