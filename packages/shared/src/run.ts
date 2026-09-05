import { z } from 'zod'

/**
 * 一次投放的一次处理。runs 是「最近」页的落点、气泡回执的数据源，
 * 也是 GET /api/runs/:id/events 挂靠的对象。
 */
export const RunStatus = z.enum(['running', 'done', 'failed', 'limit'])
export type RunStatus = z.infer<typeof RunStatus>

export type RunCounts = {
  created: number
  updated: number
  dropped: number
  needsConfirm: number
}

export type Run = {
  id: string
  fragmentId: string
  status: RunStatus
  startedAt: string
  finishedAt: string | null
  /** 气泡那句回执。现在由路由拼（「接住了。」/ 四种失败话术），第 5 步换成模型的话。 */
  message: string | null
  /** 动作痕迹那行（新建 3 条 · 更新 1 条）的数据源；失败时是 null。 */
  counts: RunCounts | null
}

/**
 * GET /api/runs/:id/events 的冻结形状（第 5 步往里填 tool_call，不再改形状）：
 *   { type: 'run_started',  at, runId }
 *   { type: 'tool_call',    at, step, tool, args }   // 只带工具名与参数，不带结果
 *   { type: 'run_finished', at, status, counts, message }
 */
export type RunEvent =
  | { type: 'run_started'; at: string; runId: string }
  | { type: 'tool_call'; at: string; step: number; tool: string; args: Record<string, unknown> }
  | { type: 'run_finished'; at: string; status: RunStatus; counts: RunCounts | null; message: string | null }
