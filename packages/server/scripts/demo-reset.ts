import { rmSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CalendarSchema, createCtx, nowInShanghai } from '@flowpal/shared'
import type { Ctx, ExtractedItem, FragmentSource, ItemType } from '@flowpal/shared'
import { newId, openDb } from '../src/store/db.ts'
import { insertFragment } from '../src/store/fragments.ts'
import { addItemCitations, addItemSource, insertItem, recordItemHistory } from '../src/store/items.ts'
import { createProject } from '../src/store/projects.ts'

/**
 * 演示库种子：删库 → 建表 → 灌一个「用了两周的库」，三秒回到干净状态。
 *
 * 与 fixtures/ 对照集不是一回事：对照集证明「扔进去能理解」，这里证明「此刻」、
 * 项目页「多久没动」、精力事实、待确认角标都有数据可看。
 *
 * 种子里的日期全部相对执行时刻算，不写死——写死的话今天调好、明天演示就全过期。
 * 时钟只在入口读一次（nowInShanghai），往下所有时间都从 now 派生。
 *
 * 引用纪律不豁免：每条种子的引文必须逐字出现在它来源碎片的原文里，插入前自检，
 * 对不上直接抛——演示数据也是「判断指得出出处」这一条的展示。
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const dataDir = resolve(process.argv[2] ?? join(repoRoot, 'data'))

const now = nowInShanghai()
const calendar = CalendarSchema.parse(
  JSON.parse(readFileSync(join(repoRoot, 'data', 'calendar.json'), 'utf8')),
)

/** 相对日期的时刻：now 往后 days 天、+08 的 hour:minute。 */
function at(days: number, hour = 10, minute = 0): string {
  const base = new Date(now)
  base.setUTCDate(base.getUTCDate() + days)
  const shifted = new Date(base.getTime() + 8 * 3600_000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}T${pad(hour)}:${pad(minute)}:00+08:00`
}

/** 相对日期的日期串（YYYY-MM-DD），嵌进碎片原文用。 */
function day(days: number): string {
  return at(days, 10).slice(0, 10)
}

/** 相对日期的星期几（周X），嵌进碎片原文用——写错星期的通知看起来是假的。 */
function dowLabel(days: number): string {
  const base = new Date(now)
  base.setUTCDate(base.getUTCDate() + days)
  return '周' + '日一二三四五六'[base.getUTCDay()]
}

/** 从现在起最近的一个星期几（0=周日..6=周六）的 hour:minute。 */
function nextDow(dow: number, hour: number, minute = 0): string {
  const cur = new Date(now).getUTCDay()
  return at((dow - cur + 7) % 7, hour, minute)
}

const ctxFor = (daysAgo: number, hour = 9): Ctx => createCtx(calendar, at(-daysAgo, hour))

// ── 项目 ──────────────────────────────────────────────────────────────
type SeedProject = [key: string, name: string, statusNote: string]
const projects: SeedProject[] = [
  ['gaoshu', '高等数学', `期中考试 ${day(3)}；作业做到第三题卡在积分`],
  ['job', '实习申请', '简历那版太长了'],
  ['ds', '数据结构', `第三次作业已布置；期中 ${day(9)}`],
  ['mcm', '数学建模', '每周四组会'],
  ['paper', '论文', '找导师讨论选题'],
]

// ── 碎片与条目 ────────────────────────────────────────────────────────
type SeedItem = {
  project?: string
  type: ItemType
  title: string
  status?: 'active' | 'done'
  startsAt?: string
  dueAt?: string
  dayOnly?: boolean
  rrule?: string
  location?: string
  confidence?: 'high' | 'medium' | 'low'
  /** 必须逐字出现在本碎片原文里。 */
  quote: string
}
type SeedFragment = {
  key: string
  daysAgo: number
  source: FragmentSource
  rawText: string
  items: SeedItem[]
}

const fragments: SeedFragment[] = [
  {
    key: 'job', daysAgo: 7, source: 'paste',
    rawText: `实习申请要开始了：先确定投哪几家，字节、腾讯、美团都看看。上次写的简历那版太长了，要删掉一半。字节的网申截止是 ${day(7)}。`,
    items: [
      { type: 'task', title: '确定实习申请投哪几家', project: 'job', status: 'done', dueAt: at(-6, 22), quote: '确定投哪几家' },
      { type: 'state', title: '简历那版太长了', project: 'job', quote: '简历那版太长了' },
      { type: 'event', title: '字节实习网申截止', project: 'job', startsAt: at(7, 0), dayOnly: true, quote: '字节的网申截止' },
    ],
  },
  {
    key: 'mcm', daysAgo: 11, source: 'email',
    rawText: `数学建模竞赛报名通知：请于 ${day(20)} 前完成组队并提交报名表，指导老师一栏暂可空缺。`,
    items: [
      { type: 'task', title: '数学建模竞赛组队报名', project: 'mcm', dueAt: at(20, 0), dayOnly: true, quote: '数学建模竞赛报名' },
    ],
  },
  {
    key: 'gaoshu', daysAgo: 10, source: 'paste',
    rawText: '高数第一次作业：习题1-3，做完拍照发到群里。预习第一章的内容也一起过一遍。高数作业做到第三题，卡在积分了。',
    items: [
      { type: 'task', title: '高数第一次作业（习题1-3）', project: 'gaoshu', status: 'done', dueAt: at(-3, 23), quote: '高数第一次作业' },
      { type: 'task', title: '预习第一章', project: 'gaoshu', status: 'done', dueAt: at(-2, 23), quote: '预习第一章' },
      { type: 'progress', title: '高数作业做到第三题，卡在积分', project: 'gaoshu', quote: '高数作业做到第三题' },
    ],
  },
  {
    key: 'ds', daysAgo: 8, source: 'paste',
    rawText: '数据结构第三次作业发布了，PTA 平台上交。实验课每周二下午，机房404。',
    items: [
      { type: 'task', title: '数据结构第三次作业', project: 'ds', dueAt: at(2, 23), dayOnly: true, quote: '数据结构第三次作业' },
      { type: 'event', title: '数据结构实验课', project: 'ds', rrule: 'FREQ=WEEKLY;BYDAY=TU', startsAt: nextDow(2, 14), location: '机房404', quote: '实验课每周二下午' },
    ],
  },
  {
    key: 'mcm2', daysAgo: 6, source: 'paste',
    rawText: '数学建模组会：每周四下午三点，教二204。这周要讲机器学习部分，记得准备组会材料。',
    items: [
      { type: 'event', title: '数学建模组会', project: 'mcm', rrule: 'FREQ=WEEKLY;BYDAY=TH', startsAt: nextDow(4, 15), location: '教二204', quote: '数学建模组会' },
      { type: 'task', title: '准备数学建模组会材料（机器学习）', project: 'mcm', dueAt: at(1, 18), dayOnly: true, quote: '准备组会材料' },
    ],
  },
  {
    key: 'paper', daysAgo: 5, source: 'paste',
    rawText: '论文方向：找导师讨论一下选题，另外参考文献要开始整理了。',
    items: [
      { type: 'task', title: '找导师讨论论文选题', project: 'paper', dueAt: at(3, 14), dayOnly: true, quote: '找导师讨论' },
      { type: 'task', title: '整理论文参考文献', project: 'paper', dueAt: at(9, 14), dayOnly: true, quote: '参考文献' },
    ],
  },
  {
    key: 'ds2', daysAgo: 3, source: 'paste',
    rawText: `数据结构期中考试安排在 ${day(9)} 下午两点，教三3101。组会 PPT 下周交。`,
    items: [
      { type: 'event', title: '数据结构期中考试', project: 'ds', startsAt: at(9, 14), location: '教三3101', quote: '数据结构期中考试' },
      { type: 'task', title: '组会 PPT', project: 'mcm', dueAt: at(3, 12), dayOnly: true, quote: '组会 PPT' },
    ],
  },
  {
    key: 'resched', daysAgo: 1, source: 'paste',
    rawText: '组会 PPT 改到下周五交。',
    items: [],
  },
  {
    key: 'thoughts', daysAgo: 1, source: 'hotkey',
    rawText: '记得回小王消息，他问我要不要一起组队参加数学建模。论文里那张图要换成最新数据。',
    items: [
      { type: 'thought', title: '记得回小王消息', quote: '记得回小王消息' },
      { type: 'thought', title: '论文里那张图要换成最新数据', quote: '论文里那张图要换成最新数据' },
    ],
  },
  {
    key: 'exam', daysAgo: 2, source: 'paste',
    rawText: `高等数学期中考试：${day(3)}（${dowLabel(3)}）9:00，明德楼101，带学生证。`,
    items: [
      { type: 'event', title: '高等数学期中考试', project: 'gaoshu', startsAt: at(3, 9), location: '明德楼101', quote: '高等数学期中考试' },
    ],
  },
  {
    key: 'pe', daysAgo: 1, source: 'screenshot',
    rawText: `体育课通知：体测安排在 ${day(6)}，提前准备。`,
    items: [
      { type: 'event', title: '体测', startsAt: at(6, 8), quote: '体测' },
    ],
  },
  {
    key: 'uncertain', daysAgo: 2, source: 'paste',
    rawText: '看到班群转发的消息：计算机等级考试报名可能快截止了，不确定。小论文改到第二章了。',
    items: [
      { type: 'task', title: '计算机等级考试报名', confidence: 'low', quote: '计算机等级考试报名' },
      { type: 'progress', title: '小论文改到第二章', confidence: 'medium', quote: '小论文改到第二章' },
    ],
  },
]

// ── 专注时段 ──────────────────────────────────────────────────────────
const focusSessions = [
  { daysAgo: 1, hour: 20, planned: 45, actual: 45, endedEarly: 0, project: 'gaoshu' },
  { daysAgo: 2, hour: 15, planned: 25, actual: 25, endedEarly: 0, project: 'ds' },
  { daysAgo: 4, hour: 21, planned: 50, actual: 30, endedEarly: 1, project: 'paper' },
  { daysAgo: 6, hour: 13, planned: 25, actual: 25, endedEarly: 0, project: 'mcm' },
]

// ── 落库 ──────────────────────────────────────────────────────────────
for (const suffix of ['', '-wal', '-shm']) {
  rmSync(join(dataDir, `flowpal.db${suffix}`), { force: true })
}
const db = openDb(dataDir)

const projectIds = new Map<string, string>()
for (const [key, name, statusNote] of projects) {
  projectIds.set(key, createProject(db, createCtx(calendar, at(-13, 9)), { name, statusNote }).id)
}

const fragmentIds = new Map<string, string>()
const itemIds = new Map<string, string>()
for (const f of fragments) {
  const ctx = ctxFor(f.daysAgo)
  const fragment = insertFragment(db, ctx, { source: f.source, rawType: 'text', rawText: f.rawText })
  fragmentIds.set(f.key, fragment.id)

  for (const s of f.items) {
    // 引用自检：种子不是模型产出，但也必须逐字可验。
    if (!f.rawText.includes(s.quote)) {
      throw new Error(`种子引文不在原文里：${f.key} / 「${s.quote}」`)
    }
    const projectId = s.project ? projectIds.get(s.project) ?? null : null
    const hasDate = s.startsAt !== undefined || s.dueAt !== undefined
    const extracted: ExtractedItem = {
      type: s.type,
      title: s.title,
      starts_at: s.startsAt ?? null,
      due_at: s.dueAt ?? null,
      date_precision: hasDate ? (s.dayOnly ? 'day' : 'minute') : null,
      date_raw: null,
      recurrence: s.rrule ?? null,
      location: s.location ?? null,
      confidence: s.confidence ?? 'high',
      date_confidence: hasDate ? 'high' : null,
      citations: [{ field: 'title', quote: s.quote }],
    }
    const id = insertItem(db, ctx, extracted, { projectId })
    itemIds.set(s.title, id)
    addItemSource(db, ctx, id, fragment.id)
    addItemCitations(db, id, fragment.id, extracted)
    if (s.status === 'done') {
      db.prepare(`UPDATE items SET status = 'done', updated_at = ? WHERE id = ?`).run(ctx.now, id)
    }
  }
}

// 改期：组会 PPT 的截止日被一条通知推走。历史行指回那条碎片，改期因此有出处。
{
  const ctx = ctxFor(1)
  const pptId = itemIds.get('组会 PPT')
  const noticeId = fragmentIds.get('resched')
  if (!pptId || !noticeId) throw new Error('种子缺组会 PPT 或改期通知')
  const oldDue = at(3, 12)
  const newDue = nextDow(5, 12)
  db.prepare(`UPDATE items SET due_at = ?, updated_at = ? WHERE id = ?`).run(newDue, ctx.now, pptId)
  recordItemHistory(db, ctx, pptId, 'due_at', oldDue, newDue, 'llm', noticeId)
  addItemSource(db, ctx, pptId, noticeId)
  addItemCitations(db, pptId, noticeId, {
    type: 'task', title: '组会 PPT', starts_at: null, due_at: newDue,
    date_precision: 'day', date_raw: null, recurrence: null, location: null,
    confidence: 'high', date_confidence: 'high',
    citations: [{ field: 'due_at', quote: '改到下周五交' }],
  })
}

{
  const insertFocus = db.prepare(
    `INSERT INTO focus_sessions
       (id, started_at, planned_minutes, actual_minutes, ended_early, item_id, project_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  for (const s of focusSessions) {
    const started = at(-s.daysAgo, s.hour)
    insertFocus.run(
      newId('fcs'), started, s.planned, s.actual, s.endedEarly,
      null, projectIds.get(s.project) ?? null, started,
    )
  }
}

const count = (sql: string): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${sql}`).get() as { n: number }).n

console.log(`demo 库已重置：${join(dataDir, 'flowpal.db')}`)
console.log(`  项目 ${count('projects')} · 条目 ${count('items')} · 碎片 ${count('fragments')}`)
console.log(`  专注时段 ${count('focus_sessions')} · 变更历史 ${count('item_history')} · 引用 ${count('item_citations')}`)
db.close()
