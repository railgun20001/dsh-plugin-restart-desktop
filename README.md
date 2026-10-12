# dsh-restart-desktop

DSH 桌面版（DeepSeek Harness Electron 壳）的**一键重启**插件：**保留窗口位置、大小与最大化状态**，可选在重启后**自动续上被打断的那一轮对话**。

三个入口，默认全开，可在插件设置页逐个关闭：

| 入口 | 位置 |
|---|---|
| **账号浮窗** | 侧栏底部账号浮窗里，**「退出登录」正下方** |
| **侧栏底部** | 侧栏底部、与「设置」同一行区域（官方给第三方插件的动作座位） |
| **设置 → 通用** | 「重启桌面版」一行 |

另外还注册了斜杠命令 `/restart-desktop`（有任务在跑时用 `/restart-desktop --force` 越过警告）。

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

`lib/geometry.ps1` 用 `GetWindowPlacement` 取 `rcNormalPosition`（**用户真正选定的那个矩形** —— 窗口最大化时当前矩形是最大化后的，只有它记录着要还原的尺寸）与 `showCmd`（常规 / 最小化 / 最大化），重启后用 `SetWindowPos` + `ShowWindow` 放回去，并**读回实际值**写进日志。

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

- 只处理**这次重启的发起会话**（客户端把它随重启请求一起交给宿主半），**绝不**扫描、唤醒别的历史会话；
- 只在**重启排程那一刻该会话确实在跑**时才标记为「被打断」—— 空闲会话被重启没有损失任何工作，不该凭空多发一条消息；
- 标记带 **5 分钟 TTL**：宿主要是在几分钟之后才起来（比如用户手动重开），就不再自动发消息；
- 标记在宿主启动时被**取走即删**，所以一次重启最多恢复一次，恢复失败也不会在下次启动时重放。

---

## 安装

```powershell
# 1) 确认插件目录
Test-Path C:\work\my\dsh\plugins\dsh-restart-desktop\index.js

# 2) 安装（link 方式：改代码即生效，不需要重新打包）
plugin_manager(action: "install_bundle", target: "link:C:\work\my\dsh\plugins\dsh-restart-desktop")
```

或用 DSH 的插件页 / `~/.dsh/profiles/desktop/package.json` 手工加：

```jsonc
// package.json
"dsh": { "profile": { "bundles": [ /* … */ "dsh-restart-desktop" ] } },
"dependencies": { "dsh-restart-desktop": "link:C:/work/my/dsh/plugins/dsh-restart-desktop" }
```

宿主半在 **DSH 下次启动时**加载；客户端半每次刷新页面重新取。两半版本不一致时，设置页里会显示宿主版本。

---

## 使用

- **账号浮窗**：点侧栏底部的账号行 → 菜单最下方「重启 DSH」。
- **侧栏底部**：和「设置」同一行区域的「重启 DSH」。
- **设置 → 通用**：「重启桌面版」一行。
- **斜杠命令**：`/restart-desktop`；有任务在跑时先警告一次，`/restart-desktop --force` 才是「我看过了」。

有任务在跑时**只警告、不硬拦**：第二次点击（且过了 900ms 冷却，避免双击等于忽略警告）才真的执行。硬拦会在 helper 卡住时把重启按钮永久锁死，而解除它恰恰需要重启应用。

### 设置页（设置 → 重启桌面版）

- 三个入口的开关（存在浏览器本地，改完立即生效）；
- **重启后还原窗口位置与大小**（默认开；关掉后重启回到应用默认的 1280×820）；
- **重启后自动续上被打断的那一轮对话**（默认开）；
- 事实展示：是不是桌面版、现在停掉会打断什么、**上一次重启到底成没成**、**上一次自动恢复到底成没成**、账号浮窗入口有没有注入成功。

### 排障

浏览器控制台里有 `globalThis.__DSH_RESTART_DESKTOP__`：

```js
__DSH_RESTART_DESKTOP__.status()      // 宿主状态快照
__DSH_RESTART_DESKTOP__.bridge()      // 账号浮窗桥的状态（injected / found / lastReason）
__DSH_RESTART_DESKTOP__.sweepMenu()   // 立刻重扫一次浮窗
__DSH_RESTART_DESKTOP__.entries()     // 三个入口的开关
```

宿主侧的交接记录在 `~/.dsh/restart-desktop/`：`handoff-*.json`、`restart-*.log`、`restart-*.result.json`、`restart-*.geometry.json`（保留最近 20 组）。

---

## 已知边界（写清楚，免得当成 bug）

- **正在跑的那一轮一定会断**，不会自动续跑；自动恢复发的是「说明现状 + 让模型判断」的消息，不是「重放那一轮」。
- **正在被工具写入的文件可能停在半路**。插件不做回滚。
- **后台任务 / 子 agent / teammate 全部被杀**；**定时任务在应用关闭期间不会触发**。
- **账号浮窗那一项靠观察 DOM**。官方没给第三方留「账号菜单项」座位（`settings.launcher` 是 single 座位，整块由 `@deepseek-ai/dsh-client-ui-settings-account` 渲染，菜单项写死在它的 `items` 数组里），所以只能等菜单出现、按文案（中英两套）认出它、再追加一个同款菜单项。**认不出来就什么都不做**（代价是浮窗里少一个入口，另外两个官方座位的入口照常）。它也不能用键盘上下键走到 —— `Menu` 的键盘遍历走的是它自己的 `items` 数组。
- **只支持 Windows 桌面版**。非桌面宿主（`dsh web` / headless）会明确拒绝并说明原因，绝不误杀进程。
- **窗口几何依赖 `rcNormalPosition`**：多显示器且各屏 DPI 不同时，工作区坐标与屏幕坐标可能不一致，此时还原结果可能偏移。日志里会记下「wanted / actual」，一眼能看出来。

---

## 验证情况

已经跑过的（全部通过）：

| 层 | 内容 |
|---|---|
| 单元（57 项） | 入口开关归一化、浮窗识别判据（中英、未登录、反例）、重启状态机（确认 / 警告冷却 / force / 失败重试）、宿主守卫判据、可信请求判定、交接目录清理、设置读写、恢复标记与恢复流程的每一条分支 |
| 客户端 bundle 冒烟 | 在 Node 里用假 `window` / `document` / React 真正执行 `lib/client.js`：factory 注册、`apply` 跑完、四个座位挂上、开关能关入口、`slots` 缺失时优雅退出 |
| 宿主挂载与路由 | 假 ctx 真 `apply` 一遍，按真实 HTTP 形状调路由：状态契约、403 / 404 / 409 / 500、设置写入、守卫先拦、`force=1` 才交接 |
| **端到端** | 临时编译一个 WinForms 靶子程序当「应用」，跑完 `lib/helper.mjs` 全链路：捕获几何（700×500 @ 300,200）→ 结束靶子主进程（确认日志里是 `/T` 之外的方式）→ 拉起新实例（靶子第二次启动刻意用默认几何 320×220 @ 20,20）→ **独立复核**新窗口实际几何逐像素等于重启前 |
| helper 启动方式 | 用真正的 `DeepSeek Harness.exe` + `ELECTRON_RUN_AS_NODE=1` + `detached` 跑一次最小脚本，证明这条启动路径确实能跑起来 |

**没有跑过的**（诚实说明）：没有真正重启过正在运行的 DSH —— 一跑就会杀掉当前会话。生产路径的每一段都被单独验证过，但「在本机完整重启一次 DSH」留给你第一次点按钮时完成。

复现：

```powershell
cd C:\work\my\dsh\plugins\dsh-restart-desktop
npm run check        # bundle 一致性 + 57 项单元测试
npm run test:e2e     # 端到端（需要 Windows 桌面会话，约 10 秒）
```

---

## 文件结构

```
index.js                 宿主半：路由、任务守卫、交接、启动后自动续接会话
lib/helper.mjs           分离 helper：重启的实际执行者
lib/geometry.ps1         Win32 窗口几何捕获 / 还原（刻意只用 ASCII）
lib/resume.mjs           重启后自动续上被打断会话（纯逻辑 + 服务缝）
src/client-core.js       客户端纯逻辑：开关归一化、浮窗识别判据、状态机
src/menu-bridge.js       账号浮窗 DOM 注入
src/client-main.js       客户端接线：三个入口 + 设置分区
lib/client.js            客户端 bundle（由 build/bundle.mjs 生成，不要手改）
build/bundle.mjs         客户端 bundle 构建（三源文件内联，无外部依赖）
test/                    单元 + 冒烟 + 端到端测试
```

## 卸载

```powershell
plugin_manager(action: "remove_bundle", target: "dsh-restart-desktop")
```

宿主侧状态在 `~/.dsh/restart-desktop/`，可以直接删；浏览器里的入口开关在 localStorage 的 `dsh-restart-desktop/*` 键下。
