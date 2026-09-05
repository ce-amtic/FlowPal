/**
 * 回复标记：一段话里就地标出可以画出来的东西。
 *
 * 形状是 `::标签 主语 {属性} 正文`，容器是 `:::标签 标题 … :::`。
 *
 * 只有一条设计规则，其余都是它的推论：**属性只放机器味的值（id、枚举、日期、数字），
 * 自由文本一律放正文。** 值里不带空格，于是引号与转义整套消失，解析从左到右三步走完，
 * 模型也不必配对闭合什么。
 *
 * 第二条规则划的是权责：**模型只说给看什么，从不说长什么样。** 没有颜色、字号、
 * 强调——紧急感来自那条数据的截止日，不来自模型的形容词。所以回复不可能变丑，
 * 设计系统也不会被它慢慢蛀空。
 *
 * 这份表是单一来源：解析器认识哪些标签、界面怎么渲染、提示词里那段语法说明，
 * 三者都从这里出。分开写的话迟早出现「提示词教了一个应用不会渲染的标签」，
 * 而那是最难查的一种漂移。
 */

/** 主语是什么。none 表示这个标签不带主语 */
export type SubjectKind = 'item' | 'project' | 'fragment' | 'none'

export type ElementSpec = {
  tag: string
  subject: SubjectKind
  /** 属性名 → 给模型看的说明。值一律不带空格 */
  attrs: Record<string, string>
  /** 正文的用途；空串表示这个标签不该带正文 */
  body: string
  summary: string
  example: string
}

export type ContainerSpec = {
  tag: string
  summary: string
  example: string
}

/**
 * 元素表。
 *
 * 每加一个标签，此前写好的回复照样能渲染——这是它比「封闭的一组视图」强的地方：
 * 词汇量可以从一开始，盖不住的部分本来就退化成话，而话是默认形态不是失败。
 */
export const MARKUP_ELEMENTS: ElementSpec[] = [
  {
    tag: 'item',
    subject: 'item',
    attrs: {
      show: '要突出这条的哪个字段：due / location / project / history。可省',
    },
    body: '你对这一条要说的一句话。可省',
    summary: '指出一条具体的事。标题、日期、状态都由应用查出来，你只给 id 和你的判断',
    example: '::item itm_a1b2 还差三张图',
  },
]

/** 容器表。容器只在你想说一句关于这一组的话时才用；连着写同类元素已经会自动成组 */
export const MARKUP_CONTAINERS: ContainerSpec[] = []

const ELEMENT_BY_TAG = new Map(MARKUP_ELEMENTS.map((e) => [e.tag, e]))
const CONTAINER_BY_TAG = new Map(MARKUP_CONTAINERS.map((c) => [c.tag, c]))

export type MarkupElement = {
  tag: string
  subject: string | null
  attrs: Record<string, string>
  body: string
}

/**
 * 一段话里的一截。
 *
 * 同一个元素，独占一行是一整行，夹在句子中间就是一枚小标签——由位置决定，不由模型
 * 决定，它少一个要做的选择就少一处会做错。夹在句中时只认标签和主语：那一行剩下的
 * 是句子本身，没有地方放正文。
 */
export type MarkupSpan =
  | { kind: 'text'; text: string }
  | { kind: 'ref'; tag: string; subject: string }

export type MarkupBlock =
  /** 一段普通的话 */
  | { kind: 'text'; spans: MarkupSpan[] }
  /** 连着的同类元素。合成一组是渲染上的事，在这里就先并好，渲染那边才不用再判一次 */
  | { kind: 'run'; tag: string; items: MarkupElement[] }
  | { kind: 'group'; tag: string; title: string; blocks: MarkupBlock[] }

/**
 * 解析。
 *
 * 兜住模型跑偏的几条都在这里，一条都不抛异常：不认识的标签整行当文字，不认识的
 * 属性忽略，容器没闭合到结尾自动闭合，行首挂了 `-` / `*` 先剥掉。屏幕上宁可多出
 * 一行没渲染的字，也不能因为一个标签写错就整条回复空白。
 */
export function parseMarkup(source: string): MarkupBlock[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const root: MarkupBlock[] = []
  /** 容器栈。只有栈顶在收行 */
  const stack: { tag: string; title: string; blocks: MarkupBlock[] }[] = []
  let paragraph: string[] = []

  const target = (): MarkupBlock[] => stack[stack.length - 1]?.blocks ?? root

  const flushParagraph = (): void => {
    const text = paragraph.join('\n').trim()
    paragraph = []
    if (text) target().push({ kind: 'text', spans: parseSpans(text) })
  }

  const pushElement = (el: MarkupElement): void => {
    const into = target()
    const last = into[into.length - 1]
    // 连着的同类并进上一组，而不是各自成块
    if (last?.kind === 'run' && last.tag === el.tag) last.items.push(el)
    else into.push({ kind: 'run', tag: el.tag, items: [el] })
  }

  for (const raw of lines) {
    // 模型习惯把东西写成列表，行首的记号先剥掉
    const line = raw.replace(/^\s*[-*]\s+/, '').trim()

    if (line === ':::') {
      flushParagraph()
      const closed = stack.pop()
      if (closed) target().push({ kind: 'group', tag: closed.tag, title: closed.title, blocks: closed.blocks })
      continue
    }

    if (line.startsWith(':::')) {
      flushParagraph()
      const { tag, rest } = splitTag(line.slice(3))
      // 不认识的容器照样收内容，只是不带标题——里面的东西比那个标题要紧
      stack.push({ tag: CONTAINER_BY_TAG.has(tag) ? tag : 'list', title: rest, blocks: [] })
      continue
    }

    if (line.startsWith('::')) {
      const { tag, rest } = splitTag(line.slice(2))
      const spec = ELEMENT_BY_TAG.get(tag)
      if (!spec) {
        // 不认识就当它是一句话，原样显示
        paragraph.push(line)
        continue
      }
      flushParagraph()
      pushElement(parseElement(spec, rest))
      continue
    }

    if (line === '') flushParagraph()
    else paragraph.push(line)
  }

  flushParagraph()
  // 没闭合的容器到结尾自动闭合，从里往外
  while (stack.length > 0) {
    const closed = stack.pop()!
    target().push({ kind: 'group', tag: closed.tag, title: closed.title, blocks: closed.blocks })
  }
  return root
}

/**
 * 句子里就地出现的引用。
 *
 * 模型被告知要让它独占一行，但它照样会写在句子中间——而那时候如果不认，屏幕上就
 * 会出现一个光秃秃的 id，是最难看的一种收场。所以这里认下来，渲染成一枚小标签。
 *
 * 只认表里有的标签，所以散文里偶然出现的冒号不会被误当成标记。
 */
function parseSpans(text: string): MarkupSpan[] {
  const spans: MarkupSpan[] = []
  const pattern = /::([a-zA-Z][\w-]*)\s+(\S+)/g
  let last = 0
  for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
    const tag = m[1]!
    if (!ELEMENT_BY_TAG.has(tag)) continue
    if (m.index > last) spans.push({ kind: 'text', text: text.slice(last, m.index) })
    spans.push({ kind: 'ref', tag, subject: m[2]! })
    last = m.index + m[0].length
  }
  if (last < text.length) spans.push({ kind: 'text', text: text.slice(last) })
  return spans
}

/** 从左往右三步：标签、主语、可省的 `{属性}`，剩下整行是正文 */
function parseElement(spec: ElementSpec, rest: string): MarkupElement {
  let remainder = rest
  let subject: string | null = null

  if (spec.subject !== 'none') {
    const match = /^(\S+)\s*/.exec(remainder)
    subject = match?.[1] ?? null
    remainder = remainder.slice(match?.[0].length ?? 0)
  }

  const attrs: Record<string, string> = {}
  if (remainder.startsWith('{')) {
    const end = remainder.indexOf('}')
    if (end !== -1) {
      for (const pair of remainder.slice(1, end).split(/\s+/)) {
        const eq = pair.indexOf('=')
        // 不认识的属性不算错——属性永远是增量的
        if (eq > 0) attrs[pair.slice(0, eq)] = pair.slice(eq + 1)
      }
      remainder = remainder.slice(end + 1)
    }
  }

  return { tag: spec.tag, subject, attrs, body: remainder.trim() }
}

function splitTag(rest: string): { tag: string; rest: string } {
  const match = /^([a-zA-Z][\w-]*)\s*/.exec(rest)
  if (!match) return { tag: '', rest: rest.trim() }
  return { tag: match[1]!, rest: rest.slice(match[0].length).trim() }
}

/**
 * 提示词里那段语法说明，由上面那张表生成。
 *
 * 之所以不手写进 prompts/：手写的那份会和这份表分头演化，而它们不一致时的症状是
 * 「模型用了一个应用不认识的标签」——回复看着正常，只是那一行变成了纯文字，
 * 没有任何地方会报错。
 */
export function markupGuide(): string {
  const lines: string[] = [
    '## 怎么把东西画出来',
    '',
    '你的回答就是一段话。话里凡是能指着一条具体东西说的，就用下面的写法把它标出来，',
    '让它在界面上变成真正的一行，而不是你把它的标题和日期再抄一遍。',
    '',
    '写法：`::标签 主语 {属性} 正文`，一行一个，独占一行。',
    '',
    '**标题、日期、状态、还剩几天，一律不要写进你的话里**——你只给 id，应用自己查，',
    '而且查出来的一定对。正文写的是那一句别人看不出来的判断；没有就不写。',
    '',
    '**正文里一个日期都不许出现。**不许写「周三晚上截止」「明天要交」「还剩五天」——',
    '那一行右边就写着，你再写一遍就是让人把同一件事读两遍。',
    '',
    '```',
    '不好  ::item itm_a1 今晚截止的数据结构第三次作业',
    '不好  ::item itm_a1 周三晚上的截止',
    '好    ::item itm_a1 上次做到第三题就停了',
    '好    ::item itm_a1',
    '```',
    '',
    '写不出这样一句就别写。空着比凑一句强。',
    '',
    '**要提到好几样东西时，把它们一条条指出来，不要在话里报菜名。**',
    '「还有实验课、体测、百团大战」这种一串名字，是三个 `::item`，不是一句话。',
    '',
    '**不要用问句收尾**，也不要在末尾提议再帮他做点什么。你答完了就停。',
    '让他读完之后手上的事更少，而不是又多一件要回答的。',
    '',
  ]

  for (const el of MARKUP_ELEMENTS) {
    lines.push(`### ::${el.tag}`, '', el.summary, '')
    if (el.body) lines.push(`正文：${el.body}`, '')
    for (const [name, desc] of Object.entries(el.attrs)) lines.push(`属性 \`${name}\`：${desc}`)
    if (Object.keys(el.attrs).length > 0) lines.push('')
    lines.push('```', el.example, '```', '')
  }

  lines.push(
    '连着写几个同类的，界面会把它们排成一组，你不用额外做什么。',
    '',
    '盖不住的情况就直接说话——这是正常的收场，不是失败。但凡能指出来的就别只用嘴说。',
  )
  return lines.join('\n')
}
