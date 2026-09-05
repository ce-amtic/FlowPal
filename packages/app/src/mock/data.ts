import type { Project, Run } from '@flowpal/shared'
import type { AgendaView, ItemWithSources, NowView, ProjectCard, RecentEntry } from '../api.ts'

/**
 * 样例数据。只在样例模式下使用，真实模式下这个文件不会被读到。
 *
 * 日期一律相对当前时间算出来，不写死：写死的话今天调好、明天打开就全部过期，
 * 「还剩 2 天」会变成「已过期 3 天」，而那是最不该出现的错。
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

/** 重复规则里的星期码要和它的首次发生日对得上，否则界面上会自相矛盾 */
function weekdayCode(days: number): string {
  const d = new Date(now)
  d.setDate(d.getDate() + days)
  return ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][d.getDay()]!
}

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
    id: 'i_mail', type: 'task', title: '填写实习申请邮件的收件人',
    dueAt: at(2), datePrecision: 'day', dateRaw: '周三之前', projectId: 'p_intern',
  }),
  item({ id: 'i_resume', type: 'task', title: '把简历第二页的实习经历压到三行', projectId: 'p_intern' }),
  item({ id: 'i_rec', type: 'task', title: '找王老师要推荐信', projectId: 'p_intern', confidence: 'medium' }),
  item({
    id: 'i_midterm', type: 'event', title: '高等数学期中考试',
    startsAt: at(10, 14), datePrecision: 'minute', location: '明德主楼 0201', projectId: 'p_math',
  }),
  item({
    id: 'i_seminar', type: 'task', title: '组会材料',
    dueAt: at(0, 18), datePrecision: 'minute', rrule: `FREQ=WEEKLY;BYDAY=${weekdayCode(0)}`,
    projectId: 'p_ds',
  }),
  item({
    id: 'i_hw', type: 'task', title: '数据结构第三次作业',
    dueAt: at(-1), datePrecision: 'day', projectId: 'p_ds', status: 'done',
  }),
  item({
    id: 'i_signup', type: 'event', title: '暑期科研项目报名截止',
    startsAt: at(5), datePrecision: 'day', dateRaw: '下周二',
  }),
  item({ id: 'i_t1', type: 'thought', title: '查一下上次提到的那篇关于注意残留的论文', createdAt: at(0, 11, 20) }),
  item({ id: 'i_t2', type: 'thought', title: '组会 PPT 用上次那个模板就行', createdAt: at(-1, 15, 40) }),
  item({ id: 'i_t3', type: 'thought', title: '记得回小王消息', createdAt: at(-1, 9, 5) }),
  item({
    id: 'i_said1', type: 'state', title: '简历那版太长了，两页压不住',
    projectId: 'p_intern', createdAt: at(-7, 21, 10),
  }),
  item({
    id: 'i_confirm', type: 'task', title: '交材料',
    dueAt: at(3), datePrecision: 'day', status: 'needs_confirm', confidence: 'low', dateRaw: '这周内',
  }),
]

const byId = (id: string) => ITEMS.find((i) => i.id === id)!

export const NOW: NowView = {
  primary: {
    itemId: 'i_mail',
    title: '填写实习申请邮件的收件人',
    reason: '周三截止，还剩 2 天。本周另有高数期中与组会材料。',
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
    next: [{ id: 'i_mail', type: 'task', title: '填写实习申请邮件的收件人', at: at(2) }],
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
  return {
    id: `run_${fragmentId}`,
    fragmentId,
    status: 'done',
    startedAt: at(0, 14, 20),
    finishedAt: at(0, 14, 20),
    message: '接住了。原文已存。',
    counts: { created: 2, updated: 0, dropped: 0, needsConfirm: 0 },
    ...over,
  }
}

export const RECENT: RecentEntry[] = [
  {
    fragment: {
      id: 'f1', createdAt: at(0, 14, 20), device: 'desktop', source: 'drop',
      rawType: 'image', rawText: null, rawBlobPath: 'blobs/f1.png',
    },
    run: run('f1'),
    items: [byId('i_midterm'), byId('i_seminar')],
  },
  {
    fragment: {
      id: 'f2', createdAt: at(0, 13, 5), device: 'desktop', source: 'hotkey',
      rawType: 'text', rawText: '下周三之前把那个报告发给老师', rawBlobPath: null,
    },
    run: run('f2', { counts: { created: 1, updated: 0, dropped: 0, needsConfirm: 0 } }),
    items: [byId('i_mail')],
  },
  {
    fragment: {
      id: 'f3', createdAt: at(0, 11, 40), device: 'desktop', source: 'drop',
      rawType: 'image', rawText: null, rawBlobPath: 'blobs/f3.png',
    },
    run: run('f3', {
      message: '没找到需要记的东西。原文已存。',
      counts: { created: 0, updated: 0, dropped: 0, needsConfirm: 0 },
    }),
    items: [],
  },
  {
    fragment: {
      id: 'f4', createdAt: at(-1, 22, 12), device: 'desktop', source: 'paste',
      rawType: 'text', rawText: '各位同学，关于本学期期末考试安排的通知……', rawBlobPath: null,
    },
    run: run('f4', { status: 'failed', message: '没能理解这条。原文已存。', counts: null }),
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
