# 语义层（A）交接说明

> 写给 B（桌面侧）与 C（主窗口）。2026-09-05，作品冻结（09-06 12:30）之前。
> 本文只讲「A 已经做了什么、你们会碰到什么」，第 3 步路由扩展做完后会再更新一节。

## 1. 用的什么 AI、什么接口格式

- **供应商**：DeepSeek 官方 API，**OpenAI 兼容的 chat completions**（路径 `/v1`）。
- **baseUrl**：`https://api.deepseek.com/v1`
- **模型**：
  - 文本抽取：`deepseek-v4-flash`
  - 读图（截图类碎片）：`deepseek-v4-flash-vision-exp`
- **配置位置**：`config.local.json` 的 `llm.text` 与 `llm.vision`（各 `baseUrl/apiKey/model` 三项）。**该文件已被 .gitignore，key 永不进仓库**。换模型/换网关只改这里，不动代码。
- **输出格式（重要，B/C 要心里有数）**：
  - 设计上契约是 strict `response_format: json_schema`，但 **DeepSeek v4 目前不支持**（返回 400 `This response_format type is unavailable now`）。
  - `packages/server/src/llm/client.ts` 已做成两级：先发 strict json_schema；被拒后自动降级 `response_format: json_object`，并把同一份 `z.toJSONSchema` 产物塞进 system prompt。
  - 两条路的入库校验完全一样：zod 校验 + 引用逐字检查。**验收标准没有降级**，只是「形状对不对」的保证从服务端挪到了我们这一侧。
  - 降级模式的已知差异：json_object 不强制每个字段出现，模型可能省略值为 null 的键（实测缺 `starts_at`）；`pipeline/extract.ts` 的 `fillAbsentNullableFields` 机械补 null，不猜语义。
  - 视觉模型每轮输出的措辞有差异，但六条对照里日期/类型/条数三个断言连跑稳定。

## 2. 那张群聊截图是我 mock 的

- `fixtures/01-groupchat.png` 是**合成的截图**：我用 Playwright 渲染了一个仿群聊的 HTML 版式再截图（2x 缩放），内容 = 三条无关消息（拼奶茶）+ 一条高数期中考试通知。**不是任何真实聊天记录。**
- 它只服务于管道对照集（验证「视觉模型能从群聊噪音里抽出那条考试」）。路演/展示要用真实截图素材的话，**直接替换这个文件即可**，`fixtures/01-groupchat.json` 里的期望值不用动。
- 如需重现：HTML 版式 + Chromium `element.screenshot`，代码已删，重做很快。

## 3. 抽取 prompt 里的针对性细节

`prompts/extract.md` 不是通用模板，以下几条都是**对着 DeepSeek 实跑踩出来的坑**逐条加的，B/C 改 prompt 时别顺手删掉：

1. **通知里顺带的要求不单独成条**。模型一度把期中考试通知拆成两条：一条 event（考试）+ 一条假 task（「提前15分钟到场，带学生证」）。规则：这类附带要求属于那条通知本身，没有自己的时间，拆出去就是假任务。
2. **thought 与 task 的分界**：没有明确时间点、只是冒出来的念头是想法（「记得回小王」「把图换成最新数据」）；有期限或交付物的才是事务。`hotkey` 来源（专注中快捷键）默认按想法处理。
3. **日期**：绝对时间由模型结合 now / 学期第一周周一 / 第几周来算；`date_precision` 区分 day/minute；重复事项填 RFC 5545 RRULE 而不是编一个具体日期；`date_raw` 保留原始表达供用户对照。
4. **引用纪律**：每个有内容的字段的 `quote` 必须逐字出现在原文里，机器验（`extract.ts` 的 `assertCitationsAreVerbatim`），对不上直接报错。
5. **语气**：title 是对用户处境的一句复述，在场而不评判——不写「别忘了」「抓紧时间」。
6. **群聊/截图**：宁可少抽，不要凑数；无关消息丢弃。

这六条的行为已经用 `pnpm check:fixtures` 的六条碎片标定，是全绿的活验收。

## 4. A 已经落地的东西（第 1、2 步）

- **项目层**：`projects` 表、`items.project_id` / `items.external_id`、`focus_sessions` 表；`store/projects.ts`（建项目同名自动归并，忽略大小写与空白）；`progress` 条目无归属时以 `needs_confirm` 落库（[[010]] 的断言，check-fixtures 里有一条活的）。
- **给 B 的现成件**：`store/upsertByExternalId(db, ctx, fragmentId, externalId, item, opts)` —— 按 external_id 覆盖、幂等、字段变化写一行 `item_history`。教务/日历同步照抄 rucgo（`portal_repository.dart` 的 `calendarList.rst`，`_p=YXQ9MSZwPTEmbT1OJg__`）时直接调它，**不必等 A**。
- **真实校历** `data/calendar.json`：从微人大门户「校历」分类实拉（2026-09-05）：秋季 2026-09-07（周一）开学、18 教学周；春季 2027-02-22（周一）开学、19 教学周。B 的同步落地后替换这份文件。
- **旧库守卫**：`db.ts` 对旧形状的库大声拒绝并提示重建；`pnpm demo:reset` 就是重建工具（删库、建表、灌种子）。
- **演示种子** `pnpm demo:reset`：5 项目 / 21 条目 / 12 碎片 / 4 次专注 / 1 条改期历史。日期全部相对执行时刻算（演示当天跑永远成立）；引文在插入前逐字自检。
- **契约**：`packages/shared` 新增 `Project`、`Item.projectId`、`Item.externalId`；store 导出了 `insertItem / addItemSource / addItemCitations / recordItemHistory` 供种子与同步使用。

## 5. 下一步（第 3 步，路由扩展）预告

即将落地并冻结形状：项目增删改查、五页取数（含 /api/now 空形状）、待确认队列、`GET /api/events`（SSE 广播「变了」，不带内容）、`GET /api/runs/:id/events`（先空实现、形状当场冻结）。**做完这一步 C 与 B 不再等 A。**

## 6. 怎么跑

```bash
pnpm check:fixtures   # 六条对照 + 静态断言，当前全绿
pnpm demo:reset       # 演示库一键重置
pnpm typecheck        # 三个包一起查
pnpm dev:server       # 只起 server 调管道
```

## 已知的阶段性翻面

`fixtures/06-progress` 的期望值在第 5 步（agent 循环）上线后会翻面：当前旧管道没有项目归属，进度以 `needs_confirm` 落库；循环上线后经 `createItem` 的 project 参数挂上「高等数学」，期望改成 `active`。细节写在 `fixtures/README.md`。
