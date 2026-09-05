import { z } from 'zod'

/**
 * server 的全部环境依赖都从这里传入，不向环境要。
 * 这是「将来能把 server 抽成独立后端」的其中一条保证：desktop 包算好 dataDir 再调
 * createServer()，server 自己不知道 Electron 存在，也不知道 app.getPath('userData')。
 */
/** 请求体里由代码决定、配置不许覆盖的字段。写在这儿是为了覆盖时能大声报错 */
const OWNED_PARAMS = ['model', 'messages', 'tools', 'tool_choice', 'response_format', 'stream']

export const ModelConfig = z.object({
  baseUrl: z.string(),
  apiKey: z.string(),
  model: z.string(),
  /**
   * 原样并进请求体的额外字段。
   *
   * 各家都说自己是「OpenAI 兼容」，但控制推理强度这件事上谁也不一样：DeepSeek 同时有
   * 顶层 `reasoning_effort` 和它自己的 `thinking: {type}`，Anthropic 是
   * `thinking.budget_tokens`，Google 是 `thinkingConfig`，Qwen 是 `enable_thinking`。
   * 把它们逐个建模成类型字段，就是把「换一家」重新变成改代码。
   *
   * 所以这里不理解语义，只透传。代价是写错了要等供应商回 400——那是响亮的失败，
   * 可以接受；真正危险的是悄悄覆盖掉代码自己在用的字段，所以那些单独拦下来。
   */
  params: z.record(z.string(), z.unknown()).default({}).refine(
    (p) => !OWNED_PARAMS.some((k) => k in p),
    { message: `params 不能覆盖这些字段（它们由代码决定）：${OWNED_PARAMS.join(', ')}` },
  ),
})
export type ModelConfig = z.infer<typeof ModelConfig>

export const ServerConfig = z.object({
  /** 默认只监听本机。局域网监听（手机端）是显式开关，开了就要 token。 */
  host: z.string().default('127.0.0.1'),
  port: z.number().int().default(5123),
  dataDir: z.string(),
  /** prompts/ 的绝对路径。跟 dataDir 一样由调用方给——server 不靠模块相对路径找文件，
   *  那种路径在 desktop 那侧打包之后会指向错的地方，而且不会报错。 */
  promptsDir: z.string(),
  /** data/calendar.json 的绝对路径 */
  calendarPath: z.string(),
  /** 非 null 时校验 Authorization: Bearer <token>；绑 0.0.0.0 时必须有 */
  token: z.string().nullable().default(null),
  llm: z.object({
    text: ModelConfig,
    /** 图片不走 OCR，直接交视觉模型 */
    vision: ModelConfig,
  }),
  ruc: z.object({ studentId: z.string(), password: z.string() }).nullable().default(null),
})
export type ServerConfig = z.infer<typeof ServerConfig>

export function assertLanBindingIsAuthenticated(config: ServerConfig): void {
  if (config.host !== '127.0.0.1' && config.host !== 'localhost' && !config.token) {
    // 已识别的失败模式：黑客松公共 wifi 上挂一个无鉴权、能写库、能烧模型额度的接口。
    throw new Error(`绑定 ${config.host} 属于局域网监听，必须同时配 token`)
  }
}
