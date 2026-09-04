import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Ctx, Fragment } from '@flowpal/shared'
import { ExtractOutput, extractJsonSchema, weekOf } from '@flowpal/shared'
import type { ServerConfig } from '../config.ts'
import { callJson } from '../llm/client.ts'

/**
 * 非结构化碎片 → 条目候选。纯函数：不碰数据库，不读时钟（now 从 ctx 来）。
 *
 * 结构化来源（课表、考试、ICS）不走这里，走 map-structured.ts——
 * 那些数据已经是准确的结构，喂给模型只会让它变得不准。
 */
export async function extract(
  config: ServerConfig, ctx: Ctx, fragment: Fragment,
): Promise<ExtractOutput> {
  const isImage = fragment.rawType === 'image'
  const model = isImage ? config.llm.vision : config.llm.text

  const raw = await callJson(model, {
    system: readFileSync(join(config.promptsDir, 'extract.md'), 'utf8'),
    user: buildUserMessage(ctx, fragment),
    images: isImage && fragment.rawBlobPath ? [toDataUri(fragment.rawBlobPath)] : undefined,
    schemaName: 'extract_output',
    jsonSchema: extractJsonSchema(),
  })

  const parsed = ExtractOutput.safeParse(raw)
  if (!parsed.success) {
    // 校验不过就大声失败，把原始回复打出来，不猜着修。
    throw new Error(
      `模型输出不符合抽取契约：\n${JSON.stringify(parsed.error.issues, null, 2)}\n` +
      `原始回复：\n${JSON.stringify(raw, null, 2)}`,
    )
  }

  assertCitationsAreVerbatim(parsed.data, fragment)
  return parsed.data
}

/** now、校历、当前周次作为事实喂进去——「下周三」「第 8 周」只有有这些才算得出来。 */
function buildUserMessage(ctx: Ctx, fragment: Fragment): string {
  return [
    `当前时间：${ctx.now}（时区 ${ctx.tz}）`,
    `当前学期：${ctx.term.name}，第一教学周的周一是 ${ctx.term.startMonday}，共 ${ctx.term.weeks} 周`,
    `今天是本学期第 ${weekOf(ctx.term, ctx.now)} 周`,
    `碎片来源：${fragment.source}`,
    '',
    '原文：',
    fragment.rawText ?? '（无文本，见附图）',
  ].join('\n')
}

/**
 * 引用必须逐字出现在原文里。这是模型有没有瞎编的机器判据，与它输出什么无关，
 * 所以在抽取这一层就检查，而不是等到入库。图片碎片没有 rawText，跳过。
 */
function assertCitationsAreVerbatim(output: ExtractOutput, fragment: Fragment): void {
  if (fragment.rawText === null) return
  for (const item of output.items) {
    for (const c of item.citations) {
      if (!fragment.rawText.includes(c.quote)) {
        throw new Error(
          `引用不是原文的逐字片段，模型编了：字段 ${c.field}，引文「${c.quote}」\n` +
          `原文：\n${fragment.rawText}`,
        )
      }
    }
  }
}

function toDataUri(blobPath: string): string {
  const bytes = readFileSync(blobPath)
  const ext = blobPath.split('.').pop()?.toLowerCase() ?? 'png'
  const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`
  return `data:${mime};base64,${bytes.toString('base64')}`
}
