import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { App } from './shell/App.tsx'
import './tokens/tokens.css'

/**
 * HashRouter 而不是 BrowserRouter：打包后页面从 file:// 加载，
 * BrowserRouter 在那种情况下失效，而这是个改起来烦、发现得晚的坑。
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 数据的唯一真相在本机那个进程里，变更由 SSE 广播触发失效，
      // 所以不需要窗口聚焦重取那一套。
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
})

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}>
    <HashRouter>
      <App />
    </HashRouter>
  </QueryClientProvider>,
)
