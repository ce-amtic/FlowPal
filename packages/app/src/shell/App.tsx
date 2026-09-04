import { CollectionView } from '../views/collection/CollectionView.tsx'

/**
 * 壳。
 *
 * 产品形态、主界面、陪伴形象都还没定，所以这里刻意保持最朴素——它不是主界面，
 * 只是一个容器。采集是壳里的一个视图而不是主界面本身：不这样分，采集界面会因为
 * 是当时唯一存在的东西而默认变成主界面，等形态想清楚了，形态就得跟一个已经长成的界面打架。
 *
 * 形态定了之后换掉的是这个文件，views/collection/ 一行不动。
 */
export function App() {
  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', padding: 24, maxWidth: 860, margin: '0 auto' }}>
      <h1 style={{ fontSize: 18, fontWeight: 600, marginBottom: 16 }}>FlowPal</h1>
      <CollectionView />
    </div>
  )
}
