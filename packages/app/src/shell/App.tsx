import { useEffect } from 'react'
import { inElectron } from '../bridge.ts'
import { CollectionView } from '../views/collection/CollectionView.tsx'
import './shell.css'

/**
 * 壳。
 *
 * 产品形态、主界面、陪伴形象都还没定，所以这里只做两件不预设形态的事：
 * 接住被隐藏的系统标题栏（留出拖动区与红绿灯的位置），和定下基础观感。
 * 采集是壳里的一个视图而不是主界面本身——不这样分，采集界面会因为是当时唯一
 * 存在的东西而默认变成主界面，等形态想清楚了，形态就得跟一个已经长成的界面打架。
 *
 * 形态定了之后换掉的是这个文件，views/collection/ 一行不动。
 */
export function App() {
  useEffect(() => {
    // 浏览器里没有窗口毛玻璃，body 要自己上底色；红绿灯的位置也不用留。
    document.body.classList.toggle('in-electron', inElectron)
  }, [])

  return (
    <div className="shell">
      <header className="titlebar">
        <span>FlowPal</span>
        <span className="spacer" />
        <span className="hint">扔进来就好</span>
      </header>
      <main className="body">
        <div className="inner">
          <CollectionView />
        </div>
      </main>
    </div>
  )
}
