/**
 * dsh-restart-desktop —— 把「重启 DSH」塞进侧栏底部的账号浮窗，落在「退出登录」下方。
 *
 * ## 为什么必须靠观察 DOM
 *
 * 那个浮窗是 `@deepseek-ai/dsh-client-ui-settings-account` 整体渲染进
 * `settings.launcher` 这个 **single** 座位的（菜单项写死在它的 `items` 数组里：
 * 设置 / 意见反馈 / 退出登录）。官方没有给第三方留「菜单项」座位，`Menu` 组件也不
 * 暴露任何扩展点。所以想精确落位，只剩「等菜单出现 → 认出它 → 追加一个同款菜单项」
 * 这一条路。
 *
 * ## 这条路的边界（写清楚，免得以后当成 bug）
 *
 * - **认不出来就什么都不做。** 识别靠菜单项文案（中英两套）。官方改文案、或用户
 *   用别的语言时，这里会静默失效 —— 代价是「浮窗里少一个入口」，另外两个官方座位
 *   的入口照常工作。绝不猜：在别人的菜单里塞一个重启按钮，比少一个入口糟得多。
 * - **只追加、不修改官方节点。** 追加的是 React 管理的容器里的一个额外子节点；
 *   官方列表顺序不变，因此 React 不会去动它；菜单卸载时它随容器一起消失，不留残留。
 * - **键盘导航到不了它。** `Menu` 的上下键走的是它自己的 `items` 数组，我们插在
 *   DOM 里的节点不在其中。鼠标/触摸点击正常。这是刻意的取舍：改 `items` 需要
 *   改官方组件，那才是真的会坏。
 *
 * @module dsh-restart-desktop/menu-bridge
 */

import { isAccountMenuLabels } from './client-core.js'

/** 标记属性：菜单与我们插入的那一项都带上它，用于幂等与自检。 */
const MENU_MARKER = 'data-dsh-restart-desktop'
const ITEM_MARKER = 'data-dsh-restart-desktop-item'

/** 默认的菜单项文案。 */
const DEFAULT_ITEM_LABEL = '重启 DSH'

/** 默认图标：16 格描边的刷新箭头，跟随 `currentColor`。 */
const DEFAULT_ICON_SVG = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M13.51 7.03A5.6 5.6 0 1 1 10.8 3.15"/><path d="M10.42 1.75L10.97 3.25L9.4 3.53"/></svg>'

/**
 * 启动浮窗桥。
 *
 * `document` 与 `MutationObserver` 可以从外面注入，因此这个模块可以在没有浏览器的
 * 环境里用假 DOM 单测（见 test/menu-bridge-test.mjs）。
 * @param {{ document?: any, MutationObserver?: any, label?: string, iconHtml?: string, onActivate: () => void, onStatus?: (status: object) => void, coalesceMs?: number }} options 选项。
 * @returns {{ stop: () => void, sweep: () => object, status: () => object }} 句柄。
 */
function startAccountMenuBridge(options) {
  const doc = options.document ?? (typeof document === 'undefined' ? undefined : document)
  const Observer = options.MutationObserver ?? (typeof MutationObserver === 'undefined' ? undefined : MutationObserver)
  const label = typeof options.label === 'string' && options.label !== '' ? options.label : DEFAULT_ITEM_LABEL
  const iconHtml = typeof options.iconHtml === 'string' ? options.iconHtml : DEFAULT_ICON_SVG
  const onActivate = options.onActivate
  const onStatus = options.onStatus
  const coalesceMs = Number.isFinite(options.coalesceMs) ? Number(options.coalesceMs) : 30

  let observer = null
  let timer = null
  let stopped = false
  const state = { supported: doc !== undefined && typeof doc.querySelectorAll === 'function', found: 0, injected: 0, lastReason: 'not-scanned' }

  /** 把状态播报出去（诊断用），失败不影响桥本身。 */
  const publish = () => {
    if (typeof onStatus !== 'function') return
    try {
      onStatus({ ...state })
    } catch {
      /* 诊断回调失败不该影响注入 */
    }
  }

  /**
   * 追加一个同款菜单项。
   *
   * 类名、图标容器、文案容器的类名全部从**同一个菜单里已有的菜单项**上抄下来，
   * 因此官方改样式时这里自动跟着变，不需要跟着改哈希类名。
   * @param {any} menu `[role="menu"]` 元素。
   * @param {any[]} items 该菜单里已有的 `button[role="menuitem"]`。
   * @returns {boolean} 是否插入成功。
   */
  const injectItem = (menu, items) => {
    const template = items[items.length - 1]
    const host = template?.parentNode ?? menu
    if (host === null || host === undefined || typeof host.appendChild !== 'function') return false

    let button
    try {
      button = doc.createElement('button')
    } catch {
      return false
    }
    button.type = 'button'
    button.setAttribute('role', 'menuitem')
    button.setAttribute(ITEM_MARKER, '1')
    if (typeof template.className === 'string') button.className = template.className

    // 图标容器沿用模板里第一个子元素的类名；文案容器沿用模板里的 itemLabel。
    const iconHost = doc.createElement('span')
    const templateIcon = template?.firstElementChild
    iconHost.className = typeof templateIcon?.className === 'string' ? templateIcon.className : ''
    iconHost.innerHTML = iconHtml
    button.appendChild(iconHost)

    const labelHost = doc.createElement('span')
    const templateLabel = templateIcon?.nextElementSibling
    labelHost.className = typeof templateLabel?.className === 'string' ? templateLabel.className : ''
    labelHost.textContent = label
    button.appendChild(labelHost)

    button.addEventListener('click', (event) => {
      try {
        event?.preventDefault?.()
        event?.stopPropagation?.()
      } catch {
        /* 事件对象形状不认识也要继续触发动作 */
      }
      // 先把浮窗关掉：官方 Menu 认 Escape，派发一个就够，不必去改它的内部状态。
      closeMenu(menu)
      try {
        onActivate?.()
      } catch {
        /* 动作失败由入口自己的状态机表达 */
      }
    })

    try {
      host.appendChild(button)
      menu.setAttribute(MENU_MARKER, '1')
      return true
    } catch {
      return false
    }
  }

  /**
   * 让官方 Menu 自己关掉：派发一个冒泡的 Escape 键事件。
   * @param {any} menu 菜单元素。
   */
  const closeMenu = (menu) => {
    try {
      const view = doc.defaultView ?? (typeof window === 'undefined' ? undefined : window)
      const KeyboardEventCtor = view?.KeyboardEvent ?? (typeof KeyboardEvent === 'undefined' ? undefined : KeyboardEvent)
      if (typeof KeyboardEventCtor !== 'function' || typeof menu.dispatchEvent !== 'function') return
      menu.dispatchEvent(new KeyboardEventCtor('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    } catch {
      /* 关不掉浮窗不影响重启本身 */
    }
  }

  /**
   * 扫一遍当前页面上的菜单，认出账号浮窗并注入。
   * @returns {{ found: number, injected: number }} 本轮结果。
   */
  const sweep = () => {
    if (stopped || !state.supported) return { found: 0, injected: 0 }
    let menus
    try {
      menus = doc.querySelectorAll('[role="menu"]')
    } catch {
      return { found: 0, injected: 0 }
    }
    let found = 0
    let injected = 0
    for (const menu of Array.from(menus ?? [])) {
      if (menu === null || typeof menu.getAttribute !== 'function') continue
      if (menu.getAttribute(MENU_MARKER) === '1') continue
      let items
      try {
        items = Array.from(menu.querySelectorAll('button[role="menuitem"]') ?? [])
      } catch {
        continue
      }
      const labels = items.map((item) => String(item?.textContent ?? ''))
      if (!isAccountMenuLabels(labels)) continue
      found += 1
      if (injectItem(menu, items)) injected += 1
    }
    state.found = found
    state.injected += injected
    state.lastReason = found === 0 ? 'no-account-menu' : injected > 0 ? 'injected' : 'already-present'
    publish()
    return { found, injected }
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
    },
    sweep,
    status() {
      return { ...state }
    },
  }
}

export { startAccountMenuBridge, MENU_MARKER, ITEM_MARKER, DEFAULT_ICON_SVG, DEFAULT_ITEM_LABEL }
