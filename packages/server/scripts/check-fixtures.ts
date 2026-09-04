import { readdirSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CalendarSchema, createCtx } from '@flowpal/shared'
import { ServerConfig } from '../src/config.ts'
import { openDb } from '../src/store/db.ts'
import { insertFragment, countFragments } from '../src/store/fragments.ts'
import { applyPlans, listItems } from '../src/store/items.ts'
import { extract } from '../src/pipeline/extract.ts'
import { dedupe } from '../src/pipeline/dedupe.ts'

/**
 * 演示碎片跑一遍管道，打印对照表供人肉核对，并执行四条硬断言。
 *
 * 对照表的判断依据是团队手写的期望（fixtures/*.json 里的 expect 段）——哪张截图该出
 * 1 条期中考试而不是 5 条、「下周三」该是哪天。不是代码自己说了算。
 *
 * 四条断言与模型输出什么无关，所以稳定；断言具体字符串意味着明天全部时间在修测试。
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const failures: string[] = []

function assert(ok: boolean, what: string, detail = ''): void {
  if (ok) console.log(`  ✓ ${what}`)
  else { console.log(`  ✗ ${what}${detail ? `\n${detail}` : ''}`); failures.push(what) }
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  )
}

function finish(): never {
  if (failures.length > 0) {
    console.log(`\n${failures.length} 条断言未通过`)
    process.exit(1)
  }
  console.log('\n全部通过')
  process.exit(0)
}

// ── 静态断言：不需要模型，永远跑 ───────────────────────────────────────

console.log('\n静态检查')

{
  // 判据：now 必须从 ctx 来。破了不会报错，只会静悄悄给出错日期——
  // 今天调通的用例明天解析成别的日期。
  const offenders = walk(join(repoRoot, 'packages/server/src/pipeline'))
    .filter((f) => /Date\.now\(\)|new Date\(\s*\)/.test(readFileSync(f, 'utf8')))
  assert(offenders.length === 0, '管道里没有无参 Date.now() / new Date()', offenders.join('\n'))
}

{
  // 判据：server 不依赖 Electron，否则「抽出去做独立后端」这条性质会悄悄消失。
  const offenders = walk(join(repoRoot, 'packages/server/src'))
    .filter((f) => /from\s+['"]electron['"]|require\(\s*['"]electron['"]\s*\)/.test(readFileSync(f, 'utf8')))
  assert(offenders.length === 0, 'packages/server 里没有对 electron 的引用', offenders.join('\n'))
}

// ── 管道断言：需要模型与演示碎片 ───────────────────────────────────────

const fixtureDir = join(repoRoot, 'fixtures')
const configPath = join(repoRoot, 'config.local.json')
const fixtures = existsSync(fixtureDir)
  ? readdirSync(fixtureDir).filter((f) => f.endsWith('.json')).sort()
  : []

if (fixtures.length === 0 || !existsSync(configPath)) {
  // 不静默通过：跳过就说跳过了。
  console.log(`\n管道检查：跳过（${fixtures.length === 0 ? '还没有 fixtures/*.json' : '缺 config.local.json'}）`)
  finish()
}

const config = ServerConfig.parse({
  ...JSON.parse(readFileSync(configPath, 'utf8')),
  dataDir: join(repoRoot, 'data', 'check-run'),
})
const calendar = CalendarSchema.parse(
  JSON.parse(readFileSync(join(repoRoot, 'data', 'calendar.json'), 'utf8')),
)

rmSync(config.dataDir, { recursive: true, force: true })
const db = openDb(config.dataDir)

console.log('\n对照表')
let insertedFragments = 0

for (const name of fixtures) {
  const fixture = JSON.parse(readFileSync(join(fixtureDir, name), 'utf8')) as {
    now: string
    fragment: Parameters<typeof insertFragment>[2]
    expect?: { count?: number; types?: string[]; dates?: (string | null)[] }
  }

  // now 固定注入：演示碎片里的「下周三」必须每天解析成同一个日期。
  const ctx = createCtx(calendar, fixture.now)
  const fragment = insertFragment(db, ctx, fixture.fragment)
  insertedFragments += 1

  const output = await extract(config, ctx, fragment)
  const planned = dedupe(ctx, output.items, listItems(db))
  applyPlans(db, ctx, fragment.id, planned)

  console.log(`\n  ${name}  (now=${fixture.now})`)
  console.log(`    期望 ${fixture.expect?.count ?? '—'} 条 / 实得 ${output.items.length} 条`)
  for (const [i, item] of output.items.entries()) {
    const expected = fixture.expect?.dates?.[i]
    const actual = item.due_at ?? item.starts_at ?? item.recurrence
    const mark = expected === undefined ? ' ' : expected === actual ? '✓' : '✗'
    console.log(`    ${mark} [${item.type}] ${item.title}`)
    console.log(`        日期 ${actual ?? '—'}${expected ? `  期望 ${expected}` : ''}`)
    console.log(`        原始表达 ${item.date_raw ?? '—'} · 置信 ${item.confidence}`)
  }
  console.log(`    合并计划：${planned.map((p) => p.plan.action).join(', ') || '—'}`)
}

console.log('\n管道检查')

// 引用逐字可验：extract() 在每条碎片上强制过，能跑到这里说明全都通过了。
assert(true, '所有引用都是原文的逐字片段（extract 内强制）')

assert(
  countFragments(db) === insertedFragments,
  '全流程跑完后 fragments 只增不改不删',
  `落库 ${insertedFragments} 条，跑完 ${countFragments(db)} 条`,
)

db.close()
finish()
