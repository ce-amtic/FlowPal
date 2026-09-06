import { z } from 'zod'

/**
 * 「此刻」的一次只读生成。不是 agent 循环：不带工具，只从 buildContext 的事实里挑一件。
 * 与 packages/app/src/api.ts 的 NowPick 对齐：reason + steps（一串越来越小的切口）。
 */
export const NowChoice = z.object({
  itemId: z.string(),
  title: z.string(),
  /** 一句说中处境的话：为什么是它。对应前端的 reason。 */
  reason: z.string(),
  /** 第一步；其后是更小的切口。「更小的一步」在这个数组里往后走。至少给两级。 */
  steps: z.array(z.string()).min(2),
}).strict()

/**
 * 今天剩下的时间的一段。固定的（课、有时刻的事件）原样落位，事务排进空隙，
 * 排在哪个空隙由精力事实决定——这是那条曲线在挑选之外唯一看得见的地方。
 */
export const PlanSlot = z.object({
  /** HH:MM */
  start: z.string(),
  /** HH:MM */
  end: z.string(),
  kind: z.enum(['fixed', 'task']),
  /** 固定项与事务都指回条目；模型自己加的间歇不进这里，所以没有 null。 */
  itemId: z.string(),
  title: z.string(),
  /** 为什么排在这里，一短句；固定项留空串。 */
  note: z.string(),
}).strict()

export const NowOutput = z.object({
  primary: NowChoice.nullable(),
  alternates: z.array(NowChoice),
  energy_reading: z.string(),
  plan: z.array(PlanSlot),
  /** 这次输出用了哪些材料：条目 id，或来自 buildContext 的逐字事实。 */
  basis: z.array(z.string()),
}).strict()

export type NowChoice = z.infer<typeof NowChoice>
export type PlanSlot = z.infer<typeof PlanSlot>
export type NowOutput = z.infer<typeof NowOutput>

export function nowJsonSchema() {
  return z.toJSONSchema(NowOutput, { target: 'draft-2020-12' })
}
