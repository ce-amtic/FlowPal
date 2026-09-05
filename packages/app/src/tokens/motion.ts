/**
 * 动效 token 的 JS 镜像。framer-motion 要的是数字，CSS 要的是带单位的字符串，
 * 所以同一组值必须存在两处。check-tokens 会核对这两处一致——不核对的话，
 * 改了一边忘了另一边，页面切换和悬停会跑在不同的节奏上，而这种不齐很难被看出来。
 *
 * 单位是秒，framer-motion 的约定。
 */
export const DUR = {
  fast: 0.12,
  base: 0.22,
  slow: 0.4,
} as const

/** 与 CSS 里的 --ease 同一条曲线 */
export const EASE = [0.2, 0, 0, 1] as const

export const transition = {
  fast: { duration: DUR.fast, ease: EASE },
  base: { duration: DUR.base, ease: EASE },
  slow: { duration: DUR.slow, ease: EASE },
} as const
