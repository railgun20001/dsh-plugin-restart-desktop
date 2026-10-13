/**
 * dsh-restart-desktop —— 客户端 bundle（由 build/bundle.mjs 生成，请不要手改）
 *
 * 内联自：
 *   - src/client-core.js     纯逻辑：账号行识别判据、重启状态机、提示文案
 *   - src/account-button.js  账号行右侧图标按钮的 DOM 注入
 *   - src/client-main.js     接线：DSH 座位服务 → 图标按钮 + 官方座位回落 + 提示浮层
 *
 * 协议：DSH 客户端模块系统用 classic <script> 加载本文件，脚本执行时通过
 * window.__ModuleLoader__.load({ id, factory }) 注册工厂；工厂在首次
 * import/require 时物化，并作为 Cordis 插件激活（apply + inject）。
 */
window.__ModuleLoader__.load({
	id: "dsh-restart-desktop",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		/** 客户端半的构建版本；由 build/bundle.mjs 从 package.json 注入。 */
		const BUNDLE_VERSION = "0.2.0";

		//#region src/client-core.js
		/**
		 * dsh-restart-desktop —— 客户端半的纯逻辑层。
		 *
		 * 这里刻意不碰 DOM、不碰 React、不碰 fetch：重启动作的状态机、当前会话 id 的解析、
		 * 「哪个按钮是账号行触发按钮」的识别判据都放在这里，因此可以完全离线单测
		 * （见 test/client-core-test.mjs）。真正的接线在 src/client-main.js，
		 * 账号行右侧那个图标按钮的 DOM 注入在 src/account-button.js。
		 *
		 * 这一版的形态是刻意的简单：**只有一个入口**（侧栏底部账号行右侧的图标按钮），
		 * **单击即重启**（没有二次确认，也不因为「有任务在跑」要求再点一次）。
		 *
		 * @module dsh-restart-desktop/client-core
		 */

		/**
		 * 账号行触发按钮的两个判据。
		 *
		 * 侧栏底部那一行账号是官方 `@deepseek-ai/dsh-client-ui-settings-account` 的
		 * `AccountMenu` 渲染的：它的展开按钮由官方写死了 `aria-haspopup="menu"` 与
		 * `data-signed-out`（登录/未登录都会有这个属性，React 把布尔值渲染成 "true"/"false"）。
		 * 页面上 `aria-haspopup="menu"` 的按钮不止一个（模型选择器等），但 `data-signed-out`
		 * 只有账号行有 —— 两个条件同时成立才认，认错比漏认严重得多。
		 *
		 * 分两层是为了「官方改了其中一个属性」时还能认出来：
		 * 严格判据要求两个属性都在，宽松判据只要求 `data-signed-out`。
		 */

		/**
		 * 元素标签名是不是 button（大小写不敏感，兼容 HTML 与假 DOM）。
		 * @param {any} element 待判定的元素。
		 * @returns {boolean} 是 button 时为 true。
		 */
		function isButtonElement(element) {
		  return String(element?.tagName ?? '').toLowerCase() === 'button'
		}

		/**
		 * 宽松判据：这个按钮是不是账号行的那个（只看官方写死的 `data-signed-out`）。
		 * @param {any} element 待判定的元素。
		 * @returns {boolean} 是账号行触发按钮时为 true。
		 */
		function isAccountRowButton(element) {
		  if (element === null || element === undefined) return false
		  if (typeof element.getAttribute !== 'function') return false
		  if (!isButtonElement(element)) return false
		  return element.getAttribute('data-signed-out') !== null
		}

		/**
		 * 严格判据：宽松判据之外，还要求它带 `aria-haspopup="menu"`。
		 * @param {any} element 待判定的元素。
		 * @returns {boolean} 是账号行触发按钮时为 true。
		 */
		function isAccountTrigger(element) {
		  if (!isAccountRowButton(element)) return false
		  return element.getAttribute('aria-haspopup') === 'menu'
		}

		/**
		 * 从会话列表快照里解析「当前打开的那个会话」。
		 *
		 * 判据与侧栏一致：`retainedBy.mainView > 0` 的那一行就是主视图中的会话
		 * （`dsh-client-ui-workspace` 的 mainSessionId 同款）。宿主半用它来判断
		 * 「这次重启打断了谁」。
		 * @param {any} listState 会话列表快照。
		 * @returns {string | undefined} 会话 id。
		 */
		function currentSessionIdOf(listState) {
		  const byId = listState?.byId
		  if (byId === null || typeof byId !== 'object') return undefined
		  for (const id of Object.keys(byId)) {
		    const row = byId[id]
		    if (row !== null && typeof row === 'object' && (row.retainedBy?.mainView ?? 0) > 0) return id
		  }
		  return undefined
		}

		/**
		 * 兜底解析当前会话 id：客户端把「当前会话」持久化在 localStorage 的
		 * `dsh.sessions.current` 里（形状 `{"sessionId":"…"}`），服务不可用时读它。
		 * @param {string | null} raw localStorage 原文。
		 * @returns {string | undefined} 会话 id。
		 */
		function sessionIdFromStorage(raw) {
		  if (typeof raw !== 'string' || raw === '') return undefined
		  try {
		    const parsed = JSON.parse(raw)
		    const id = parsed?.sessionId
		    return typeof id === 'string' && id !== '' ? id : undefined
		  } catch {
		    return undefined
		  }
		}

		/**
		 * 重启动作的初始状态。
		 * @returns {{ phase: string, force: boolean, message: string, guardHint: string, desktop: boolean | null }} 初始状态。
		 */
		function createActionState() {
		  return {
		    phase: 'idle',
		    force: false,
		    message: '',
		    guardHint: '',
		    desktop: null,
		  }
		}

		/**
		 * 重启动作的状态机（纯函数）。
		 *
		 * 相位只有三条：`idle` → `busy` → `done` / `error`。**没有确认相位**：
		 * 一次点击就是一次重启请求（`force` 恒为 true，宿主半因此不会再拦一次）。
		 * 有任务在跑时只把 `guardHint` 写进提示文案（鼠标悬停能看到），不拦点击。
		 *
		 * 唯一会被忽略的点击是 `busy`（已经排程、页面即将断开）与 `done`
		 * （已排程，等页面重载）—— 那不是「要你再确认一次」，而是「这一枪已经打出去了」。
		 * @param {ReturnType<typeof createActionState>} state 当前状态。
		 * @param {{ type: string, [key: string]: any }} event 事件。
		 * @returns {ReturnType<typeof createActionState>} 新状态。
		 */
		function reduceAction(state, event) {
		  switch (event?.type) {
		    case 'status':
		      return {
		        ...state,
		        desktop: event.desktop === true ? true : event.desktop === false ? false : null,
		        guardHint: typeof event.guardHint === 'string' ? event.guardHint : '',
		      }
		    case 'press': {
		      if (state.phase === 'busy' || state.phase === 'done') return state
		      if (state.desktop === false) {
		        return { ...state, phase: 'error', force: false, message: '当前不是桌面版，这一项只在桌面应用里可用' }
		      }
		      return { ...state, phase: 'busy', force: true, message: '正在排程重启…' }
		    }
		    case 'result': {
		      if (event.ok === true) {
		        return { ...state, phase: 'done', force: false, message: typeof event.text === 'string' ? event.text : '已排程重启' }
		      }
		      return { ...state, phase: 'error', force: false, message: typeof event.text === 'string' ? event.text : '重启请求失败' }
		    }
		    case 'reset':
		      return { ...createActionState(), desktop: state.desktop, guardHint: state.guardHint }
		    default:
		      return state
		  }
		}

		/**
		 * 按钮的悬浮提示（图标按钮没有自己的文案位，说明只能挂在这里）。
		 *
		 * 三档：正在排程 / 失败原因 >「有任务在跑」的实况 > 默认说明。
		 * @param {ReturnType<typeof createActionState>} state 动作状态。
		 * @returns {string} 提示文案。
		 */
		function actionTitle(state) {
		  if (state.message !== '') return state.message
		  if (state.guardHint !== '') return `重启 DSH：${state.guardHint}；单击仍会重启并打断它们，重启后自动续接`
		  return '重启 DSH（保留窗口位置与大小）'
		}

		/**
		 * 按钮的 `aria-label`：图标按钮没有文字，状态要在这里说全。
		 * @param {ReturnType<typeof createActionState>} state 动作状态。
		 * @returns {string} 无障碍标签。
		 */
		function actionAriaLabel(state) {
		  if (state.desktop === false) return '重启桌面应用（仅在桌面版可用）'
		  if (state.phase === 'busy') return '正在排程重启桌面应用'
		  if (state.phase === 'done') return '已排程重启，页面即将断开'
		  if (state.phase === 'error') return '重启失败，单击重试'
		  return state.guardHint === ''
		    ? '重启桌面应用，保留窗口位置与大小'
		    : `重启桌面应用（${state.guardHint}，单击会打断它们）`
		}

		/**
		 * 按钮是否不可用。
		 * @param {ReturnType<typeof createActionState>} state 动作状态。
		 * @returns {boolean} 不可用时为 true。
		 */
		function actionDisabled(state) {
		  return state.phase === 'busy' || state.phase === 'done' || state.desktop === false
		}

		/**
		 * 图标与提示的颜色语气。
		 *
		 * 正常状态（含「有任务在跑」）一律用与侧栏文字同色的 `plain`：图标按钮不是告警灯，
		 * 那一路实况只进提示文案。只有请求失败才用 `error` 变色，因为那时必须让人看见。
		 * @param {ReturnType<typeof createActionState>} state 动作状态。
		 * @returns {'plain' | 'error'} 语气。
		 */
		function toneOf(state) {
		  if (state.phase === 'error') return 'error'
		  return 'plain'
		}

		//#region src/account-button.js
		/**
		 * dsh-restart-desktop —— 把「重启 DSH」做成账号行右侧的一个图标按钮（DOM 注入）。
		 *
		 * ## 为什么必须靠观察 DOM
		 *
		 * 侧栏底部那一行账号是 `@deepseek-ai/dsh-client-ui-settings-account` 的 `AccountMenu`
		 * 整体渲染进 `sidebar.settings` 这个 **single** 座位的（头像 + 昵称 + 一个 Menu 的展开
		 * 按钮），官方既没给第三方留「账号行里的按钮」座位，`Menu` 也不暴露扩展点。想在账号
		 * 右边放一个自己的按钮，只剩「等它出现 → 认出它 → 在它右边追加一个节点」这一条路。
		 *
		 * ## 落点怎么算（不依赖任何哈希类名）
		 *
		 * 官方 `Menu` 渲染出来的结构是：
		 *
		 *   div（账号动作区，侧栏底部的 sidebar.settings）
		 *     └── div（AccountMenu 的 root，flex:1）
		 *           └── span（Menu 的 root，宽度 100%）
		 *                 └── button（账号行：头像 + 昵称，官方写死 aria-haspopup / data-signed-out）
		 *
		 * 于是：**触发按钮 → 上两层 = 账号行根节点 → 再上一层 = 账号动作区**。我们的按钮插在
		 * 「账号行之后」，也就是账号右边的同一行；再靠 CSS 的 `order:1` 保证无论 DOM 顺序怎么变，
		 * 它永远排在账号行右侧。整条路径里没有任何类名、id 或层级数字假设 —— 官方的 CSS 模块
		 * 类名是构建期哈希，每个版本都变。
		 *
		 * ## 这条路的边界（写清楚，免得以后当成 bug）
		 *
		 * - **认不出来就什么都不做**，由 client-main 回落到官方 `sidebar.footer.action` 座位
		 *   （侧栏底部的图标按钮），所以官方改结构不会让这个功能彻底消失。
		 * - **只追加、不修改官方节点**：不动官方列表顺序、不改官方的 class/属性，菜单与账号行
		 *   自己重渲染时我们的节点不受影响。
		 * - **账号行没了它就不显示**：Windows 上侧栏收起时官方本来就把整个底栏隐藏
		 *   （`[data-windows-titlebar] .collapsed .footArea{display:none}`），此时改用斜杠命令。
		 *
		 * @module dsh-restart-desktop/account-button
		 */


		/** 标记属性：用于自检与测试定位。 */
		const BUTTON_MARKER = 'data-dsh-restart-desktop-button'

		/** 我们的按钮类名（样式由 client-main 注入的 CSS 提供）。 */
		const BUTTON_CLASS = 'dsrd-acct-btn'

		/** 默认图标：16 格描边的刷新箭头，跟随 `currentColor`。 */
		const DEFAULT_ICON_SVG = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M13.51 7.03A5.6 5.6 0 1 1 10.8 3.15"/><path d="M10.42 1.75L10.97 3.25L9.4 3.53"/></svg>'

		/** DOM 变动的合并窗口（毫秒）：一次重渲染只扫一遍。 */
		const DEFAULT_COALESCE_MS = 30

		/** 寻找触发按钮的两个查询，先严格后宽松。 */
		const TRIGGER_SELECTORS = ['button[aria-haspopup="menu"]', 'button[data-signed-out]']

		/**
		 * 启动账号行按钮的注入桥。
		 *
		 * `document` 与 `MutationObserver` 可以从外面注入，因此这个模块可以在没有浏览器的
		 * 环境里用假 DOM 单测（见 test/account-button-test.mjs）。
		 * @param {{ document?: any, MutationObserver?: any, iconHtml?: string, onActivate?: () => void, onHover?: () => void, onStatus?: (status: object) => void, coalesceMs?: number }} options 选项。
		 * @returns {{ stop: () => void, sweep: () => { found: number, injected: number }, status: () => object, update: (view: object) => void }} 句柄。
		 */
		function startAccountButtonBridge(options) {
		  const doc = options.document ?? (typeof document === 'undefined' ? undefined : document)
		  const Observer = options.MutationObserver ?? (typeof MutationObserver === 'undefined' ? undefined : MutationObserver)
		  const onActivate = options.onActivate
		  const onHover = options.onHover
		  const onStatus = options.onStatus
		  const iconHtml = typeof options.iconHtml === 'string' ? options.iconHtml : DEFAULT_ICON_SVG
		  const coalesceMs = Number.isFinite(options.coalesceMs) ? Number(options.coalesceMs) : DEFAULT_COALESCE_MS

		  let observer = null
		  let timer = null
		  let stopped = false
		  /** 我们注入的那一个按钮节点（只创建一次，之后只挪位置）。 */
		  let node = null
		  /** 最近一次 `update()` 给的视图；节点还没建出来时先存着。 */
		  let view = { busy: false, tone: 'plain', disabled: false, title: '', ariaLabel: '' }
		  const state = {
		    supported: doc !== undefined && typeof doc.querySelectorAll === 'function',
		    found: 0,
		    injected: 0,
		    lastReason: 'not-scanned',
		  }

		  /** 把状态播报出去（诊断 + 回落决策用），失败不影响桥本身。 */
		  const publish = () => {
		    if (typeof onStatus !== 'function') return
		    try {
		      onStatus({ ...state })
		    } catch {
		      /* 诊断回调失败不该影响注入 */
		    }
		  }

		  /**
		   * 按选择器收集候选元素；选择器不被假 DOM 支持时当作没有。
		   * @param {string} selector CSS 选择器。
		   * @returns {any[]} 候选元素数组。
		   */
		  const collect = (selector) => {
		    try {
		      return Array.from(doc.querySelectorAll(selector) ?? [])
		    } catch {
		      return []
		    }
		  }

		  /**
		   * 找账号行的展开按钮：先按「aria-haspopup + data-signed-out」找，找不到再只认后者。
		   * @returns {any | null} 触发按钮，或 null。
		   */
		  const findTrigger = () => {
		    for (const candidate of collect(TRIGGER_SELECTORS[0])) if (isAccountTrigger(candidate)) return candidate
		    for (const candidate of collect(TRIGGER_SELECTORS[1])) if (isAccountRowButton(candidate)) return candidate
		    return null
		  }

		  /**
		   * 由触发按钮反推「账号行根节点」与「账号动作区」。
		   * @param {any} trigger 账号行触发按钮。
		   * @returns {{ accountRoot: any, area: any } | null} 落点，或 null（结构不认识）。
		   */
		  const locate = (trigger) => {
		    const menuRoot = trigger?.parentElement
		    const accountRoot = menuRoot?.parentElement
		    const area = accountRoot?.parentElement
		    if (area === null || area === undefined) return null
		    if (typeof area.insertBefore !== 'function') return null
		    return { accountRoot, area }
		  }

		  /** 把最近一次视图写进节点属性。 */
		  const applyView = () => {
		    if (node === null) return
		    node.setAttribute('data-busy', view.busy === true ? '1' : '0')
		    node.setAttribute('data-tone', view.tone)
		    node.setAttribute('title', view.title)
		    node.setAttribute('aria-label', view.ariaLabel)
		    try {
		      node.disabled = view.disabled === true
		    } catch {
		      /* 假 DOM / 只读属性：忽略 */
		    }
		  }

		  /** 创建我们那一个按钮节点（只创建一次）。 */
		  const ensureNode = () => {
		    if (node !== null) return node
		    let button
		    try {
		      button = doc.createElement('button')
		    } catch {
		      return null
		    }
		    button.type = 'button'
		    button.className = BUTTON_CLASS
		    button.setAttribute(BUTTON_MARKER, '1')
		    button.innerHTML = iconHtml
		    button.addEventListener('click', () => {
		      try {
		        onActivate?.()
		      } catch {
		        /* 动作失败由入口自己的状态机表达 */
		      }
		    })
		    // 悬停时让调用方去刷新一次宿主状态：提示文案里的「有任务在跑」因此是实时的。
		    button.addEventListener('pointerenter', () => {
		      try {
		        onHover?.()
		      } catch {
		        /* 刷新失败不影响按钮本身 */
		      }
		    })
		    node = button
		    applyView()
		    return node
		  }

		  /**
		   * 扫一遍页面，把按钮放到账号行右侧。
		   * @returns {{ found: number, injected: number }} 本轮结果（`injected` 是「这一轮插进去了」）。
		   */
		  const sweep = () => {
		    if (stopped || !state.supported) return { found: 0, injected: 0 }
		    // 节点还在页面里就是「注入着」—— 认不出账号行不代表我们的按钮被拿掉了。
		    const connected = () => (node !== null && node.isConnected === true ? 1 : 0)
		    const trigger = findTrigger()
		    if (trigger === null) {
		      state.found = 0
		      state.injected = connected()
		      state.lastReason = 'no-account-row'
		      publish()
		      return { found: 0, injected: 0 }
		    }
		    const place = locate(trigger)
		    if (place === null) {
		      state.found = 0
		      state.injected = connected()
		      state.lastReason = 'no-anchor'
		      publish()
		      return { found: 0, injected: 0 }
		    }
		    state.found = 1
		    const target = ensureNode()
		    if (target === null) {
		      state.injected = 0
		      state.lastReason = 'create-failed'
		      publish()
		      return { found: 1, injected: 0 }
		    }
		    // 已经被官方重渲染踢出来、或账号行换了个容器：重新插一次。
		    const moved = target.isConnected !== true || target.parentNode !== place.area
		    if (moved) {
		      try {
		        place.area.insertBefore(target, place.accountRoot.nextSibling ?? null)
		      } catch {
		        /* 下一轮再试；插不进去时状态如实报 0 */
		      }
		    }
		    const injected = target.isConnected === true ? 1 : 0
		    state.injected = injected
		    state.lastReason = injected === 0 ? 'insert-failed' : moved ? 'injected' : 'already-present'
		    publish()
		    return { found: 1, injected: injected === 1 && moved ? 1 : 0 }
		  }

		  /** 合并一串 DOM 变动，只扫一次。 */
		  const schedule = () => {
		    if (stopped || timer !== null) return
		    timer = setTimeout(() => {
		      timer = null
		      sweep()
		    }, coalesceMs)
		    timer?.unref?.()
		  }

		  if (state.supported) {
		    sweep()
		    if (typeof Observer === 'function') {
		      try {
		        observer = new Observer(schedule)
		        observer.observe(doc.body ?? doc.documentElement, { childList: true, subtree: true })
		      } catch {
		        observer = null
		      }
		    }
		  } else {
		    state.lastReason = 'no-document'
		    publish()
		  }

		  return {
		    stop() {
		      stopped = true
		      if (timer !== null) {
		        clearTimeout(timer)
		        timer = null
		      }
		      try {
		        observer?.disconnect?.()
		      } catch {
		        /* 断开失败无所谓：页面正在卸载 */
		      }
		      observer = null
		      try {
		        node?.remove?.()
		      } catch {
		        /* 移除失败无所谓：页面正在卸载 */
		      }
		      node = null
		      state.injected = 0
		    },
		    sweep,
		    status() {
		      return { ...state }
		    },
		    /**
		     * 更新按钮的状态（忙碌 / 语气 / 提示 / 禁用）。
		     * @param {{ busy?: boolean, tone?: string, disabled?: boolean, title?: string, ariaLabel?: string }} next 新视图。
		     */
		    update(next) {
		      if (next === null || typeof next !== 'object') return
		      view = {
		        busy: next.busy === true,
		        tone: typeof next.tone === 'string' && next.tone !== '' ? next.tone : 'plain',
		        disabled: next.disabled === true,
		        title: typeof next.title === 'string' ? next.title : '',
		        ariaLabel: typeof next.ariaLabel === 'string' ? next.ariaLabel : '',
		      }
		      applyView()
		    },
		  }
		}

		//#region src/client-main.js
		/**
		 * dsh-restart-desktop —— 客户端半（浏览器 bundle 的 factory 体）。
		 *
		 * 这一版只有**一个入口**：侧栏底部账号行右侧的图标按钮（`src/account-button.js`
		 * 把它注入进官方的账号行）。**单击即重启**：没有二次确认，也不因为「有任务在跑」
		 * 要求再点一次 —— 那个实况只体现在按钮的提示文案与图标语气上。
		 *
		 * 官方座位只留一个用途：账号行认不出来时，回落到 `sidebar.footer.action`
		 * （侧栏底部的官方动作座位），用一个图标按钮顶上，免得官方改 DOM 之后这个功能
		 * 彻底消失。除此之外不再注册任何设置页 / 浮窗入口，也不再有任何本机开关。
		 *
		 * 刻意不依赖 `@deepseek-ai/dsh-client-ui-primitives`：界面全部由本插件的 CSS
		 * （数值取自官方 token 与官方组件）画出来，少一个包就少一类「官方改版导致整个客户端半
		 * 加载失败」的失败形态。
		 *
		 * @module dsh-restart-desktop/client
		 */



		const React = require('react')

		/** 插件 id（与 package.json 的 name 一致）。 */
		const PLUGIN_ID = 'dsh-restart-desktop'

		/** 宿主半的路由。客户端用**文档相对**路径：桌面端页面是 `dsh-app://app/`，
		 * 其非静态路径会被 shell 同源转发到宿主；Web 端页面带 `<base href="./">`，
		 * 相对路径能正确落在部署前缀下。 */
		const STATUS_ROUTE = `${PLUGIN_ID}/api/status`
		const RESTART_ROUTE = `${PLUGIN_ID}/api/restart`

		/** localStorage 键（带版本后缀：形状变化时换键即自动丢弃旧数据）。 */
		const PENDING_KEY = `${PLUGIN_ID}/pending-v1`

		/** 只有两个官方座位：账号行认不出来时的回落入口，以及提示浮层。 */
		const SIDEBAR_FOOTER_SLOT = 'sidebar.footer.action'
		const OVERLAY_SLOT = 'shell.overlay'

		/** 本插件在座位里用的 id。 */
		const SLOT_ID = PLUGIN_ID

		/** 硬依赖：没有座位服务就没有回落入口与提示浮层。 */
		const inject = ['slots']

		/**
		 * 账号行注入的观察期（毫秒）：这段时间内没注入成功，就挂上官方座位的回落入口。
		 * 官方账号行是首屏渲染出来的，正常情况下远快于这个时间；等待只是为了避免
		 * 「回落入口闪一下又消失」。
		 */
		const FALLBACK_GRACE_MS = 800

		/** 提示浮层显示多久（毫秒）。 */
		const NOTICE_MS = 8_000

		/** 自己的样式。数值逐字取自官方 token 与官方组件。 */
		const CSS = [
		  // ── 账号行右侧的图标按钮 ──
		  // 落点是官方「账号动作区」里的账号行子节点；用 :has() 把那一层变成一行 flex，
		  // 于是账号行（flex:1）自己让位，我们的按钮贴在它右边。类名/层级都不写死。
		  `div:has(> .dsrd-acct-btn){display:flex;flex-direction:row;align-items:center;gap:2px}`,
		  `.dsrd-acct-btn{box-sizing:border-box;order:1;flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;margin-left:2px;padding:0;border:none;border-radius:8px;cursor:pointer;color:var(--dsw-alias-label-primary,inherit);background:0 0}`,
		  `.dsrd-acct-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.18))}`,
		  `.dsrd-acct-btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,rgba(77,107,254,.75));outline-offset:2px}`,
		  `.dsrd-acct-btn:disabled{opacity:.4;cursor:not-allowed;background:0 0}`,
		  // 侧栏收起（轨道模式）时不显示：宽度只够一行账号，塞不下第二个控件。
		  // Windows 上官方本来就把整个底栏隐藏了，这条对 macOS 的轨道同样适用。
		  `[data-sidebar-collapsed] .dsrd-acct-btn{display:none}`,
		  // ── 官方座位的回落入口（账号行认不出来时才挂）──
		  `.dsrd-foot{box-sizing:border-box;flex:none;display:flex;justify-content:flex-end;width:100%;height:36px;margin:0}`,
		  `.dsrd-foot-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:none;border-radius:8px;cursor:pointer;font:inherit;color:var(--dsw-alias-label-primary,inherit);background:0 0}`,
		  `.dsrd-foot-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.18))}`,
		  `.dsrd-foot-btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,rgba(77,107,254,.75));outline-offset:2px}`,
		  `.dsrd-foot-btn:disabled{opacity:.4;cursor:not-allowed;background:0 0}`,
		  `.dsrd-foot[data-rail=1]{justify-content:center;width:36px;height:36px}`,
		  // ── 状态语气与忙碌动画（只有失败才变色，其余时候与侧栏文字同色）──
		  `[data-tone=error]{color:var(--dsw-alias-state-error-primary,#f85149)}`,
		  `[data-busy=1] svg{transform-origin:center;animation:dsrd-spin 1s linear infinite}`,
		  `@keyframes dsrd-spin{to{transform:rotate(360deg)}}`,
		  `@media (prefers-reduced-motion:reduce){[data-busy=1] svg{animation:none}}`,
		  // ── 排程结果 / 失败原因的浮层提示 ──
		  `.dsrd-toast{position:fixed;left:50%;bottom:32px;transform:translateX(-50%);z-index:60;box-sizing:border-box;max-width:min(520px,90vw);padding:10px 14px;border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-elevated,rgba(32,32,36,.96));color:var(--dsw-alias-label-primary,#fff);box-shadow:0 6px 24px rgba(0,0,0,.28);font-size:13px;line-height:20px}`,
		].join('')

		/** 注入一次样式；标签带插件名，别的插件不会撞车。 */
		const CSS_TAG_ID = `${PLUGIN_ID}/Client.module.css`
		if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css=${JSON.stringify(CSS_TAG_ID)}]`) === null) {
		  const tag = document.createElement('style')
		  tag.dataset.plugin = PLUGIN_ID
		  tag.dataset.pluginCss = CSS_TAG_ID
		  tag.textContent = CSS
		  document.head.appendChild(tag)
		}

		/**
		 * 刷新图标：16 格描边的刷新箭头（与注入进账号行的那一个同款，
		 * `account-button.js` 里是同一段 SVG 字符串）。
		 * @param {number} size 边长。
		 * @returns {object} React 元素。
		 */
		function Glyph(size) {
		  return React.createElement('svg', {
		    width: String(size),
		    height: String(size),
		    viewBox: '0 0 16 16',
		    fill: 'none',
		    stroke: 'currentColor',
		    strokeWidth: '1.2',
		    strokeLinecap: 'round',
		    'aria-hidden': 'true',
		    focusable: 'false',
		  },
		  React.createElement('path', { d: 'M13.51 7.03A5.6 5.6 0 1 1 10.8 3.15' }),
		  React.createElement('path', { d: 'M10.42 1.75L10.97 3.25L9.4 3.53' }))
		}

		/** 读 localStorage 里的 JSON；任何异常都回落到默认值。 */
		function readJson(key, fallback) {
		  try {
		    if (typeof localStorage === 'undefined') return fallback
		    const raw = localStorage.getItem(key)
		    if (raw === null || raw === '') return fallback
		    const value = JSON.parse(raw)
		    return value === null || value === undefined ? fallback : value
		  } catch {
		    return fallback
		  }
		}

		/** 写 localStorage 里的 JSON；配额/隐私模式导致的失败只记日志。 */
		function writeJson(key, value) {
		  try {
		    if (typeof localStorage === 'undefined') return
		    localStorage.setItem(key, JSON.stringify(value))
		  } catch (error) {
		    console.warn(`[${PLUGIN_ID}] 写入 ${key} 失败`, error)
		  }
		}

		/** 删一个 localStorage 键。 */
		function removeKey(key) {
		  try {
		    if (typeof localStorage !== 'undefined') localStorage.removeItem(key)
		  } catch {
		    /* 删不掉无所谓 */
		  }
		}

		/**
		 * 一个极小的可订阅状态容器，供 React 读取。
		 * @param {any} initial 初始值。
		 * @returns {{ getSnapshot: () => any, subscribe: (listener: () => void) => () => void, set: (next: any) => void }} 容器。
		 */
		function createStore(initial) {
		  let state = initial
		  const listeners = new Set()
		  return {
		    getSnapshot: () => state,
		    subscribe(listener) {
		      listeners.add(listener)
		      return () => { listeners.delete(listener) }
		    },
		    set(next) {
		      if (next === state) return
		      state = next
		      for (const listener of [...listeners]) {
		        try {
		          listener()
		        } catch {
		          /* 单个订阅者出错不影响其他订阅者 */
		        }
		      }
		    },
		  }
		}

		/** 用 React 18 的 `useSyncExternalStore`；老版本退化成 useState + useEffect。 */
		const useStore = typeof React.useSyncExternalStore === 'function'
		  ? (store) => React.useSyncExternalStore(store.subscribe, store.getSnapshot)
		  : (store) => {
		    const [value, setValue] = React.useState(store.getSnapshot)
		    React.useEffect(() => store.subscribe(() => { setValue(store.getSnapshot()) }), [store])
		    return value
		  }

		/** 应用 Cordis 客户端插件。 */
		function apply(ctx) {
		  const slots = typeof ctx.get === 'function' ? ctx.get('slots') : undefined
		  if (slots === undefined || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
		    console.warn(`[${PLUGIN_ID}] 客户端半没有拿到 slots 服务，界面入口全部跳过`)
		    return
		  }

		  // ---- 本机状态 -----------------------------------------------------------
		  const actionStore = createStore(createActionState())
		  const statusStore = createStore(null)
		  const noticeStore = createStore(null)
		  const buttonStore = createStore({ supported: false, found: 0, injected: 0, lastReason: 'not-started' })

		  /** 已经撤过：页面卸载后宿主状态不再覆盖按钮。 */
		  let disposed = false
		  /** 提示浮层的定时器。 */
		  let noticeTimer = null

		  /**
		   * 显示一条浮层提示（排程结果 / 失败原因 / 重启完成）。
		   * @param {string} text 内容。
		   */
		  const showNotice = (text) => {
		    noticeStore.set(text)
		    if (noticeTimer !== null) clearTimeout(noticeTimer)
		    noticeTimer = setTimeout(() => {
		      noticeTimer = null
		      noticeStore.set(null)
		    }, NOTICE_MS)
		    noticeTimer?.unref?.()
		  }

		  /**
		   * 当前打开的会话 id：优先问受支持的会话列表服务，退路是客户端自己持久化的
		   * `dsh.sessions.current`。宿主半只用它来判断「这次重启打断了谁」。
		   *
		   * 退路扫一遍 localStorage 而不是只读一个固定键：键名带不带前缀是客户端内部约定，
		   * 不该成为「自动续接失效」的原因。两条都拿不到就返回 undefined —— 那时宿主半
		   * 不写恢复标记，窗口几何照样还原，只是不会自动发恢复消息。
		   * @returns {string | undefined} 会话 id。
		   */
		  const currentSessionId = () => {
		    try {
		      const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
		      const fromService = currentSessionIdOf(sessions?.list?.getSnapshot?.())
		      if (fromService !== undefined) return fromService
		    } catch {
		      /* 服务形状不认识：走退路 */
		    }
		    try {
		      if (typeof localStorage === 'undefined') return undefined
		      const direct = sessionIdFromStorage(localStorage.getItem('dsh.sessions.current'))
		      if (direct !== undefined) return direct
		      for (let index = 0; index < localStorage.length; index += 1) {
		        const key = localStorage.key(index)
		        if (typeof key === 'string' && /sessions\.current$/u.test(key)) {
		          const found = sessionIdFromStorage(localStorage.getItem(key))
		          if (found !== undefined) return found
		        }
		      }
		      return undefined
		    } catch {
		      return undefined
		    }
		  }

		  /**
		   * 问一次宿主状态（是不是桌面版、现在有多少活在跑、上次重启/上次恢复的结果）。
		   * 按钮的提示文案读它，所以鼠标悬停时会再问一次，免得提示里说的实况早已过期。
		   */
		  const refreshStatus = async () => {
		    if (typeof fetch !== 'function') return
		    try {
		      const response = await fetch(STATUS_ROUTE, { method: 'GET' })
		      const body = await response.json().catch(() => null)
		      if (disposed || body === null || typeof body !== 'object') return
		      statusStore.set(body)
		      const reasons = Array.isArray(body.guard?.reasons) ? body.guard.reasons : []
		      actionStore.set(reduceAction(actionStore.getSnapshot(), {
		        type: 'status',
		        desktop: body.desktop === true,
		        guardHint: reasons.join('；'),
		      }))
		    } catch (error) {
		      console.warn(`[${PLUGIN_ID}] 读取宿主状态失败`, error)
		    }
		  }

		  /**
		   * 请宿主排程一次重启。
		   *
		   * 单击即执行：请求固定带 `?force=1`，宿主半因此不会再拦一次 —— 「有任务在跑」
		   * 只体现在悬停提示上，不再是需要点两次的门槛。`session` 也走查询参数，因为桌面壳
		   * 转发页面 fetch 时只保证 URL 与头部到达。
		   * @returns {Promise<void>} 完成。
		   */
		  const requestRestart = async () => {
		    const sessionId = currentSessionId()
		    const params = new URLSearchParams()
		    if (typeof sessionId === 'string' && sessionId !== '') params.set('session', sessionId)
		    params.set('force', '1')
		    let response
		    try {
		      response = await fetch(`${RESTART_ROUTE}?${params.toString()}`, { method: 'POST' })
		    } catch (error) {
		      const text = `重启请求失败：${String((error && error.message) || error)}`
		      actionStore.set(reduceAction(actionStore.getSnapshot(), { type: 'result', ok: false, text }))
		      showNotice(text)
		      return
		    }
		    const body = await response.json().catch(() => null)
		    if (response.ok && body?.ok === true) {
		      // 记一笔本机标记：页面重新加载后据此提示「重启完成」。
		      writeJson(PENDING_KEY, { at: Date.now(), sessionId: sessionId ?? null })
		      actionStore.set(reduceAction(actionStore.getSnapshot(), {
		        type: 'result',
		        ok: true,
		        text: '已排程重启：窗口即将关闭，随后自动打开并还原到原来的位置与大小。',
		      }))
		      return
		    }
		    const text = String(body?.error ?? `HTTP ${String(response.status)}`)
		    actionStore.set(reduceAction(actionStore.getSnapshot(), { type: 'result', ok: false, text }))
		    showNotice(text)
		  }

		  /** 按一次按钮：立即进入 busy 并发出重启请求；busy / done 期间的重复点击被忽略。 */
		  const press = () => {
		    const next = reduceAction(actionStore.getSnapshot(), { type: 'press' })
		    actionStore.set(next)
		    if (next.phase === 'busy') void requestRestart()
		  }

		  /** 把动作状态翻译成图标按钮的视图（样式与提示都由它决定）。 */
		  const viewOf = (action) => ({
		    busy: action.phase === 'busy',
		    tone: toneOf(action),
		    disabled: actionDisabled(action),
		    title: actionTitle(action),
		    ariaLabel: actionAriaLabel(action),
		  })

		  /** 按钮共用的动作状态。 */
		  const useAction = () => useStore(actionStore)

		  /** 重启完成 / 失败原因的浮层提示。 */
		  function RestartNotice() {
		    const notice = useStore(noticeStore)
		    if (notice === null) return null
		    return React.createElement('div', { className: 'dsrd-toast', role: 'status' }, notice)
		  }

		  /**
		   * 官方座位的回落入口：账号行认不出来时才挂上，形态与注入的那一个一致
		   * （图标按钮，单击即重启）。
		   */
		  function FallbackRestartButton(props) {
		    const action = useAction()
		    const wide = !(props !== null && props !== undefined && props.wide === false)
		    return React.createElement('div', { className: 'dsrd-foot', 'data-rail': wide ? '0' : '1' },
		      React.createElement('button', {
		        type: 'button',
		        className: 'dsrd-foot-btn',
		        'data-busy': action.phase === 'busy' ? '1' : '0',
		        'data-tone': toneOf(action),
		        disabled: actionDisabled(action),
		        title: actionTitle(action),
		        'aria-label': actionAriaLabel(action),
		        onClick: press,
		      }, Glyph(16)))
		  }

		  // ---- 注入账号行按钮 + 官方座位回落 ---------------------------------------

		  /** 官方座位回落入口的 disposer。 */
		  let fallbackDisposer = null
		  let fallbackVisible = false
		  /** 观察期是否已经过去（过去之前不挂回落入口，避免闪一下又消失）。 */
		  let graceElapsed = false

		  /**
		   * 挂上 / 撤掉官方座位的回落入口。
		   * @param {boolean} visible 是否要显示回落入口。
		   */
		  const setFallback = (visible) => {
		    if (visible === fallbackVisible) return
		    fallbackVisible = visible
		    if (!visible) {
		      try {
		        fallbackDisposer?.()
		      } catch {
		        /* 已经撤掉了 */
		      }
		      fallbackDisposer = null
		      return
		    }
		    try {
		      fallbackDisposer = slots.inject(SIDEBAR_FOOTER_SLOT, () => slots.register({
		        name: SIDEBAR_FOOTER_SLOT,
		        id: SLOT_ID,
		        order: 100,
		        label: '重启 DSH',
		      }, FallbackRestartButton)) ?? null
		      const line = `[${PLUGIN_ID}] 没能在账号行右侧注入按钮（${buttonStore.getSnapshot().lastReason}），改用侧栏底部的官方座位`
		      if (typeof ctx.logger?.warn === 'function') ctx.logger.warn(line)
		      else console.warn(line)
		    } catch (error) {
		      console.error(`[${PLUGIN_ID}] 注册回落入口失败`, error)
		    }
		  }

		  const accountButton = startAccountButtonBridge({
		    onActivate: press,
		    // 悬停时问一次宿主：提示里的「有任务在跑」因此是实时的，而不是首页那一次的旧快照。
		    onHover: () => { void refreshStatus() },
		    onStatus: (status) => {
		      buttonStore.set(status)
		      setFallback(graceElapsed && status.injected === 0)
		    },
		  })

		  // 按钮的视图跟着动作状态走：忙碌转圈、提示文案（以及失败时的变色）都在这里更新。
		  const syncButton = () => accountButton.update(viewOf(actionStore.getSnapshot()))
		  actionStore.subscribe(syncButton)
		  syncButton()

		  const graceTimer = setTimeout(() => {
		    graceElapsed = true
		    setFallback(buttonStore.getSnapshot().injected === 0)
		  }, FALLBACK_GRACE_MS)
		  graceTimer?.unref?.()

		  // 提示浮层走官方 shell.overlay 座位。
		  ctx.effect(() => slots.inject(OVERLAY_SLOT, () => slots.register({
		    name: OVERLAY_SLOT,
		    id: SLOT_ID,
		    order: 90,
		    label: () => '重启提示',
		  }, RestartNotice)))

		  ctx.effect(() => () => {
		    disposed = true
		    if (noticeTimer !== null) clearTimeout(noticeTimer)
		    clearTimeout(graceTimer)
		    accountButton.stop()
		    try {
		      fallbackDisposer?.()
		    } catch {
		      /* 已经撤掉了 */
		    }
		    fallbackDisposer = null
		  })

		  // 页面重新加载过 = 上一次排程的重启应该已经发生：提示一次。
		  const pending = readJson(PENDING_KEY, null)
		  if (pending !== null) {
		    removeKey(PENDING_KEY)
		    showNotice('桌面版已重启，窗口位置与大小已按重启前还原。')
		  }

		  void refreshStatus()

		  ctx.logger?.info?.(`[${PLUGIN_ID}] 客户端半 v${BUNDLE_VERSION} 已启动：账号行图标按钮 + 官方座位回落`)

		  // ---- 诊断入口（排障与端到端验证用）--------------------------------------
		  try {
		    globalThis.__DSH_RESTART_DESKTOP__ = {
		      version: BUNDLE_VERSION,
		      status: () => statusStore.getSnapshot(),
		      action: () => ({ ...actionStore.getSnapshot() }),
		      button: () => accountButton.status(),
		      sweep: () => accountButton.sweep(),
		      refreshStatus,
		      press,
		      restart: () => requestRestart(),
		    }
		  } catch {
		    /* 只读全局对象等极端环境下放弃暴露诊断入口 */
		  }
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
