import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CalendarSchema, createCtx, occursOn, supportsRrule } from '@flowpal/shared'
import { openDb } from '../src/store/db.ts'
import { insertFragment } from '../src/store/fragments.ts'
import { itemHistory, listItems } from '../src/store/items.ts'
import { listProjects } from '../src/store/projects.ts'
import { mapStructured } from '../src/pipeline/map-structured.ts'
import { applyMapped } from '../src/sync/apply.ts'
import { parseNotices, parseSchedule } from '../src/sync/portal.ts'
import { mapPortalSchedule } from '../src/sync/map.ts'
import { failed, idle, ok, summarize } from '../src/sync/state.ts'

/**
 * 同步这条路的硬断言。**不联网、不用凭据、不调模型**，所以它天天可跑。
 *
 * 判断依据分三处，都不是「代码自己说了算」：
 *
 *   - **字段名与形状**来自既有 Flutter/Dart 实现（~/RUC/rucgo `lib/systems/portal/
 *     schedule.dart`）。下面这份样例是照它记下的实测形状手写的，包括「没有事的那天
 *     根本没有 events 这个键」这种只有真跑过才知道的细节。
 *   - **幂等与改期**两条来自已定的不变量：结构化来源按 external_id 覆盖、不走语义
 *     链路；覆盖时字段变化要写一行 item_history。
 *   - **引用逐字可验**来自「每个字段带原文引用」这条原则，与拉回来的是什么无关。
 *
 * 它验不了的是**接口今天还给不给这份形状**——那要真实凭据，只能靠 `pnpm sync:once`
 * 现跑一次。两件事分开说：这里保证解析与落库对，那里保证接口还在。
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const failures: string[] = []

function assert(ok: boolean, what: string, detail = ''): void {
  if (ok) console.log(`  ✓ ${what}`)
  else { console.log(`  ✗ ${what}${detail ? `\n      ${detail}` : ''}`); failures.push(what) }
}

const calendar = CalendarSchema.parse(
  JSON.parse(readFileSync(join(repoRoot, 'data/calendar.json'), 'utf8')),
)
const ctx = createCtx(calendar, '2026-09-14T10:00:00+08:00')

// ── 样例：照实测形状手写的一份日程中心返回 ────────────────────────────

/** 一节课的一次发生。字段名逐字照抄接口。 */
function lesson(day: string, from: string, to: string) {
  return {
    beginTime: `${day} ${from}:00`,
    endTime: `${day} ${to}:00`,
    schedule: {
      title: '网络与通信01',
      location: '公教一楼1201',
      content: '课程:网络与通信01;上课时间：星期1 第7～9节;老师:鄂金龙',
      cateGory: { id: -2, name: '课表' },
    },
  }
}

function calendarNote(day: string, title: string) {
  return {
    beginTime: `${day} 00:00:00`,
    endTime: `${day} 23:59:00`,
    schedule: { title, location: '', content: '', cateGory: { id: -5, name: '校历' } },
  }
}

function personal(day: string, from: string, title: string) {
  return {
    beginTime: `${day} ${from}:00`,
    endTime: `${day} ${from}:00`,
    schedule: { title, location: '明德楼', content: '', cateGory: { id: 0, name: '我的日历' } },
  }
}

/** 每周一同一时段的课，连着四周。 */
const CLASS_DAYS = ['2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28']

const body = [
  ...CLASS_DAYS.map((day) => ({ day: `${day} 00:00:00`, events: [lesson(day, '14:00', '15:40')] })),
  // 没有事的那天：**根本没有 events 这个键**，不是空数组。
  { day: '2026-09-08 00:00:00' },
  // 调课：一个孤立的周日，上的是星期二的课。它该落在那一天上，不该被压进课表细带。
  { day: '2026-09-20 00:00:00', events: [lesson('2026-09-20', '08:00', '09:40')] },
  // 跨天的校历被服务端按天切开了，这里是连着的三天。
  { day: '2026-10-01 00:00:00', events: [calendarNote('2026-10-01', '国庆节放假')] },
  { day: '2026-10-02 00:00:00', events: [calendarNote('2026-10-02', '国庆节放假')] },
  { day: '2026-10-03 00:00:00', events: [calendarNote('2026-10-03', '国庆节放假')] },
  { day: '2026-09-30 00:00:00', events: [personal('2026-09-30', '19:00', '组会')] },
]

const rawText = JSON.stringify({
  kind: 'ruc-portal-schedule',
  term: ctx.term.id,
  range: { from: '2026-09-07', to: '2027-01-10' },
  weeks: [{ from: '2026-09-07', to: '2027-01-10', body }],
})

// ── 解析 ──────────────────────────────────────────────────────────────

console.log('\n解析')

const events = parseSchedule(body)
assert(events.length === 9, '没有 events 键的那天不产生任何条目，也不报错', `实得 ${events.length} 条`)
assert(
  events.filter((e) => e.categoryId === -2).length === 5,
  '课表、校历、我的日历三类都在同一份返回里',
)
assert(
  events.find((e) => e.title === '国庆节放假')?.allDay === true,
  '00:00 到 23:59 认成整天的事',
)
assert(
  events[0]?.beginRaw === '2026-09-07 14:00:00',
  '起止时刻原样留着，不在解析时换算',
  events[0]?.beginRaw ?? '无',
)

// ── 映射 ──────────────────────────────────────────────────────────────

console.log('\n映射')

const mapped = mapPortalSchedule(ctx, events)
const weekly = mapped.find((m) => m.item.recurrence !== null)
assert(
  mapped.filter((m) => m.item.title === '网络与通信01').length === 2,
  '同一门课的四次周一压成一条，孤立的那次调课单独一条',
  `实得 ${mapped.filter((m) => m.item.title === '网络与通信01').length} 条`,
)
assert(
  weekly?.item.recurrence === 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20260928T155959Z',
  '每周一的课给出 RRULE，UNTIL 落在最后一次上课那天',
  weekly?.item.recurrence ?? '无',
)
assert(
  weekly?.item.date_raw === '周一 14:00–15:40 · 第 1–4 周',
  'date_raw 写出周几、时段与第几周',
  weekly?.item.date_raw ?? '无',
)
assert(
  mapped.find((m) => m.item.date_raw === '2026-09-20 08:00')?.item.recurrence === null,
  '只发生一次的那组不给 RRULE——它是调课，该占日程上的一格',
)

const holiday = mapped.find((m) => m.item.title === '国庆节放假')
assert(
  mapped.filter((m) => m.item.title === '国庆节放假').length === 1,
  '按天切开的三天校历重新拢成一条，不在日程上连着排三行',
  `实得 ${mapped.filter((m) => m.item.title === '国庆节放假').length} 条`,
)
assert(
  holiday?.item.starts_at === '2026-10-01T00:00:00+08:00' && holiday.item.date_raw === '2026-10-01 至 2026-10-03',
  '校历条目是整天的，日期写成一段区间',
  `${holiday?.item.starts_at} / ${holiday?.item.date_raw}`,
)
assert(
  holiday?.item.date_precision === 'day',
  '无时刻的日期标成 day，否则会被当成午夜',
)
assert(
  mapped.every((m) => m.item.citations.every((c) => rawText.includes(c.quote))),
  '每条引用逐字出现在拉回来的原文里',
  mapped.flatMap((m) => m.item.citations.filter((c) => !rawText.includes(c.quote)).map((c) => c.quote)).join(' / '),
)

// ── 重复项落在哪几天 ──────────────────────────────────────────────────

console.log('\n重复')

{
  // 用上面那条课自己的 RRULE，不另写一条：日程页要问的正是「同步进来的这一条
  // 在今天发生吗」，拿一条手编的规则去问，验的就是另一件事了。
  const rule = weekly!.item.recurrence!
  const start = weekly!.item.starts_at!

  assert(occursOn(rule, start, '2026-09-14'), '每周一的课在第二个周一发生')
  assert(!occursOn(rule, start, '2026-09-15'), '它不在周二发生')
  assert(!occursOn(rule, start, '2026-08-31'), 'DTSTART 之前不发生')
  assert(!occursOn(rule, start, '2026-10-05'), 'UNTIL 之后不发生——课结束了就不该还在日程上')
  assert(
    occursOn(rule, start, '2026-09-28'),
    'UNTIL 当天仍然发生：它是最后一次上课那天，不是结束之后',
  )

  const biweekly = 'FREQ=WEEKLY;BYDAY=MO;INTERVAL=2;UNTIL=20261228T155959Z'
  assert(
    occursOn(biweekly, start, '2026-09-21') && !occursOn(biweekly, start, '2026-09-14'),
    '隔周的相位由 DTSTART 定，不是随便隔一周',
  )

  const monthly = 'FREQ=MONTHLY'
  assert(
    occursOn(monthly, '2026-09-07T09:00:00+08:00', '2026-11-07')
    && !occursOn(monthly, '2026-09-07T09:00:00+08:00', '2026-11-08'),
    '按月重复落在 DTSTART 那个日子上',
  )

  let loud = false
  try {
    occursOn('FREQ=YEARLY', start, '2026-09-14')
  } catch {
    loud = true
  }
  assert(loud, '看不懂的规则抛出，而不是当成「不发生」把一门课从日程上抹掉')
  assert(
    !supportsRrule('FREQ=YEARLY') && !supportsRrule('FREQ=MONTHLY;BYDAY=2TU'),
    '放不下的规则事先问得出来，日程页据此给它另找位置而不是整页 500',
  )
  assert(supportsRrule(rule) && supportsRrule(monthly), '我们自己写出来的规则都放得下')
}

// ── 通知的信封 ────────────────────────────────────────────────────────

console.log('\n通知')

const noticeBody = {
  resultCode: 0,
  result: {
    total: 2,
    data: [
      {
        siteArticleId: 88991,
        articleId: 5501,
        title: '  关于2026年秋季学期选课的通知',
        createOrgName: '教务处',
        publishTime: '2026-09-05 16:20:00',
        topest: 1,
        read: 0,
        url: '',
      },
      {
        siteArticleId: 88990,
        articleId: 5500,
        title: '图书馆国庆假期开放安排',
        createOrgName: '图书馆',
        publishTime: '2026-09-04 09:00:00',
        topest: 0,
        read: 1,
        url: 'https://lib.ruc.edu.cn/notice/1',
      },
    ],
  },
}

const notices = parseNotices(noticeBody)
assert(notices.length === 2, '通知在 result.data 里，不在 result 上', `实得 ${notices.length} 条`)
assert(
  notices[0]?.title === '关于2026年秋季学期选课的通知',
  '标题的前导空格去掉，否则列表左边缘参差不齐',
  JSON.stringify(notices[0]?.title),
)
assert(
  notices[0]?.id === 88991,
  '用 siteArticleId 而不是 articleId——详情接口认的是前者',
)
assert(
  notices[0]?.url === null && notices[1]?.url === 'https://lib.ruc.edu.cn/notice/1',
  '空的 url 表示正文在门户自己这里，不是一条指向空处的链接',
)

/*
 * 少带一个 `_p` 时门户回 HTTP 200、resultCode 1、result null。不查 resultCode
 * 的话，那种失败在上层看起来是「今天没有通知」——一个永远不会被发现的空。
 */
let silentlyEmpty = false
try {
  parseNotices({ resultCode: 1, result: null, errorMsg: '参数错误' })
} catch {
  silentlyEmpty = true
}
assert(silentlyEmpty, 'resultCode 非 0 时抛出，不当成「今天没有通知」')

// ── 一轮的总状态 ──────────────────────────────────────────────────────

console.log('\n同步状态')

assert(
  summarize([
    ok('课表与校历', 30, 0),
    idle('通知公告', '已记下当前进度，从下次起处理新通知'),
    idle('邮件', '未配置'),
  ]).state === 'ok',
  '第一次同步：通知只记水位、邮件没配，整轮仍然是成功',
)
assert(
  summarize([ok('课表与校历', 0, 30), failed('邮件（x@ruc.edu.cn）', '认证失败')]).message === '认证失败',
  '有一路坏了就报那一路的原因，而不是「有 1 路失败」',
)
assert(
  summarize([ok('课表与校历', 2, 30), ok('通知公告', 1, 0)]).message === '新增 3 条 · 更新 30 条',
  '都成功时报新增与更新的条数',
)

// ── 落库 ──────────────────────────────────────────────────────────────

console.log('\n落库')

const db = openDb(':memory:')
const fragment = insertFragment(db, ctx, { source: 'timetable', rawType: 'structured', rawText })

const first = applyMapped(db, ctx, fragment.id, mapStructured(ctx, fragment))
const afterFirst = listItems(db).length
const second = applyMapped(db, ctx, fragment.id, mapStructured(ctx, fragment))

assert(afterFirst === mapped.length, '第一次落库把每条候选都写进去了', `实得 ${afterFirst} 条`)
assert(
  listItems(db).length === afterFirst,
  '同一份课表连拉两次，items 不增加',
  `实得 ${listItems(db).length} 条`,
)
assert(
  first.created === afterFirst && second.created === 0 && second.updated === afterFirst,
  '第二次全部走覆盖，一条都不算新建',
  `created ${second.created} / updated ${second.updated}`,
)
assert(
  listItems(db).every((i) => itemHistory(db, i.id).length === 0),
  '原样重放不写任何变更历史',
)
assert(
  listProjects(db).some((p) => p.name === '网络与通信01'),
  '课程自动成为项目',
  listProjects(db).map((p) => p.name).join(' / '),
)
assert(
  listItems(db).filter((i) => i.projectId !== null).length === 2
  && listItems(db).filter((i) => i.title === '国庆节放假' && i.projectId === null).length === 1,
  '只有课挂到项目上，校历与个人日程不挂',
)

// 改期：教务把这门课挪到下午三点。
const moved = body.map((day) =>
  'events' in day && day.events?.[0]?.schedule.cateGory.id === -2 && day.day.startsWith('2026-09-07')
    ? { ...day, events: [lesson('2026-09-07', '15:00', '16:40')] }
    : day,
)
const movedFragment = insertFragment(db, ctx, {
  source: 'timetable',
  rawType: 'structured',
  rawText: JSON.stringify({ ...JSON.parse(rawText), weeks: [{ from: '2026-09-07', to: '2027-01-10', body: moved }] }),
})
applyMapped(db, ctx, movedFragment.id, mapStructured(ctx, movedFragment))

const rescheduled = listItems(db)
  .filter((i) => i.title === '网络与通信01')
  .flatMap((i) => itemHistory(db, i.id))
assert(
  rescheduled.some((h) => h.field === 'starts_at' && h.actor === 'sync'),
  '课挪了时间，覆盖时写出一行 actor 为 sync 的 item_history',
  rescheduled.map((h) => `${h.field}:${h.actor}`).join(' / ') || '一行都没写',
)

db.close()

if (failures.length > 0) {
  console.log(`\n${failures.length} 条断言未通过`)
  process.exit(1)
}
console.log('\n全部通过')
