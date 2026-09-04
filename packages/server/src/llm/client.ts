import OpenAI from 'openai'
import type { ModelConfig } from '../config.ts'

/**
 * 供应商是配置不是代码路径：换一家是改 config.local.json 里的三个字段，不是改代码。
 * 只认 OpenAI 兼容的 chat completions + structured output。
 */
export type JsonCall = {
  system: string
  user: string
  /** 图片：data URI 或 http(s) URL。给了就走 vision 模型。 */
  images?: string[]
  schemaName: string
  jsonSchema: unknown
}

export async function callJson(model: ModelConfig, call: JsonCall): Promise<unknown> {
  const client = new OpenAI({ baseURL: model.baseUrl, apiKey: model.apiKey })

  const content: OpenAI.Chat.ChatCompletionContentPart[] = [{ type: 'text', text: call.user }]
  for (const url of call.images ?? []) content.push({ type: 'image_url', image_url: { url } })

  const res = await client.chat.completions.create({
    model: model.model,
    messages: [
      { role: 'system', content: call.system },
      { role: 'user', content },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: call.schemaName, strict: true, schema: call.jsonSchema as any },
    },
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
