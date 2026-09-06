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
pnpm dev           # 完整的桌面应用（起界面 + Electron 壳）
pnpm dev:server    # 只起 server，调管道用。不开 Electron
pnpm dev:app       # 只起界面，浏览器打开 localhost:5173。不开 Electron
pnpm dev:mock:desktop # 测试数据 + Electron 桌面应用（不启动真实 server/model）
pnpm dev:desktop   # 只起 Electron；界面要另开一个 pnpm dev:app
```

测试数据只用于界面和桌宠交互验收，不会调用模型或写入真实数据库。若需要构建一个
内置样例数据的前端资源，可运行 `pnpm build:app:mock`；真实构建仍使用默认的
`pnpm --filter @flowpal/app build`。

调 prompt 不需要开界面：

```bash
curl -X POST localhost:5123/api/extract \
  -H 'content-type: application/json' \
  -d '{"rawText":"下周三之前把那个报告发给老师"}'
```

跑演示碎片的对照与断言，以及类型检查：

```bash
pnpm check:fixtures
pnpm check:sync      # 同步的解析与落库，不联网、不用凭据、不调模型
pnpm typecheck
pnpm check           # 以上全部
```

演示用「一个用了两周的库」一键重置（删库、建表、灌相对日期的种子，三秒回到
干净状态；种子日期相对执行时刻算，演示当天跑永远成立）：

```bash
pnpm demo:reset
```

## 接上学校的系统

打开桌面应用 → 设置 → **登录人大门户**。会弹一个真的浏览器窗口，在里面照常登录
（可能要图形验证码或短信码）。认证通过后窗口自己关掉，课表、校历、门户上的通知
就开始自己进来：启动时一次，之后每六小时一次，设置页上还有一个「现在同步」。

**本程序不接触密码。** CAS 的登录页带验证码、短信码，密码还在前端加过一道；无头
重放那套表单是在猜一个随时会变的东西，猜错的代价是真实账号被锁。所以登录只发生在
那个窗口里，我们只把那次登录留下的 Cookie 搬到 server。它存在
`data/ruc-cookies.json`（`.gitignore` 里），等价于一次登录，别外传。

登录态过期时设置页会说「登录已过期」。再点一次登录多半连密码都不用输——票据授予
Cookie 活得久，缺的只是一份没过期的会话。

拿到的东西来自门户的**日程中心**一个接口，它同时给三样：课表、校历、用户自己的
日历。从这里取而不是直连教务，是因为**调课只在这里看得见**——教务那边的周次位图
是排课时定死的，学校把某个周日定成「上星期二的课」时位图不会变。

- **课表**压成一条带 `RRULE` 的条目（日程页上是一条细带，不占条目位置），每门课
  自动成为一个项目；只发生一次的那种保留在它自己那天，因为那就是调课。
- **校历**按天切开的条目重新拢成一段，整天的事标成 day 精度。
- **通知公告**是散文，日期藏在句子里，所以走 agent 循环，有配额
  （`sync.noticesPerRun`，默认 3）。第一次同步只记下水位、不倒灌历史。

**邮件在设置 → 邮箱里加**，可以有好几个（学校的、私人的），各自一份进度。人大邮箱
是网易企业邮箱的一份部署，默认值 `imap.ruc.edu.cn:993` 已经填好，通常只要填邮箱
地址和授权码。

授权码是邮箱网页版设置里生成的那串**客户端授权码**，不是登录密码——网易那套默认
不许拿登录密码走 IMAP。填错了「测试连接」会当场说 `460 ERR.LOGIN.PASSERR`。

走 IMAP 不走 POP3，理由不在协议在产品：POP3 拿不到 `\Seen`，而「只读你还没处理过
的」这条规矩完全建立在服务端的已读标记上。只读收件箱里未读且比水位新的几封，
**不替用户标已读**——标记是他自己的动作。

**授权码不明文落盘。** 桌面端用系统钥匙串（Electron `safeStorage`）加密，库里只有
密文；明文由桌面端启动时解一次、推给 server，只活在内存里，进程退出即无。因此：

- 拿到 `flowpal.db` 不等于拿到授权码；
- `pnpm dev:server` 单跑时没有能解钥匙串的东西，邮箱那几行会显示「需要在桌面应用
  里解锁」。这是对的，不是缺陷。

验收分两半，都要跑：

```bash
pnpm check:sync    # 解析与落库对不对。不联网，天天可跑
pnpm sync:once     # 接口今天还在不在、登录态还有没有。要先登录过
```

## 结构

```
packages/
  shared/    契约：条目、项目、agent 工具 schema、NowOutput、Ctx、校历。三个包共用
  server/    Hono + SQLite + agent 循环 + buildContext + sync/。不依赖 electron
  app/       React 界面。shell/ 是容器，views/collection/ 是采集视图
  electron/  Electron 主进程、透明 3D 桌宠窗口与窄 preload。全仓库唯一 import electron 的地方
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

## 模型的额外参数与思考强度

`llm.*.params` 原样并进请求体。各家都说自己「OpenAI 兼容」，但控制推理强度这件事上
谁也不一样，逐个建模成配置字段等于把「换一家」变回改代码。

**强度由调用点决定，不由配置决定。**同一个模型，答「此刻」要快，改库要稳，这是两件事。
代码只说要哪一档，配置说明这一家怎么拼这三档：

```json
"effort": {
  "none": { "thinking": { "type": "disabled" } },
  "low":  { "thinking": { "type": "enabled" }, "reasoning_effort": "minimal" },
  "high": { "thinking": { "type": "enabled" }, "reasoning_effort": "high" }
}
```

合并顺序是 `params` 在前、这一档在后，所以某一档可以覆盖恒定项。整张表要么不写
（那就没有强度控制），要么三档写全——缺一档做默认回退的话，某个调用点会悄悄跑在
别的强度上，而这种事只能靠账单发现。

三个调用点各自要多少：

| 调用点 | 档 | 为什么 |
|---|---|---|
| 「此刻」 | `none` | 首屏，人正等着；而且量过，关掉思考梯子反而更准 |
| agent 循环（写库） | `low` | 合并到哪一条是要想的判断，错了得靠人回头发现；没人在等这一步 |
| extract | `low` | 要读懂一段乱七八糟的原文，没人在等它的秒数 |

换模型、换参数之后跑这个对照台，不要靠肉眼看两三条就下结论：

```bash
pnpm dev:server        # 另开一个终端
pnpm bench:now 5       # 同一个库跑 5 次
```

它量速度与空态率，并按文案规则机器判一遍：梯子是不是由大到小、每一步有没有提到这件事
本身、有没有含糊词 / 复述统计 / 机器格式 / 零计数 / 催促 / 公文腔 / 报时。规则来自外部写的
三组范文，不是脚本自己编的。读起来暖不暖机器判不了，所以每一次的原文照样打出来给人看。

实测（21 条目的库，「此刻」生成一次）。这张表就是「此刻」为什么用 `none`：

| 这一档加的字段 | 耗时 | 输出 token | 一步的梯子由大到小 |
|---|---|---|---|
| 不给（默认） | 30–75 秒 | 9000–13500 | 对 |
| `reasoning_effort: minimal` | 6–67 秒 | 560–8000 | 4 次里 2 次 |
| `thinking: disabled` | 3–4 秒 | 310–470 | 5 次里 5 次 |

关掉思考之后梯子反而更稳，是因为 prompt 里把「哪一级更小」这个判断换成了固定的动作
顺序：先产出、再打开、最后定位。判断需要推理，照着序号写不需要。

写库那条路两档都安全——判据是 `pnpm check:fixtures`，十条对照连同合并正反例全部通过：
关掉思考整轮 58 秒，`low` 是 67 秒。换来的十几秒买的是那条路上「错了要靠人回头发现」
的那部分，所以它留在 `low`。

输入侧不用调：前缀缓存实测命中 97–100%，system prompt 与工具定义都在缓存里。
server 每次调用会打一行用量，`[llm ...] 入 … 出 … 缓存命中 …`。

## 几个环境上的坑

- VSCode 的集成终端会设 `ELECTRON_RUN_AS_NODE=1`，带着它启动 Electron 会进 Node 模式，
  `require('electron')` 返回字符串而不是对象。`dev:desktop` 会显式解除它。
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
  2026-09-07 开学、18 教学周；春季 2027-02-22 开学、19 教学周）。`startMonday`
  错了，所有「第 N 周」的解析全盘皆错，所以它仍然手敲、不由同步覆盖——同步拉回
  来的是校历上的**事件**，学期第一周的周一是另一回事，猜错不会报错。
- 同步一次要按周打十几次门户，一轮几秒到十几秒。慢是刻意的：同一个接口区间拉到
  半年时返回里只剩校历，课表那一类整个消失，而且不报错。
- `data/ruc-cookies.json` 等价于一次登录。删掉它就是退出登录，与设置页上那个按钮
  同义。
