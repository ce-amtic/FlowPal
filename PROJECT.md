# Project: FlowPal

<!--
This file is the project's constitution: background, long-term goals,
hard constraints, and shared vocabulary. Read by agents at session start
(via CLAUDE.md). Keep it stable — short-term plans go in docs/atlas/ROADMAP.md.

Authoring tip — the session-start hook extracts this file, so write
for extraction: lead each prose section with a self-contained first sentence
(it becomes the headline), and keep Non-goals / Hard constraints /
Working rules as short bullet lists (those are inlined in full — they're
the guardrails). Keep "Current stage" to a single lifecycle word; the live
milestone lives in ROADMAP.md, so don't restate it here or it goes stale.
-->

## Background

一个懂你的 AI 学习伙伴，让开始变容易，让专注变自然。产品名暂定「FlowPal」，仓库名为 WorkDouBao。这是人大首届黑客松 Build with Care · 命题挑战组 · 赛道二「伴学计划」的参赛作品。题面痛点有两层：注意力层面，数字干扰与学业压力让学生难以启动学习；事务层面，日程散落在微信群、邮件、课程公告、口头通知里，堆在一起就被淹没。我们对题目的解读：「让 AI 理解用户的处境」是题眼，处境 = 外部截止日的逼近程度 × 同时压着几件事 × 此刻精力所在位置。出题方赛后获得「参考创意实现」的授权，说明他们在找可落地的产品假设。

来源：docs/problem-brief.md；docs/伴学计划-策略与产品形态.md §1。

## Long-term goals

- 近期（本次黑客松）：交付一个现场可运行的原型，走通「归集 → 画像 → 再评估 → 一个足够小的下一步」的完整链路，并在路演里给评委一个「它懂我」的交互瞬间。
- 长期（赛后）：验证「用户只需维护一份状态、产品真正懂你」这个假设；画像（时间轴外部压力 × 并行事务负载 × 精力曲线）成为引擎，陪伴形态是它的表面。

## Non-goals

- 不做 Recall 式后台截屏或任何定时监控；所有采集由用户的一个动作或明确授权的数据源触发。
- 不自动抓取微信消息；用分享菜单和截图替代。
- 不强制用户选类型、填表单；分类由系统做。
- 不做监督型产品：不评价、不催、不用羞耻或责备驱动。
- 不做通用聊天助手；LLM 在评估层工作，不是对话皮肤。

## Hard constraints

- 作品冻结：2026-09-06 12:30。之后不能改代码。
- 代码只能在开赛（2026-09-04 17:30）后写。
- Demo 必须现场可运行，本地运行即可，不依赖线上部署。
- 代码可读，README 说明如何运行。
- 项目说明 1 页以内；路演 2 分钟。
- 只能选一个组别、一个赛道：命题挑战组 · 赛道二。

## Working rules

<!-- Rules in force that no mechanism enforces. A rule belongs here exactly
     when nothing stops the agent from violating it: if a script, hook or
     validator can catch it, write the check instead. One line per rule,
     ending with a link to the record that justifies it. Authored by hand —
     nothing is promoted here automatically. Starts empty.
     Keep it curated and bounded — line count here is a budget, not a log. -->

- 所有面向用户的 LLM 输出：在场而不评判，说中用户处境的具体细节，不责备、不催、不用「意志力 / 自控力」叙事 ([[002-llm-tone-present-not-judging]])

## Glossary

- **处境** = 外部截止日的逼近程度 × 并行事务数 × 此刻精力位置；题眼，所有推理的输入。
- **画像 / 数据画像** = 用户的长期状态，三个维度：时间轴上的外部压力、并行事务负载、精力曲线历史。
- **再评估引擎** = LLM 三步：重估要求 → 以具体细节回应感受 → 生成一条执行意向；输出一个缩小到当下资源能承受的下一步。
- **执行意向** = Gollwitzer 的「如果…就…」句式，把计划变成可触发的动作。
- **碎片 / Fragment** = 用户扔进来的任何原始输入（文本、图片、语音、文件、同步条目），永不删除。
- **条目 / Item** = LLM 理解碎片后的结构化结果，五类之一，用户可改、合并、丢弃。
- **五类条目** = 事件（有确定时间点的外部节点）、事务（用户要做的事）、念头（专注中的零散想法）、进度（某件事务做到哪）、状态（用户自评或系统观察）。
- **置信度三档** = 高：直接入库；中：入库但标「猜的」；低：不入库，进待确认队列。
- **待确认队列** = 低置信度条目的暂存区，只在有内容时出现，产品不催。
- **引用 / citation** = 每个结构化字段指向原文中的哪一段，保证来源可追溯。
- **校历** = 学期起始日与「第 N 周」到具体日期的映射；解析相对日期的必要依赖。
- **在场而不评判** = 陪伴形态的设计原则，区别于监督。

## Collaborators & stakeholders

- 团队：冯友和、杜海乐、HuanCheng65。
- 出题人 / 评委：张菊蓉（人大创客协会副会长，OpenRUC 发起人；看校园场景是否真实、能否落地）；蒋宏伟（心情可可创始人，AI for Love Life 出海产品；看「被理解感」与心理学 / 认知行为学洞察）。

## Current stage

prototype

## References

- 赛题：docs/problem-brief.md
- 策略与产品形态：docs/伴学计划-策略与产品形态.md
- 信息采集模块设计：docs/信息采集模块-设计文档.md
- Sirois & Pychyl 2013 — 拖延是情绪调节问题
- Steel 2007 — 时间动机理论
- Lazarus & Folkman — 压力交互模型（要求 vs 资源）；画像即评估模型
- Risko & Gilbert 2016 — 认知卸载；Zeigarnik 效应；Leroy 注意残留
- Reis — perceived partner responsiveness；Lieberman — 情绪标注
- Gollwitzer — 执行意向；Fogg — B=MAP
- Zajonc — 社会助长；Eagle et al. 2023 — body doubling 质性研究
- Deci & Ryan — 自我决定理论（监控削弱自主性）
- Wohl et al. 2010 — 自我原谅减少后续拖延
- Roenneberg — chronotype，精力曲线先验
