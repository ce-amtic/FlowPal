import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '../api.ts'

/**
 * 一条 SSE，server 在任何写操作后广播一条粗粒度的「变了」，收到就整棵失效。
 *
 * 事件不携带内容：实体在库里另有真相，事件再带一份就会长出第二套数据模型，
 * 而两套一定会不同步。本机重取的代价可以忽略。
 *
 * 效果是桌宠扔进一条东西，主窗口的日程里自动多一条，两边都没有人写过同步代码。
 */
export function useServerEvents(): void {
  const queryClient = useQueryClient()

  useEffect(() => {
    // EventSource 自带重连，开发时 Vite 热更新留下的断连由它自己收拾。
    const source = new EventSource(`${api.serverUrl}/api/events`)
    const invalidate = () => queryClient.invalidateQueries()

    source.addEventListener('changed', invalidate)
    source.onmessage = invalidate

    return () => source.close()
  }, [queryClient])
}
