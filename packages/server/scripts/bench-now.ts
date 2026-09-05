import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ServerConfig } from '../src/config.ts'
import { loadConfig } from '../src/index.ts'

/**
 * 「此刻」的对照台：同一个库跑 N 次，量速度、用量，并按文案规则机器判一遍。
 *
 * 存在的理由是换模型、换推理强度这类决定不能靠肉眼看两三条输出就下。规则不是这里
 * 编的——它们来自外部写的三组范文（见 docs/文案需求-此刻.md 与那一轮的设计记录），
 * 这个脚本只是把其中能机器判的那部分自动化。判不了的（这句话读起来暖不暖）照样得人看，
 * 所以每一次的原文也打出来。
 *
 * 用法：先起 server（pnpm dev:server），再 `pnpm bench:now [次数]`。
 * 改 config.local.json 里的 llm.*.params 或 model，重启 server，再跑一次对比。
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
// 走 loadConfig 而不是直接读 JSON：dataDir 那几项由调用方补，server 自己不向环境要
const config = ServerConfig.parse(loadConfig(repoRoot))
const base = `http://${config.host}:${config.port}`
const runs = Number(process.argv[2] ?? 5)

type Pick = { itemId: string; title: string; reason: string; steps: string[] }
type Now = { primary: Pick | null; alternates: Pick[]; energy: string | null }

/** 一条规则一个判据。命中即违例，打印出来让人自己看那句话 */
const RULES: { name: string; hit: (text: string) => boolean }[] = [
  { name: '含糊词', hit: (t) => /相关|之前的|有关的|一些|适当|尽快|梳理|了解一下|熟悉一下|看一眼/.test(t) },
  { name: '复述统计', hit: (t) => /\d+\s*件事|\d+\s*个项目|\d+\s*次专注|共\s*\d+/.test(t) },
  { name: '机器格式', hit: (t) => /\d{4}-\d{2}-\d{2}|\d{1,2}:\d{2}:\d{2}/.test(t) },
  { name: '零计数', hit: (t) => /还没有开始|尚未开始|已完成\s*0|只完成了|一件都没/.test(t) },
  { name: '催促', hit: (t) => /别忘了|抓紧|尽快完成|要抓紧|加油|你可以的|别担心/.test(t) },
  { name: '公文腔', hit: (t) => /该任务|相关事项|需优先|建议优先处理|进行处理/.test(t) },
  { name: '报时', hit: (t) => /^(周[一二三四五六日]|今天|明天)?\s*(上午|下午|晚上|中午)?\s*\d+\s*点[，,]/.test(t) },
]

/**
 * 梯子由大到小。判据是 prompt 里那三类动作的顺序：先产出、再打开、最后定位。
 * 只判首尾——中间那级两边都说得通，硬判会把对的也判成错的。
 */
const PRODUCE = /写下|写上|列出|标出|改|填|记下|拟/
const LOCATE = /找到|打开|定位|搜|进入|翻到/

function ladderOk(steps: string[]): boolean {
  if (steps.length < 2) return false
  const first = steps[0]!
  const last = steps[steps.length - 1]!
  // 第一级要产出点东西；最后一级只是打开或找到，不该还要产出
  return PRODUCE.test(first) && LOCATE.test(last) && !PRODUCE.test(last)
}

/** 具体性：这一步里有没有出现这件事本身的字眼。全是通用词的一步放到任何事上都成立 */
function mentionsItem(step: string, title: string): boolean {
  for (let i = 0; i + 2 <= title.length; i += 1) {
    const gram = title.slice(i, i + 2)
    if (/[一-龥A-Za-z0-9]{2}/.test(gram) && step.includes(gram)) return true
  }
  return false
}

async function once(): Promise<{ seconds: number; now: Now }> {
  await fetch(`${base}/api/now/refresh`, { method: 'POST' })
  const started = Date.now()
  const res = await fetch(`${base}/api/now`)
  const now = await res.json() as Now
  return { seconds: (Date.now() - started) / 1000, now }
}

const model = config.llm.text
console.log(`模型 ${model.model} · params ${JSON.stringify(model.params)} · ${runs} 次\n`)

const times: number[] = []
let empty = 0
let ladderRight = 0
let specific = 0
let stepsTotal = 0
const violations = new Map<string, string[]>()

let unreachable = 0

for (let i = 1; i <= runs; i += 1) {
  // server 重启、掉线这类连不上，不该让整轮对照白跑——记一笔继续
  let result: Awaited<ReturnType<typeof once>>
  try {
    result = await once()
  } catch (e) {
    unreachable += 1
    console.log(`${i}. 连不上 server：${e instanceof Error ? e.message : String(e)}`)
    continue
  }
  const { seconds, now } = result
  times.push(seconds)

  if (!now.primary) {
    empty += 1
    console.log(`${i}. ${seconds.toFixed(1)}s  ✗ 空态（模型输出不合契约，或库里没有可推的）`)
    continue
  }

  const p = now.primary
  const ok = ladderOk(p.steps)
  if (ok) ladderRight += 1
  const named = p.steps.filter((s) => mentionsItem(s, p.title)).length
  specific += named
  stepsTotal += p.steps.length

  for (const rule of RULES) {
    for (const line of [now.energy ?? '', p.reason, ...p.steps]) {
      if (rule.hit(line)) violations.set(rule.name, [...(violations.get(rule.name) ?? []), line])
    }
  }

  console.log(`${i}. ${seconds.toFixed(1)}s  梯子${ok ? '对' : '✗ 错'}  具体 ${named}/${p.steps.length}`)
  console.log(`   精力：${now.energy ?? '（无）'}`)
  console.log(`   为什么：${p.reason}`)
  console.log(`   一步：${p.steps.join(' → ')}`)
}

if (times.length === 0) {
  console.log(`\n${runs} 次全都连不上 ${base}。先起 pnpm dev:server。`)
  process.exit(1)
}

const mean = times.reduce((a, b) => a + b, 0) / times.length
const sorted = [...times].sort((a, b) => a - b)
const done = runs - unreachable

console.log(`\n${done}/${runs} 次跑通：平均 ${mean.toFixed(1)}s，最快 ${sorted[0]!.toFixed(1)}s，最慢 ${sorted.at(-1)!.toFixed(1)}s`)
if (unreachable > 0) console.log(`连不上 ${unreachable} 次（不计入下面几项）`)
console.log(`空态 ${empty}/${done}`)
console.log(`梯子由大到小 ${ladderRight}/${done - empty}`)
console.log(`一步里提到了这件事本身 ${specific}/${stepsTotal}`)

if (violations.size === 0) {
  console.log('文案规则：没有命中')
} else {
  console.log('文案规则命中：')
  for (const [name, lines] of violations) {
    console.log(`  ${name} ×${lines.length}`)
    for (const line of [...new Set(lines)].slice(0, 3)) console.log(`    ${line}`)
  }
}

console.log('\n读起来暖不暖、说没说中处境，机器判不了，看上面每一次的原文。')
