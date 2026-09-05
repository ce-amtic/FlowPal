# 演示碎片集

这是 agent 循环的验收依据，也是路演的素材，排在写代码前面——没有它，prompt 没法调，界面里是空的。

十条按文件名顺序跑，**顺序即用例**：04 改期必须排在 01 之后；09/10 的合并必须排在 07/08 之后，
这样循环才能在条目清单里看到前一条。

- [x] `01-groupchat` 一张群聊截图，混着无关消息和一条期中考试通知（图片，走视觉模型）
- [x] `02-email` 一封邮件文本，含报名截止日（报名截止是事件，不是事务）
- [x] `03-verbal` 一条口头风格的文字：「下周三之前把那个报告发给老师」
- [x] `04-reschedule` 一条改期通知，和 01 的期中考试撞上，触发改期（日期推移）
- [x] `05-thoughts` 几条专注中扔进来的念头
- [x] `06-progress` 一条进度记录：经 createItem 的 project 参数挂上「高等数学」
- [x] `07-ds-assignment` 数据结构作业：为 08 的「不合并」准备对照
- [x] `08-ds-exam` 数据结构考试：与作业同名不同事，**不得**合并
- [x] `09-group-material` 组会材料：为 10 的「合并」准备对照
- [x] `10-group-ppt` 组会 PPT：与材料是同一件事，**应** updateItem 而非新建

## 一个碎片一个 json

`expect` 是手写期望值，不是从代码里跑出来的。`scripts/check-fixtures.ts` 拿它跟实际结果对照。

`now` 必须写死：演示碎片里有「下周三」「10月22日」这类表达，now 不固定的话今天调通的用例明天就是别的日期。
**now 要落在真实校历的学期内**（秋季 2026-09-07 开学）。

```json
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
    "created": 1,
    "updated": 0,
    "needsConfirm": 0
  }
}
```

- `count`：本碎片关联到的条目数（新建或更新都会追加 item_sources）
- `types` / `dates` / `statuses`：逐条对照；`dates` 带 `RRULE:` 前缀则比 `rrule`，
  否则比 `due_at ?? starts_at`
- `projects`：逐条的项目名，用于验证项目归属
- `created` / `updated` / `needsConfirm`：循环收尾时的动作计数。`updated` 按去重后的条目数，
  同一条被改多次仍算 1

四项字段都能省；省掉的那项只打印不对照。

图片碎片把文件放在这个目录下，`rawBlobPath` 写相对仓库根的路径：

```json
{
  "now": "2026-09-20T12:00:00+08:00",
  "fragment": {
    "source": "screenshot",
    "rawType": "image",
    "rawBlobPath": "fixtures/01-groupchat.png"
  },
  "expect": { "count": 1, "types": ["event"], "dates": ["2026-10-22T14:00:00+08:00"] }
}
```

## 依赖

管道对照需要 `config.local.json` 里填好 `llm.text` 与 `llm.vision`（01 走视觉）。
没有 key 时 `pnpm check:fixtures` 会明说「跳过」，不静默通过。
