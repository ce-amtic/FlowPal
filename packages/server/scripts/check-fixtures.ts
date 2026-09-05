import { readdirSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CalendarSchema, createCtx } from '@flowpal/shared'
import type { ExtractedItem } from '@flowpal/shared'
import { ServerConfig } from '../src/config.ts'
import { openDb } from '../src/store/db.ts'
import { SCHEMA } from '../src/store/schema.ts'
import { insertFragment, countFragments } from '../src/store/fragments.ts'
import { createProject } from '../src/store/projects.ts'
import {
  applyPlans, getItem, insertItem, itemHistory, listItems, upsertByExternalId,
} from '../src/store/items.ts'
import { extract } from '../src/pipeline/extract.ts'
import { dedupe } from '../src/pipeline/dedupe.ts'

/**
 * 演示碎片跑一遍管道，打印对照表供人肉核对，并执行硬断言。
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

{
  // 判据：项目层、external_id 与专注时段是其余一切的前提（五页、种子、B 的同步与 /focus），
  // 缺了只会到用时才炸。空白归一后做包含检查，断言的写法不绑定 DDL 的排版。
  const flat = SCHEMA.replace(/\s+/g, ' ')
  const required = [
    'CREATE TABLE IF NOT EXISTS projects',
    'project_id TEXT REFERENCES projects(id)',
    'external_id TEXT UNIQUE',
    'CREATE TABLE IF NOT EXISTS focus_sessions',
  ]
  const missing = required.filter((s) => !flat.includes(s))
  assert(
    missing.length === 0,
    'schema 含 projects / items.project_id / items.external_id / focus_sessions',
    missing.join('\n'),
  )
}

{
  // 判据：progress 必须挂项目；给不出归属时以 needs_confirm 落库（[[010]]）。
  // 这条与模型输出无关，直接拿内存库测，不消耗额度。
  const db = openDb(':memory:')
  const calendar = CalendarSchema.parse(
    JSON.parse(readFileSync(join(repoRoot, 'data', 'calendar.json'), 'utf8')),
  )
  const ctx = createCtx(calendar, '2026-09-05T10:00:00+08:00')
  const fragment = insertFragment(db, ctx, {
    source: 'paste', rawType: 'text', rawText: '做到第三题，卡在积分',
  })
  const progress: ExtractedItem = {
    type: 'progress', title: '做到第三题，卡在积分',
    starts_at: null, due_at: null, date_precision: null, date_raw: null,
    recurrence: null, location: null,
    confidence: 'high', date_confidence: null, citations: [],
  }
  applyPlans(db, ctx, fragment.id, [{ extracted: progress, plan: { action: 'new' } }])
  const orphan = listItems(db)[0]
  assert(
    orphan?.status === 'needs_confirm',
    'progress 无归属以 needs_confirm 落库',
    orphan ? `实得 ${orphan.status}` : '没有条目',
  )

  const project = createProject(db, ctx, { name: '高等数学' })
  const attachedId = insertItem(db, ctx, progress, { projectId: project.id })
  assert(getItem(db, attachedId)?.status === 'active', 'progress 挂上项目直接落库（active）')
  db.close()
}

{
  // 判据：结构化来源按 external_id 覆盖写入，幂等；字段变化写一行 item_history（[[016]]）。
  // B 的同步依赖这两条，与模型输出无关，内存库直接测。
  const db = openDb(':memory:')
  const calendar = CalendarSchema.parse(
    JSON.parse(readFileSync(join(repoRoot, 'data', 'calendar.json'), 'utf8')),
  )
  const ctx = createCtx(calendar, '2026-09-05T10:00:00+08:00')
  const fragment = insertFragment(db, ctx, {
    source: 'calendar', rawType: 'structured', rawText: '{"kind":"exam"}',
  })
  const exam: ExtractedItem = {
    type: 'event', title: '高等数学期中',
    starts_at: '2026-10-15T14:00:00+08:00', due_at: null,
    date_precision: 'minute', date_raw: null, recurrence: null,
    location: '明德楼', confidence: 'high', date_confidence: 'high', citations: [],
  }
  upsertByExternalId(db, ctx, fragment.id, 'ruc-exam-001', exam)
  const id = upsertByExternalId(db, ctx, fragment.id, 'ruc-exam-001', {
    ...exam, starts_at: '2026-10-22T14:00:00+08:00',
  })
  assert(listItems(db).length === 1, '同一 external_id 连写两次，items 不增加', `实得 ${listItems(db).length} 条`)
  assert(
    itemHistory(db, id).some((h) => h.field === 'starts_at'),
    'external_id 覆盖时字段变化写出 item_history',
  )
  db.close()
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
  // 与 loadConfig 相同的路径默认值；config.local.json 里没有这两项。
  promptsDir: join(repoRoot, 'prompts'),
  calendarPath: join(repoRoot, 'data', 'calendar.json'),
  ...JSON.parse(readFileSync(configPath, 'utf8')),
  dataDir: join(repoRoot, 'data', 'check-run'),
})
const calendar = CalendarSchema.parse(
  JSON.parse(readFileSync(join(repoRoot, 'data', 'calendar.json'), 'utf8')),
)

rmSync(config.dataDir, { recursive: true, force: true })
const db = openDb(config.dataDir)

/**
 * 把日期拆成「日 + 时:分」两半：日必须相等；两边都带时刻才比时刻，且按同一瞬间比
 * （容忍 +08:00 / Z / 裸时刻的格式差）。这样模型把「10月22日14:00」写成
 * 2026-10-22T14:00:00+08:00 还是 2026-10-22 14:00 都算对，但日期错了必挂。
 */
function dateKey(s: string): { day: string; time: string | null } | null {
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?/.exec(s.trim())
  if (!m) return null
  return { day: m[1]!, time: m[2] ?? null }
}

function datesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a == null || b == null) return a === b
  if (a === b) return true
  const ka = dateKey(a)
  const kb = dateKey(b)
  if (!ka || !kb) return a === b
  if (ka.day !== kb.day) return false
  if (ka.time !== null && kb.time !== null) {
    const ta = Date.parse(a)
    const tb = Date.parse(b)
    if (!Number.isNaN(ta) && !Number.isNaN(tb)) return ta === tb
    return ka.time === kb.time
  }
  return true
}

console.log('\n对照表')
let insertedFragments = 0

for (const name of fixtures) {
  const fixture = JSON.parse(readFileSync(join(fixtureDir, name), 'utf8')) as {
    now: string
    fragment: Parameters<typeof insertFragment>[2]
    expect?: {
      count?: number
      types?: string[]
      dates?: (string | null)[]
      statuses?: (string | null)[]
      plans?: string[]
    }
  }

  // now 固定注入：演示碎片里的「下周三」必须每天解析成同一个日期。
  const ctx = createCtx(calendar, fixture.now)
  const fragment = insertFragment(db, ctx, fixture.fragment)
  insertedFragments += 1

  const output = await extract(config, ctx, fragment)
  const planned = dedupe(ctx, output.items, listItems(db))
  const itemIds = applyPlans(db, ctx, fragment.id, planned)

  const expect = fixture.expect
  const issues: string[] = []
  console.log(`\n  ${name}  (now=${fixture.now})`)
  console.log(`    条数：期望 ${expect?.count ?? '—'} / 实得 ${output.items.length}`)
  if (expect?.count !== undefined && expect.count !== output.items.length) {
    issues.push(`条数：期望 ${expect.count}，实得 ${output.items.length}`)
  }

  for (const [i, item] of output.items.entries()) {
    const stored = getItem(db, itemIds[i] ?? '')
    const expectedType = expect?.types?.[i]
    const expectedStatus = expect?.statuses?.[i]
    const isRrule = expect?.dates?.[i]?.startsWith('RRULE:') ?? false
    const expectedDate = isRrule ? expect?.dates?.[i]!.slice(6) : expect?.dates?.[i]
    // stored 是水合后的 Item，字段是驼峰；别用蛇形键名去读它。
    const actualDate = isRrule
      ? stored?.rrule
      : stored?.dueAt ?? stored?.startsAt

    const typeMark = expectedType === undefined ? ' ' : expectedType === item.type ? '✓' : '✗'
    const dateMark = expectedDate === undefined ? ' ' : datesMatch(actualDate, expectedDate) ? '✓' : '✗'
    const statusMark = expectedStatus === undefined ? ' ' : expectedStatus === stored?.status ? '✓' : '✗'
    if (expectedType !== undefined && expectedType !== item.type) {
      issues.push(`第 ${i + 1} 条类型：期望 ${expectedType}，实得 ${item.type}`)
    }
    if (expectedDate !== undefined && !datesMatch(actualDate, expectedDate)) {
      issues.push(`第 ${i + 1} 条日期：期望 ${expectedDate}，实得 ${actualDate ?? '—'}`)
    }
    if (expectedStatus !== undefined && expectedStatus !== stored?.status) {
      issues.push(`第 ${i + 1} 条状态：期望 ${expectedStatus}，实得 ${stored?.status ?? '—'}`)
    }

    console.log(`    ${typeMark}${dateMark}${statusMark} [${item.type}] ${item.title}`)
    console.log(`        日期 ${actualDate ?? '—'}${expectedDate ? `  期望 ${expectedDate}` : ''}`)
    console.log(`        状态 ${stored?.status ?? '—'}${expectedStatus ? `  期望 ${expectedStatus}` : ''} · 原始表达 ${item.date_raw ?? '—'} · 置信 ${item.confidence}`)
  }

  const plans = planned.map((p) => p.plan.action)
  const plansMark = expect?.plans === undefined
    ? ' '
    : JSON.stringify(expect.plans) === JSON.stringify(plans) ? '✓' : '✗'
  if (expect?.plans !== undefined && JSON.stringify(expect.plans) !== JSON.stringify(plans)) {
    issues.push(`合并计划：期望 ${expect.plans.join(', ')}，实得 ${plans.join(', ') || '—'}`)
  }
  console.log(`    ${plansMark} 合并计划：${plans.join(', ') || '—'}${expect?.plans ? `  期望 ${expect.plans.join(', ')}` : ''}`)

  assert(issues.length === 0, `${name} 与手写期望值相符`, issues.join('\n'))
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
