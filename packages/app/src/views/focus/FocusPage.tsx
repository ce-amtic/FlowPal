import { Empty } from '../../shell/State.tsx'

/**
 * 专注是模式不是页面：进来之后整个窗口换一副样子，出去回到原处。
 *
 * 这条路由归桌面侧那条线：计时、形象在场、结束时两个按钮、结束简报。
 * 这里只占住位置，让「此刻」上的开始按钮有地方可去。
 */
export function FocusPage() {
  return (
    <>
      <h1 className="page-title">专注</h1>
      <Empty>先从「此刻」挑一件事。</Empty>
    </>
  )
}
