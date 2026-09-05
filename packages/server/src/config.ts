import { z } from 'zod'

/**
 * server 的全部环境依赖都从这里传入，不向环境要。
 * 这是「将来能把 server 抽成独立后端」的其中一条保证：desktop 包算好 dataDir 再调
 * createServer()，server 自己不知道 Electron 存在，也不知道 app.getPath('userData')。
 */
/** 请求体里由代码决定、配置不许覆盖的字段。写在这儿是为了覆盖时能大声报错 */
const OWNED_PARAMS = ['model', 'messages', 'tools', 'tool_choice', 'response_format', 'stream']

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
const ProviderParams = z.record(z.string(), z.unknown()).refine(
  (p) => !OWNED_PARAMS.some((k) => k in p),
  { message: `不能覆盖这些字段（它们由代码决定）：${OWNED_PARAMS.join(', ')}` },
)

/**
 * 思考强度的三档。
 *
 * 只有三档，因为再细的差别我们测不出来：`bench:now` 上「最低」和「默认」之间的
 * 波动已经大过它们的间距。
 *
 * 档位由调用点决定，不由配置决定——同一个模型，答「此刻」要快，改库要稳，
 * 这是两件事。配置只负责说明这一家怎么拼写这三档。
 */
export const Effort = z.enum(['none', 'low', 'high'])
export type Effort = z.infer<typeof Effort>

export const ModelConfig = z.object({
  baseUrl: z.string(),
  apiKey: z.string(),
  model: z.string(),
  /** 与调用点无关、每次请求都带上的字段 */
  params: ProviderParams.default({}),
  /**
   * 三档各自要往请求体里加什么。整张表要么不写（那就没有强度控制，等同于全用
   * 供应商默认），要么三档写全——缺一档就做默认回退的话，某个调用点会悄悄跑在
   * 别的强度上，而这种事只能靠账单发现。
   */
  effort: z.object({
    none: ProviderParams,
    low: ProviderParams,
    high: ProviderParams,
  }).optional(),
})
export type ModelConfig = z.infer<typeof ModelConfig>

/**
 * 学校邮箱。人大的邮箱是网易企业邮箱的一份部署，IMAP 在 `imap.ruc.edu.cn:993`。
 *
 * **password 是邮箱设置里那串「客户端授权码」，不是登录密码。** 网易那套默认不许
 * 拿登录密码走 IMAP，填错了只会得到一句认证失败，看不出是这个原因。
 *
 * 这是全程序唯一存密码的地方，因为 IMAP 没有别的凭据形式。门户那条路不存密码，
 * 见 sync/cookies.ts。不配这一段则整条邮件来源不跑，设置页显示「未配置」。
 */
export const MailConfig = z.object({
  host: z.string().default('imap.ruc.edu.cn'),
  port: z.number().int().default(993),
  user: z.string(),
  password: z.string(),
  /** 一次同步至多读几封。读邮件要过模型，配额就是花销的上限 */
  perRun: z.number().int().nonnegative().default(3),
})
export type MailConfig = z.infer<typeof MailConfig>

export const SyncConfig = z.object({
  /**
   * 一次同步至多把几条通知公告送进 agent 循环。
   *
   * 通知是散文，日期藏在句子里，只有模型算得出来，所以这一路要花钱。门户上通知
   * 每天几十条，没有配额的话，第一个早上就能把额度烧掉一大半，而那时没有人看着。
   * 设成 0 就是不处理通知，课表与校历照旧。
   */
  noticesPerRun: z.number().int().nonnegative().default(3),
  /** 自动同步的间隔（分钟）。课表与考试变化很慢，六小时绰绰有余 */
  intervalMinutes: z.number().int().positive().default(360),
})
export type SyncConfig = z.infer<typeof SyncConfig>

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
  sync: SyncConfig.default({ noticesPerRun: 3, intervalMinutes: 360 }),
  mail: MailConfig.nullable().default(null),
})
export type ServerConfig = z.infer<typeof ServerConfig>

export function assertLanBindingIsAuthenticated(config: ServerConfig): void {
  if (config.host !== '127.0.0.1' && config.host !== 'localhost' && !config.token) {
    // 已识别的失败模式：黑客松公共 wifi 上挂一个无鉴权、能写库、能烧模型额度的接口。
    throw new Error(`绑定 ${config.host} 属于局域网监听，必须同时配 token`)
  }
}
