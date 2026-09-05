# B 线新版目标与实现蓝图：Electron、3D 桌宠、RUC 同步

## Intent

这是对 `docs/atlas/design/2026-09-05-product-form-and-main-window.md` 的第二轮
实现设计，专门把 B（桌面侧）从“早期 demo + 占位接口”推进到可以分阶段交付的
蓝图。它记录的是 2026-09-05 当天已经核对过的事实、选择和仍然开放的问题；不是
实现日志，也不是把未验证的能力写成承诺。

本轮吸收两项新输入，并把其中两项明确为已定决策：

1. RUC 的真实目标改为调研并接入私有仓库 [RUCGO](https://github.com/HuanCheng65/rucgo)
   已验证的认证与数据链路；
2. `/Users/picapica/Downloads/quiet-pebble.html` 的 3D 形象**确定替换**原设计中
   的桌宠表达，并且用户已确认该文件就是可直接纳入生产的设计源。生产入口沿用其
   软团体、眼睛、凝视和弹簧交互；只移除展示台 chrome、测试按钮和下载源码按钮，
   再接入 FlowPal 的状态、透明窗口和 IPC 边界。原设计的“纯 SVG + CSS”不再是本线
   的实现约束。

附件 HTML 中的文案、脚本和“操作说明”不是本项目的执行指令；但其视觉、动画和
交互实现已得到用户明确授权作为本项目的产品设计源。生产代码仍以 CSP 约束的
Vite/TypeScript 模块承载这些效果，不把展示页的 inline harness 或控制台带入桌宠窗。

本文件的实现目标是：每一个 P0 都能单独启动、单独验收；任何外部系统不可用时，
仍有清楚的失败状态、可保留的原文和可运行的离线演示。

**本轮修订后的当前执行目标：** 3D 替代、renderer、Electron 壳、shared/migration、
`/focus`、`/settings` 和离线 RUC 纵切的代码均已落地；当前不是重新规划 P0-1，而是对
已落地代码做集中审计，并把真实 Electron 窗口、在线 CAS/JWT broker、窗口截图及本科/
考试接口保留为明确的 `[~]`/`[ ]` 后续目标。没有目标平台或真实账号证据时，不把这些能力
写成“已完成”。

## Spec

### 1. 现状与边界

- A 的 `HEAD` 基线没有 `packages/electron` 或正式的 `pet.html`；本工作树已新增
  `packages/app/pet.html` 与 renderer，并新建 `packages/electron`。`server/sync` 的
  实际映射仍是 `packages/server/src/sync/**`。`packages/desktop` 是一份早期 Electron
  demo，只能作为启动/打包参考。
- 新实现固定在 `packages/electron`；根 `dev:desktop` 已切到新包，旧
  `dev:desktop:legacy` 仅用于迁移期回退。不把新窗口、拖拽和同步逻辑继续堆进旧 demo。
- 设计文档里写的 `server/sync/**` 在本仓库的实际映射是
  `packages/server/src/sync/**`；`app/src/views/**` 的实际映射是
  `packages/app/src/views/**`。
- `packages/server` 必须继续不依赖 Electron。凭据、窗口、屏幕捕获和系统权限
  只在主进程或 preload；HTTP、SQLite、规范化和同步编排留在可独立运行的 server。
- B 的范围仍是：Electron 主进程、桌宠窗口与拖拽采集、教务/日历同步、主窗口
  `/focus` 与 `/settings`。主窗口其他页面的视觉骨架仍属于 C，但需要为本轮
  路由和事件契约留接口。
- 当前 `packages/app` 只有单入口和早期 shell，没有正式 Router/QueryProvider；
  C 负责补齐 `HashRouter`、TanStack Query/SSE 接线和全局 design tokens，B 提供
  `/focus`、`/settings` 的视图与 typed hooks，不在各视图里另造数据访问层。

#### 与 A 部分合并后的现成基线

本轮先从 `origin/master` 的 `4df8e77` 快进到最新 `9ff614b`（A：项目层、五页取数与
两条 SSE），再把本地 B 变更逐文件恢复并解决冲突；没有 reset 或覆盖任一方的工作。
B 直接建立在这条已统一的基线上，不重复发明以下能力：

- `projects`、`items.project_id`、`items.external_id`、`focus_sessions` 已在
  `packages/server/src/store/schema.ts` 中存在；
- `store/items.ts` 的 `upsertByExternalId(...)` 是结构化同步的现成幂等写入口，字段
  变化会写 `item_history`，同步 adapter 应直接复用；
- `packages/server/scripts/demo-reset.ts`、六条 fixtures、真实的 `data/calendar.json`、
  五页读取路由和粗粒度 SSE 已可用于离线演示与 parser/mapper 验证；
- B 已把数据库守卫从 A 的 v4 扩展到 v5：对 v4 旧库执行显式、可重复的追加迁移，
  其它旧版本仍响亮拒绝并要求受控重建，不能假定 `CREATE TABLE IF NOT EXISTS` 会升级旧库。

交接细节见 [`docs/语义层-A交接说明.md`](../../语义层-A交接说明.md)。

### 2. 新版目标与优先级

优先级不是功能数量排序，而是“先消灭会导致返工的未知，再做可见功能”。每个阶段
都有一个退出门槛：没有通过门槛，不把下一阶段伪装成已完成。

| 阶段 | 目标 | 交付物 | 退出门槛 |
| --- | --- | --- | --- |
| P0-0 | **3D 桌宠替换（代码完成）** | 直接沿用已批准的 `quiet-pebble` 视觉/动画并模块化为 `PetRenderer`；移除展示台与测试按钮，补六态映射、透明 alpha、idle 呼吸、fallback、`dispose()` | 独立 bundle、六态、命中测试、reduced-motion、context-lost 均已有可重复检查 |
| P0-1 | **Electron 宠物窗口（代码完成，平台验收待补）** | 新 `packages/electron`、主窗 + pet 窗、双入口 Vite、typed preload、单实例 | 主进程/预加载 bundle 已构建；真实透明窗口、第二实例、跨屏拖动需 Electron 目标环境验收 |
| P0-2 | 共享契约与高风险探针（代码完成） | store migration、shared 类型、settings/sync/focus API、RUC broker seam、桌面捕获探针 | server 独立代码/迁移/smoke 已验证；broker 与 capture 仍是显式 seam |
| P0-3 | 窗口交互、四种输入与回执（部分完成） | 形状穿透、手动拖动和 typed 输入桥已落地；文本/粘贴/快捷键/文件 drop 的 fragment/run 编排、receipt 气泡和截图采集仍待完成 | 前三类入口真正落 immutable fragment；窗口截图和跨平台权限链路未完成 |
| P0-4 | `/focus` 与 `/settings`（代码完成） | 最小专注会话、设置表单、RUC 登录/同步状态入口 | 刷新/重启恢复、幂等和 secret redaction 已验证；真实登录 broker 未接入 |
| P0-5 | 确定性 RUC 纵切（离线完成） | portal 日程、研究生课表、normalizer、external id、fixture；在线 broker seam | fixture、空响应、重复同步、原文保留和 scheduler contract 已验证 |
| P1-1 | 真实 RUC 认证与在线同步 | Electron-owned `RucAuthBroker`、CAS WebView、重定向 transport 的生产实现 | 会话失效能明确要求登录；不把密码交给 server；单飞刷新无重试风暴 |
| P1-2 | 尚未具备证据的能力 | 本科课表、考试接口调查与 adapter | 只有通过真实 fixture/契约测试后才从“暂不支持”变成可用 |
| P2 | 可选增强 | 系统日历、微表情、颜色/尺寸持久化、更多平台探针 | 不影响 P0/P1 的稳定性和原文保留语义 |

P0-0 是第一个实际编码目标，不是“是否采用 3D”的讨论；P0-2 的最小类型可以
并行准备，但不能把 migration/API 大包作为开始桌宠工作的前置条件。

P0 的主依赖顺序固定为：

```text
PetRenderer ─> Electron pet 窗口 ─> 状态/穿透/拖动 ─> 四入口/捕获
     │                 │
     └──────────────> bridge/契约 ─> focus/settings
                                   │
                                   └─> RUC fixture/normalizer ─> 在线 broker/scheduler
```

### 3. 已确定的 3D 桌宠替代：直接纳入设计本体，移除测试 chrome

这是已确定的产品决策：生产桌宠直接使用 `quiet-pebble.html` 的程序化 3D 形象；
旧 SVG 只允许在迁移期间作为临时 fallback，不能继续作为默认形象，也不能与 3D
形象并行形成两套业务状态机。P0-0 的任务不是再讨论选型，而是把已批准的视觉和
动画接入一个可独立测试的 `PetRenderer`。

`quiet-pebble.html` 是单文件、无外部网络依赖的 WebGL 原型。其文件 SHA-256 为：

```text
3629b807bf759092d1ff808aff9b918ee5e9e61ea1b57847b1170e3f10d944ef
```

素材来源和 SHA-256 记录在本蓝图中；用户已明确允许直接使用该设计文件。实现上仍将
shader 和交互拆到受 CSP 约束的 TypeScript 模块，避免把原 HTML 的 inline 脚本、
展示台布局和测试控制器原样带进生产入口。

**保留：**

- fragment shader 的软团体积感、眼睛/凝视、弹簧形变和颜色参数；
- pointer long-press、拖动、释放的响应感；
- `ResizeObserver`、DPR 上限、静止时停 RAF、`prefers-reduced-motion`、
  WebGL context lost 的可检测性；
- 无纹理、无模型文件、无远程请求的轻量资产形态。

**生产入口删除或重写：**

- `FORM STUDY`/展示台 header、控制面板、slider、下载源码按钮和原型文案；
- 只在 canvas 局部改变 `x/z` 的 demo 拖动；
- `focus()` 等仅改变视觉 mood 的 API；它不能代表 FlowPal 的 focus session；
- 随机 mood 作为业务状态的做法。

原型的 shader、软团体形变、凝视和 pointer 弹簧均可直接沿用；只把其 DOM/事件
接线改为 `pet.html` + `PetRenderer` + typed preload。原型的“桌面 96”只作为视觉
比例参考，生产呈现采用两档尺寸：主页面 A 为 148×148 logical px，遮挡后悬浮 B 为
224×224 logical px。A/B 的切换由 Electron 主进程控制，renderer 只负责同一套形象
的缩放和动画。

生产 renderer 的唯一业务入口是协议状态，而不是原型按钮：

```ts
type PetStatus =
  | 'idle'
  | 'receiving'
  | 'processing'
  | 'done'
  | 'error'
  | 'focus'

interface PetRenderer {
  mount(): void
  setStatus(status: PetStatus, meta?: { message?: string }): void
  setTheme(theme: {
    color?: 'chalk' | 'fog' | 'stone'
    size?: 148 | 224
    reducedMotion?: boolean
  }): void
  hitTest(localPoint: { x: number; y: number }): boolean
  startDrag(pointer: { x: number; y: number; pointerId: number }): void
  updatePointer(pointer: { x: number; y: number; pointerId: number }): void
  endDrag(): void
  dispose(): void
}
```

状态映射固定为：

| 协议状态 | 3D 表现 | 触发事实 |
| --- | --- | --- |
| `idle` | 低幅呼吸、偶发眨眼 | 没有进行中的输入/运行 |
| `receiving` | 被抱起/轻压、注意力转向输入 | pointer down、drop 或快捷键输入已收到 |
| `processing` | 低频凝视/稳定形变，不显示成功 | fragment 已落库，agent/sync 正在运行 |
| `done` | 短促回弹/暖色高光 | 运行成功且结果已落库 |
| `error` | 收缩/忧虑表情 | 失败已分类；原文仍可访问 |
| `focus` | 慢呼吸、稳定凝视 | focus session 为 running |

原型没有真正的待机呼吸振荡，必须新增低幅、低频 idle oscillator；
`reduced-motion` 时禁用弹跳/呼吸并保留静态状态可辨识性。`sleepy`、`curious` 等
可以作为未来微表情，但不能绕过上述六态。

透明窗口的 WebGL 改造必须同时完成：`alpha: true`、透明 clear color、形状外
alpha 为 0、形状内 alpha 为 1；高精度 shader 探测失败时降级到 mediump 或静态
CSS/SVG fallback。不能把原型的 `alpha:false` 不透明矩形直接放进桌面。

#### P0-0 现在具体要做什么

先不接 RUC、SQLite、窗口截图，也不把旧 `packages/desktop` 当作新实现。只完成一
个可以在浏览器中运行的生产形象切片：

1. 在 `packages/app/pet.html` 建立独立入口；从原型抽出 shader、uniform、spring
   和 pointer 表现到 `packages/app/src/pet/{renderer,shader,state-machine}.ts`，
   删除展示台 header、controls、slider、下载源码和原型文案。
2. 实现 `PetRenderer` 的六态、`hitTest`、idle 低幅呼吸、reduced-motion、
   WebGL context-lost/不支持时的静态 fallback，以及 `dispose()` 清理所有 RAF、
   timer、observer 和 pointer listener。
3. 生产默认只加载 3D renderer；旧 SVG 不作为业务路径。测试通过 renderer/state
   contract、focused TypeScript 和独立 Vite bundle 完成；生产 `pet.html` 不包含
   harness、按钮、slider 或下载入口。
4. 在 96/224 logical px、DPR 1/2 下检查透明边缘、命中轮廓、长按/拖动/取消和
   reduced-motion；GPU 不可用时仍能看到状态文字或静态形象，而不是白屏。

**P0-0 的完成定义：** 独立 `pet.html` 能加载 3D 形象；六态可重复切换；形状外
透明、形状内可命中；context lost、取消拖动和销毁后无 listener/timer 增长。完成这
个切片后，下一步才是 P0-1：把同一个 bundle 接进新 Electron pet 窗口。

#### 当前工作树实现状态（2026-09-05）

- 已新增 `packages/app/pet.html`、`src/pet/{main,renderer,shader,state-machine}.ts`
  和 `pet.css`；生产入口只保留 3D renderer、fallback 和无障碍 live label，不带测试按钮。
- `packages/app/vite.config.ts` 已改为保留主入口并增加 `pet.html` 多入口；renderer
  不依赖 Electron、server、SQLite 或网络。
- 已通过 renderer 文件的 strict TypeScript 检查，以及以独立 `pet.html` 为入口的
  Vite production build。完整 workspace 安装/fixture 命令仍受当前环境无法访问
  npm registry（`ENOTFOUND`）影响，不能据此宣称全仓检查通过。
- P0-0 的独立 renderer 已完成代码切片；P0-1 的新壳代码已落地并新增
  `packages/electron/{src/main.ts,src/preload.ts,src/ipc/**,src/windows/**,src/lifecycle/**}`。
  新壳实现单实例、主窗、透明 pet 窗、dev/prod app 路径、typed preload、基础
  hit/drag IPC 与 server 生命周期；旧 `packages/desktop` 仍只作迁移期参考。
- `packages/app/src/pet/main.ts` 已把 `hit`、拖动和主进程 status command 接到窄 bridge；
  preload 同时保留旧的四个 flat 方法和新的 grouped `pet/input/windows/capture` 面。
- 已通过 Electron shell 的 strict TypeScript 检查与 esbuild main/preload bundle；本机
  Electron 44 已能启动生产主窗口。透明边缘、第二实例聚焦、跨屏拖动和关闭/重建后的
  listener/drag 清理仍需在目标平台逐项视觉验收。
- `FLOWPAL_APP_URL` 默认仅允许本机 dev server；`FLOWPAL_APP_DIST` 可用于未打包的
  file-mode smoke；主进程拒绝未列入 HashRouter 白名单的导航路径。
- Electron 启动时即使没有 `config.local.json` 也会用仓库内的
  `config.example.json` 启动本地 server（dataDir 仍落在 Electron userData）；因此主界面
  的读取/空态/设置页不会因 `Failed to fetch` 失效。模型投放等需要密钥的动作仍保持失败态，
  用户补齐本地配置后无需改代码即可启用。
- P0-2/P0-4 的 shared contract、v4→v5 migration、settings/focus/sync store 与
  `/focus`、`/settings` 路由已落地；`packages/server/scripts/check-b-api.ts` 的
  schema、secret redaction、revision、focus 幂等和 unsupported sync smoke 通过。
- P0-5 的 portal/graduate normalizer、stable external id、structured import、项目归类、
  `sync_records` 幂等和空响应保留已落地；12 个 RUC + 1 个 scheduler（共 13 个）Node 26
  contract tests 通过。`POST
  /api/sync/run` 只有显式 `mode: 'fixture'` 才会导入内置/传入样例；默认 `online` 在
  未注入 Electron-owned broker 时持久化为 `unsupported`，不会伪报成功。
- server 已提供可注入 broker 的 single-flight scheduler：有 broker 时启动一次、按设置
  间隔（默认 6 小时）运行，失败只等下一个周期；无 broker 的独立/浏览器模式不启动
  后台假同步。崩溃遗留的 running sync 超过 30 分钟会被标记并恢复，避免永久卡住。
- 当前仍未宣称完成的能力：真实 Electron 窗口 smoke、在线 CAS/JWT broker、窗口列表/单窗
  截图与拖宠采集、快捷键/剪贴板/文件 drop 到 fragment/run 的主窗口编排、receipt 气泡、
  本科课表和考试接口。它们在 API/UI 中保持显式 unsupported 或待探针状态。

#### 交互逻辑剩余清单（2026-09-06）

按“现有代码可闭环”与“需要平台权限/外部协议”拆分，后续实现不得跳过退出门槛：

- [x] 桌宠形状命中、点击回主界面、悬停提示、原生拖拽与拖拽期间的穿透锁定。
- [x] 主窗口 inline A 尺寸 / 独立窗口 B 尺寸、失焦右下角传送、聚焦回场、最小化延迟与布局占位动画。
- [x] 文件 drop：路径白名单、图片/文本/ICS 分类、fragment/run 回执、失败原文保留。
- [x] 文本剪贴板：桌宠长按、快捷键、统一队列、`/api/fragments` 投递和状态回执。
- [x] 剪贴板图片：Electron 主进程读取系统图片并写入临时 PNG/JPG，主 renderer 以
  `rawType=image` 投递到已有 vision pipeline；无图无文时给出明确错误回执。
- [x] 系统截图/窗口采集基础链路：Electron `desktopCapturer` 权限探针、屏幕/窗口 source
  选择和临时 PNG 输出已接入；仍需目标 macOS 机器授予屏幕录制权限后做视觉验收。
- [x] 在线 RUC CAS broker 基础链路：`persist:ruc` 登录窗口、门户 Cookie、研究生 Cookie
  bootstrap/重试和在线 normalizer 已接入；本科 JWT/考试 adapter 仍未勾选。
- [ ] 本科课表和考试 adapter：只有真实契约或 fixture 通过后才勾选。
- [ ] 真实 Electron smoke：透明边缘、第二实例、跨屏拖动、macOS 最小化/恢复顺序。

当前实现退出门槛：`packages/app` 与 `packages/electron` strict TypeScript、Electron
main/preload bundle、`git diff --check` 均通过；截图需 macOS 权限验收，本科/考试和真实
窗口 smoke 仍是明确的后续项。

#### 桌宠呈现迁移更新（2026-09-05）

- 主页面内嵌桌宠固定为 A 尺寸（148×148）；Electron 独立窗口使用 B 尺寸（224×224）。
  B 窗口从内嵌桌宠的屏幕坐标开始，保持 `alwaysOnTop`，先在原地起跳，再瞬时传送到
  当前显示器工作区右下角；失焦即启动，不依赖屏幕录制权限或遮挡探测。
- 失焦出发先播放约 280ms 的原地弹跳，抵达右下角后播放约 260ms 的低高度落地；主窗口
  重新获得焦点时，B 在右下角弹跳消失（280ms），隐藏 native pet，再在原内嵌位置以 A
  尺寸播放传送到达/低位落地（360ms）。presentation 事件通过 typed preload 同时驱动
  两个 renderer，避免重复状态机。
- 最小化或隐藏事件走强制停靠分支：取消正在进行的迁移，直接显示置顶 B 窗口并设到右下角，
  避免 blur/minimize 事件顺序差异导致桌宠停在原位置。
- 桌宠点击契约：悬停时显示非阻塞陪伴气泡（“有新点子吗？告诉我吧，或者把任务拖给我～”），
  悬浮态单击留在桌宠窗口内并触发抚摸/弹簧反馈；主窗口导航通过 Space/P 或明确输入动作完成。
  删除双击状态机，避免透明窗口下的 click/dblclick 合成和穿透竞态。
  长按阈值为 800ms 并读取剪贴板，拖动仍保留原生拖拽。透明窗口的形状命中切换使用同步
  `sendSync` IPC，避免鼠标刚进入桌宠时首个单击在命中状态更新前穿透到下层主窗口。
  气泡不用系统模态框，避免透明桌宠窗口被模态焦点打断。
- 文件投放按扩展名分流：文本/ICS 使用安全本地文件读取，PNG/JPEG/WebP 等图片使用
  `rawType: image` 进入视觉模型；未实现的系统截图探针继续保持显式 unsupported。
- 若在 Codex 的 macOS seatbelt 沙箱内直接运行 Electron，macOS LaunchServices 可能在
  Electron 初始化前触发 SIGABRT；这不是 FlowPal renderer 或主进程异常。桌面验证需在
  沙箱外终端运行（本机同一 Electron 44.2.0 已验证可启动）。
- 失焦迁移增加 700ms 状态恢复兜底：若主窗仍失焦但 native pet 实际不可见，会重新创建/停靠
  并显示悬浮窗，避免子窗口切换中断迁移后状态标记与实际可见性不一致。
- macOS 最小化会先取消 blur 触发的迁移并隐藏桌宠，延迟 1 秒确认窗口仍处于最小化状态
  后才显示右下角悬浮窗，避开系统最小化动画造成的闪烁；恢复窗口会取消该延迟任务。
- native pet 从创建开始就使用 B 尺寸和右下角目标位置，传送期间不再执行 A→B 的可见
  resize；renderer 同时使用 layout 尺寸（`offsetWidth/offsetHeight`）并在 presentation
  命令到达时刷新，避免旧 backing buffer 在尺寸变化中短暂放大并裁成四分之一。
- 主页面的 A 容器在悬浮态脱离文档流但保留稳定的 148×148 渲染盒，释放页面布局空间；
  回场时恢复文档流，再执行 A 尺寸落地动画。
- 主窗口首次展示和每次回焦都先保持 A 槽的宽高为 0（桌宠与其布局空间均不可见），
  再同步打开槽位并播放 `teleport-in`，让正文先随槽位过渡下推、桌宠随后弹出；失焦时
  先播放 `floating-start`，结束后进入 `layout-closing` 再收起槽位。Electron 的首个
  `ready-to-show`/`show` 瞬时未聚焦事件由生命周期门控，避免把首次绘制误判为失焦而触发
  悬浮迁移；renderer reload 重放当前 phase，不用 synthetic `steady` 打断入场/离场动画。
- `petInlineGeometry` 只负责记录回场坐标；`PetPresentationChange` 负责阶段和动画时长。
  该简化方案没有 `desktopCapturer`/screen-recording 权限依赖，悬浮窗口始终不抢焦点。

### 4. 真实 RUC 能力矩阵（以 RUCGO 为事实来源）

本轮调研通过本地 SSH 只读浅克隆完成；RUCGO `main` 当前核对的 commit 是
`1a107ec1a8c0de63e88fd705f3d9220f724659cd`。以下结论只描述该 commit 中实际存在
的代码，不把 README 模板或推测接口算成能力。

RUCGO 是 Flutter/Dart 应用，不是可直接安装到 Node 的 SDK；仓库根部未发现
`LICENSE`/`COPYING`。因此本项目采用基于已验证 endpoint、字段和失败判据的
clean-room TypeScript adapter，不复制 Dart 源码，也不把 RUCGO 当作运行时依赖。

| 来源/目标 | 已验证接口或行为 | 认证形态 | 本项目状态 |
| --- | --- | --- | --- |
| RUC 门户日程/校历 | `GET https://my.ruc.edu.cn/calendar/mgr/api/ruc/calendarList.rst`；`categoryIds=0,-2,-5` 本地筛选；返回按天 events | CAS cookie，门户 probe 为 `sopplus/_web/portal/api/user/loginInfo.rst` | P0 只读同步；可覆盖校历、课表/调课事件；不宣称考试 |
| 研究生课表 | 取学期 `modules/xskcb/kfdxnxqcx.do`；整学期 `bykb/loadXskbData.do`，表单 `XNXQDM` | CAS cookie；首次模块请求 403 时访问 `*default/index.do` 一次再重发 | P0 adapter + 严格 normalizer |
| 本科教务（Njw2017） | 只验证 topology/probe，没有课表 repository | JWT 在 `https://jw.ruc.edu.cn/` localStorage `qzdatasoft`，请求头 `token` + `app: PCWEB`；不是 Cookie | P1 调查；UI 明示“暂不支持/需验证” |
| 考试 | RUCGO 当前没有 exam/score repository 或已验证 endpoint | 未知 | P1 调查；不得从日程类别推断已支持 |

研究生课表 normalizer 必须保留以下数据事实：`rwList` 的无排课教学任务是合法
数据；`jgList` 通过 `BJDM` 连接班级，`ZCBH` 周次位图决定周次，`KSJCDM/JSJCDM`
是节次范围，`JCFADM`/节次方案给出实际时间；只合并相邻节次，午休断开，不依赖
`ZCMC` 文本。若 meeting 引用不存在的班级/节次方案、或混入多套节次方案，整个
payload 拒绝落库而不是静默修正。

门户日程接口的 `teachingWeek`、`isHoliday`、`holidayName` 不能作为必填事实；若
需要生成 `CalendarSchema`，优先使用研究生课表的 `firstMonday + weekCount` 或已
验证的校历事件，并将推导来源写入 structured fragment。

#### RUC 认证与传输不可违反的规则

RUCGO 的认证实现把用户登录放在 WebView，再把浏览器上下文中的 Cookie/JWT 搬到
请求客户端。Electron 对应实现必须保持这个边界：

- 主进程拥有持久 partition（建议 `persist:ruc`）和登录 BrowserWindow；
  `session.cookies` 与同一 WebContents 的 `localStorage` 由主进程读取；
- server 不接收学号密码，不在 `config.local.json` 中保存明文密码；凭据 broker
  只向 server 提供受控的、短生命周期的已授权 transport 或 normalized payload；
- 重定向由 transport 手动逐跳处理，保留 `Set-Cookie` 与 `Referer`，最多 10 跳；
  研究生 form POST 遇 3xx 时先以 GET 走完整链，再原样重发 POST，绝不把表单重发
  给 CAS；
- 重定向链中间经过 CAS 不等于失效，只有系统定义的终点/JSON error 判据才抛
  `SessionExpired`；研究生 403 只做一次 bootstrap，仍失败就报错；
- 会话刷新采用 single-flight，最多一次刷新/重试，不允许并发请求各自唤起登录；
- 本科 JWT 与对应 `SESSION` cookie 必须成对搬运；取不到 localStorage token
  直接报告会话失效，不发送一个注定失败的空 token 请求。

### 5. 目录与模块蓝图

```text
packages/
  electron/                         # 新建；唯一的 Electron 主进程包
    package.json
    src/
      main.ts                       # 单实例、server 生命周期、窗口注册、退出清理
      lifecycle/
        app-ready.ts
        single-instance.ts
      windows/
        main-window.ts               # 主窗口与内部 hash 路由
        pet-window.ts                # 透明、置顶、96/224 尺寸、形状 hit-test
        login-window.ts              # RUC 真人登录，不暴露密码给 server
      ipc/
        channels.ts                  # 字面量 channel + payload schema
        handlers.ts                  # sender 校验、参数校验、幂等处理
      capture/
        capability-probe.ts          # 屏幕录制/窗口列表/截图探针
        window-locator.ts             # OS adapter；先接口，后选 native 实现
        screenshot.ts                 # 单窗口截图与权限错误
        drag-session.ts              # 手动拖动、跨屏 DPI、ESC 取消
      ruc/
        auth-broker.ts               # Cookie/localStorage/safeStorage 边界
        web-login.ts
        transport.ts                 # redirect、bootstrap、single-flight
      sync/
        scheduler.ts                 # 启动一次 + 每 6h + 手动；不自动重试
        status-store.ts
      security/
        secret-store.ts              # safeStorage adapter；不把 secret 传 renderer
  app/
    index.html                       # 主窗口入口
    pet.html                         # 只载入 pet bundle，不载主 app bundle
    src/
      main.tsx
      pet/
        main.tsx
        renderer.ts
        shader.ts
        state-machine.ts
        pet.css
      bridge.ts                       # 浏览器 mock + Electron typed bridge
      views/
        focus/
          FocusView.tsx
          focus.css
          focus.api.ts
        settings/
          SettingsView.tsx
          settings.css
          settings.api.ts
  server/
    src/
      sync/
        types.ts                      # ExternalRecord/SyncResult/Capability
        scheduler.ts                   # 可测试的时间与 single-flight 编排
        ruc-source.ts
        portal-source.ts
        graduate-source.ts
        normalizers/
          ruc-timetable.ts
          ruc-schedule.ts
        structured-import.ts
      routes/
        focus.ts
        settings.ts
        sync.ts
        events.ts
      store/
        migrations/
        focus.ts
        settings.ts
        sync.ts
  shared/
    src/
      desktop.ts                      # PetStatus/bridge payload
      focus.ts
      settings.ts
      sync.ts
      schemas.ts
```

`packages/desktop` 在迁移期只修必要的启动兼容问题；新代码不得反向依赖它。Vite
采用 multi-page build，`index.html` 与 `pet.html` 的 bundle 入口分离，pet 页面
不能因为复用 React shell 而加载主窗口所有查询和模型代码。

### 6. Electron 窗口与输入契约

#### 主窗口

- 单实例；第二次启动把既有主窗口显示并聚焦，不创建第二个 server 或第二个
  scheduler。
- 继续使用 `contextIsolation`，preload 只暴露白名单方法；renderer 不接触
  `ipcRenderer`、文件系统、Cookie 或 secret。
- 主窗口通过 HTTP 调本地 server；IPC 只做窗口、快捷键、原生拖拽、剪贴板、
  捕获和登录窗口等 Electron 不可替代能力。

#### 桌宠窗口

- frameless、transparent、non-resizable、always-on-top、默认不抢焦点；支持
  all workspaces，但不覆盖 fullscreen；开发/生产都必须显式设置背景透明。
- 不使用 `-webkit-app-region: drag`。拖动由 renderer 报 pointer 事件，主进程
  用 `screen.getCursorScreenPoint()` 和窗口 bounds 更新桌宠位置。
- 形状外开启 `setIgnoreMouseEvents(true, { forward: true })`，形状内恢复接收；
  renderer 只报告共享的 `hitTest` 结果，不能让 CSS 盒子决定可点击区域。
- 生产呈现固定为 A=148/ B=224 logical px（96 仅是原型比例参考）；DPR 1/2 下限制
  canvas 面积、帧率和最大 DPR，静止时停 RAF，避免常驻 ray-march 耗电。

#### 窄 preload API（目标形状）

```ts
interface FlowPalDesktopBridge {
  pet: {
    setStatus(status: PetStatus, meta?: { message?: string }): void
    onCommand(cb: (command: PetCommand) => void): () => void
    reportHit(inside: boolean): void
    beginDrag(point: ScreenPoint): void
    moveDrag(point: ScreenPoint): void
    endDrag(): Promise<DragResult>
    cancelDrag(): void
  }
  input: {
    onHotkey(cb: () => void): () => void
    onFilesDropped(cb: (files: DroppedFile[]) => void): () => void
    readClipboard(): Promise<string>
  }
  windows: {
    openMain(hash?: string): Promise<void>
    hidePet(): Promise<void>
  }
  capture: {
    probe(): Promise<CaptureCapability>
  }
}
```

所有 channel 的 payload 通过 zod/等价 schema 校验，handler 校验 sender、窗口来源和
路径范围；不把原始 `ipcRenderer` 对象或通用 `send(channel, any)` 暴露给页面。

#### 四种输入的统一序列

```text
输入开始
  -> fragment 先落库（原文/文件路径/structured JSON）
  -> pet = receiving
  -> 需要处理时 pet = processing
  -> server run / sync run 产生事件
  -> done 或 error
  -> receipt 气泡：一句结果 + 一条动作痕迹；失败结尾为“原文已存”
```

拖宠到窗口的具体顺序必须是：

1. pointer down 命中形状后进入 drag session；
2. 主进程读取屏幕指针位置，按前到后排除 pet 自己，定位第一个包含该点的窗口；
3. 先做屏幕录制/窗口列表能力检查，再按窗口 ID 截单窗口图；
4. 权限失败、大于一个候选窗口、窗口已销毁或捕获超时，都报告明确错误，不静默
   退化成全屏截图；
5. 原始截图先成为 fragment，再交现有 extract/agent pipeline；松手和 ESC 都必须
   幂等。

捕获能力探针是 P0 的硬门槛。macOS 屏幕录制权限或平台窗口列表拿不到时，
“拖桌宠到窗口”当场显示不可用原因；不把一个未经验证的 native module 直接写进
   主流程。`WindowLocator` 先做平台 adapter，候选 `node-window-manager` 需在目标
   OS、打包 Electron 和缩放/多屏组合上通过探针后才引入，且要处理 native module
   rebuild/签名问题。

### 7. `/focus` 最小版

专注页不是新的 prompt 页面，也不是把 quiet-pebble 的 `focus()` mood 当事实。
它只显示：计时器、桌宠在场、当前条目/短摘要、`完成` 和 `继续` 两个动作。

路由形状：

```text
/#/focus?item=<item-id>&minutes=<n>
```

服务端优先复用 A 已落地的 `focus_sessions`，只追加本轮确实需要的关联/摘要字段，
不要再建第二张同义的 session 表。当前基线形状是（`item_id`、`project_id` 都可为空，
project-only 历史是合法状态）：

```text
focus_sessions(
  id, started_at, planned_minutes, actual_minutes, ended_early,
  item_id, project_id, created_at
)
```

`focus_session_fragments(session_id, fragment_id, added_at)` 仍是 B 的追加迁移目标；
结束简报所需的 summary/ideas 可以先由关联条目和 fragments 查询得到，只有确认无法
从现有事实推导时才加列。

当前 A schema 尚没有 `ended_at`、`outcome` 或 `updated_at`；因此恢复/结束 API 在
扩展这些字段前只能把 `started_at + planned_minutes + actual_minutes + ended_early`
作为事实来源，不能在实现中假定完整的结束事件审计已经存在。A 的演示 focus seed
也允许只有 `project_id` 而没有 `item_id`，UI/API 必须保留这种 project-only 会话。

前端状态机：`resolving → starting → running → ending → summary | error`。

- 计时以持久化 `started_at` 与当前注入时钟计算，不以 setInterval 累加秒数；
- `start`、`done`、`continue`、`early_end`、`end` 带 session id 并幂等；专注中允许
  提前结束，重复点击不能多建 session；
- 主进程把 session 状态映射为 `pet.setStatus('focus')`；结束后回到 `idle` 或
  `processing`，不由 renderer 自己猜；
- 崩溃/重启后 GET session 能恢复 running/ending 状态，超时由 server 判定；
- summary 只显示事实（用时、完成/继续、关联条目），不做评判、不额外生成 prompt。

### 8. `/settings` 最小版

设置页分四块，但都由一个可保存的 draft 管理：

1. **模型**：文本/视觉 `baseUrl`、`model`、API key 状态（只显示已配置/未配置，
   不回显 secret）；
2. **RUC 教务**：真人登录/重新授权、当前角色、上次会话时间、能力矩阵；明确显示
   “研究生课表/门户日程可用”“本科课表/考试暂不支持”，而不是一个含糊的“同步成功”；
3. **chronotype 两问**：保存两项明确回答，不在本轮展开画像算法；
4. **同步**：启用状态、上次开始/结束、来源、导入条数、失败原因、`立即同步`。

表单状态机为 `clean → dirty → saving → saved | error`；离开页面有未保存提示，
重复保存使用 revision/updated_at 防止旧响应覆盖新 draft。RUC 的“登录”按钮只打开
Electron-owned WebView/BrowserWindow；server 收到的是授权状态，不是用户名密码。

### 9. 同步与结构化落库

同步编排固定为：

```text
启动一次 -> 每 6 小时一次 -> 设置页手动一次
             \\ 所有入口共用 single-flight
```

本轮不做无限重试；网络/权限/解析失败写入 `sync_runs` 并在设置页显示，保留上一次
成功数据。每个 source 返回统一的 `ExternalRecord`：

```ts
type ExternalRecord = {
  externalId: string       // 命名空间 + 版本化稳定键
  source: 'ruc.portal' | 'ruc.graduate'
  kind: 'calendar' | 'timetable' | 'exam'
  observedAt: string
  title: string
  startsAt?: string
  endsAt?: string
  location?: string
  raw: unknown
  capability: 'available' | 'unsupported' | 'unauthorized' | 'error'
}
```

建议的第一版稳定键（最终以 normalizer 测试固定）：

```text
ruc:graduate:v1:<termCode>:meeting:<class>:<weekday>:<periodStart>-<periodEnd>:<room>:<weeks>
ruc:portal:v1:calendar:<eventId>:<localDate>
```

规范化后在一个事务中完成：immutable structured fragment → `ExternalRecord` 校验
→ item upsert → `external_id` 冲突/字段变化写 `item_history`。已 `done`/`dropped`
的条目不因外部重复同步自动复活；原始 fragment 永不改、永不删。结构化来源绕过
LLM，但仍走共享的 dedupe/link/citation 语义，原始 JSON 可追溯。

A 已经落地、B 应直接复用的存储概念：

```text
projects
items.project_id, items.external_id
focus_sessions
```

B 仍需要新增或迁移的存储概念：

```text
focus_session_fragments
sync_runs, sync_records/external_id 索引
settings（非 secret 配置）
必要时才增加 items.source_kind（当前 A schema 尚无此列）
```

A 的 schema v4 已有真实的 runs/focus 基线；B 当前 `openDb()` 将它显式迁移到 v5：
追加 focus 结束字段、focus-fragments、settings、sync_runs、sync_records，并用
`hasColumn`/`IF NOT EXISTS` 保证重复执行安全。其它旧版本仍明确拒绝并要求受控重建。
版本号、迁移失败保留原库和内存库 smoke 都已覆盖；不能把 `CREATE TABLE IF NOT EXISTS`
误当成旧表升级机制。

同步状态事件只发粗粒度 invalidate（source、run id、时间、状态、计数），不在
SSE 中广播 Cookie、token、完整原文或第三方响应。`GET /api/runs/:id/events` 只给
需要展示 agent/tool 进度的本地短事件：工具名和参数摘要，不给 secret 和原始结果。

当前同步 runner 的边界是：`mode: 'fixture'` 走已提交的 clean-room parser，先把完整
响应包进 immutable structured fragment，再在同一事务里 upsert 条目、项目和
`sync_records`；`mode: 'online'` 只有在 `createServer(..., { rucBroker })` 注入
Electron-owned broker 时才会请求外部系统，否则写入 `unsupported` run。这个显式 seam
让离线验收可重复，也避免把内置样例冒充真人 RUC 数据。

### 10. 计划中的 HTTP/API 契约

以下是 B 与 C/A 共享的契约；zod schema 在 `packages/shared` 定义，server route 与
app 使用同一形状。A 的 items/fragments/extract、projects、五页取数和 SSE 已在
`9ff614b` 落地；B 的 settings/sync/focus 路由也已接入。下面仍把“在线 broker 未注入”
和“捕获未实现”明确写在语义里，不能把结构存在误读成能力已完成。

| 方法 | 路径 | 语义 |
| --- | --- | --- |
| `GET` | `/api/settings` | 返回非 secret 配置、能力矩阵、sync 摘要 |
| `PUT` | `/api/settings` | 校验 draft/revision；当前只接受 `apiKeyAction: "keep"`，`set`/`clear` 明确返回 `secret_settings_unsupported` |
| `GET` | `/api/sync/status` | 最近 runs、下次计划、每个 source capability |
| `POST` | `/api/sync/run` | 手动触发；已有 running 时返回既有 run id；默认 `online`，显式 `mode: 'fixture'` 才导入离线样例 |
| `GET` | `/api/focus/:id` | 恢复 session 与事实摘要 |
| `GET` | `/api/focus` | 返回 canonical focus session 列表；旧 `/api/focus-sessions` 仅为 A 兼容入口 |
| `POST` | `/api/focus` | 创建/复用 session，幂等键为 item + active session |
| `POST` | `/api/focus/:id/end` | 完成/继续/提前结束，重复请求返回同一结果 |
| `GET` | `/api/events` | coarse invalidation SSE |
| `GET` | `/api/runs/:id/events` | 本地短事件流，断线可从 sequence 恢复 |

现有 `items/fragments/extract` 路由继续兼容；新增同步 mapper 不得把 `fetchExams`
   的占位 throw 当成成功响应。能力不足要返回结构化 `unsupported`，让 settings 与
   pet 使用不同的失败文案。

### 11. 错误、隐私与安全边界

用户可见失败至少区分：

- **系统未授权**：`“RUC 登录态已失效。重新登录后再同步；原文已存。”`；
- **系统暂不支持**：`“当前版本还不能读取本科课表/考试；原文已存。”`；
- **网络/服务端**：`“RUC 暂时没有回应。保留上次结果；原文已存。”`；
- **解析/数据不一致**：`“RUC 返回的课表格式变了，未覆盖已有条目；原文已存。”`。

实现约束：

- `contextIsolation`、CSP、禁止远程脚本；RUC 登录页只允许白名单 origin；
- `safeStorage` 只保存必要的 refresh/session material，renderer 永远拿不到明文；
- 日志做 redaction：Cookie、JWT、Authorization、密码、完整 URL query 中的 ticket
  都不能写日志；
- 截图原文和 RUC 原始 JSON 受数据目录权限保护，UI 展示引用而非把 token 传给模型；
- server 的所有输入（settings、sync payload、IPC 传入路径）都做 schema/路径边界
  校验；局域网绑定仍需显式 token。

### 12. 验证与验收清单

标记约定：`[x]` 是本工作树已有可重复证据；`[~]` 是代码/契约已落地但仍需目标
平台或真实外部系统验收；`[ ]` 尚未实现。

#### 设计/静态门槛

- [x] `packages/server` 全树无 `electron` import；
- [x] A schema v4 → B schema v5 的空库、旧库迁移、重复打开和失败保留行为有 smoke；
- [x] `quiet-pebble` SHA-256 在本蓝图中可追溯；用户已确认可直接纳入，生产 renderer
      以模块化 TypeScript 提取复用其视觉/动画，不退回旧 SVG；
- [x] 生产默认加载 3D `pet.html` 独立 bundle；旧 SVG、展示台 controls 和下载源码
      不在生产路径；
- [x] P1 未覆盖能力在 API、settings、文案中均为 `unsupported`，没有“假同步”。

#### Electron/桌宠

- [~] 主窗与 pet 双入口只启动一个 server；第二次启动复用既有实例（代码与 bundle 已
      自检，本机 Electron 44 可启动，第二实例/目标平台视觉 smoke 待验）；
- [~] 主页面 A=148、悬浮 B=224 logical px，DPR 1/2 下无不透明矩形、黑边或明显 alpha
      halo（shader/alpha 代码已检视，平台截图待验）；
- [x] 六个协议状态可由固定事件独立驱动，且与 renderer 视觉映射一致；
- [x] idle/focus 使用限帧 ambient RAF；reduced-motion 禁用呼吸/弹跳；
- [~] 形状外点击穿透到后方窗口，形状内可点/长按；pet 默认不抢焦点（依赖 Electron
      运行验收）；
- [x] `pet.html` 是独立入口，不加载主窗口路由、查询和模型 bundle；
- [~] 跨显示器、不同缩放、窗口移出屏幕和 ESC 取消的拖动可恢复（主进程坐标转换已写，
      真实多屏待验）；
- [x] 关闭/重建时清理 renderer listener/timer、IPC drag session 和窗口生命周期；
- [x] GPU/WebGL 不可用与 context lost 均有静态 fallback；
- [ ] 屏幕录制/窗口列表权限失败时的单窗截图链路（当前 probe 返回明确 unsupported）。

#### 输入/回执

- [~] Electron preload 已提供文本/剪贴板、文件 drop 和快捷键 bridge，桌宠指针拖动已接入；
      主窗口尚未订阅这些 bridge 并创建 fragment/run，拖宠到窗口截图也尚未实现，不能宣称四入口全通过；
- [ ] 完成/失败气泡均可追到 run/fragment；失败文案按四类区分并以“原文已存”收尾；
- [~] clipboard 读取 API 只在调用时执行且没有后台轮询；真正的用户入口编排尚未接入；
- [ ] pet renderer 不访问网络、secret 或数据库。

#### RUC/同步契约

- [x] portal endpoint fixture：日期边界按本地日转 UTC，空天合法，分类本地筛选；
- [x] graduate fixture：空 `rwList/jgList` 合法，周次按 `ZCBH` 位图，节次只合并相邻；
- [ ] POST 302 顺序断言为 `[POST, GET each redirect hop, POST]`，不向 CAS 重发表单；
- [ ] 研究生 403 只 bootstrap 一次；仍 403 明确失败；本科不做 bootstrap；
- [ ] CAS 中间跳转不误判失效；只有终点/JSON error 判据触发 `SessionExpired`；
- [x] 重复同步 external_id 幂等；字段变化写 history；结构化原文和空响应保留；
- [x] 研究生课表记录可按稳定课程键归入 projects；
- [x] 并发手动/定时同步只产生一个 active run；失败不覆盖上次成功快照（单进程 SQLite
      startSyncRun 复用 running，broker 仍需在线环境验收）。

#### focus/settings

- [x] focus 时间来自持久化时间戳；刷新、重启、重复点击均不重复建会话；
- [x] `/settings` draft 的 dirty/saving/error 状态可见；secret 不回显；
- [x] RUC capability matrix、fixture/online 状态和未支持项可解释；原始响应可追溯。

### 13. 实施顺序（代码蓝图）

1. **P0-0（已完成代码切片）**：建立 `packages/app/pet.html` 和
   `src/pet/{renderer,shader,state-machine}.ts`，移除展示台 chrome，完成六态、
   alpha/hitTest、idle 呼吸、fallback、reduced-motion 和 `dispose()`；先在浏览器
   renderer/state contract 与独立 bundle 验证，不接 Electron、RUC 或 SQLite；生产入口
   不包含 harness 或测试按钮。
2. **P0-1（代码已落地，运行验收待 Electron 环境）**：新建 `packages/electron`，复制
   可验证的启动约定（包括解除 `ELECTRON_RUN_AS_NODE`），实现 single-instance、主窗、
   pet 窗、typed preload；server 仍从 `@flowpal/server` 启动，所有 server 单测不需要
   Electron。接下来的验收重点是形状穿透、显示/隐藏、手动拖动、第二实例聚焦与资源清理。
3. **P0-2（server 纵切已完成，broker/capture 仍是 seam）**：复用 A 已落地的 projects、items、
   focus_sessions 类型和 `upsertByExternalId` 语义，只补 `ExternalRecord`、settings、
   focus 扩展、sync run/event；给现有 schema 加版本化迁移与索引，而不是重复创建
   projects、items.external_id 或 focus_sessions。
   同时只做一条 RUC broker proof：能打开真人登录上下文、读到受保护的会话摘要，
   但不把密码或 token 返回 renderer；捕获能力失败也在这一阶段响亮报告。
4. **P0-3（桌宠指针交互与 typed bridge 已落地，业务编排待实现）**：把快捷键、剪贴板、文件 drop
   和手动拖到窗口真正接入 fragment/run/receipt；捕获探针失败时立即可见。
5. **P0-4（代码与 smoke 已完成）**：实现 `/focus` 与 `/settings`；先用 fixture/mock broker 跑通页面、重启恢复、
   error copy，再接真实 RUC 登录，不让页面依赖未完成的网络接口。
6. **P0-5（代码与 12 个 RUC + 1 个 scheduler contract tests 已完成）**：实现离线 RUC adapter：先 portal + graduate 的 parser/normalizer/contract
   tests 和 structured mapper，再接 Electron broker；数据源失败不影响旧数据。
7. **接在线 RUC**：实现 persistent WebView、Cookie/localStorage harvest、手动
   redirect/bootstrap、single-flight refresh；每一步保留可导出的诊断摘要，不记录 secret。
8. **最后做 P1/P2 调查与加固**：本科、考试、系统日历、平台 native locator、
   WebGL fallback/性能/无障碍；任何一项不通过探针就保持显式 unsupported。

### 14. Still open（截至 2026-09-05）

- `quiet-pebble.html` 已获用户确认可作为直接产品设计源；后续只需继续维护 SHA 溯源和
  模块化提取，不再把“是否允许复用”作为阻塞项；
- 首发平台集合，以及各平台“按窗口 ID 截图 + 叠放顺序”的可用 native adapter；
- Electron 打包版本是否稳定提供所需的 `node:sqlite`/native module 能力；
- RUC 本科课表的真实数据 endpoint、考试/成绩 endpoint 和授权范围；
- 门户事件中课表、调课、考试的长期语义，以及由何种事实生成 `CalendarSchema`；
- 是否在 P2 接系统日历；这不能成为 P0 RUC 日程同步的隐式依赖。

这些问题未决时，代码应选择可删除的 adapter/fixture，不应把假设写进核心 schema 或
   UI 承诺。

### 15. 参考实现与规范

- 产品母设计：`docs/atlas/design/2026-09-05-product-form-and-main-window.md`；
- 旧骨架和进程边界：`docs/atlas/design/2026-09-05-starter-skeleton-and-stack.md`；
- RUCGO 实证版本：[commit 1a107ec](https://github.com/HuanCheng65/rucgo/tree/1a107ec1a8c0de63e88fd705f3d9220f724659cd)；
- Electron 窗口/透明、屏幕与捕获能力：
  [BrowserWindow](https://www.electronjs.org/docs/latest/api/browser-window)、
  [screen](https://www.electronjs.org/docs/latest/api/screen)、
  [desktopCapturer](https://www.electronjs.org/docs/latest/api/desktop-capturer)、
  [systemPreferences](https://www.electronjs.org/docs/latest/api/system-preferences)；
- Electron 安全边界：[security](https://www.electronjs.org/docs/latest/tutorial/security)、
  [context isolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation)、
  [safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)；
- Vite 多入口：[build / multi-page app](https://vite.dev/guide/build.html#multi-page-app)。

### 16. 本轮实现审计记录

- 远端 `origin/master` 在本轮从 `4df8e77` 推进到 `9ff614b`，已用 `git fetch --prune` +
  快进合并，再恢复并解决本地 B 变更；没有用 reset 覆盖任一方工作。
- 可重复验证：RUC contract tests `12/12`，连同 scheduler 为 `13/13`；B API smoke（schema v5、migration 相关表、
  settings revision/secret redaction、focus 幂等、unsupported sync）全绿；renderer
  focused TypeScript 与独立 pet Vite build 全绿；Electron main/preload 的 strict
  TypeScript（本机 ambient shim）与 esbuild bundle 全绿。
- 环境限制：当前工作环境没有可执行 Electron binary，且 npm registry DNS 为
  `ENOTFOUND`，所以没有把真实窗口截图、跨屏 DPI、在线 CAS/JWT 和完整 workspace
  `pnpm typecheck` 写成已通过。失败能力均保持显式状态，不用样例数据冒充在线结果。
