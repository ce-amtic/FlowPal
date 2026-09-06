import {
  MARKUP_CONTAINERS, MARKUP_ELEMENTS, parseMarkup, type MarkupBlock,
} from '../src/markup.ts'

/**
 * 解析器的对照集。
 *
 * 判据是手写的期望，不是解析器自己说了算——这里量的正好是「模型写歪了会怎样」，
 * 而那是我们最不希望靠肉眼在演示当天发现的东西。
 *
 * 每一条畸形输入的期望都是同一句话：**别丢内容，别抛异常。**
 */
type Case = { name: string; source: string; expect: (blocks: MarkupBlock[]) => boolean }

const summary = (blocks: MarkupBlock[]): string =>
  blocks.map((b) => {
    if (b.kind === 'text') {
      const inner = b.spans
        .map((s) => (s.kind === 'text' ? s.text : `<${s.tag}:${s.subject}>`))
        .join('')
      return `text(${inner.replace(/\n/g, '⏎')})`
    }
    if (b.kind === 'run') {
      const items = b.items
        .map((i) => i.subject + i.quotes.map((q) => `+${q.tag}`).join(''))
        .join(',')
      return `run:${b.tag}[${items}]`
    }
    return `group:${b.tag}(${b.title})<${summary(b.blocks)}>`
  }).join(' ')

const CASES: Case[] = [
  {
    name: '一段话就是一段话',
    source: '这周压得比较满。',
    expect: (b) => summary(b) === 'text(这周压得比较满。)',
  },
  {
    name: '连着的同类并成一组',
    source: '::item itm_a\n::item itm_b\n::item itm_c',
    expect: (b) => summary(b) === 'run:item[itm_a,itm_b,itm_c]',
  },
  {
    name: '话与组交替，各自成块',
    source: '这周满。\n\n::item itm_a\n::item itm_b\n\n高数不急。',
    expect: (b) => summary(b) === 'text(这周满。) run:item[itm_a,itm_b] text(高数不急。)',
  },
  {
    name: '正文是第一个空格之后的整行，不受空格影响',
    source: '::item itm_a 还差三张图，明天下午要用',
    expect: (b) => b[0]?.kind === 'run' && b[0].items[0]?.body === '还差三张图，明天下午要用',
  },
  {
    name: '属性在主语之后、正文之前',
    source: '::item itm_a {show=location} 地点换了',
    expect: (b) => b[0]?.kind === 'run'
      && b[0].items[0]?.attrs.show === 'location'
      && b[0].items[0]?.body === '地点换了',
  },
  {
    name: '不认识的属性忽略掉，不算错',
    source: '::item itm_a {show=due bogus=1} 明天',
    expect: (b) => b[0]?.kind === 'run' && b[0].items[0]?.attrs.show === 'due',
  },
  {
    name: '不认识的标签原样当文字，不丢',
    source: '::sparkline itm_a 看这个',
    expect: (b) => summary(b) === 'text(::sparkline itm_a 看这个)',
  },
  {
    name: '模型习惯写成列表，行首记号剥掉',
    source: '- ::item itm_a\n* ::item itm_b',
    expect: (b) => summary(b) === 'run:item[itm_a,itm_b]',
  },
  {
    name: '容器没闭合，到结尾自动闭合',
    source: ':::list 这周\n::item itm_a',
    expect: (b) => summary(b) === 'group:list(这周)<run:item[itm_a]>',
  },
  {
    name: '不认识的容器照样收内容',
    source: ':::whatever 标题\n::item itm_a\n:::',
    expect: (b) => summary(b) === 'group:list(标题)<run:item[itm_a]>',
  },
  {
    name: '按天排开的容器认下来，标签不被降成 list',
    source: ':::days 这周\n::item itm_a\n::item itm_b\n:::',
    expect: (b) => summary(b) === 'group:days(这周)<run:item[itm_a,itm_b]>',
  },
  {
    name: '容器可以不带标题',
    source: ':::days\n::item itm_a\n:::',
    expect: (b) => summary(b) === 'group:days()<run:item[itm_a]>',
  },
  {
    name: '原文紧跟着同一条，挂到那一行下面',
    source: '::item itm_a 日期是你写的\n::quote itm_a {field=due_at}',
    expect: (b) => summary(b) === 'run:item[itm_a+quote]',
  },
  {
    name: '挂靠不影响后面的条目继续并进同一组',
    source: '::item itm_a\n::quote itm_a\n::item itm_b',
    expect: (b) => summary(b) === 'run:item[itm_a+quote,itm_b]',
  },
  {
    name: '原文的 id 和上一条对不上就不挂，自成一块，内容不丢',
    source: '::item itm_a\n::quote itm_b',
    expect: (b) => summary(b) === 'run:item[itm_a] run:quote[itm_b]',
  },
  {
    name: '没有上一条的原文自成一块',
    source: '::quote itm_a',
    expect: (b) => summary(b) === 'run:quote[itm_a]',
  },
  {
    name: '隔了一段话就不再挂靠',
    source: '::item itm_a\n\n另外说一句。\n\n::quote itm_a',
    expect: (b) => summary(b) === 'run:item[itm_a] text(另外说一句。) run:quote[itm_a]',
  },
  {
    name: '动作的正文是那一步，整行都算',
    source: '::start itm_a 先把第三题那张图补上',
    expect: (b) => b[0]?.kind === 'run' && b[0].tag === 'start'
      && b[0].items[0]?.body === '先把第三题那张图补上',
  },
  {
    name: '动作可以不带正文',
    source: '::start itm_a',
    expect: (b) => b[0]?.kind === 'run' && b[0].items[0]?.body === '',
  },
  {
    name: '指标只点名，不带正文',
    source: '::stat prj_x {metric=idle}',
    expect: (b) => b[0]?.kind === 'run' && b[0].tag === 'stat'
      && b[0].items[0]?.subject === 'prj_x'
      && b[0].items[0]?.attrs.metric === 'idle'
      && b[0].items[0]?.body === '',
  },
  {
    name: '模型自己写了数字也只是正文，不会变成那个数',
    source: '::stat prj_x {metric=idle} 12 天',
    expect: (b) => b[0]?.kind === 'run' && b[0].items[0]?.body === '12 天',
  },
  {
    name: '项目和条目各自成组，不混进同一组',
    source: '::item itm_a\n::project prj_x\n::item itm_b',
    expect: (b) => summary(b) === 'run:item[itm_a] run:project[prj_x] run:item[itm_b]',
  },
  {
    name: '句子中间的引用认下来，不留光秃秃的 id',
    source: '另外 ::item itm_x 也要盯一下。',
    expect: (b) => summary(b) === 'text(另外 <item:itm_x> 也要盯一下。)',
  },
  {
    name: '散文里偶然的冒号不会被误当成标记',
    source: '他说：::不知道 反正不是标签',
    expect: (b) => summary(b) === 'text(他说：::不知道 反正不是标签)',
  },
  {
    name: '一条完整的回复：话、按天排开的一组带凭据、收尾的动作',
    source: [
      '这周前半段挤，后半段空。',
      '',
      ':::days 这周',
      '::item itm_a 上次做到第三题',
      '::quote itm_a {field=due_at}',
      '::item itm_b',
      ':::',
      '',
      '::start itm_a 先把第三题那张图补上',
    ].join('\n'),
    expect: (b) => summary(b) === 'text(这周前半段挤，后半段空。)'
      + ' group:days(这周)<run:item[itm_a+quote,itm_b]>'
      + ' run:start[itm_a]',
  },
  {
    /*
     * 中文里 id 后面常常直接跟标点，没有空格。主语要是按「非空白」取，整句后半段
     * 会被一起吞掉，屏幕上那半句凭空消失——真跑出来过一次。
     */
    name: '句中引用后面紧跟中文标点，后半句不能丢',
    source: '明确写了地点的只有那条组会 ::item itm_c64e，在立德楼803。',
    expect: (b) => {
      const block = b[0]
      if (block?.kind !== 'text') return false
      const ref = block.spans.find((s) => s.kind === 'ref')
      const tail = block.spans[block.spans.length - 1]
      return ref?.kind === 'ref' && ref.subject === 'itm_c64e'
        && tail?.kind === 'text' && tail.text === '，在立德楼803。'
    },
  },
  {
    name: '整行的主语后面紧跟中文标点，正文照样取得到',
    source: '::item itm_a1，还差三张图',
    expect: (b) => summary(b) === 'run:item[itm_a1]',
  },
  {
    /*
     * 多打一个冒号，把元素写成了容器。当容器收的话，元素的名字会变成标题——
     * 屏幕上就是一行光秃秃的 id。真跑出来过一次。
     */
    name: '把 ::item 写成 :::item，仍然当元素收',
    source: ':::item itm_a1 机器学习部分',
    expect: (b) => summary(b) === 'run:item[itm_a1]',
  },
  {
    name: '空输入不炸',
    source: '',
    expect: (b) => b.length === 0,
  },
  {
    name: '只有一个孤零零的冒号不炸',
    source: '::',
    expect: (b) => summary(b) === 'text(::)',
  },
]

/** 这段解析结果里有没有真的长出这个标签——包括挂在某一行下面的那种 */
function mentions(blocks: MarkupBlock[], tag: string): boolean {
  return blocks.some((b) => {
    if (b.kind === 'run') {
      return b.tag === tag || b.items.some((i) => i.quotes.some((q) => q.tag === tag))
    }
    if (b.kind === 'group') return mentions(b.blocks, tag)
    return b.spans.some((s) => s.kind === 'ref' && s.tag === tag)
  })
}

/**
 * 表里每个标签的示例，必须真的解析成它自己。
 *
 * 示例是模型唯一照着抄的东西：那里一个笔误，教出来的就是一整类解析不出来的回复，
 * 而且屏幕上看着一切正常。所以示例和解析器共用同一份判据。
 */
const EXAMPLE_CASES: Case[] = [
  ...MARKUP_ELEMENTS.map((el) => ({
    name: `::${el.tag} 的示例解析成 ::${el.tag}`,
    source: el.example,
    expect: (b: MarkupBlock[]) => mentions(b, el.tag),
  })),
  ...MARKUP_CONTAINERS.map((c) => ({
    name: `:::${c.tag} 的示例解析成 :::${c.tag}`,
    source: c.example,
    expect: (b: MarkupBlock[]) => {
      const g = b[0]
      // 里面得有东西：一个空容器示范不了任何事
      return b.length === 1 && g?.kind === 'group' && g.tag === c.tag && g.blocks.length > 0
    },
  })),
]

let failed = 0
for (const c of [...CASES, ...EXAMPLE_CASES]) {
  let ok = false
  let detail = ''
  try {
    const blocks = parseMarkup(c.source)
    ok = c.expect(blocks)
    detail = summary(blocks)
  } catch (e) {
    detail = `抛异常：${e instanceof Error ? e.message : String(e)}`
  }
  if (!ok) failed += 1
  console.log(`${ok ? '  ✓' : '  ✗'} ${c.name}`)
  if (!ok) console.log(`      实得 ${detail}`)
}

console.log(failed === 0 ? '\n标记解析：全部通过' : `\n标记解析：${failed} 条不符`)
if (failed > 0) process.exit(1)
