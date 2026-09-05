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

演示用「一个用了两周的库」一键重置（删库、建表、灌相对日期的种子，三秒回到
干净状态；种子日期相对执行时刻算，演示当天跑永远成立）：

```bash
pnpm demo:reset
```

## 结构

```
packages/
  shared/    契约：条目、项目、agent 工具 schema、NowOutput、Ctx、校历。三个包共用
  server/    Hono + SQLite + agent 循环 + buildContext + 教务接入。不依赖 electron
  app/       React 界面。shell/ 是容器，views/collection/ 是采集视图
  desktop/   Electron 壳。全仓库唯一 import electron 的地方
prompts/     agent.md / now.md / extract.md
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

## 模型的额外参数

`llm.text.params` / `llm.vision.params` 原样并进请求体。各家都说自己「OpenAI 兼容」，
但控制推理强度这件事上谁也不一样，逐个建模成配置字段等于把「换一家」变回改代码。

用 DeepSeek 时这一项决定了「此刻」是三秒还是一分钟：

```json
"params": { "thinking": { "type": "disabled" } }
```

换模型、换参数之后跑这个对照台，不要靠肉眼看两三条就下结论：

```bash
pnpm dev:server        # 另开一个终端
pnpm bench:now 5       # 同一个库跑 5 次
```

它量速度与空态率，并按文案规则机器判一遍：梯子是不是由大到小、每一步有没有提到这件事
本身、有没有含糊词 / 复述统计 / 机器格式 / 零计数 / 催促 / 公文腔 / 报时。规则来自外部写的
三组范文，不是脚本自己编的。读起来暖不暖机器判不了，所以每一次的原文照样打出来给人看。

实测（21 条目的库，「此刻」生成一次）：

| params | 耗时 | 输出 token | 一步的梯子由大到小 |
|---|---|---|---|
| 不给（默认） | 30–75 秒 | 9000–13500 | 对 |
| `reasoning_effort: minimal` | 6–67 秒 | 560–8000 | 4 次里 2 次 |
| `thinking: disabled` | 3–4 秒 | 310–470 | 5 次里 5 次 |

关掉思考之后梯子反而更稳，是因为 prompt 里把「哪一级更小」这个判断换成了固定的动作
顺序：先产出、再打开、最后定位。判断需要推理，照着序号写不需要。

写库那条路关掉思考同样安全——判据是 `pnpm check:fixtures`，十条对照连同合并正反例
全部通过，整轮 58 秒。

输入侧不用调：前缀缓存实测命中 97–100%，system prompt 与工具定义都在缓存里。
server 每次调用会打一行用量，`[llm ...] 入 … 出 … 缓存命中 …`。

## 几个环境上的坑

- VSCode 的集成终端会设 `ELECTRON_RUN_AS_NODE=1`，带着它启动 Electron 会进 Node 模式，
  `require('electron')` 返回字符串而不是对象。`dev:desktop` 里已经把它去掉了。
- `pnpm demo:reset` 会删掉并重建库文件。**server 开着的时候跑它，server 仍然抓着
  被删掉的那份**，于是「重置了，界面却没变」。重置后重启 server。
- **`pnpm dev` 与 `pnpm dev:server` 用的不是同一个库。** Electron 把库放在
  `~/Library/Application Support/FlowPal/data`，`dev:server` 用仓库里的 `data/`。
  所以在完整应用里灌种子要指定目录，否则重置完打开应用还是空的：

  ```bash
  pnpm demo:reset "$HOME/Library/Application Support/FlowPal/data"
  ```
- server 固定监听 5123。已经开着 `pnpm dev:server` 再跑 `pnpm dev`，第二个会以
  `EADDRINUSE` 弹一个 Electron 报错框。`lsof -ti :5123 | xargs kill` 清掉前一个。
- `data/calendar.json` 是真实校历（2026-09-05 从微人大门户「校历」实拉：秋季
  2026-09-07 开学、18 教学周；春季 2027-02-22 开学、19 教学周）。B 的教务同步
  落地后会替换它。`startMonday` 错了，所有「第 N 周」的解析全盘皆错。
