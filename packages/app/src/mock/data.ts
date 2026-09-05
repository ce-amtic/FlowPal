import type { Drop, ItemWithSources, NowView, Project, ProjectDetail } from '../api.ts'

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

/** 重复规则里的星期码要和它的首次发生日对得上，否则界面上会自相矛盾 */
function weekdayCode(days: number): string {
  const d = new Date(now)
  d.setDate(d.getDate() + days)
  return ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][d.getDay()]!
}

function item(over: Partial<ItemWithSources> & Pick<ItemWithSources, 'id' | 'type' | 'title'>): ItemWithSources {
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
    createdAt: at(-2, 10),
    updatedAt: at(-2, 10),
    projectId: null,
    sourceFragmentIds: [],
    citations: [],
    ...over,
  }
}

export const PROJECTS: Project[] = [
  { id: 'p_intern', name: '实习申请', statusNote: '材料还差推荐信', status: 'active', idleDays: 7 },
  { id: 'p_math', name: '高等数学', statusNote: null, status: 'active', idleDays: 1 },
  { id: 'p_ds', name: '数据结构', statusNote: null, status: 'active', idleDays: 0 },
  { id: 'p_paper', name: '注意残留那篇综述', statusNote: '读完了三篇', status: 'active', idleDays: 12 },
]

export const ITEMS: ItemWithSources[] = [
  item({
    id: 'i_mail', type: 'task', title: '填写实习申请邮件的收件人',
    dueAt: at(2), datePrecision: 'day', dateRaw: '周三之前', projectId: 'p_intern',
  }),
  item({
    id: 'i_resume', type: 'task', title: '把简历第二页的实习经历压到三行',
    projectId: 'p_intern',
  }),
  item({
    id: 'i_rec', type: 'task', title: '找王老师要推荐信', projectId: 'p_intern',
    confidence: 'medium',
  }),
  item({
    id: 'i_midterm', type: 'event', title: '高等数学期中考试',
    startsAt: at(10, 14), datePrecision: 'minute', location: '明德主楼 0201',
    projectId: 'p_math',
  }),
  item({
    id: 'i_seminar', type: 'task', title: '组会材料',
    dueAt: at(0, 18), datePrecision: 'minute', rrule: `FREQ=WEEKLY;BYDAY=${weekdayCode(0)}`,
    projectId: 'p_ds',
  }),
  item({
    id: 'i_hw', type: 'task', title: '数据结构第三次作业',
    dueAt: at(4), datePrecision: 'day', projectId: 'p_ds', status: 'done',
  }),
  item({
    id: 'i_signup', type: 'event', title: '暑期科研项目报名截止',
    startsAt: at(5), datePrecision: 'day', dateRaw: '下周二',
  }),
  item({
    id: 'i_t1', type: 'thought', title: '查一下上次提到的那篇关于注意残留的论文',
    createdAt: at(0, 11, 20), projectId: 'p_paper',
  }),
  item({
    id: 'i_t2', type: 'thought', title: '组会 PPT 用上次那个模板就行', createdAt: at(-1, 15, 40),
  }),
  item({
    id: 'i_t3', type: 'thought', title: '记得回小王消息', createdAt: at(-1, 9, 5),
  }),
  item({
    id: 'i_confirm', type: 'task', title: '交材料',
    dueAt: at(3), datePrecision: 'day', status: 'needs_confirm', confidence: 'low',
    dateRaw: '这周内',
  }),
]

export const NOW: NowView = {
  empty: false,
  greeting: '下午好。今天是第二周的周五。',
  energyReading: '上午四节连堂上到中午，现在离你的高峰还有六个小时。',
  candidates: [
    {
      itemId: 'i_mail',
      title: '填写实习申请邮件的收件人',
      reason: '周三截止，还剩 2 天。本周另有高数期中与组会材料。',
      steps: ['把邮件草稿打开，只填收件人', '只打开草稿，不用写', '先把要附的两个文件找出来'],
      basis: ['i_mail', 'i_midterm', 'i_seminar'],
    },
    {
      itemId: 'i_resume',
      title: '把简历第二页的实习经历压到三行',
      reason: '实习申请这个项目 7 天没动了，而它是这周唯一有硬截止的一件。',
      steps: ['打开简历，读一遍第二页', '只读那一段，不改'],
      basis: ['i_resume', 'p_intern'],
    },
    {
      itemId: 'i_seminar',
      title: '组会材料',
      reason: '今天 18:00 要用，每周三一次。',
      steps: ['把上次的模板复制一份', '只打开模板'],
      basis: ['i_seminar', 'i_t2'],
    },
  ],
  dateBand: [
    { at: at(0, 18), title: '组会材料' },
    { at: at(2), title: '实习申请邮件' },
    { at: at(5), title: '科研报名截止' },
    { at: at(10, 14), title: '高数期中' },
  ],
}

export const PROJECT_DETAILS: Record<string, ProjectDetail> = {
  p_intern: {
    project: PROJECTS[0]!,
    upcoming: ITEMS.filter((i) => i.id === 'i_mail'),
    todo: ITEMS.filter((i) => ['i_resume', 'i_rec'].includes(i.id)),
    done: [],
    said: [
      { at: at(-7, 21, 10), text: '简历那版太长了，两页压不住' },
      { at: at(-12, 16, 0), text: '先投三家，别铺太开' },
    ],
  },
}

export const DROPS: Drop[] = [
  {
    fragment: {
      id: 'f1', createdAt: at(0, 14, 20), source: 'drop', rawType: 'image',
      rawText: null, rawBlobPath: 'blobs/f1.png',
    },
    items: ITEMS.filter((i) => ['i_midterm', 'i_seminar'].includes(i.id)),
    outcome: 'ok',
  },
  {
    fragment: {
      id: 'f2', createdAt: at(0, 13, 5), source: 'hotkey', rawType: 'text',
      rawText: '下周三之前把那个报告发给老师', rawBlobPath: null,
    },
    items: ITEMS.filter((i) => i.id === 'i_mail'),
    outcome: 'ok',
  },
  {
    fragment: {
      id: 'f3', createdAt: at(0, 11, 40), source: 'drop', rawType: 'image',
      rawText: null, rawBlobPath: 'blobs/f3.png',
    },
    items: [],
    outcome: 'empty',
  },
  {
    fragment: {
      id: 'f4', createdAt: at(-1, 22, 12), source: 'paste', rawType: 'text',
      rawText: '各位同学，关于本学期期末考试安排的通知……', rawBlobPath: null,
    },
    items: [],
    outcome: 'failed',
  },
]
