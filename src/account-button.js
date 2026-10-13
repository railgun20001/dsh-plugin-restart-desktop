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

import { isAccountRowButton, isAccountTrigger } from './client-core.js'

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

export { startAccountButtonBridge, BUTTON_MARKER, BUTTON_CLASS, DEFAULT_ICON_SVG, TRIGGER_SELECTORS }
