# FlowPal

一个懂你的 AI 学习伙伴。人大首届黑客松 Build with Care · 命题挑战组 · 赛道二。

用户把任何东西扔进来——一段文字、一张群聊截图、一封邮件——系统替他记住，
并且理解成可以推理的结构。

## 跑起来

需要 Node 22+（`node:sqlite` 免 flag）与 pnpm。

```bash
pnpm install
cp config.example.json config.local.json   # 填模型 baseUrl / apiKey / model
```

四种跑法，按在做什么选：

```bash
pnpm dev           # 完整的桌面应用（起界面 + Electron）
pnpm dev:server    # 只起 server，调管道用。不开 Electron
pnpm dev:app       # 只起界面，浏览器打开 localhost:5173。不开 Electron
pnpm dev:desktop   # 只起 Electron；界面要另开一个 pnpm dev:app
```

调 prompt 不需要开界面：

```bash
curl -X POST localhost:5123/api/extract \
  -H 'content-type: application/json' \
  -d '{"rawText":"下周三之前把那个报告发给老师"}'
```

跑演示碎片的对照与断言，以及类型检查：

```bash
pnpm check:fixtures
pnpm typecheck
```

## 结构

```
packages/
  shared/    契约：ExtractOutput、MergePlan、Ctx、校历。三个包共用
  server/    Hono + SQLite + 抽取管道 + 教务接入。不依赖 electron
  app/       React 界面。shell/ 是容器，views/collection/ 是采集视图
  desktop/   Electron 壳。全仓库唯一 import electron 的地方
prompts/     抽取用的 prompt
fixtures/    演示碎片与手写期望值
data/        校历（进仓库）与 SQLite（不进）
```

业务逻辑住在 `server` 里，界面通过 HTTP 调它；IPC 只承担窗口、全局快捷键、
拖拽、剪贴板这些 Electron 非做不可的事。这条分界线让抽取管道可以脱离界面单独调，
也让 `server` 随时能被拿出去当独立后端。

`server` 默认只监听 `127.0.0.1`。局域网监听（给手机端用）是显式开关，开了必须配 token。

## 数据

原始碎片永不删除、永不修改；条目是理解后的派生结果，用户可以改、合并、丢弃，
改动记录保留；每个结构化字段都带引用，指向原文的哪一段。

## 几个环境上的坑

- VSCode 的集成终端会设 `ELECTRON_RUN_AS_NODE=1`，带着它启动 Electron 会进 Node 模式，
  `require('electron')` 返回字符串而不是对象。`dev:desktop` 里已经把它去掉了。
- server 固定监听 5123。已经开着 `pnpm dev:server` 再跑 `pnpm dev`，第二个会以
  `EADDRINUSE` 弹一个 Electron 报错框。`lsof -ti :5123 | xargs kill` 清掉前一个。
- `data/calendar.json` 现在是占位数据。真实校历从教务系统拉一次替换掉——
  `startMonday` 错了，所有「第 N 周」的解析全盘皆错。
