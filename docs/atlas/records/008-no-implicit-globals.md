---
id: 8
title: 逻辑层不取隐式全局：userId / now / tz / term 一律从 Ctx 传入，SQL 只在 store 目录
date: 2026-09-05
type: memory
tags: [collection, architecture]
---

# 逻辑层不取隐式全局：userId / now / tz / term 一律从 Ctx 传入，SQL 只在 store 目录

每个请求入口构造一次 `Ctx = { userId, now, tz, term }`，往下一路传。逻辑层不许自己调 `Date.now()` / 无参 `new Date()`，不许读全局的当前用户或当前学期。

`now` 这一条明天就会咬人而不是将来才咬：演示碎片里有「下周三之前把那个报告发给老师」，`now` 不可注入的话，今天调通的用例明天解析成别的日期，而且不会报错，只会静悄悄给出错日期。check:fixtures 里有一条硬断言扫这个。

`userId` 现在恒为 "local"，表里也真的不加 `user_id` 列——但代价被限制在一个目录里：SQL 只存在于 `server/store/`，路由与管道碰不到 SQL。将来加多用户是加一列加改那一个目录，不是满仓库找。

学期同理：校历是 `data/calendar.json` 里的**学期列表**而非单个值，解析时按 `ctx.now` 选中当前学期。

时间一律 ISO8601 带 +08:00，不存 UTC、不做时区转换。

这条规则的由来：贵到不好回头的从来不是少一列，而是把「当前用户 / 当前时间 / 当前时区 / 当前学期」写成隐式全局后散落在几十个地方。见 [[005-electron-http-server]]。
