# 语义层（A）交接说明

> 写给 B（桌面侧）与 C（主窗口）。2026-09-05，作品冻结（09-06 12:30）之前。
> A 线第 1–7 步已全部落地：项目层 → 对照集与演示种子 → 路由与 SSE → 六个工具 →
> agent 循环 → buildContext → 「此刻」接口。本文只讲你们会碰到什么。

## 1. 用的什么 AI、什么接口格式

- **供应商**：DeepSeek 官方 API，**OpenAI 兼容的 chat completions**（路径 `/v1`）。
- **baseUrl**：`https://api.deepseek.com/v1`
- **模型**：
  - 文本：`deepseek-v4-flash`
  - 读图（截图类碎片）：`deepseek-v4-flash-vision-exp`
- **配置位置**：`config.local.json` 的 `llm.text` 与 `llm.vision`。该文件在 .gitignore 里，key 永不进仓库。

两条调用路径：

1. **写库走 agent 循环**：`packages/server/src/agent/loop.ts` 用 OpenAI `tools` 调用；
   `createItem` 工具参数是 strict schema，逐字引用在工具执行时校验，失败作为工具结果返回。
2. **只读的「此刻」走一次生成**：`callJson` 仍按「strict json_schema 优先、json_object 兜底」；
   DeepSeek v4 对 strict `response_format` 仍会 400，`client.ts` 已自动降级。

## 2. 那张群聊截图是我 mock 的

- `fixtures/01-groupchat.png` 是合成截图：Playwright 渲染仿群聊 HTML 再截图，内容 = 三条拼奶茶消息 + 一条高数期中考试通知。**不是真实聊天记录。**
- 路演要用真实截图，直接替换这个文件即可，`fixtures/01-groupchat.json` 的期望值不用动。

## 3. Prompt 现状

- `prompts/agent.md`：agent 循环系统 prompt。分类、合并三例、项目归属、语气都在这里。
- `prompts/now.md`：「此刻」输出 prompt，含 `energy_reading` 与文案风格约束。
- `prompts/extract.md`：仅 `/api/extract` 这个「只理解不落库」的开发口还在用；写库不再经过它。

别顺手删掉这些踩坑点：

1. 通知里顺带的要求不单独成条。
2. `thought` 与 `task` 的分界；`hotkey` 默认按想法处理。
3. 日期用 now / 学期 / 第几周算绝对时间；重复事项写 RRULE。
4. 每个有内容字段的 `quote` 必须逐字出现在原文；项目归属 quote 同样逐字。
5. 在场而不评判，不写「别忘了」「抓紧时间」。
6. 截图宁可少抽，不要凑数。
7. 合并有正反例：组会材料 → 组会 PPT 是 updateItem；数据结构作业与数据结构考试不合并。

## 4. 数据层已落地的东西

- **项目层**：`projects`、`items.project_id`、`items.external_id`、`focus_sessions`、`runs`、`run_events`、`app_settings`、`now_cache`。
- **给 B 的现成件**：`store/upsertByExternalId` 按 external_id 覆盖、幂等、字段变化写 `item_history`；教务/日历同步直接调它。
- **真实校历**：`data/calendar.json`（秋季 2026-09-07 开学、18 周；春季 2027-02-22 开学、19 周）。B 同步落地后替换。
- **演示种子**：`pnpm demo:reset` = 5 项目 / 21 条目 / 12 碎片 / 4 次专注 / 1 条改期历史，日期全部相对执行时刻算。
- **旧库守卫**：`db.ts` 当前 schema v4；旧形状拒绝并提示重建。

## 5. 路由与事件形状

| 路由 | 形状要点 | 给谁 |
|---|---|---|
| `GET /api/items`、`GET/PATCH /api/items/:id` | 条目清单（不含 dropped）；PATCH 确认待确认/改字段，写后广播 | C |
| `POST /api/fragments` | 入参 `{source, rawType, rawText?, rawBlobPath?, device?}`；返回 `{fragment, run, items, plans}`。`plans` 恒为 `[]`（MergePlan 已删除，保留字段兼容旧客户端）；看 `run.status` 与 `run.counts` | C 投放、B 拖拽采集 |
| `GET /api/fragments`、`GET /api/fragments/:id` | 原始碎片 | C |
| `GET /api/projects` | `{projects: 项目卡[], unclassified: 未归类条目[]}` | C 项目页 |
| `GET/POST /api/projects`、`GET/PATCH/DELETE /api/projects/:id` | 项目 CRUD；同名自动归并；DELETE 是标记 dropped | C 项目页 |
| `GET /api/agenda?from&to` | `{from, to, days, recurring}` | C 日程页 |
| `GET /api/thoughts` | 想法倒序流 | C 想法页 |
| `GET /api/confirmations` | `{items, count}` | C 待确认 |
| `GET /api/now` | 见下 | C 此刻页 |
| `POST /api/now/refresh` | 清「此刻」缓存；下次 GET 重新生成。**新增口，C 接一下** | C 此刻页 |
| `GET /api/recent` | `{recent:[{fragment, run, items}]}`；run 可能为 null | C 最近页 |
| `POST/GET /api/focus-sessions` | `{startedAt, plannedMinutes, actualMinutes?, endedEarly?, itemId?, projectId?}`；endedEarly=1 = 下次继续 | B 的 /focus |
| `GET /api/events` | SSE 粗粒度广播 `{type:'changed', at}`，连上先推一条 | C 两个窗口 |
| `GET /api/runs/:id/events` | SSE：先回放 `run_started` + 已落库 `tool_call`，再流式推新增，结束补 `run_finished` | B 气泡「进行中」 |

`GET /api/runs/:id/events` 的三种事件：

```json
{ "type": "run_started",  "at": "...", "runId": "..." }
{ "type": "tool_call",    "at": "...", "step": 1, "tool": "getProject", "args": { "id": "..." } }
{ "type": "run_finished", "at": "...", "status": "done", "counts": {"created":1,"updated":0,"dropped":0,"needsConfirm":0}, "message": "..." }
```

`tool_call` 只带工具名与参数，**不带工具结果**。`counts.updated` 按去重后的条目数，不是工具调用次数。

`GET /api/now` 的形状：

```json
{
  "primary": { "itemId": "itm_...", "title": "...", "reason": "...", "steps": ["...", "..."] },
  "alternates": [ ... ],
  "energy": "...",
  "basis": ["itm_... 或逐字事实"]
}
```

空库时 `primary:null, alternates:[], energy:null, basis:[]`。缓存失效三选一：跨半小时、库有写入、
`POST /api/now/refresh`。

`reason` 与 `steps` 对齐 `packages/app/src/api.ts` 的 `NowPick`；`steps` 至少两级，是「更小的一步」的本地切口数组。

## 6. 怎么跑

```bash
pnpm check:fixtures   # 十条碎片对照 + 静态断言，当前全绿
pnpm demo:reset       # 演示库一键重置
pnpm typecheck        # 三个包一起查
pnpm dev:server       # 只起 server 调管道
```

## 7. 必须同步给 B/C 的两个点

1. **C 要接新路由 `POST /api/now/refresh`**：用户在「此刻」页按「重新想一个」时打这个口，服务端只清缓存，下一次 `GET /api/now` 重新生成。不是可选项，不接的话「重新想一个」没有后端。
2. **B 要把 chronotype 两问写进 `app_settings`**：`/settings` 里写入 `chronotype_workday_wake` 与 `chronotype_restday_wake` 两个 key。A 的 `buildContext` 已经在读这两个 key；B 不写的话，「此刻」只能拿到「作息时间未知（先验，猜的）」这一条先验事实。

## 8. 其他注意点

- `MergePlan` / `applyPlans` 已删除，没有兼容路径；旧代码里再 import 会直接 typecheck 红。
- `fixtures/06-progress` 已翻面为 `active` 且挂「高等数学」；07–10 是三条合并对照。
