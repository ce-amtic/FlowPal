import { Empty } from '../../shell/State.tsx'

/**
 * 设置：模型配置、教务凭据、作息两问、校历、同步状态与上次结果。
 *
 * 这条路由归桌面侧那条线——它装着的东西与那边手上的同步同源。
 * 这里只占住位置。
 */
export function SettingsPage() {
  return (
    <>
      <h1 className="page-title">设置</h1>
      <Empty>还没有可配置的项。</Empty>
    </>
  )
}
