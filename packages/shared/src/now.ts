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

export const NowOutput = z.object({
  primary: NowChoice.nullable(),
  alternates: z.array(NowChoice),
  energy_reading: z.string(),
  /** 这次输出用了哪些材料：条目 id，或来自 buildContext 的逐字事实。 */
  basis: z.array(z.string()),
}).strict()

export type NowChoice = z.infer<typeof NowChoice>
export type NowOutput = z.infer<typeof NowOutput>

export function nowJsonSchema() {
  return z.toJSONSchema(NowOutput, { target: 'draft-2020-12' })
}
