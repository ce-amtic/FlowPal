import { useParams } from 'react-router-dom'
import { Empty } from '../../shell/State.tsx'

/** 单个项目：接下来的节点、未完成、已完成、说过的话、多久没动。 */
export function ProjectPage() {
  const { id } = useParams()

  return (
    <>
      <h1 className="page-title">项目</h1>
      <Empty>找不到这个项目（{id}）。</Empty>
    </>
  )
}
