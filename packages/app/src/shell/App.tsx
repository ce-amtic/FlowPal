import { useEffect, useState } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
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

  useEffect(() => {
    // 浏览器里没有窗口毛玻璃，body 要自己上底色；红绿灯的位置也不用留。
    document.body.classList.toggle('in-electron', inElectron)
  }, [])

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
