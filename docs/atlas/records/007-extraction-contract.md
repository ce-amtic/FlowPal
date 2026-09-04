---
id: 7
title: 抽取契约：一份 zod schema 同时当 structured output、类型与校验，引用逐字可验
date: 2026-09-05
type: decision
tags: [collection, architecture]
---

# 抽取契约：一份 zod schema 同时当 structured output、类型与校验，引用逐字可验

LLM 抽取的输出契约由一份 zod schema 定义，它同时是发给 API 的 strict json_schema、TS 类型、与入库前的校验器。同一个事实只在一处陈述。

四个决定：

绝对日期由模型算，不做后处理。prompt 里把 now、当前学期第一周周一、今天是第几周当作事实喂进去。「下周三」「期中周」「考完试之后」写不出规则，模型有 now 就能算；算错了 date_raw 留着让用户改。

citation 只给逐字 quote，不给字符偏移。模型数偏移不可靠，但「这段话必须原样出现在原文里」是机器可验的，入库前做 includes 检查，对不上就是模型编的，直接报错。偏移由我们 indexOf 出来存进 item_citations。这条把「每个字段带原文引用」([[001-fragment-immutable-item-derived-with-citations]]) 变成了一条可执行的断言。

重复性用 RFC 5545 的 RRULE 串表达，契约里对应一个可选 recurrence 字段。缺了它，模型面对「每周三的组会」只能编一个具体的周三——这是会真实发生的错误，不是假想。用标准串而非自造字段，是因为课表 ICS 导入进来的就是这个格式。

一条碎片可产出多条条目，也可以产出零条（截图里全是废话）。零条是正常结果，不是错误。

LLM 供应商是配置不是代码路径：baseUrl、apiKey、model 三项，文本与视觉各一个 model 位，允许指向不同厂商，代码只认 OpenAI 兼容的 chat completions 加 structured output。图片不做 OCR，直接交视觉模型——群聊截图的难点是判断哪条消息有用，OCR 会丢掉版式与气泡位置。

条目的 title 是展示给用户的 LLM 散文，所以语气规则 ([[002-llm-tone-present-not-judging]]) 对抽取 prompt 同样生效，不只对后面的陪伴功能。

结构化来源不走这条契约。课表、考试安排、ICS 拉回来已经是准确的结构，喂给模型只会让它变得不准，还慢、还花钱。碎片照样落库（raw_type='structured'，原始 JSON 存在 raw_text 里，满足原文永不删除），但到条目走一个确定性映射函数：课表行映成 type='event' 加 rrule 加 confidence='high'，citation 指向那条原始 JSON。管道因此有两条入口，去重合并那一段共用——同一场考试会从群通知、邮件、课表三处进来。
