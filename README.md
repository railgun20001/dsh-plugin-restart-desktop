# dsh-restart-desktop

DSH 桌面版（DeepSeek Harness Electron 壳）的**一键重启**插件：**保留窗口位置、大小、最大化状态与所在显示器**，可选在重启后**自动续上被打断的会话**（不只是你当前打开的那个）。

只有一个入口：**侧栏底部账号行右侧的图标按钮**（刷新图标）。**单击即重启** —— 没有二次确认，有任务在跑时也不要求再点一次（那一路实况只写进悬停提示）。插件不提供任何设置页配置。

| 入口 | 位置 |
|---|---|
| **账号行右侧图标** | 侧栏底部那一行账号（头像 + 昵称）的右边 |

账号行认不出来时（官方改了 DOM）会自动回落到官方给第三方插件的动作座位 `sidebar.footer.action`（侧栏底部同一行区域的图标按钮），功能不会凭空消失。

另外还注册了斜杠命令 `/restart-desktop`（一样单击即重启；这条路上的宿主侧警告仍需 `/restart-desktop --force` 越过）。

---

## 为什么需要这个插件

这不是「官方本来就有、只是藏得深」的功能，而是**官方没有留任何通道**。两条硬事实（都来自解包 `app.asar` 读主进程源码）：

1. **主进程没有暴露重启。** 完整 IPC 只有 `shutdown` / `quit-inspection` / `update-tasks`（主进程 → host）与 `ready` / `fatal` / `shutdown-complete` / `platform-session`（host → 主进程）；渲染进程侧的 `dshDesktop` API 只有 `browser` / `deviceInfo` / `keyboard` / `shortcuts` / `updates`。内置的「重启应用与 Host」菜单项**只在 development 分支里加入菜单**，打包版永远看不到；Windows 上托盘菜单只有「打开应用」和「退出」。
2. **窗口几何从不落盘。** `createWindow()` 硬编码 `width: 1280, height: 820`，主进程里没有 `getBounds` 保存、没有 window-state 存储，`%APPDATA%\@deepseek-ai\dsh-desktop\` 下也没有任何窗口状态文件。**正常退出再开一定回到 1280×820。**

还有一条容易踩的坑：**窗口的关闭按钮不会退出应用**（主进程 `preventDefault` + `hide`，只是收进托盘），所以「关掉再打开」这条最直觉的路并不成立。

所以插件只能自己动手：从宿主进程里派一个**分离的 helper**，由它结束 Electron 主进程、等端口释放、拉起新实例，再逐像素还原窗口。

---

## 它是怎么做的

```
DeepSeek Harness.exe            ← Electron 主进程：窗口、托盘、更新、spawn host
  └── DeepSeek Harness.exe      ← host 子进程（ELECTRON_RUN_AS_NODE=1），监听 127.0.0.1:19387
        └── 本插件的宿主半
              └── （分离）helper：node lib/helper.mjs handoff.json
```

1. **宿主半**校验目标是不是桌面宿主、把「现在停掉会打断什么」讲清楚、写一份交接描述，然后把 helper 拉起来。
2. **helper** 等 1.5 秒（让 HTTP 响应先送达页面）→ **趁主进程还活着**捕获窗口几何 → 结束 Electron 主进程 → 等主进程消失、等端口释放 → 拉起新实例 → 等新窗口出现 → 还原几何。

### 关键取舍：只杀主进程，**不带 `/T`**

主进程一死，host 子进程到它的 IPC 通道断开，host 里的 `process.once('disconnect')` 会走 `application.shutdown.shutdown(0)` —— 这和官方正常退出走的是**同一个 `stop()`**，会话日志因此正常落盘。带 `/T` 会把 host 一起强杀，那才是真的可能丢数据。

只有一种情况会碰到 host：端口在主进程消失后仍然不放（说明 host 卡住了）。那一步是最后手段，且会把「它的会话日志可能不完整」如实写进日志。

### 窗口几何

`lib/geometry.ps1` 用 `GetWindowPlacement` 取 `rcNormalPosition`（**用户真正选定的那个矩形** —— 窗口最大化时当前矩形是最大化后的，只有它记录着要还原的尺寸）、`showCmd`（常规 / 最小化 / 最大化），以及 `MonitorFromWindow` / `GetMonitorInfo`（**窗口在哪块显示器上**，例如 `\\.\DISPLAY2`），重启后用 `SetWindowPos` + `ShowWindow` 放回去，并**读回实际值**写进日志。

**最大化的窗口必须先把位置放回去，再最大化。** Windows 是在「窗口此刻所在的那块屏」上最大化的，而重新拉起的应用总是把窗口创建在主屏（笔记本屏）上 —— 所以对一个最大化的窗口直接 `ShowWindow(SW_MAXIMIZE)`，等于把住在副屏的窗口拽回笔记本屏。现在的顺序是：退出最大化 → `SetWindowPos` 到捕获到的正常矩形（它标记着用户当时在用哪块屏）→ 最大化。最小化同理：先放回那块屏再最小化，否则从任务栏还原时会弹到主屏。

还原后还会**读回窗口所在的显示器**并与捕获值比对，`wanted` / `actual` / `onTarget` 一并写进日志与结果文件。若目标屏仍在、窗口却落在别处（正常矩形跨两块屏时会发生），脚本会把它居中到目标屏再最大化一次，并在结果里标 `corrected: true`；目标屏已经拔掉时不做任何猜测，只如实报 `onTarget: false`。

> 这个脚本**必须保持 ASCII-only**：Windows PowerShell 5.1 对无 BOM 的 `-File` 脚本按 ANSI 解码，一句中文注释的字节被解码坏之后**可能连行尾换行一起吞掉**，下一行代码就整行变成注释（实测踩过：还原时静默拿不到目标显示器，`wanted` 变成 `null`）。`npm test` 里有一条断言把这条约束钉住。

---

## 调研结论：重启后能不能自动恢复对话

能，但形态不是「续跑那一轮」。结论分三层：

| 问题 | 结论 |
|---|---|
| 被打断的那一轮能续跑吗？ | **不能。** 主进程被结束、host 优雅关停，正在生成的那一轮就没了。官方自己的退出确认框也写「当前正在运行的任务将会中断」。 |
| 会话会丢吗？ | **不会。** 会话按工作区落盘（`session.v4.jsonl.zstd`），客户端还把「当前会话」持久化在 `dsh-app://app` 的 localStorage（`dsh.sessions.current`），重启后自动回到同一个会话，历史完整。 |
| 那「自动恢复对话」是什么？ | **把被打断的会话恢复成活 Agent，注入一条说明现状的恢复消息**，让模型自己判断哪些工具调用可以安全重试、哪些需要先核验外部状态。 |

实现走的是官方通道（源码级核对过）：

- `ctx.agents.resume({ resumeSessionId, setup })` —— 把持久化会话恢复成活 Agent。`setup` 会把会话原本的 agent preset 重新挂上，否则恢复出来的 Agent 会丢掉它那一整套工具（bash / read / goal …）；preset 解析不到时降级为「不带 preset 工具恢复」并记日志，而不是整个失败。
- `agent.followup(message)` —— 往收件箱排一条消息并唤醒驱动。官方 `dsh-headless` 与 `@deepseek-ai/dsh-goal-round-driver` 都走这两步。
- 消息的 `source.kind` 刻意**不是 `'user'`**：Chat 把 `source.kind === 'user'` 的用户消息渲染成用户气泡，其余 kind 渲染成「注入的上下文行」。用自定义 kind，这条自动消息在对话里长得像系统注入 —— 它确实是。

**副作用面被刻意收敛到最小**（自动发消息会真的花钱、真的跑模型）：

- 名单由**宿主自己在排程那一刻取实况**：agent 正在生成 / 跑工具、收件箱里有排队消息、或有正在跑的后台任务 —— 只接这些会话。刻意**不是**「你当前打开的那个会话」：在一个会话里挂着长任务、切到另一个会话点重启时，被打断的是后台那个；早先的实现把标记落在空闲的当前会话上，于是 `not-interrupted`，真正被打断的任务一条恢复消息都拿不到（上报现场就是这个形状）；
- agents / jobs 服务读不到、形状不认识、抛错时名单为空 —— 宁可一条都不恢复，也绝不凭猜测唤醒会话；
- 空闲会话与历史会话永不被唤醒；
- 标记带 **5 分钟 TTL**：宿主要是在几分钟之后才起来（比如用户手动重开），就不再自动发消息；
- 标记在宿主启动时被**取走即删**，所以一次重启最多恢复一次，恢复失败也不会在下次启动时重放；
- 一次重启可能接上多个会话，每个各发一条恢复消息；其中一个恢复失败不连累其余，失败原因逐个记进日志。

---

## 安装

**本机已经装好了**（`link:` 方式，装进 `desktop` profile）：

```powershell
plugin_manager(action: "install_bundle", target: "link:C:\work\my\dsh\plugins\dsh-restart-desktop")
```

安装后 DSH 的 HMR 会当场把两半挂上，**不需要重启**（实测：安装后宿主路由立即应答，客户端半的图标按钮立即出现在账号行右侧）。如果入口没出现，刷新一次页面即可。

在别的机器上装：

```jsonc
// ~/.dsh/profiles/desktop/package.json
"dsh": { "profile": { "bundles": [ /* … */ "dsh-restart-desktop" ] } },
"dependencies": { "dsh-restart-desktop": "link:C:/work/my/dsh/plugins/dsh-restart-desktop" }
```

正常情况下 HMR 会当场把两半挂上，不必重启。只有在没开 HMR 的组合里，宿主半才要等 **DSH 下次启动**；客户端半每次刷新页面重新取。两半版本不一致时，控制台 `__DSH_RESTART_DESKTOP__.status().version` 是宿主版本、`__DSH_RESTART_DESKTOP__.version` 是客户端版本。

---

## 使用

点侧栏底部**账号行右侧的刷新图标**：一次点击就排程重启 —— 窗口的位置、大小、最大化状态与所在显示器保留，被打断的会话按宿主实况自动续接；页面随后断开，应用重启并回到原来的样子。

**单击即重启意味着不拦你**：宿主守卫（有任务在跑 / 插件正在安装）不再要求第二次点击，只在按钮的悬停提示里说明「会打断它们」。斜杠命令那条路仍然保留一次警告（`/restart-desktop --force` 才是「我看过了」）。

### 配置

插件**没有设置页**，界面开关一个都不提供。两个宿主侧行为开关仍有默认值（都是开），需要时改插件 config 或宿主侧设置文件：

```jsonc
// ~/.dsh/profiles/desktop/package.json 里本插件那一行的 config
{ "geometry": true, "resume": true }   // 还原窗口几何 / 自动续接被打断的会话
```

宿主侧设置文件 `~/.dsh/restart-desktop/settings.json` 优先于 config；也可以 `POST /dsh-restart-desktop/api/settings?geometry=0&resume=0` 改。

### 排障

浏览器控制台里有 `globalThis.__DSH_RESTART_DESKTOP__`：

```js
__DSH_RESTART_DESKTOP__.status()      // 宿主状态快照
__DSH_RESTART_DESKTOP__.button()      // 账号行按钮的注入状态（found / injected / lastReason）
__DSH_RESTART_DESKTOP__.sweep()       // 立刻重扫一次账号行
__DSH_RESTART_DESKTOP__.action()      // 按钮此刻的动作状态
```

`button().lastReason` 的取值：`injected`（这一轮插进去了）、`already-present`（已经在位）、`no-account-row`（没找到账号行）、`insert-failed`、`no-document`（不是浏览器环境）。

宿主侧的交接记录在 `~/.dsh/restart-desktop/`：`handoff-*.json`、`restart-*.log`、`restart-*.result.json`、`restart-*.geometry.json`（保留最近 20 组）。几何结果文件里除了矩形，还有 `wanted` / `actual` / `onTarget` / `corrected`（显示器名与矩形），重启后窗口到底落在哪块屏一眼可见。

---

## 已知边界（写清楚，免得当成 bug）

- **正在跑的那一轮一定会断**，不会自动续跑；自动恢复发的是「说明现状 + 让模型判断」的消息，不是「重放那一轮」。
- **正在被工具写入的文件可能停在半路**。插件不做回滚。
- **后台任务 / 子 agent / teammate 全部被杀**；**定时任务在应用关闭期间不会触发**。
- **账号行右侧那个按钮靠观察 DOM**。官方没给第三方留「账号行里的按钮」座位（`sidebar.settings` 是 single 座位，整块由 `@deepseek-ai/dsh-client-ui-settings-account` 渲染），所以只能等它渲染出来、按官方写死的 `data-signed-out` + `aria-haspopup="menu"` 认出那个展开按钮，再顺它往上两层定位到账号行、把按钮插在账号行右边。判据里**没有一个哈希类名**（官方 CSS 模块类名每个构建都变）。**认不出来时不猜**：回落到官方 `sidebar.footer.action` 座位，日志与 `button().lastReason` 会写明原因。
- **侧栏收起时不显示这个按钮**：Windows 上官方本来就把整个底栏（账号行那一片）隐藏了。收起状态下用斜杠命令 `/restart-desktop`。
- **只支持 Windows 桌面版**。非桌面宿主（`dsh web` / headless）会明确拒绝并说明原因，绝不误杀进程。
- **窗口几何依赖 `rcNormalPosition` 与显示器本身**：还原记的是「哪块屏 + 哪个矩形」，比对靠显示器设备名（`\\.\DISPLAY2`）。**重启期间被拔掉或换掉的屏不会凭空回来** —— 此时窗口落在系统给的那块屏上，日志与结果文件里 `onTarget: false` 会直说（脚本不会往一个不存在的坐标上挪窗口）。各屏 DPI 不同时工作区坐标与屏幕坐标可能不一致，还原结果可能偏移（日志里有 wanted / actual）。

---

## 验证情况

已经跑过的（全部通过）：

| 层 | 内容 |
|---|---|
| 单元（`npm test`，本次 67 项） | 账号行触发按钮的识别判据（严格 / 宽松 / 反例）、重启状态机（单击即执行、busy·done 期间的点击被忽略、失败可重试、非桌面版禁用）、提示文案与颜色语气、当前会话 id 的解析、宿主守卫判据、「哪些会话真的在跑」的快照判据、可信请求判定、交接目录清理、设置读写、恢复标记（新旧两种形态、TTL、跳过）与多会话恢复流程的每一条分支、`lib/geometry.ps1` 的 ASCII-only 约束 |
| 客户端 bundle 冒烟 | 在 Node 里用假 `window` / `document` / React 真正执行 `lib/client.js`：factory 注册、`apply` 跑完、账号行已在时只挂提示浮层、账号行认不出来时观察期过后回落到官方座位、刷新后「已重启」提示被消费、诊断入口可用、`slots` 缺失时优雅退出 |
| **账号行图标按钮** | 用假 DOM 按**官方真实结构**（`footerActions` 下面的账号动作区 → `AccountMenu.root` → `Menu` 的 span → `button[data-signed-out][aria-haspopup="menu"]`）整条跑一遍注入桥：落点就在账号行右侧、幂等、`update()` 把忙碌/提示/禁用写进节点、被官方重渲染踢出去后下一轮插回来、认不出账号行时页面上不多出任何节点、`stop` 之后不再动 DOM。结构取自解包 `app.asar` 里的 `AccountMenu` / `Menu` / `ui-sidebar` 源码 |
| 宿主挂载与路由 | 假 ctx 真 `apply` 一遍，按真实 HTTP 形状调路由：状态契约、403 / 404 / 409 / 500、设置写入、守卫先拦、`force=1` 才交接（并核对写下的待恢复名单来自宿主实况，而不是请求里那个会话） |
| **端到端** | 临时编译一个 WinForms 靶子程序当「应用」，跑完 `lib/helper.mjs` 全链路：捕获几何（700×500 @ 300,200）→ 结束靶子主进程（确认日志里是 `/T` 之外的方式）→ 拉起新实例（靶子第二次启动刻意用默认几何 320×220 @ 20,20）→ **独立复核**新窗口实际几何逐像素等于重启前 |
| **多显示器（本机三块屏）** | 靶子第一次在副屏 `\\.\DISPLAY2` 上最大化 → 重新拉起的实例按默认几何落在主屏 `\\.\DISPLAY1` → helper 全链路还原 → **独立复核**窗口回到副屏、最大化矩形与重启前逐像素一致、结果里 `onTarget: true`；另一条用例手工构造「正常矩形与记录的显示器互相矛盾」的状态，验证纠偏分支（`corrected: true` / `onTarget: true`） |
| **复现上报缺陷（对照实验）** | 同一段靶子、同一个「副屏上最大化 → 重启」场景，分别用 git HEAD 的旧脚本与本次修复后的脚本跑一遍：**旧版落到主屏 `\\.\DISPLAY1`**（正是上报的「在左上屏，重启回到笔记本屏」），新版落回 `\\.\DISPLAY2`。另：17:14 那次真实重启的会话日志显示，被打断的是后台 `session-3f255a53`（`turn/end reason: interrupted`），而插件当时瞄准的是空闲的 `session-c5744114`（`last-resume.json` 写着 `not-interrupted`）—— 与修好的判据逐条对上 |
| helper 启动方式 | 用真正的 `DeepSeek Harness.exe` + `ELECTRON_RUN_AS_NODE=1` + `detached` 跑一次最小脚本，证明这条启动路径确实能跑起来 |
| **安装后的活体验证** | 插件安装到 `desktop` profile 后，DSH 的 HMR 当场把两半都挂上了（无需重启）：<br>• 宿主半路由 `GET /dsh-restart-desktop/api/status` 实测返回 `{"host":"dsh-restart-desktop","version":"0.1.0","desktop":true,...}`，守卫正确读到真实服务（`有任务在跑（4 项正在生成或运行工具、1 个后台任务在跑）`，12 个在挂会话）；<br>• 客户端半的注入落点在解包出来的官方源码里逐层核对过（上一行那条离线用例就是照它写的）。<br>**这一版（账号行图标按钮）还没有在真实窗口里目视确认过**：客户端半要刷新一次页面才会换上新 bundle，而刷新会打断正在进行的会话。第一次刷新后请看账号行右侧是否出现刷新图标，控制台 `__DSH_RESTART_DESKTOP__.button()` 会给出 `found` / `injected` / `lastReason`。 |

**没有跑过的**（诚实说明）：**修复后的版本还没有真正重启过一次正在运行的 DSH** —— 一跑就会杀掉当前会话。上面的对照实验与多显示器用例用的都是临时编译的靶子程序，生产路径的每一段都被单独验证过，但「在本机完整重启一次 DSH（新版）」以及「真的 resume 一个 Agent 并发出一条恢复消息」这两步，仍然留给你第一次点按钮时完成（`~/.dsh/restart-desktop/` 下的 `restart-*.log` 与 `last-resume.json` 会把结果如实记下来）。

复现：

```powershell
cd C:\work\my\dsh\plugins\dsh-restart-desktop
npm run check        # bundle 一致性 + npm test（本次 67 项）
npm run test:e2e     # 端到端（需要 Windows 桌面会话；多显示器那两条需要在多屏机器上跑，约 20 秒）
```

---

## 文件结构

```
index.js                 宿主半：路由、任务守卫、交接、启动后自动续接会话
lib/helper.mjs           分离 helper：重启的实际执行者
lib/geometry.ps1         Win32 窗口几何捕获 / 还原（刻意只用 ASCII）
lib/resume.mjs           重启后自动续上被打断会话（纯逻辑 + 服务缝）
src/client-core.js       客户端纯逻辑：账号行识别判据、重启状态机、提示文案
src/account-button.js    账号行右侧图标按钮的 DOM 注入
src/client-main.js       客户端接线：图标按钮 + 官方座位回落 + 提示浮层
lib/client.js            客户端 bundle（由 build/bundle.mjs 生成，不要手改）
build/bundle.mjs         客户端 bundle 构建（三源文件内联，无外部依赖）
test/fake-dom.mjs        假 DOM（客户端 DOM 注入的离线测试用）
test/                    单元 + 冒烟 + 端到端测试
```

## 卸载

```powershell
plugin_manager(action: "remove_bundle", target: "dsh-restart-desktop")
```

宿主侧状态在 `~/.dsh/restart-desktop/`，可以直接删；浏览器里只剩一个 `dsh-restart-desktop/pending-v1` 标记（重启完成后的一次性提示），一样可以直接删。
