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

function isResponseFormatUnavailable(e: unknown): boolean {
  return e instanceof OpenAI.BadRequestError &&
    String((e as { message?: string }).message).includes('response_format')
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
    messages: [
      { role: 'system', content: system },
      { role: 'user', content },
    ],
    response_format: responseFormat,
  })

  const text = res.choices[0]?.message?.content
  if (!text) throw new Error(`模型没有返回内容：${JSON.stringify(res.choices[0])}`)
  try {
    return JSON.parse(text)
  } catch {
    // 不猜着修，把原样打出来——JSON 解析失败说明 structured output 没生效，是配置问题。
    throw new Error(`模型返回的不是合法 JSON：\n${text}`)
  }
}
