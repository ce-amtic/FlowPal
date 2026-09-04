import type { Ctx, ExtractedItem, Item, MergePlan, PlannedItem } from '@flowpal/shared'

/**
 * 去重与合并。语义层的活儿，不碰数据库：只算出计划，写库的是 store/items.ts。
 *
 * 同一件事从多个来源进来是常态——同一场考试会从群通知、邮件、课表三处进来。
 * 规则（设计文档 §4.2）：
 *   - 标题相似 + 日期相同或相近（±1 天）→ 同一条，来源列表追加
 *   - 日期不同但标题高度相似 → 日期变更，保留历史并标记改期
 *
 * 待细化：标题相似度现在是字面重合度，效果不够时改成再调一次模型判断。
 */
export function dedupe(_ctx: Ctx, candidates: ExtractedItem[], existing: Item[]): PlannedItem[] {
  return candidates.map((extracted) => ({ extracted, plan: planFor(extracted, existing) }))
}

function planFor(e: ExtractedItem, existing: Item[]): MergePlan {
  // 念头和状态不合并：两条一样的念头是两次不同时刻的念头。
  if (e.type === 'thought' || e.type === 'state') return { action: 'new' }

  // 事件的日期在 starts_at，事务的在 due_at。改期动的是哪一列由这里定，不让数据层去猜。
  const field = e.type === 'event' ? 'starts_at' : 'due_at'
  const candidateDate = field === 'starts_at' ? (e.starts_at ?? e.due_at) : (e.due_at ?? e.starts_at)
  let bestTitleMatch: Item | null = null

  for (const item of existing) {
    if (item.type !== e.type) continue
    if (!titlesLookAlike(item.title, e.title)) continue

    const existingDate = field === 'starts_at' ? (item.startsAt ?? item.dueAt) : (item.dueAt ?? item.startsAt)
    if (candidateDate && existingDate && withinDays(candidateDate, existingDate, 1)) {
      return { action: 'merge_into', itemId: item.id }
    }
    if (!candidateDate || !existingDate) return { action: 'merge_into', itemId: item.id }
    bestTitleMatch = item
  }

  if (bestTitleMatch) {
    // 标题高度相似但日期对不上 = 改期。这本身是画像信号，落库时要多写一行历史。
    return {
      action: 'reschedule',
      itemId: bestTitleMatch.id,
      field,
      from: field === 'starts_at' ? bestTitleMatch.startsAt : bestTitleMatch.dueAt,
      to: candidateDate,
    }
  }
  return { action: 'new' }
}

const SIMILARITY_THRESHOLD = 0.6

function titlesLookAlike(a: string, b: string): boolean {
  const setA = new Set(a.replace(/\s+/g, ''))
  const setB = new Set(b.replace(/\s+/g, ''))
  if (setA.size === 0 || setB.size === 0) return false
  let shared = 0
  for (const ch of setA) if (setB.has(ch)) shared += 1
  return shared / Math.min(setA.size, setB.size) >= SIMILARITY_THRESHOLD
}

function withinDays(a: string, b: string, days: number): boolean {
  const diff = Math.abs(new Date(a).getTime() - new Date(b).getTime())
  return diff <= days * 86_400_000
}
