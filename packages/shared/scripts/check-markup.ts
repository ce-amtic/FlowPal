import { parseMarkup, type MarkupBlock } from '../src/markup.ts'

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
    if (b.kind === 'run') return `run:${b.tag}[${b.items.map((i) => i.subject).join(',')}]`
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

let failed = 0
for (const c of CASES) {
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
