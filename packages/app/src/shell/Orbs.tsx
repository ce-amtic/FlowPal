import { ThinkingOrb } from 'thinking-orbs'

/**
 * 等待态的那颗球。
 *
 * 用现成的 thinking-orbs：它是照着 agent 界面调出来的一组球，九种状态两种尺寸，
 * 自己认深浅、自己认「减弱动态」、滚出屏幕自己停。这些都比一段手写的 CSS 动画
 * 想得周到。
 *
 * 包一层是为了把「哪种活对应哪颗球」定死在一处——同一条流桌宠那边也要用，两处
 * 各挑一种球就成了两套语言。球本身不带文字，它站在一句话前面，说什么由那句话负责。
 */

/** 这一步在做什么。读是找，写是做——只有这两种，多了就得让用户去分辨球的差别 */
export type OrbKind = 'reading' | 'writing' | 'starting'

const STATE = {
  reading: 'searching',
  writing: 'working',
  // 还没有第一次工具调用：它确实还什么都没做，安静地呼吸比装作在忙要诚实
  starting: 'breathing',
} as const

/** 与一行正文并排的那一档。64 是当头像用的，这里用不上 */
export const ORB_SIZE = 20

export function Orbs({ kind = 'starting' }: { kind?: OrbKind }) {
  return <ThinkingOrb state={STATE[kind]} size={ORB_SIZE} aria-label="正在处理" />
}
