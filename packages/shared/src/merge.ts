import type { ExtractedItem } from './extract.ts'

/**
 * 合并计划：语义层与数据层之间的契约。
 *
 * 路由把三段串起来：extract（语义层）→ dedupe（语义层）→ store.apply（数据层）。
 * 语义层只算出计划，写 item_sources / item_history 的是数据层——不先冻这个返回值，
 * 两边会各自发明一个。
 *
 * reschedule 单独成一档而不是并进 merge_into：改期本身是画像信号（「日期推移」），
 * 落库时要多写一行 item_history，并且要知道是哪条碎片把日期推走的。
 *
 * reschedule 带 field 而不是让数据层去猜移的是哪一列：事件用 starts_at、事务用 due_at，
 * 两边各猜一次就会出现「把日期写进事件的 due_at、starts_at 原封不动」这种谁都不报错的错。
 * 判断该动哪一列的信息在语义层，所以由语义层给出。
 */
export type MergePlan =
  | { action: 'new' }
  | { action: 'merge_into'; itemId: string }
  | {
      action: 'reschedule'
      itemId: string
      field: 'starts_at' | 'due_at'
      from: string | null
      to: string | null
    }

/** dedupe 的输出：与抽取出的每一条一一对应。 */
export type PlannedItem = {
  extracted: ExtractedItem
  plan: MergePlan
}
