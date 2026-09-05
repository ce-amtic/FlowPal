import type { Fragment, Project, Run } from '@flowpal/shared'
import type {
  AgendaView, Citation, ItemHistoryRow, ItemWithSources, NowView, ProjectCard, RecentEntry,
} from '../api.ts'

/**
 * 样例数据。只在样例模式下使用，真实模式下这个文件不会被读到。
 *
 * 日期一律相对当前时间算出来，不写死：写死的话今天调好、明天打开就全部过期，
 * 「还剩 2 天」会变成「已过期 3 天」，而那是最不该出现的错。碎片原文里出现的
 * 日期也是算出来的，否则原文与它抽出的条目会互相矛盾。
 */
const now = new Date()

function at(days: number, hour = 0, minute = 0): string {
  const d = new Date(now)
  d.setDate(d.getDate() + days)
  d.setHours(hour, minute, 0, 0)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:00+08:00`
}

const day = (days: number) => at(days).slice(0, 10)

/** 碎片原文里写成中文的那个日期。和条目上的绝对时间同源，不会对不上 */
function cn(days: number): string {
  const d = new Date(now)
  d.setDate(d.getDate() + days)
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

/**
 * 碎片原文里那句「周三之前」的星期。
 *
 * 写死的话，今天跑出来的截止日是周一，原文却说周三——条目详情页会把两者并排
 * 摆着，一眼就看得出对不上。原始表达必须和算出来的绝对时间同源。
 */
function cnWeekday(days: number): string {
  const d = new Date(now)
  d.setDate(d.getDate() + days)
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()]!
}

/** 重复规则里的星期码要和它的首次发生日对得上，否则界面上会自相矛盾 */
function weekdayCode(days: number): string {
  const d = new Date(now)
  d.setDate(d.getDate() + days)
  return ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][d.getDay()]!
}

// ── 碎片 ──────────────────────────────────────────────────────────────

function frag(
  id: string,
  createdAt: string,
  over: Pick<Fragment, 'source' | 'rawType'> & Partial<Fragment>,
): Fragment {
  return {
    id, createdAt, device: 'desktop', rawText: null, rawBlobPath: null, ...over,
  }
}

export const FRAGMENTS: Fragment[] = [
  frag('f_shot', at(0, 14, 20), { source: 'drop', rawType: 'image', rawBlobPath: 'blobs/f_shot.png' }),

  frag('f_mail', at(0, 13, 5), {
    source: 'hotkey', rawType: 'text',
    rawText: `刚跟学长聊完。实习申请的材料${cnWeekday(2)}之前要交，推荐信还没找王老师要。`
      + '简历那版太长了，两页压不住。',
  }),

  frag('f_thought', at(0, 11, 20), {
    source: 'hotkey', rawType: 'text',
    rawText: '刚想起来，查一下上次提到的那篇关于注意残留的论文，应该是 2010 年前后的。',
  }),

  frag('f_blank', at(0, 11, 40), { source: 'drop', rawType: 'image', rawBlobPath: 'blobs/f_blank.png' }),

  frag('f_notice', at(-1, 22, 12), {
    source: 'paste', rawType: 'text',
    rawText: `各位同学：\n本学期高等数学期中考试定于 ${cn(10)} 14:00 在明德主楼 0201 进行，`
      + '考试时长两小时，请携带学生证与身份证入场。',
  }),

  frag('f_confirm', at(-1, 20, 40), {
    source: 'paste', rawType: 'text',
    rawText: '别忘了这周内交材料，具体交到哪儿群里还没说。',
  }),

  frag('f_fail', at(-1, 19, 2), {
    source: 'paste', rawType: 'text',
    rawText: '各位同学，关于本学期期末考试安排的通知……',
  }),
]

const fragment = (id: string) => FRAGMENTS.find((f) => f.id === id)!

/**
 * 一条引用。偏移由 indexOf 算出来，和服务端同一套做法。
 *
 * 引文不在原文里就直接抛——样例数据里出现一条对不上的引用，等于把「逐字可验」
 * 这条产品前提在演示现场证伪，宁可这个文件加载不起来。
 */
function cite(
  itemId: string, fragmentId: string, field: Citation['field'], quote: string,
): Citation {
  const raw = fragment(fragmentId).rawText
  if (raw === null) throw new Error(`${fragmentId} 没有原文，不能引用`)
  const startOffset = raw.indexOf(quote)
  if (startOffset < 0) throw new Error(`${fragmentId} 的原文里没有「${quote}」`)
  return { itemId, field, fragmentId, quote, startOffset, endOffset: startOffset + quote.length }
}

// ── 条目 ──────────────────────────────────────────────────────────────

function item(
  over: Partial<ItemWithSources> & Pick<ItemWithSources, 'id' | 'type' | 'title'>,
): ItemWithSources {
  return {
    startsAt: null,
    dueAt: null,
    datePrecision: null,
    dateRaw: null,
    rrule: null,
    dateConfidence: null,
    confidence: 'high',
    location: null,
    status: 'active',
    projectId: null,
    externalId: null,
    createdAt: at(-2, 10),
    updatedAt: at(-2, 10),
    sourceFragmentIds: [],
    citations: [],
    ...over,
  }
}

function project(id: string, name: string, statusNote: string | null): Project {
  return { id, name, statusNote, status: 'active', createdAt: at(-20), updatedAt: at(-1) }
}

export const PROJECTS: Project[] = [
  project('p_intern', '实习申请', '材料还差推荐信'),
  project('p_math', '高等数学', null),
  project('p_ds', '数据结构', null),
  project('p_paper', '注意残留那篇综述', '读完了三篇'),
]

export const ITEMS: ItemWithSources[] = [
  item({
    id: 'i_mail', type: 'task', title: '把实习申请的材料交上去',
    dueAt: at(2), datePrecision: 'day', dateRaw: `${cnWeekday(2)}之前`, projectId: 'p_intern',
    createdAt: at(0, 13, 5), sourceFragmentIds: ['f_mail'],
    citations: [
      cite('i_mail', 'f_mail', 'title', '实习申请的材料'),
      cite('i_mail', 'f_mail', 'date_raw', `${cnWeekday(2)}之前`),
    ],
  }),
  item({ id: 'i_resume', type: 'task', title: '把简历第二页的实习经历压到三行', projectId: 'p_intern' }),
  item({
    id: 'i_rec', type: 'task', title: '找王老师要推荐信',
    projectId: 'p_intern', confidence: 'medium',
    createdAt: at(0, 13, 5), sourceFragmentIds: ['f_mail'],
    citations: [cite('i_rec', 'f_mail', 'title', '推荐信还没找王老师要')],
  }),
  item({
    id: 'i_midterm', type: 'event', title: '高等数学期中考试',
    startsAt: at(10, 14), datePrecision: 'minute', location: '明德主楼 0201', projectId: 'p_math',
    createdAt: at(-1, 22, 12), sourceFragmentIds: ['f_notice'],
    citations: [
      cite('i_midterm', 'f_notice', 'title', '高等数学期中考试'),
      cite('i_midterm', 'f_notice', 'starts_at', `${cn(10)} 14:00`),
      cite('i_midterm', 'f_notice', 'location', '明德主楼 0201'),
    ],
  }),
  item({
    id: 'i_seminar', type: 'task', title: '组会材料',
    dueAt: at(0, 18), datePrecision: 'minute', rrule: `FREQ=WEEKLY;BYDAY=${weekdayCode(0)}`,
    projectId: 'p_ds', createdAt: at(0, 14, 20), sourceFragmentIds: ['f_shot'],
  }),
  item({
    id: 'i_hw', type: 'task', title: '数据结构第三次作业',
    dueAt: at(-1), datePrecision: 'day', projectId: 'p_ds', status: 'done',
  }),
  item({
    id: 'i_signup', type: 'event', title: '暑期科研项目报名截止',
    startsAt: at(5), datePrecision: 'day', dateRaw: `下${cnWeekday(5)}`,
  }),
  item({
    id: 'i_t1', type: 'thought', title: '查一下上次提到的那篇关于注意残留的论文',
    createdAt: at(0, 11, 20), sourceFragmentIds: ['f_thought'],
    citations: [cite('i_t1', 'f_thought', 'title', '查一下上次提到的那篇关于注意残留的论文')],
  }),
  item({ id: 'i_t2', type: 'thought', title: '组会 PPT 用上次那个模板就行', createdAt: at(-1, 15, 40) }),
  item({ id: 'i_t3', type: 'thought', title: '记得回小王消息', createdAt: at(-1, 9, 5) }),
  item({
    id: 'i_said1', type: 'state', title: '简历那版太长了，两页压不住',
    projectId: 'p_intern', createdAt: at(0, 13, 5), sourceFragmentIds: ['f_mail'],
    citations: [cite('i_said1', 'f_mail', 'title', '简历那版太长了，两页压不住')],
  }),
  item({
    id: 'i_confirm', type: 'task', title: '交材料',
    dueAt: at(3), datePrecision: 'day', status: 'needs_confirm', confidence: 'low', dateRaw: '这周内',
    createdAt: at(-1, 20, 40), sourceFragmentIds: ['f_confirm'],
    citations: [
      cite('i_confirm', 'f_confirm', 'title', '交材料'),
      cite('i_confirm', 'f_confirm', 'date_raw', '这周内'),
    ],
  }),
]

const byId = (id: string) => ITEMS.find((i) => i.id === id)!

/**
 * 改动记录。下划线命名是服务端把库里的行原样返出来的样子，样例数据跟着它写。
 * 「改期」那几行是处境信号，所以这一段必须有东西可看。
 */
export const HISTORY: Record<string, ItemHistoryRow[]> = {
  i_mail: [
    {
      id: 'h1', item_id: 'i_mail', changed_at: at(-1, 9, 30), field: 'due_at',
      old_value: at(-1), new_value: at(2), actor: 'user', fragment_id: null,
    },
    {
      id: 'h2', item_id: 'i_mail', changed_at: at(0, 13, 5), field: 'title',
      old_value: '交材料', new_value: '把实习申请的材料交上去', actor: 'merge', fragment_id: 'f_mail',
    },
  ],
}

// ── 各页 ──────────────────────────────────────────────────────────────

export const NOW: NowView = {
  primary: {
    itemId: 'i_mail',
    title: '把实习申请的材料交上去',
    reason: `${cnWeekday(2)}截止，还剩 2 天。本周另有高数期中与组会材料。`,
    steps: ['把邮件草稿打开，只填收件人', '只打开草稿，不用写', '先把要附的两个文件找出来'],
  },
  alternates: [
    {
      itemId: 'i_resume',
      title: '把简历第二页的实习经历压到三行',
      reason: '实习申请这个项目 7 天没动了，而它是这周唯一有硬截止的一件。',
      steps: ['打开简历，读一遍第二页', '只读那一段，不改'],
    },
    {
      itemId: 'i_seminar',
      title: '组会材料',
      reason: '今天 18:00 要用，每周一次。',
      steps: ['把上次的模板复制一份', '只打开模板'],
    },
  ],
  energy: '上午四节连堂上到中午，现在离你的高峰还有六个小时。',
  basis: ['i_mail', 'i_midterm', 'i_seminar'],
}

export const PROJECT_CARDS: ProjectCard[] = [
  {
    project: PROJECTS[0]!, unfinished: 3, done: 0,
    next: [{ id: 'i_mail', type: 'task', title: '把实习申请的材料交上去', at: at(2) }],
    said: ['简历那版太长了，两页压不住'], idleDays: 7, lastActivityAt: at(-7),
  },
  {
    project: PROJECTS[1]!, unfinished: 1, done: 0,
    next: [{ id: 'i_midterm', type: 'event', title: '高等数学期中考试', at: at(10, 14) }],
    said: [], idleDays: 1, lastActivityAt: at(-1),
  },
  {
    project: PROJECTS[2]!, unfinished: 1, done: 1,
    next: [{ id: 'i_seminar', type: 'task', title: '组会材料', at: at(0, 18) }],
    said: [], idleDays: 0, lastActivityAt: at(0),
  },
  {
    project: PROJECTS[3]!, unfinished: 0, done: 0,
    next: [], said: ['读完了三篇'], idleDays: 12, lastActivityAt: at(-12),
  },
]

function run(fragmentId: string, over: Partial<Run> = {}): Run {
  const f = fragment(fragmentId)
  return {
    id: `run_${fragmentId}`,
    fragmentId,
    status: 'done',
    startedAt: f.createdAt,
    finishedAt: f.createdAt,
    message: '接住了。原文已存。',
    counts: { created: 1, updated: 0, dropped: 0, needsConfirm: 0 },
    ...over,
  }
}

/** 四种收场都要在这一页上出现：抽到了、抽到但要确认、零条、失败 */
export const RECENT: RecentEntry[] = [
  { fragment: fragment('f_shot'), run: run('f_shot'), items: [byId('i_seminar')] },
  {
    fragment: fragment('f_mail'),
    run: run('f_mail', { counts: { created: 3, updated: 0, dropped: 0, needsConfirm: 0 } }),
    items: [byId('i_mail'), byId('i_rec'), byId('i_said1')],
  },
  { fragment: fragment('f_thought'), run: run('f_thought'), items: [byId('i_t1')] },
  {
    fragment: fragment('f_blank'),
    run: run('f_blank', {
      message: '没找到需要记的东西。原文已存。',
      counts: { created: 0, updated: 0, dropped: 0, needsConfirm: 0 },
    }),
    items: [],
  },
  { fragment: fragment('f_notice'), run: run('f_notice'), items: [byId('i_midterm')] },
  {
    fragment: fragment('f_confirm'),
    run: run('f_confirm', {
      message: '有一条要你确认。原文已存。',
      counts: { created: 0, updated: 0, dropped: 0, needsConfirm: 1 },
    }),
    items: [byId('i_confirm')],
  },
  {
    fragment: fragment('f_fail'),
    run: run('f_fail', { status: 'failed', message: '没能理解这条。原文已存。', counts: null }),
    items: [],
  },
]

export const AGENDA: AgendaView = {
  from: day(0),
  to: day(13),
  days: [
    { day: day(2), items: [{ item: byId('i_mail'), project: { id: 'p_intern', name: '实习申请' } }] },
    { day: day(5), items: [{ item: byId('i_signup'), project: null }] },
    { day: day(10), items: [{ item: byId('i_midterm'), project: { id: 'p_math', name: '高等数学' } }] },
  ],
  recurring: [{ item: byId('i_seminar'), project: { id: 'p_ds', name: '数据结构' } }],
}
