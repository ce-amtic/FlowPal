import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
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
    images: isImage && fragment.rawBlobPath
      ? [toDataUri(config.promptsDir, fragment.rawBlobPath)]
      : undefined,
    schemaName: 'extract_output',
    jsonSchema: extractJsonSchema(),
    // 抽取要读懂一段乱七八糟的原文，没人在等它的秒数——和改库那条同一档
    effort: 'low',
  })

  const parsed = ExtractOutput.safeParse(fillAbsentNullableFields(raw))
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

/**
 * 把可空字段里缺席的键补成 null。
 *
 * strict json_schema 会强制每个字段出现；json_object 兜底模式没有这个保证——
 * 有的供应商会干脆省掉值为 null 的键（DeepSeek v4 实测省 starts_at）。这是机械
 * 补形，不猜语义：引文逐字校验仍然在下面照常执行。严格模式生效时这是个 no-op。
 */
function fillAbsentNullableFields(raw: unknown): unknown {
  const NULLABLE = [
    'starts_at', 'due_at', 'date_precision', 'date_raw', 'recurrence',
    'location', 'date_confidence',
  ]
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>
    for (const item of Array.isArray(obj.items) ? obj.items : []) {
      if (item && typeof item === 'object') {
        const it = item as Record<string, unknown>
        for (const key of NULLABLE) if (!(key in it)) it[key] = null
      }
    }
  }
  return raw
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

/** 相对路径按仓库根解析（promptsDir 恒在仓库根的 prompts/ 下），不按进程 cwd。 */
function toDataUri(promptsDir: string, blobPath: string): string {
  const path = isAbsolute(blobPath) ? blobPath : join(promptsDir, '..', blobPath)
  const bytes = readFileSync(path)
  const ext = path.split('.').pop()?.toLowerCase() ?? 'png'
  const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`
  return `data:${mime};base64,${bytes.toString('base64')}`
}
