import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type OpenAI from 'openai'
import type { AgentToolName, Ctx, Fragment, RunCounts } from '@flowpal/shared'
import { agentToolParameters, markupGuide } from '@flowpal/shared'
import type { ServerConfig } from '../config.ts'
import { callAgent, type AgentToolSpec } from '../llm/client.ts'
import { buildAgentContext } from './context.ts'
import { executeAgentTool } from './tools.ts'

export type AgentLoopEvent = { step: number; tool: string; args: Record<string, unknown> }

export type AgentLoopResult = {
  status: 'done' | 'failed' | 'limit'
  message: string | null
  counts: RunCounts
}

const MAX_STEPS = 8

const TOOL_DEFS: { name: AgentToolName; description: string; strict?: boolean }[] = [
  { name: 'getItem', description: '按 id 读取一条条目的全字段、来源碎片原文与引用。拿不准某条是什么时先读它。' },
  { name: 'searchItems', description: '在窗口之外的条目里按关键词查。query 匹配标题或原始日期表达；from/to 是 YYYY-MM-DD，可空。' },
  { name: 'getProject', description: '按 id 读取项目的状态说明（status_note）与该项目下全部条目。' },
  {
    name: 'createItem', strict: true,
    description: '新建一条条目。参数就是抽取契约；project 三选一：existing / new / none，前两种必须带逐字 quote。进度类条目必须给 existing 或 new。'
  },
  { name: 'updateItem', description: '修改已有条目，例如改期、标完成、改标题或改归属。patch 只传要改的字段；citations 可选。' },
  { name: 'dropItem', description: '标记丢弃已有条目（不是删除）。只有这条确实作废时才用。' },
]

function toolSpecs(): AgentToolSpec[] {
  return TOOL_DEFS.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: agentToolParameters(t.name),
    strict: t.strict,
  }))
}

/**
 * 写库的唯一机制：一次带工具的模型调用序列。输入是一条碎片，输出是若干工具调用加一句回执。
 * 步数上限 8，超出即 limit；已落库的写入不回滚——它们各自有效，重跑时在条目清单里看得见。
 */
export async function runAgentLoop(
  config: ServerConfig, db: DatabaseSync, ctx: Ctx, fragment: Fragment,
  emitToolCall?: (e: AgentLoopEvent) => void,
): Promise<AgentLoopResult> {
  const model = fragment.rawType === 'image' ? config.llm.vision : config.llm.text
  /*
   * 语法说明由元素表生成，不写在 agent.md 里。手写的那一份会和表分头演化，而它们
   * 不一致的症状是「模型用了应用不认识的标签」——回复看着正常，只是那一行变成纯
   * 文字，没有任何地方会报错。
   */
  const system = `${readFileSync(join(config.promptsDir, 'agent.md'), 'utf8')}\n\n${markupGuide()}`

  const userText = buildAgentContext(db, ctx, fragment)
  const userContent: OpenAI.Chat.ChatCompletionContentPart[] = [{ type: 'text', text: userText }]
  if (fragment.rawType === 'image' && fragment.rawBlobPath) {
    userContent.push({ type: 'image_url', image_url: { url: toDataUri(config.promptsDir, fragment.rawBlobPath) } })
  }

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: system },
    { role: 'user', content: userContent },
  ]

  const counts: RunCounts = { created: 0, updated: 0, dropped: 0, needsConfirm: 0 }
  const updatedIds = new Set<string>()
  const droppedIds = new Set<string>()

  for (let step = 1; step <= MAX_STEPS; step += 1) {
    /*
     * 这条路在改库，而且改错了要靠人回头去发现——合并到哪一条、算不算同一件事，
     * 都是要想一下的判断。用户不在等这一步的结果（回执随后才出现），几秒钟换稳当
     * 是划算的。
     */
    const res = await callAgent(model, { messages, tools: toolSpecs(), effort: 'low' })
    if (res.toolCalls.length === 0) {
      counts.updated = updatedIds.size
      counts.dropped = droppedIds.size
      return { status: 'done', message: res.text ?? '接住了。原文已存。', counts }
    }

    messages.push({
      role: 'assistant',
      content: res.text ?? null,
      tool_calls: res.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: JSON.stringify(tc.args) },
      })),
    } as any)

    for (const tc of res.toolCalls) {
      emitToolCall?.({ step, tool: tc.name, args: tc.args })
      const executed = executeAgentTool(db, ctx, fragment, tc.name, tc.args)
      messages.push({ role: 'tool', tool_call_id: tc.id, content: executed.content } as any)
      if (executed.touched?.action === 'created') {
        counts.created += 1
        if (executed.touched.needsConfirm) counts.needsConfirm += 1
      } else if (executed.touched?.action === 'updated') {
        updatedIds.add(executed.touched.itemId)
      } else if (executed.touched?.action === 'dropped') {
        droppedIds.add(executed.touched.itemId)
      }
    }
  }

  counts.updated = updatedIds.size
  counts.dropped = droppedIds.size
  return { status: 'limit', message: '这条太复杂，没能处理完。原文已存。', counts }
}

/** 相对路径按仓库根解析（promptsDir 恒在仓库根的 prompts/ 下），不按进程 cwd。 */
function toDataUri(promptsDir: string, blobPath: string): string {
  const path = isAbsolute(blobPath) ? blobPath : join(promptsDir, '..', blobPath)
  const bytes = readFileSync(path)
  const ext = path.split('.').pop()?.toLowerCase() ?? 'png'
  const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`
  return `data:${mime};base64,${bytes.toString('base64')}`
}
