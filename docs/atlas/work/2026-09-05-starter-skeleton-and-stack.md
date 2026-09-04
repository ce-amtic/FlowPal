# Starter skeleton and stack

## Intent

仓库里还没有一行代码，三个人要在冻结（2026-09-06 12:30）前把整个 App 做到可运行、可路演的状态。现在需要的不是功能，是一副骨架：技术栈定下来、进程形态定下来、三份契约（HTTP 路由、抽取输出、合并计划）先冻，让三个人各自开工时不用互相等，也不用在明天上午为了改一个存储形状回头动所有代码。

**骨架只覆盖已定的那一半。** 信息采集这一层的设计是定了的（见设计文档），本文件把它的存储形状、契约与模块边界固定下来。另一半——产品形态、主界面长什么样、陪伴形象、再评估引擎——还在想，本次工作不替它做任何决定。结构上只留一处：界面分成 `shell/` 与 `views/collection/`，采集界面是壳里的一个视图而不是主界面本身。再评估引擎连桩都不建——它还没定，提前建目录或桩路由就是替一个没想清楚的东西表态。

先做完整的输入这一侧，判断依据是它相对固定、且不受后面形态决定的影响。

为什么是现在：本次工作触到两样贵到不好回头的东西——数据要按某个形状落盘，三个人的分工会直接变成代码的模块边界。这两样定错了，剩下的时间全花在返工上。而未定的那一半必须尽快单独过一遍设计，它是排期上的真风险，不是采集管道。

## Spec

### 技术栈与进程形态

- **桌面端 Electron**，不用 Tauri。选择依据是迭代速度而非技术优劣：这两天基本靠模型写代码，Tauri 的 Rust 工具链每撞一次编译错误都是纯亏损；Electron 主进程就是普通 Node，本机 Node 22.16 内置 `node:sqlite`，不装原生模块、不走 electron-rebuild。
- **业务逻辑全部在主进程内的一个本地 HTTP server（Hono）里**，拥有 SQLite 与抽取管道。渲染进程用 React + Vite，通过 `fetch('http://127.0.0.1:<port>')` 调它，不走 IPC。
- **server 是一个不依赖 Electron 的独立包**，将来要抽出去做真后端时，是拷两个目录进新仓库、一行代码不改：

  ```
  packages/
    shared/    zod schemas、Ctx、MergePlan —— 不依赖任何东西
    server/    Hono + SQLite + pipeline + connectors；package.json 里没有 electron
               导出 createServer(config)，同时自带可执行入口
    app/       React 渲染进程
    desktop/   Electron；依赖 server 与 app，main.ts 里调 createServer()
  ```

  保证这条边界的不是约定，是三件会当场失败的事。pnpm workspace 默认严格不提升，`server/` 里写 `import 'electron'` 直接解析失败。环境相关的一切从 config 传入（`app.getPath('userData')` 只出现在 `desktop/`），server 不知道 Electron 存在。以及 `pnpm dev:server` 是 A 每天调 prompt 的工作方式——curl 打管道、跑 check:fixtures 全程不启动 Electron，所以这条边界天天被走。只写在文档里的边界两天后一定已经不独立了。
- **IPC 只承担 Electron 非做不可的事**：窗口显隐、全局快捷键、原生拖拽、剪贴板。分界线是「手机端将来要不要得起」——要得起的全在 HTTP 侧。
- **默认绑定 `127.0.0.1`。** 局域网监听是显式开关，打开才绑 `0.0.0.0`，并且要求 token：server 启动时生成随机串，界面出二维码编码 `http://<ip>:<port>` + token，手机扫码配对。已识别的失败模式是黑客松公共 wifi 上挂一个无鉴权、能写库、能烧模型额度的接口。
- **数据的唯一真相是笔记本上这个进程**。手机端（做不做看进度）在同一局域网 POST 给它，只写不改，因此不需要任何同步逻辑。远程后端不做——硬约束要求现场本地可运行；真正贵的是条目可改可合并带来的冲突与离线语义。将来若要上云，是同一份路由换台机器跑、客户端改 base URL。
- **LLM 是配置不是代码路径**：`{ baseUrl, apiKey, model }`，文本与视觉各一个 model 位，允许指向不同厂商，代码只认 OpenAI 兼容的 chat completions + structured output。图片不做 OCR，直接交视觉模型——群聊截图的难点是判断哪条消息有用，OCR 会丢掉版式与气泡位置。

### 表示：存储 schema

这是本次工作要求的表示，类型是 **schema**——数据会按这个形状堆积，并且活得比任何一版代码都久。

```sql
fragments(id, created_at, device, source, raw_type, raw_text, raw_blob_path)
  -- source: paste|hotkey|drop|share|screenshot|email|calendar|timetable
  -- raw_type: text|image|audio|file|structured
  -- 只增，永不改、永不删

items(id, type, title, starts_at, due_at, date_precision, date_raw,
      rrule, date_confidence, confidence, location, status,
      created_at, updated_at)
  -- type: event|task|thought|progress|state
  -- date_precision: day|minute
  -- status: active|done|dropped|needs_confirm
  -- rrule: RFC 5545 RRULE 串，starts_at 同时是 DTSTART

item_sources(item_id, fragment_id, added_at)
item_citations(item_id, field, fragment_id, quote, start_offset, end_offset)
item_links(id, from_item_id, to_item_id, kind, created_at)
item_history(id, item_id, changed_at, field, old_value, new_value, actor, fragment_id)
  -- actor: user|llm|merge
```

设计取舍：

- `starts_at` / `due_at` 分两列，不合成设计文档里的 `due_or_start`。事务常常两者都有，而「什么时候开始做」与「什么时候必须交」的差别正是紧迫度的输入。
- `date_precision` 区分「那天」与「那天零点」。没有它，无时刻的日期会被当成午夜，渲染与紧迫度都错。
- `item_sources` 独立成表：同一件事从多个来源进来是常态，合并时只往这张表追加一行，`items` 一个字段不动。
- `item_history` 带 `fragment_id`：改期本身是画像信号，要知道是哪条通知把日期推走的。
- 五类条目共用一张宽表，多余的列留空。字段重合度高，拆表会让每个查询都要 union。
- `rrule` 现在就加。缺了它，模型面对「每周三的组会」只能编一个具体的周三——这是明天真会发生的错。单次发生的状态（这周的组会做完 ≠ 系列做完）明确推迟：真要做时是新加一张 `item_occurrences(item_id, occurrence_date, status)`，现有表不动，是纯追加而非迁移。

校历不进库，是 `data/calendar.json`，里面是**学期列表** `terms: [{ id, name, start_monday, weeks }]`，解析时按当前时间选中学期。它是手敲的参照数据，不是用户数据。

### 教务系统接入

`packages/server/connectors/ruc/` 是骨架里的一个真模块，不是一次性脚本。课表、考试安排、校历都是「外部压力」这个画像维度的直接输入，而且「一键导入我的课表」对看校园场景真实性与落地性的评委本身就是个演示动作。凭据（学号密码）走本地配置文件并在 `.gitignore` 里排掉，不进仓库。

**演示不依赖现场登录**：课表提前导好躺在库里，路演时不发生一次教务系统往返；现场网好的话再当场跑一次当加分项。这跟功能做不做无关，只跟演示的故障面有关。

### 管道有两条入口

```
非结构化（文本 / 图片 / 语音） → LLM 抽取 → 校验 → ┐
                                                   ├→ 去重合并 → 入库
结构化（课表 / 考试 / ICS / 校历） → 确定性映射 ───┘
```

结构化来源不走模型：课表拉回来已经是准确的结构，喂给模型只会让它变得不准，还慢、还花钱。碎片照样落库（`raw_type='structured'`，原始 JSON 存在 `raw_text` 里，满足原文永不删除），但到条目走确定性映射——课表行映成 `type='event'` + `rrule` + `confidence='high'`，citation 指向那条原始 JSON。

去重合并两条路共用：同一场考试会从群通知、邮件、课表三处进来，必须能合并（设计文档 §4.2）。

**这个表示焊死的假设，以及解开的代价：**

1. **只有一个用户**——全表无 `user_id`。代价被限制在一个目录里：SQL 只存在于 `packages/server/store/`，路由与管道碰不到 SQL，将来加多用户是加一列 + 改那一个目录。
2. **所有时间是 ISO8601 带 `+08:00`**，不存 UTC、不做时区转换。
3. 单学期假设**已解开**（校历是列表而非单值）。

**同一个事实只在一处陈述：**`userId` / `now` / `tz` / `term` 一律由请求入口构造成一个 `Ctx` 往下传，逻辑层不许取全局。这不只是为了将来可扩展——`now` 不可注入的话，演示碎片里的「下周三」今天调通、明天就解析成别的日期，而且不报错。

**结果错了怎么定位是哪一段错：**管道分成 预处理 → 抽取 → 校验 → 去重合并 → 入库，每一段的输出都能单独取到（`POST /api/extract` 只返回解析后的 JSON 不落库），所以能区分是模型读错了还是合并规则误伤。

### 表示：抽取输出契约

一份 zod schema，同时是发给 API 的 `json_schema`（strict）、TS 类型、入库前的校验器。

```ts
ExtractOutput = {
  items: [{
    type: 'event'|'task'|'thought'|'progress'|'state',
    title: string,                          // 展示给用户的那一句话
    starts_at?: string, due_at?: string,    // 绝对时间，模型算好
    date_precision?: 'day'|'minute',
    date_raw?: string,                      // 「第8周周三」
    recurrence?: string,                    // 识别到「每周/每两周/每天」时填
    location?: string,
    confidence: 'high'|'medium'|'low',
    citations: [{ field: string, quote: string }]
  }]
}
```

- **日期由模型算成绝对时间**，prompt 里把 `now`、当前学期第一周周一、今天是第几周当作事实喂进去。「下周三」「期中周」「考完试之后」写不出规则，模型有 `now` 就能算；算错了 `date_raw` 留着让用户改。
- **citation 只给逐字 quote，不给字符偏移**。模型数偏移不可靠，但「必须原样出现在原文里」是机器可验的；偏移由我们 `indexOf` 出来存进 `item_citations`。
- 一条碎片可产出多条 items，**也可以产出零条**（截图里全是废话）。零条是正常结果，不是错误。
- `title` 是展示给用户的 LLM 散文，所以语气规则（在场而不评判、说中具体细节、不责备不催不谈意志力）对抽取 prompt 同样生效，不只对后面的陪伴功能。

### 模块边界与分工

分工即模块边界，所以两者一起定：

| | 范围 |
|---|---|
| A | **语义层** `packages/server/pipeline/` + `prompts/`：抽取、去重合并、改期判定。纯函数，不碰数据库 |
| B | **数据与主进程** `packages/server/store/` + `packages/server/routes/` + Electron 壳（窗口、快捷键、拖拽、剪贴板） |
| C | **界面** `packages/app/`：投放区、条目列表、编辑、引用与原文展示、待确认 |

去重合并归 A 而非 B：「标题相似 + 日期相近算同一条」「日期变了算改期」是语义判断，可能还要再调一次模型，与 prompt 是同一类工作。

三处耦合存在，但都不构成阻塞：

- **C 调 B 的接口**：路由清单在骨架里就冻。C 第一分钟就有数据可渲染——数据来自往库里灌的一份演示数据，不是假的路由实现（假实现是将来必须删掉的代码，灌数据不留残骸）。
- **C 用 B 写的 preload**：`window.flowpal` 冻成四个方法（`onHotkeyOpen` / `onFilesDropped` / `readClipboard` / `hideWindow`），不在 Electron 里时有 mock 实现，**C 全程在浏览器标签页开发**，不启动 Electron。
- **A 的去重合并结果交给 B 落库**：路由要按 `extract`(A) → `dedupe`(A) → `store.apply`(B) 串起来，中间那个返回值是第三份必须先冻的契约，否则 A 和 B 会各自发明一个。它是一份**合并计划**：

  ```ts
  MergePlan = { action: 'new' } | { action: 'merge_into', itemId: string }
            | { action: 'reschedule', itemId: string, from: string, to: string }
  ```

  A 只算出计划，写 `item_sources` / `item_history` 的是 B。`reschedule` 单独成一档而不是并进 `merge_into`，因为改期是画像信号，落库时要多写一行历史。

另外两条工作线不绑定到人，谁手上空谁接：

- **演示碎片集**（设计文档 §8）：在关键路径上，不需要写代码，排在写代码前面——A 没有它就没法调 prompt，C 没有它界面就是空的。
- **教务系统接入**：有一份现成的 Flutter/Dart 实现可以照抄，语言不同但登录鉴权与接口逻辑是通的，所以它不是研究工作，任何人接手成本都一样。

### Verification

`pnpm check:fixtures` 把 §8 演示碎片喂进管道（`now` 固定注入成演示日期），打印对照表供人肉核对，并执行四条硬断言。

| 检查 | 判断依据来自哪里 |
|---|---|
| 每个碎片抽出的条数与类型、相对日期解析成的绝对日期 | 团队手写的期望值（哪张截图该出 1 条期中考试而不是 5 条、「下周三」是哪天）——即用户指定的值 |
| 每条 citation 的 quote 逐字出现在 `raw_text` 里 | 不变量，来自「每个字段带原文引用」这条已定原则；与模型输出什么无关 |
| 管道内无无参 `Date.now()` / `new Date()` 调用 | 不变量：`now` 必须从 `ctx` 来。破了不会报错，只会静悄悄给出错日期 |
| 全流程跑完后 `fragments` 只增不改不删 | 不变量，来自「原始碎片不可变永不删除」这条已定原则 |
| `packages/server/` 下不出现对 `electron` 的引用 | 不变量：server 不依赖 Electron，否则「抽出去做独立后端」这条性质悄悄消失 |
| 教务接入拉回的课表行 | 参考实现：同一个学号下，与既有 Flutter/Dart 实现的结果逐行对齐。判断依据来自另一个程序 |

不写完整测试套件：模型输出不确定，断言具体字符串意味着明天全部时间在修测试。上面四条不变量与模型输出无关，因此稳定。

**Keepers**：四条不变量断言（引用逐字可验、`now` 可注入、fragments 只增、server 不依赖 Electron）——它们各自对应一条已陈述的原则。§8 对照表在里程碑退出标准成立前也是 Keeper，因为它就是退出标准本身。

**Throwaways**：`window.flowpal` 的 mock、`data/calendar.json` 的占位学期、骨架里的空实现——真实现落地即删除。

## Plan

0. 先验一件会推翻栈选择的事：Electron 自带的 Node 是否支持免 flag 的 `node:sqlite`（`electron -e "console.log(process.versions.node); require('node:sqlite')"`）。本机系统 Node 22.16 可以，但 Electron 打包的是它自己那份。不行就得回到 better-sqlite3 + electron-rebuild，而那正是选 Electron 时说要避开的东西——那样的话选型理由要重写。
1. 建仓库骨架与工具链：pnpm workspace，`packages/{shared,server,app,desktop}` 四个包，加根级 `prompts/` / `data/` / `fixtures/`，TypeScript 配置，Vite。`server` 的 package.json 里不放 electron。
2. 写 `shared/schema.ts`：`ExtractOutput` 与 `MergePlan` 的 zod 定义，导出 TS 类型与 strict json_schema。这是先冻的第一、三份契约。两个细节：strict 模式要求每个属性都在 `required` 里且 `additionalProperties: false`，所以可选字段一律写成 `.nullable()` 而不是 `?:`；`citations[].field` 是条目字段名的枚举而不是 `string`，否则模型可以引用一个不存在的字段而逐字校验照样通过。
3. 写 `shared/ctx.ts`：`Ctx` 类型与请求入口的构造函数（`userId='local'`、`now`、`tz='Asia/Shanghai'`、按 `now` 选中的 `term`）。
4. 写 `packages/server/store/schema.sql` 与建表逻辑，SQLite 落到 `data/flowpal.db`；`packages/server/store/` 内的读写函数，是全仓库唯一出现 SQL 的地方。
5. 写 `packages/server/routes/`：冻结路由清单（`POST /api/fragments`、`GET /api/items`、`GET /api/items/:id`、`PATCH /api/items/:id`、`GET /api/fragments`、`GET /api/fragments/:id`、`POST /api/extract`）。这是先冻的第二份契约。

   路由直接接真的 store，不做返回假数据的实现——假实现是一段将来必须删掉的代码，而它换来的「界面第一分钟有数据可渲染」用往库里灌一份演示数据同样能拿到，且不留残骸。合并的动作不单独开 `POST /api/items/:id/merge`：合并由 `POST /api/fragments` 里的 dedupe 决定，手动合并等界面真需要时再加。
6. 写 `packages/server/src/index.ts`：导出 `createServer(config)`，并加一个可执行入口（`pnpm dev:server`）。默认 `127.0.0.1`；端口、token、`dataDir`、llm 配置全部从传入的 config 读，不向环境要。
7. 写 `packages/desktop/main.ts` 与 `preload.ts`：算好 `dataDir` 后调 `createServer()`、开窗口、暴露冻结的四个 `window.flowpal` 方法。这是全仓库唯一 import electron 的地方。
8. 写 `packages/app/`：分成 `shell/`（最朴素的容器，形态定了就换掉）与 `views/collection/`（C 的工作面）；`window.flowpal` 不存在时的 mock 实现，使 C 能脱离 Electron 开发；一个最小的条目列表页面，证明 HTTP 链路通。
9. 写 `packages/server/pipeline/extract.ts` 的空实现骨架：签名 `(fragment, ctx) => Promise<ExtractOutput>`，内部读 `prompts/extract.md`，调 OpenAI 兼容接口，用 zod 校验，校验不过抛错并打印原始回复。
10. 写 `packages/server/pipeline/map-structured.ts` 的空实现骨架：签名 `(fragment, ctx) => Item[]`，结构化碎片走这条路，不经模型。
11. 写 `packages/server/connectors/ruc/` 的模块骨架：登录、拉课表 / 考试 / 校历三个函数的签名，输出统一成 `raw_type='structured'` 的碎片；凭据从 `config.local.json` 读，该文件进 `.gitignore`。
12. 写 `data/calendar.json` 的结构与一份占位学期数据，等真实校历拉回来替换。
13. 写 `scripts/check-fixtures.ts` 与 `fixtures/` 的目录结构，实现三条硬断言与对照表打印；演示碎片本身待补。
14. 写 README：如何安装、如何配 LLM key 与教务凭据、如何跑起来、如何跑 check。
