import { readdirSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CalendarSchema, createCtx, CreateItemInput } from '@flowpal/shared'
import type { ExtractedItem } from '@flowpal/shared'
import { ServerConfig } from '../src/config.ts'
import { openDb } from '../src/store/db.ts'
import { SCHEMA } from '../src/store/schema.ts'
import { insertFragment, countFragments } from '../src/store/fragments.ts'
import { createProject, getProject, listProjects } from '../src/store/projects.ts'
import { getItem, itemHistory, listItems, upsertByExternalId } from '../src/store/items.ts'
import { runAgentLoop } from '../src/agent/loop.ts'
import { executeAgentTool } from '../src/agent/tools.ts'
import { buildContext } from '../src/context/build.ts'

/**
 * 演示碎片跑一遍 agent 循环，打印对照表供人肉核对，并执行硬断言。
 * 判断依据是团队手写的期望（fixtures/*.json 里的 expect 段），不是代码自己说了算。
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
  const dirs = [
    join(repoRoot, 'packages/server/src/pipeline'),
    join(repoRoot, 'packages/server/src/agent'),
  ]
  const offenders = dirs.flatMap((d) => walk(d))
    .filter((f) => /Date\.now\(\)|new Date\(\s*\)/.test(readFileSync(f, 'utf8')))
  assert(offenders.length === 0, '管道与 agent 里没有无参 Date.now() / new Date()', offenders.join('\n'))
}

{
  const offenders = walk(join(repoRoot, 'packages/server/src'))
    .filter((f) => /from\s+['"]electron['"]|require\(\s*['"]electron['"]\s*\)/.test(readFileSync(f, 'utf8')))
  assert(offenders.length === 0, 'packages/server 里没有对 electron 的引用', offenders.join('\n'))
}

{
  const flat = SCHEMA.replace(/\s+/g, ' ')
  const required = [
    'CREATE TABLE IF NOT EXISTS projects',
    'project_id TEXT REFERENCES projects(id)',
    'external_id TEXT UNIQUE',
    'CREATE TABLE IF NOT EXISTS focus_sessions',
    'CREATE TABLE IF NOT EXISTS runs',
    'CREATE TABLE IF NOT EXISTS run_events',
    'CREATE TABLE IF NOT EXISTS app_settings',
    'CREATE TABLE IF NOT EXISTS now_cache',
  ]
  const missing = required.filter((s) => !flat.includes(s))
  assert(missing.length === 0, 'schema 含项目层 / 结构化键 / 专注 / runs / run_events / settings / now_cache', missing.join('\n'))
}

{
  const routes = readFileSync(join(repoRoot, 'packages/server/src/routes/index.ts'), 'utf8')
  const missing = ['/api/events', '/api/runs/:id/events'].filter((s) => !routes.includes(s))
  assert(missing.length === 0, 'routes 含 /api/events 与 /api/runs/:id/events', missing.join('\n'))
}

{
  const db = openDb(':memory:')
  const calendar = CalendarSchema.parse(JSON.parse(readFileSync(join(repoRoot, 'data/calendar.json'), 'utf8')))
  const ctx = createCtx(calendar, '2026-09-05T10:00:00+08:00')
  const snapshot = buildContext(db, ctx)
  const labels = snapshot.sections.map((s) => s.label)
  assert(
    JSON.stringify(labels) === JSON.stringify(['算出来的', '观察到的', '用户说的', '先验']),
    'buildContext 四组来源分节且带来源标签',
    labels.join(', '),
  )
  assert(snapshot.formatted.includes('【先验】'), 'buildContext 先验节明确标出')
  db.close()
}

{
  const nowPrompt = readFileSync(join(repoRoot, 'prompts/now.md'), 'utf8')
  assert(nowPrompt.includes('energy_reading'), 'now prompt 要求 energy_reading')
  assert(nowPrompt.includes('在场而不评判'), 'now prompt 写进文案风格约束')
  const routes = readFileSync(join(repoRoot, 'packages/server/src/routes/index.ts'), 'utf8')
  assert(routes.includes('isNowStale') && routes.includes('clearNowCache'), '「此刻」缓存与失效规则已接进路由')
}

{
  // createItem 是入库契约：缺 project 或 quote 不逐字都必须过不了 schema / 工具校验。
  const good = CreateItemInput.safeParse({
    type: 'task', title: '交报告', starts_at: null, due_at: '2026-09-16T00:00:00+08:00',
    date_precision: 'day', date_raw: '下周三', recurrence: null, location: null,
    confidence: 'high', date_confidence: 'high', citations: [{ field: 'title', quote: '报告' }],
    project: { kind: 'existing', projectId: 'prj_x', quote: '报告' },
  })
  assert(good.success, 'CreateItemInput 合法输入可解析', good.success ? '' : JSON.stringify(good.error.issues))
  const bad = CreateItemInput.safeParse({ ...(good.success ? good.data : {}), project: { kind: 'new', name: 'X' } })
  assert(!bad.success, 'CreateItemInput 缺 project quote 会被拒绝')
}

{
  // progress 必须挂项目；给不出归属以 needs_confirm 落库。这里直接走工具，不消耗模型。
  const db = openDb(':memory:')
  const calendar = CalendarSchema.parse(JSON.parse(readFileSync(join(repoRoot, 'data/calendar.json'), 'utf8')))
  const ctx = createCtx(calendar, '2026-09-05T10:00:00+08:00')
  const fragment = insertFragment(db, ctx, { source: 'paste', rawType: 'text', rawText: '高数作业做到第三题，卡在积分不会做了。' })
  const base = {
    type: 'progress', title: '高数作业做到第三题，卡在积分', starts_at: null, due_at: null,
    date_precision: null, date_raw: null, recurrence: null, location: null,
    confidence: 'high', date_confidence: null, citations: [{ field: 'title', quote: '高数作业做到第三题' }],
  }
  const orphan = executeAgentTool(db, ctx, fragment, 'createItem', { ...base, project: { kind: 'none' } })
  assert(listItems(db)[0]?.status === 'needs_confirm', 'progress 无归属以 needs_confirm 落库', listItems(db)[0]?.status ?? '无条目')
  const attached = executeAgentTool(db, ctx, fragment, 'createItem', {
    ...base, project: { kind: 'new', name: '高等数学', quote: '高数作业' },
  })
  const attachedItem = listItems(db).find((i) => i.status === 'active')
  const attachedProject = attachedItem?.projectId ? getProject(db, attachedItem.projectId) : null
  assert(attachedItem?.status === 'active' && attachedProject?.name === '高等数学', 'progress 挂上项目直接落库（active）')
  const badQuote = executeAgentTool(db, ctx, fragment, 'createItem', {
    ...base, project: { kind: 'new', name: '不存在', quote: '这句话不在原文里' },
  })
  assert(badQuote.content.includes('ok\":false'), 'createItem 引文不逐字时作为工具结果返回，不抛异常')
  db.close()
}

{
  // 待确认门槛是「错了不可逆」，不是「模型没把握」：low confidence 照常 active，不因此进待确认。
  const db = openDb(':memory:')
  const calendar = CalendarSchema.parse(JSON.parse(readFileSync(join(repoRoot, 'data/calendar.json'), 'utf8')))
  const ctx = createCtx(calendar, '2026-09-05T10:00:00+08:00')
  const fragment = insertFragment(db, ctx, { source: 'paste', rawType: 'text', rawText: '看到班群转发的消息：计算机等级考试报名可能快截止了，不确定。' })
  const low = executeAgentTool(db, ctx, fragment, 'createItem', {
    type: 'task', title: '计算机等级考试报名', starts_at: null, due_at: null,
    date_precision: null, date_raw: null, recurrence: null, location: null,
    confidence: 'low', date_confidence: 'low',
    citations: [{ field: 'title', quote: '计算机等级考试报名' }],
    project: { kind: 'none' },
  })
  const item = listItems(db)[0]
  assert(item?.status === 'active', 'low confidence 不因此进待确认，照常落 active', item?.status ?? '无条目')
  assert(low.touched?.needsConfirm !== true, 'low confidence 的 createItem 不计入待确认')
  db.close()
}

{
  const db = openDb(':memory:')
  const calendar = CalendarSchema.parse(JSON.parse(readFileSync(join(repoRoot, 'data/calendar.json'), 'utf8')))
  const ctx = createCtx(calendar, '2026-09-05T10:00:00+08:00')
  const fragment = insertFragment(db, ctx, { source: 'calendar', rawType: 'structured', rawText: '{"kind":"exam"}' })
  const exam: ExtractedItem = {
    type: 'event', title: '高等数学期中',
    starts_at: '2026-10-15T14:00:00+08:00', due_at: null,
    date_precision: 'minute', date_raw: null, recurrence: null,
    location: '明德楼', confidence: 'high', date_confidence: 'high', citations: [],
  }
  upsertByExternalId(db, ctx, fragment.id, 'ruc-exam-001', exam)
  const id = upsertByExternalId(db, ctx, fragment.id, 'ruc-exam-001', { ...exam, starts_at: '2026-10-22T14:00:00+08:00' })
  assert(listItems(db).length === 1, '同一 external_id 连写两次，items 不增加', `实得 ${listItems(db).length} 条`)
  assert(itemHistory(db, id).some((h) => h.field === 'starts_at'), 'external_id 覆盖时字段变化写出 item_history')
  db.close()
}

// ── 管道断言：需要模型与演示碎片 ───────────────────────────────────────

const fixtureDir = join(repoRoot, 'fixtures')
const configPath = join(repoRoot, 'config.local.json')
const fixtures = existsSync(fixtureDir) ? readdirSync(fixtureDir).filter((f) => f.endsWith('.json')).sort() : []

if (fixtures.length === 0 || !existsSync(configPath)) {
  console.log(`\n管道检查：跳过（${fixtures.length === 0 ? '还没有 fixtures/*.json' : '缺 config.local.json'}）`)
  finish()
}

const config = ServerConfig.parse({
  promptsDir: join(repoRoot, 'prompts'),
  calendarPath: join(repoRoot, 'data/calendar.json'),
  ...JSON.parse(readFileSync(configPath, 'utf8')),
  dataDir: join(repoRoot, 'data', 'check-run'),
})
const calendar = CalendarSchema.parse(JSON.parse(readFileSync(join(repoRoot, 'data/calendar.json'), 'utf8')))

rmSync(config.dataDir, { recursive: true, force: true })
const db = openDb(config.dataDir)

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
      projects?: (string | null)[]
      created?: number
      updated?: number
      needsConfirm?: number
    }
  }

  const ctx = createCtx(calendar, fixture.now)
  const fragment = insertFragment(db, ctx, fixture.fragment)
  insertedFragments += 1
  const result = await runAgentLoop(config, db, ctx, fragment)
  const projectNames = new Map(listProjects(db).map((p) => [p.id, p.name]))
  const items = listItems(db).filter((i) => i.sourceFragmentIds.includes(fragment.id))

  const expect = fixture.expect
  const issues: string[] = []
  console.log(`\n  ${name}  (now=${fixture.now}, status=${result.status})`)
  console.log(`    created=${result.counts.created} updated=${result.counts.updated} needsConfirm=${result.counts.needsConfirm}`)
  console.log(`    条数：期望 ${expect?.count ?? '—'} / 实得 ${items.length}`)
  if (expect?.count !== undefined && expect.count !== items.length) {
    issues.push(`条数：期望 ${expect.count}，实得 ${items.length}`)
  }
  if (expect?.created !== undefined && expect.created !== result.counts.created) {
    issues.push(`created：期望 ${expect.created}，实得 ${result.counts.created}`)
  }
  if (expect?.updated !== undefined && expect.updated !== result.counts.updated) {
    issues.push(`updated：期望 ${expect.updated}，实得 ${result.counts.updated}`)
  }
  if (expect?.needsConfirm !== undefined && expect.needsConfirm !== result.counts.needsConfirm) {
    issues.push(`needsConfirm：期望 ${expect.needsConfirm}，实得 ${result.counts.needsConfirm}`)
  }

  for (const [i, item] of items.entries()) {
    const expectedType = expect?.types?.[i]
    const expectedStatus = expect?.statuses?.[i]
    const expectedProject = expect?.projects?.[i]
    const isRrule = expect?.dates?.[i]?.startsWith('RRULE:') ?? false
    const expectedDate = isRrule ? expect?.dates?.[i]!.slice(6) : expect?.dates?.[i]
    const actualDate = isRrule ? item.rrule : item.dueAt ?? item.startsAt
    const projectName = item.projectId ? projectNames.get(item.projectId) ?? null : null

    const typeMark = expectedType === undefined ? ' ' : expectedType === item.type ? '✓' : '✗'
    const dateMark = expectedDate === undefined ? ' ' : datesMatch(actualDate, expectedDate) ? '✓' : '✗'
    const statusMark = expectedStatus === undefined ? ' ' : expectedStatus === item.status ? '✓' : '✗'
    const projectMark = expectedProject === undefined ? ' ' : expectedProject === projectName ? '✓' : '✗'
    if (expectedType !== undefined && expectedType !== item.type) issues.push(`第 ${i + 1} 条类型：期望 ${expectedType}，实得 ${item.type}`)
    if (expectedDate !== undefined && !datesMatch(actualDate, expectedDate)) issues.push(`第 ${i + 1} 条日期：期望 ${expectedDate}，实得 ${actualDate ?? '—'}`)
    if (expectedStatus !== undefined && expectedStatus !== item.status) issues.push(`第 ${i + 1} 条状态：期望 ${expectedStatus}，实得 ${item.status}`)
    if (expectedProject !== undefined && expectedProject !== projectName) issues.push(`第 ${i + 1} 条项目：期望 ${expectedProject}，实得 ${projectName ?? '未归类'}`)

    console.log(`    ${typeMark}${dateMark}${statusMark}${projectMark} [${item.type}] ${item.title}`)
    console.log(`        日期 ${actualDate ?? '—'}${expectedDate ? `  期望 ${expectedDate}` : ''}`)
    console.log(`        状态 ${item.status}${expectedStatus ? `  期望 ${expectedStatus}` : ''} · 项目 ${projectName ?? '未归类'} · 置信 ${item.confidence}`)
  }

  assert(issues.length === 0, `${name} 与手写期望值相符`, issues.join('\n'))
}

console.log('\n管道检查')

assert(countFragments(db) === insertedFragments, '全流程跑完后 fragments 只增不改不删', `落库 ${insertedFragments} 条，跑完 ${countFragments(db)} 条`)

{
  // 同一条碎片重跑不产生重复：重跑后 items 总数不变、没有新 id。
  const fixture = JSON.parse(readFileSync(join(fixtureDir, '03-verbal.json'), 'utf8')) as { now: string; fragment: Parameters<typeof insertFragment>[2] }
  const ctx = createCtx(calendar, fixture.now)
  const before = new Set(listItems(db).map((i) => i.id))
  const fragment = insertFragment(db, ctx, fixture.fragment)
  const result = await runAgentLoop(config, db, ctx, fragment)
  const after = listItems(db)
  assert(
    after.length === before.size && after.every((i) => before.has(i.id)),
    '同一条碎片重跑不产生重复条目',
    `重跑后 ${after.length} 条（重跑前 ${before.size} 条），run=${result.status}`,
  )
}

db.close()
finish()
