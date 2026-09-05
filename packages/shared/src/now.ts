import { z } from 'zod'

/**
 * 「此刻」的一次只读生成。不是 agent 循环：不带工具，只从 buildContext 的事实里挑一件。
 * basis 是这次输出用了哪些材料——列条目 id 或逐字事实，不是 item_citations。
 */
export const NowChoice = z.object({
  itemId: z.string(),
  title: z.string(),
  /** 一句说中处境的话：为什么是它。 */
  why: z.string(),
  /** 足够小的第一步，可执行；给不出有出处的具体步骤就降承诺。 */
  step: z.string(),
}).strict()

export const NowBasis = z.object({
  itemId: z.string().nullable(),
  /** 来自 buildContext 或条目原文的逐字片段。 */
  quote: z.string(),
  field: z.string().nullable(),
}).strict()

export const NowOutput = z.object({
  primary: NowChoice.nullable(),
  alternates: z.array(NowChoice),
  energy_reading: z.string(),
  basis: z.array(NowBasis),
}).strict()

export type NowChoice = z.infer<typeof NowChoice>
export type NowBasis = z.infer<typeof NowBasis>
export type NowOutput = z.infer<typeof NowOutput>

export function nowJsonSchema() {
  return z.toJSONSchema(NowOutput, { target: 'draft-2020-12' })
}
