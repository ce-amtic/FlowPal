---
id: 5
title: 桌面端用 Electron，业务逻辑住在主进程内的本地 HTTP server
date: 2026-09-05
type: decision
tags: [collection, architecture]
---

# 桌面端用 Electron，业务逻辑住在主进程内的本地 HTTP server

桌面端选 Electron 而非 Tauri，判断依据是迭代速度：这两天基本靠模型写代码，Tauri 的 Rust 工具链每撞一次编译错误都是纯亏损；Electron 主进程是普通 Node，本机系统 Node 22.16 内置 `node:sqlite`，不装原生模块、不走 electron-rebuild。

这条理由有个未验证的前提：Electron 打包的是它自己那份 Node，免 flag 的 `node:sqlite` 从 22.13 起才有。搭骨架的第一步是验它；不成立就得回到 better-sqlite3 加 electron-rebuild，那时这条选型理由需要重写。

业务逻辑全部住在主进程内的一个本地 HTTP server（Hono）里，它拥有 SQLite 与抽取管道；渲染进程用 fetch 调它，不走 IPC。IPC 只承担 Electron 非做不可的事：窗口显隐、全局快捷键、原生拖拽、剪贴板。这条分界线等于「手机端将来要不要得起」——要得起的全在 HTTP 侧。

server 是 pnpm workspace 里一个不依赖 Electron 的独立包（`packages/{shared,server,app,desktop}`），将来抽出去做真后端时是拷两个目录进新仓库、一行代码不改。保证这条边界的不是约定而是三件会当场失败的事：pnpm 默认严格不提升，server 里 import electron 直接解析失败；环境相关的一切从 `createServer(config)` 传入，`app.getPath('userData')` 只出现在 desktop 包里；以及 `pnpm dev:server` 就是调 prompt 的日常工作方式，边界天天被走。check:fixtures 里有一条断言扫 server 包内对 electron 的引用——只写在文档里的边界两天后一定已经不独立了。

被否决的替代方案是标准的 Electron IPC 形态。它更简单，但两个代价都在关键路径上：调 prompt 必须开着 UI 点，而调 prompt 是耗时最多的活；手机端将来要接就得把逻辑重搬一遍，因为 IPC 这根管子只有 Electron 窗口能插。

模块边界随之定下，并与三人分工重合：语义层（抽取、去重合并、改期判定，纯函数不碰数据库）／数据与主进程（store、路由、Electron 壳）／界面。去重合并归语义层而非数据层，因为「标题相似加日期相近算同一条」是语义判断而非数据库操作。

三处跨人耦合各有解法且都不构成阻塞：路由清单先冻并给出返回假数据的实现，界面第一分钟就有东西可渲染；preload 冻成四个方法并在非 Electron 环境下有 mock，界面全程可以在浏览器标签页里开发；语义层的去重结果与数据层之间冻一份「合并计划」（new / merge_into / reschedule 三档），语义层只算计划，写 item_sources 与 item_history 的是数据层。reschedule 单独成一档而非并进 merge_into，因为改期是画像信号，落库时要多写一行历史。
