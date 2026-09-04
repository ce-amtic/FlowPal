import type { Calendar, Term } from './calendar.ts'
import { selectTerm } from './calendar.ts'

/**
 * 请求上下文。
 *
 * 规矩：逻辑层不许取隐式全局——不调无参 `new Date()` / `Date.now()`，
 * 不读全局的当前用户或当前学期，一律从这里拿。
 *
 * `now` 这条明天就会咬人而不是将来才咬：演示碎片里有「下周三之前把那个报告发给老师」，
 * now 不可注入的话，今天调通的用例明天解析成别的日期，而且不会报错，只会静悄悄给出错日期。
 * scripts/check-fixtures.ts 里有一条硬断言扫这个。
 */
export type Ctx = {
  /** 现在恒为 'local'。表里没有 user_id 列；要加多用户是加一列 + 改 packages/server/src/store/ 一个目录。 */
  userId: string
  /** ISO8601 带 +08:00 */
  now: string
  tz: string
  term: Term
}

export function createCtx(calendar: Calendar, now: string, userId = 'local'): Ctx {
  return { userId, now, tz: 'Asia/Shanghai', term: selectTerm(calendar, now) }
}

/** 唯一允许读系统时钟的地方：请求入口。逻辑层拿到的永远是 ctx.now。 */
export function nowInShanghai(): string {
  const d = new Date()
  const shifted = new Date(d.getTime() + 8 * 3600_000)
  return shifted.toISOString().replace(/\.\d{3}Z$/, '+08:00')
}
