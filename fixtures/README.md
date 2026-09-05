# 演示碎片集

设计文档 §8 那一套。这是管道的验收依据，也是路演的素材，**排在写代码前面**——
没有它，prompt 没法调，界面里是空的。

六条覆盖（按文件名顺序跑，**顺序即用例**——04 改期必须排在 01 之后，去重合并才能撞上）：

- [x] `01-groupchat` 一张群聊截图，混着无关消息和一条期中考试通知（图片，走视觉模型）
- [x] `02-email` 一封邮件文本，含报名截止日
- [x] `03-verbal` 一条口头风格的文字：「下周三之前把那个报告发给老师」
- [x] `04-reschedule` 一条改期通知，和 01 的期中考试撞上，触发改期（日期推移）
- [x] `05-thoughts` 几条专注中扔进来的念头
- [x] `06-progress` 一条进度记录

## 一个碎片一个 json

`expect` 是**手写的期望值**，不是从代码里跑出来的——`scripts/check-fixtures.ts`
拿它跟实际结果对照，判断依据来自人，不是来自被检查的代码。

`now` 必须写死：演示碎片里有「下周三」「10月22日」这类表达，now 不固定的话
今天调通的用例明天就是别的日期。**now 要落在真实校历的学期内**（秋季 2026-09-07
开学），否则「第 N 周」没有意义。

\`\`\`json
{
  "now": "2026-09-09T15:00:00+08:00",
  "fragment": {
    "source": "paste",
    "rawType": "text",
    "rawText": "下周三之前把那个报告发给老师"
  },
  "expect": {
    "count": 1,
    "types": ["task"],
    "dates": ["2026-09-16"],
    "statuses": ["active"],
    "plans": ["new"]
  }
}
\`\`\`

- `count`：抽出几条
- `types`：逐条的类型
- `dates`：逐条的日期（`due_at ?? starts_at`；带 `RRULE:` 前缀则比 `rrule`）。
  比较按「日 + 时刻」做：两边都有时刻才比时刻，只看日期不看格式（模型写
  `2026-10-22T14:00:00+08:00` 还是 `2026-10-22 14:00` 都算对）
- `statuses`：逐条的落库状态（`active | needs_confirm | ...`）
- `plans`：逐条的合并计划（`new | merge_into | reschedule`）

四项都能省；省掉的那项只打印不对照。

图片碎片把文件放在这个目录下，`rawBlobPath` 写相对仓库根的路径：

\`\`\`json
{
  "now": "2026-09-20T12:00:00+08:00",
  "fragment": {
    "source": "screenshot",
    "rawType": "image",
    "rawBlobPath": "fixtures/01-groupchat.png"
  },
  "expect": { "count": 1, "types": ["event"], "dates": ["2026-10-22T14:00:00+08:00"] }
}
\`\`\`

## 已知的阶段性翻面

`06-progress` 的期望值随管道换代翻一次面，**不是 bug**：

- 当前管道（extract → dedupe → applyPlans）：抽取契约里没有项目归属，进度给不出
  项目 → 按 [[010]] 以 `needs_confirm` 落库。期望 `statuses: ["needs_confirm"]`。
- agent 循环上线（第 5 步）后：同一条碎片经 `createItem` 的 `project` 参数挂上
  「高等数学」，期望改成 `active` 并带项目断言。到时改这里的 expect 与注释，
  别当成红字修。

## 依赖

管道对照需要 `config.local.json` 里填好 `llm.text` 与 `llm.vision`（01 走视觉）。
没有 key 时 `pnpm check:fixtures` 会明说「跳过」，不静默通过。
