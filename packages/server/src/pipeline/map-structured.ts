import type { Ctx, ExtractedItem, Fragment } from '@flowpal/shared'

/**
 * 结构化碎片 → 条目候选，不经模型。
 *
 * 课表、考试安排、ICS 拉回来已经是准确的结构，喂给模型只会让它变得不准，还慢、还花钱。
 * 碎片照样落库（raw_type='structured'，原始 JSON 存在 raw_text 里），
 * 但到条目走这条确定性的路。
 *
 * 待实现：教务系统接入落地后，按拉回来的结构补齐各来源的映射。
 */
export function mapStructured(_ctx: Ctx, fragment: Fragment): ExtractedItem[] {
  if (fragment.rawType !== 'structured') {
    throw new Error(`mapStructured 只接结构化碎片，收到 ${fragment.rawType}`)
  }
  if (fragment.rawText === null) {
    throw new Error(`结构化碎片 ${fragment.id} 没有 raw_text`)
  }

  const payload = JSON.parse(fragment.rawText) as { kind?: string }
  switch (payload.kind) {
    default:
      throw new Error(
        `未知的结构化来源 kind=${payload.kind}；映射还没写。` +
        `课表 / 考试 / ICS 的映射随教务接入一起补。`,
      )
  }
}
