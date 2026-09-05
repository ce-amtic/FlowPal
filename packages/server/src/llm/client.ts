import OpenAI from 'openai'
import type { ModelConfig } from '../config.ts'

/**
 * 供应商是配置不是代码路径：换一家是改 config.local.json 里的三个字段，不是改代码。
 * 只认 OpenAI 兼容的 chat completions。
 *
 * 结构化输出按「严格模式优先、json_object 兜底」：
 *   - 先发 response_format: json_schema（strict），schema 由服务端强制；
 *   - 供应商不支持时（DeepSeek v4 实测回「This response_format type is unavailable
 *     now」），重试一次 json_object，并把同一份 schema 塞进 system prompt。
 * 两条路的入库校验都是同一份 zod schema + 逐字引用检查，兜底不会降低验收标准，
 * 只把「形状对不对」的保证从服务端移到我们这一侧。
 */
export type JsonCall = {
  system: string
  user: string
  /** 图片：data URI 或 http(s) URL。给了就走 vision 模型。 */
  images?: string[]
  schemaName: string
  /** z.toJSONSchema 产物；给 null 表示这次调用不需要结构化输出。 */
  jsonSchema: unknown
}

export async function callJson(model: ModelConfig, call: JsonCall): Promise<unknown> {
  const client = new OpenAI({ baseURL: model.baseUrl, apiKey: model.apiKey })

  if (call.jsonSchema === null) {
    return attempt(client, model, call, { type: 'json_object' }, call.system)
  }
  try {
    return await attempt(client, model, call, {
      type: 'json_schema',
      json_schema: { name: call.schemaName, strict: true, schema: call.jsonSchema as any },
    }, call.system)
  } catch (e) {
    if (!isResponseFormatUnavailable(e)) throw e
    // 兜底：json_object + prompt 里的同一份 schema。形状仍由入库前的 zod 校验守住。
    const systemWithSchema = call.system +
      '\n\n输出必须是合法 JSON，且严格符合下面的 JSON Schema，不要输出任何其他内容：\n' +
      JSON.stringify(call.jsonSchema)
    return attempt(client, model, call, { type: 'json_object' }, systemWithSchema)
  }
}

/**
 * 每次调用打一行用量，重点是前缀缓存命中了多少。
 *
 * 不打就只能猜：上下文怎么排对缓存友不友好，是个可以量的问题，而在量到之前
 * 所有关于它的说法都是编的。DeepSeek 在 usage 里给 prompt_cache_hit_tokens /
 * prompt_cache_miss_tokens；别的供应商没有这两个字段时只打总数。
 */
function logUsage(label: string, usage: OpenAI.CompletionUsage | undefined): void {
  if (!usage) return
  const u = usage as OpenAI.CompletionUsage & {
    prompt_cache_hit_tokens?: number
    prompt_cache_miss_tokens?: number
  }
  const hit = u.prompt_cache_hit_tokens
  const cache = hit === undefined
    ? ''
    : ` 缓存命中 ${hit}/${usage.prompt_tokens}（${Math.round(hit / Math.max(usage.prompt_tokens, 1) * 100)}%）`
  console.log(`[llm ${label}] 入 ${usage.prompt_tokens} 出 ${usage.completion_tokens}${cache}`)
}

function isResponseFormatUnavailable(e: unknown): boolean {
  return e instanceof OpenAI.BadRequestError &&
    String((e as { message?: string }).message).includes('response_format')
}

export type AgentToolSpec = {
  name: string
  description: string
  /** z.toJSONSchema 产物。 */
  parameters: unknown
  /** 仅 createItem 用 strict；其余工具 partial 参数不适合 strict。 */
  strict?: boolean
}

export type AgentToolCall = {
  id: string
  name: string
  args: Record<string, unknown>
}

export type AgentCallResult = {
  text: string | null
  toolCalls: AgentToolCall[]
}

/**
 * agent 循环用：带工具的 chat completions。与 callJson 是两种用法——
 * callJson 给「此刻」这种一次只读生成用，这里给要改库的循环用。
 * 工具参数不合法由我们的 executeTool 返回错误，允许模型在下一步改。
 */
export async function callAgent(
  model: ModelConfig,
  call: { messages: OpenAI.Chat.ChatCompletionMessageParam[]; tools: AgentToolSpec[] },
): Promise<AgentCallResult> {
  const client = new OpenAI({ baseURL: model.baseUrl, apiKey: model.apiKey })
  const res = await client.chat.completions.create({
    model: model.model,
    // 供应商专属字段原样透传，见 ModelConfig.params
    ...model.params,
    messages: call.messages,
    tools: call.tools.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters as any,
        ...(t.strict ? { strict: true } : {}),
      },
    })),
    tool_choice: 'auto',
  })

  logUsage('agent', res.usage)

  const msg = res.choices[0]?.message
  const toolCalls: AgentToolCall[] = []
  for (const tc of msg?.tool_calls ?? []) {
    let args: Record<string, unknown> = {}
    try {
      args = JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>
    } catch {
      // 工具参数不是合法 JSON 是模型/网关问题，大声失败，不猜着修。
      throw new Error(`工具调用参数不是合法 JSON：${tc.function.name} / ${tc.function.arguments}`)
    }
    toolCalls.push({ id: tc.id, name: tc.function.name, args })
  }
  return { text: msg?.content ?? null, toolCalls }
}

async function attempt(
  client: OpenAI, model: ModelConfig, call: JsonCall,
  responseFormat: OpenAI.Chat.Completions.ChatCompletionCreateParams['response_format'],
  system: string,
): Promise<unknown> {
  const content: OpenAI.Chat.ChatCompletionContentPart[] = [{ type: 'text', text: call.user }]
  for (const url of call.images ?? []) content.push({ type: 'image_url', image_url: { url } })

  const res = await client.chat.completions.create({
    model: model.model,
    // 供应商专属字段原样透传，见 ModelConfig.params
    ...model.params,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content },
    ],
    response_format: responseFormat,
  })

  logUsage(call.schemaName, res.usage)

  const text = res.choices[0]?.message?.content
  if (!text) throw new Error(`模型没有返回内容：${JSON.stringify(res.choices[0])}`)
  try {
    return JSON.parse(text)
  } catch {
    // 不猜着修，把原样打出来——JSON 解析失败说明 structured output 没生效，是配置问题。
    throw new Error(`模型返回的不是合法 JSON：\n${text}`)
  }
}
