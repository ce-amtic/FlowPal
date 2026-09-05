---
id: 10
title: 条目之上加一层项目：长期追踪与进度的挂载点
date: 2026-09-05
type: decision
tags: [product, collection]
---

# 条目之上加一层项目：长期追踪与进度的挂载点

五类条目全是原子，但学生实际追踪的对象不是原子，是「实习申请」「高等数学这门课」「那篇论文」。缺这一层，长期追踪没有落脚点，进度记录只能错误地挂在某一条事务上。

```sql
projects(id, name, status_note, status, created_at, updated_at)   -- status: active|done|dropped
items 增加 project_id  REFERENCES projects(id)   -- 可为空，多数条目为空是正常的
items 增加 external_id TEXT UNIQUE               -- 结构化来源的稳定标识
```

**归属必须指得出出处，指不出就不归。** 归属是 `createItem` 的一个参数，三选一，前两种带一句逐字引文：`{kind:'existing', projectId, quote}` / `{kind:'new', name, quote}` / `{kind:'none'}`。`quote` 必须逐字出现在碎片原文里，与条目字段的引用共用同一段校验。这一条同时管住两头：不能凭氛围归类，也不能凭氛围建项目——原文里得出现一个可命名的长期事项才建。

项目有三个来源：教务同步让每门课自动成为项目（冷启动由真实数据解决）；模型有引文支撑就直接建，不问用户；用户手动建或改归属。日常路径上用户零介入，唯一要介入的是改归错的那一条。

**进度挂在项目上**，且进度类条目必须有所属项目——给不出归属时以 `needs_confirm` 落库。项目不是文件夹：同一条既有截止日又属于项目的事务，在日程与项目两处都出现。「未归类」是正常状态，不是待办。

主窗口的页面由此按「切法」划分而非按条目类型划分。存储 schema 的其余部分见 [[001-fragment-immutable-item-derived-with-citations]] 与 [[007-extraction-contract]]，本记录只增不改它们。

在库里还没有真实数据时加这一层是纯追加；有了数据再加就是迁移。这是在写更多代码前先停下来定表示的原因。
