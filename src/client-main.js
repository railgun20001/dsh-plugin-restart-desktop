/**
 * dsh-restart-desktop —— 客户端半（浏览器 bundle 的 factory 体）。
 *
 * 职责：
 *   - 在三个座位里放「重启 DSH」入口：侧栏底部（官方座位）、设置 → 通用（官方座位）、
 *     以及账号浮窗「退出登录」下方（DOM 注入，见 src/menu-bridge.js）；
 *   - 维护重启动作的状态机（纯逻辑在 src/client-core.js），把守卫警告、二次确认、
 *     失败重试表达成按钮自己的状态，不弹任何模态框；
 *   - 提供一个插件自己的设置分区：三个入口的开关、还原窗口几何、自动恢复对话、
 *     以及「上一次重启 / 上一次恢复到底成没成」的事实。
 *
 * 刻意不依赖 `@deepseek-ai/dsh-client-ui-primitives`：这一版的界面全部由本插件的
 * CSS（数值取自官方 token 与官方组件）画出来，少一个包就少一类「官方改版导致整个
 * 客户端半加载失败」的失败形态。
 *
 * @module dsh-restart-desktop/client
 */

import {
  ENTRY_KEYS,
  actionAriaLabel,
  actionDisabled,
  actionLabel,
  createActionState,
  currentSessionIdOf,
  normalizeEntries,
  reduceAction,
  sessionIdFromStorage,
  toneOf,
} from './client-core.js'
import { startAccountMenuBridge } from './menu-bridge.js'

const React = require('react')

/** 插件 id（与 package.json 的 name 一致）。 */
const PLUGIN_ID = 'dsh-restart-desktop'

/** 宿主半的路由。客户端用**文档相对**路径：桌面端页面是 `dsh-app://app/`，
 * 其非静态路径会被 shell 同源转发到宿主；Web 端页面带 `<base href="./">`，
 * 相对路径能正确落在部署前缀下。 */
const STATUS_ROUTE = `${PLUGIN_ID}/api/status`
const RESTART_ROUTE = `${PLUGIN_ID}/api/restart`
const SETTINGS_ROUTE = `${PLUGIN_ID}/api/settings`

/** localStorage 键（带版本后缀：形状变化时换键即自动丢弃旧数据）。 */
const ENTRIES_KEY = `${PLUGIN_ID}/entries-v1`
const PENDING_KEY = `${PLUGIN_ID}/pending-v1`

/** 三个座位。 */
const SIDEBAR_FOOTER_SLOT = 'sidebar.footer.action'
const SETTINGS_ROW_SLOT = 'settings.general.item'
const SETTINGS_SECTION_SLOT = 'settings.section'
const OVERLAY_SLOT = 'shell.overlay'

/** 入口的展示文案：`[标题, 说明]`。 */
const ENTRY_LABELS = {
  accountMenu: ['账号浮窗里的一项', '显示在侧栏底部账号浮窗的「退出登录」下方'],
  footer: ['侧栏底部的入口', '显示在左侧边栏底部，和「设置」同一行区域'],
  settingsRow: ['设置里的入口', '在「设置 → 通用」里多出一行'],
}

/** 本插件在座位里用的 id。 */
const SLOT_ID = PLUGIN_ID

/** 硬依赖：没有座位服务就没有界面。 */
const inject = ['slots']

/** 自己的样式。数值逐字取自官方 token 与官方组件（Button md / 侧栏底行动作 / 设置页行）。 */
const CSS = [
  // ── 侧栏底部的动作行：与同一座位里的邻居（官方插件面板）保持同一套数值 ──
  `.dsrd-foot{box-sizing:border-box;flex:none;align-items:center;width:calc(100% + 4px);height:42px;margin:4px -2px;display:flex;position:relative}`,
  `.dsrd-foot-btn{box-sizing:border-box;width:100%;height:42px;color:var(--dsw-alias-label-primary,inherit);cursor:pointer;background:0 0;border:none;border-radius:12px;align-items:center;gap:8px;padding:0 10px 0 8px;font-family:inherit;font-size:14px;line-height:22px;display:flex;overflow:hidden}`,
  `.dsrd-foot-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.18))}`,
  `.dsrd-foot-btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,rgba(77,107,254,.75));outline-offset:2px}`,
  `.dsrd-foot-btn:disabled{color:var(--dsw-alias-label-tertiary,inherit);cursor:default;background:0 0}`,
  `.dsrd-foot[data-rail=1]{width:36px;height:36px;margin:8px 0 10px}`,
  `.dsrd-foot[data-rail=1] .dsrd-foot-btn{border-radius:50%;justify-content:center;gap:0;width:36px;height:36px;padding:0}`,
  `.dsrd-foot[data-rail=1] .dsrd-foot-label{display:none}`,
  `.dsrd-foot-label{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}`,
  `[class*="footerActions"]:has(.dsrd-foot){flex-wrap:wrap !important}`,
  // ── 状态语气 ──
  `[data-tone=warn]{color:var(--dsw-alias-state-warn-primary,#d29922)}`,
  `[data-tone=error]{color:var(--dsw-alias-state-error-primary,#f85149)}`,
  `[data-tone=ok]{color:var(--dsw-alias-state-success-primary,#3fb950)}`,
  `[data-busy=1] svg{transform-origin:center;animation:dsrd-spin 1s linear infinite}`,
  `@keyframes dsrd-spin{to{transform:rotate(360deg)}}`,
  `@media (prefers-reduced-motion:reduce){[data-busy=1] svg{animation:none}}`,
  // ── 设置页那一行（settings.general.item）──
  `.dsrd-row{display:flex;align-items:center;gap:8px;padding:16px 0;border-bottom:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.2))}`,
  `.dsrd-row-text{display:flex;flex-direction:column;flex:1;gap:4px;min-width:0;padding-right:48px}`,
  `.dsrd-row-label{color:var(--dsw-alias-label-primary,inherit);font-size:14px;font-weight:400;line-height:22px}`,
  `.dsrd-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,rgba(140,140,150,1))}`,
  // ── 按钮：官方 Button md 的三种变体 ──
  `.dsrd-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:36px;padding:0 14px;border:none;border-radius:var(--dsw-radius-md,12px);cursor:pointer;font:inherit;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary,inherit);background:transparent;flex:none}`,
  `.dsrd-btn:disabled{cursor:not-allowed;opacity:.4}`,
  `.dsrd-btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,rgba(77,107,254,.75));outline-offset:2px}`,
  `.dsrd-btn[data-variant=outline]{border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.35));background:transparent}`,
  `.dsrd-btn[data-variant=outline]:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.18))}`,
  `.dsrd-btn[data-variant=primary]{background:var(--dsw-alias-button-primary-fill,rgba(77,107,254,1));color:var(--dsw-alias-label-primary-foreground,#fff)}`,
  `.dsrd-btn[data-variant=primary]:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,rgba(77,107,254,.85))}`,
  // ── 插件自己的设置分区 ──
  `.dsrd-page{box-sizing:border-box;display:flex;flex-direction:column;width:100%;max-width:720px;margin:0 auto;padding:24px}`,
  `.dsrd-title{color:var(--dsw-alias-label-primary,inherit);margin:0 0 4px;font-size:16px;font-weight:500;line-height:24px}`,
  `.dsrd-desc{color:var(--dsw-alias-label-secondary,inherit);margin:0;font-size:14px;line-height:22px}`,
  `.dsrd-subtitle{color:var(--dsw-alias-label-primary,inherit);margin:24px 0 0;font-size:14px;font-weight:500;line-height:22px}`,
  `.dsrd-set-row{display:flex;align-items:center;gap:12px;padding:16px 0;border-bottom:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.2))}`,
  `.dsrd-set-text{display:flex;flex-direction:column;flex:1;gap:4px;min-width:0;padding-right:48px}`,
  `.dsrd-set-label{color:var(--dsw-alias-label-primary,inherit);font-size:14px;font-weight:400;line-height:22px}`,
  `.dsrd-set-actions{display:flex;align-items:center;gap:8px;flex:none}`,
  `.dsrd-switch{appearance:none;box-sizing:border-box;width:36px;height:20px;border-radius:10px;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.3));position:relative;cursor:pointer;border:none;transition:background .12s ease;flex:none}`,
  `.dsrd-switch::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .12s ease}`,
  `.dsrd-switch:checked{background:var(--dsw-alias-button-primary-fill,rgba(77,107,254,1))}`,
  `.dsrd-switch:checked::after{transform:translateX(16px)}`,
  `.dsrd-switch:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,rgba(77,107,254,.75));outline-offset:2px}`,
  `.dsrd-facts{margin:8px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px}`,
  `.dsrd-facts li{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,inherit)}`,
  // ── 重启完成后的浮层提示 ──
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
 * 刷新图标：优先用官方组件库的，拿不到就画一个同约定的 16 格描边 SVG。
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
  const entriesStore = createStore(normalizeEntries(readJson(ENTRIES_KEY, {}), undefined))
  const actionStore = createStore(createActionState())
  const statusStore = createStore(null)
  const noticeStore = createStore(null)
  const bridgeStore = createStore({ supported: false, found: 0, injected: 0, lastReason: 'not-started' })

  /** 宿主半给的入口默认值（`/api/status` 里回来）。 */
  let hostEntries = undefined
  let disposed = false

  /**
   * 合并写入一个入口开关并立即重挂入口。
   * @param {string} key 入口名。
   * @param {boolean} value 新值。
   */
  const setEntry = (key, value) => {
    const next = { ...entriesStore.getSnapshot(), [key]: value === true }
    entriesStore.set(next)
    writeJson(ENTRIES_KEY, next)
    applyEntries()
  }

  /**
   * 当前打开的会话 id：优先问受支持的会话列表服务，退路是客户端自己持久化的
   * `dsh.sessions.current`。宿主半只用它来判断「这次重启打断了谁」。
   *
   * 退路扫一遍 localStorage 而不是只读一个固定键：键名带不带前缀是客户端内部约定，
   * 不该成为「自动恢复失效」的原因。两条都拿不到就返回 undefined —— 那时宿主半
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

  /** 问一次宿主状态（是不是桌面版、现在有多少活在跑、上次重启/恢复的结果）。 */
  const refreshStatus = async () => {
    if (typeof fetch !== 'function') return
    try {
      const response = await fetch(STATUS_ROUTE, { method: 'GET' })
      const body = await response.json().catch(() => null)
      if (disposed || body === null || typeof body !== 'object') return
      statusStore.set(body)
      if (hostEntries === undefined && body.entries !== null && typeof body.entries === 'object') {
        hostEntries = body.entries
        // 宿主 config 给的默认值只补「本机还没存过」的那些键。
        entriesStore.set(normalizeEntries(readJson(ENTRIES_KEY, {}), hostEntries))
        applyEntries()
      }
      const reasons = Array.isArray(body.guard?.reasons) ? body.guard.reasons : []
      actionStore.set(reduceAction(actionStore.getSnapshot(), {
        type: 'status',
        desktop: body.desktop === true,
        guardHint: reasons.join('；'),
      }, Date.now()))
    } catch (error) {
      console.warn(`[${PLUGIN_ID}] 读取宿主状态失败`, error)
    }
  }

  /**
   * 请宿主排程一次重启。
   *
   * `force` 与 `session` 都走查询参数而不是请求体：桌面壳转发页面 fetch 时只保证
   * URL 与头部到达，少一种失败形态就少一类「点了没反应」。
   * @param {boolean} force 是否已确认「我知道有东西在跑」。
   * @returns {Promise<void>} 完成。
   */
  const requestRestart = async (force) => {
    const sessionId = currentSessionId()
    const params = new URLSearchParams()
    if (typeof sessionId === 'string' && sessionId !== '') params.set('session', sessionId)
    if (force) params.set('force', '1')
    const query = params.toString()
    let response
    try {
      response = await fetch(query === '' ? RESTART_ROUTE : `${RESTART_ROUTE}?${query}`, { method: 'POST' })
    } catch (error) {
      actionStore.set(reduceAction(actionStore.getSnapshot(), {
        type: 'result',
        ok: false,
        text: `请求失败：${String((error && error.message) || error)}`,
      }, Date.now()))
      return
    }
    const body = await response.json().catch(() => null)
    if (response.ok && body?.ok === true) {
      // 记一笔本机标记：页面重新加载后据此提示「重启完成」，并顺带说明恢复结果。
      writeJson(PENDING_KEY, { at: Date.now(), sessionId: sessionId ?? null })
      actionStore.set(reduceAction(actionStore.getSnapshot(), {
        type: 'result',
        ok: true,
        text: '已排程重启：窗口即将关闭，随后自动打开并还原到原来的位置与大小。',
      }, Date.now()))
      return
    }
    if (body?.guard?.active === true) {
      actionStore.set(reduceAction(actionStore.getSnapshot(), {
        type: 'result',
        ok: false,
        guard: true,
        text: String(body.error ?? '现在有任务在跑'),
        guardHint: (Array.isArray(body.guard.reasons) ? body.guard.reasons : []).join('；'),
      }, Date.now()))
      return
    }
    actionStore.set(reduceAction(actionStore.getSnapshot(), {
      type: 'result',
      ok: false,
      text: String(body?.error ?? `HTTP ${String(response.status)}`),
    }, Date.now()))
  }

  /** 按一次按钮：状态机决定是「进入确认」「警告」还是「真的发请求」。 */
  const press = () => {
    const next = reduceAction(actionStore.getSnapshot(), { type: 'press' }, Date.now())
    actionStore.set(next)
    if (next.phase === 'busy') void requestRestart(next.force === true)
  }

  /** 改一个宿主侧设置（还原窗口几何 / 自动恢复对话）。 */
  const setHostSetting = async (key, value) => {
    try {
      const response = await fetch(`${SETTINGS_ROUTE}?${key}=${value ? '1' : '0'}`, { method: 'POST' })
      const body = await response.json().catch(() => null)
      if (body?.settings !== null && typeof body?.settings === 'object') {
        const current = statusStore.getSnapshot()
        statusStore.set({ ...(current ?? {}), settings: body.settings })
      }
    } catch (error) {
      console.warn(`[${PLUGIN_ID}] 写入插件设置失败`, error)
    }
  }

  /** 三个入口共用的动作状态。 */
  const useAction = () => useStore(actionStore)

  // ---- 三个入口的组件 ------------------------------------------------------

  /** 侧栏底部的入口（官方座位）。 */
  function SidebarRestartAction(props) {
    const action = useAction()
    const wide = !(props !== null && props !== undefined && props.wide === false)
    return React.createElement('div', { className: 'dsrd-foot', 'data-rail': wide ? '0' : '1' },
      React.createElement('button', {
        type: 'button',
        className: 'dsrd-foot-btn',
        'data-busy': action.phase === 'busy' ? '1' : '0',
        'data-tone': toneOf(action),
        disabled: actionDisabled(action),
        title: action.message !== '' ? action.message : '重启整个桌面应用（结束当前实例并重新打开，窗口位置与大小保留）',
        'aria-label': actionAriaLabel(action),
        onClick: press,
      },
      Glyph(16),
      React.createElement('span', { className: 'dsrd-foot-label' }, actionLabel(action))))
  }

  /** 设置 → 通用里的一行（官方座位）。 */
  function SettingsRestartRow() {
    const action = useAction()
    const hint = action.message !== ''
      ? action.message
      : (action.desktop === false
        ? '当前不是桌面版，这一行只在桌面应用里可用。'
        : (action.guardHint !== ''
          ? `${action.guardHint}；再点一次仍会重启，但那会打断它们。`
          : '重启整个桌面应用，并还原窗口的位置与大小。改了插件或设置、需要重启才生效时用这个。'))
    return React.createElement('div', { className: 'dsrd-row' },
      React.createElement('div', { className: 'dsrd-row-text' },
        React.createElement('span', { className: 'dsrd-row-label' }, '重启桌面版'),
        React.createElement('span', { className: 'dsrd-hint', 'data-tone': toneOf(action) }, hint)),
      React.createElement('button', {
        type: 'button',
        className: 'dsrd-btn',
        'data-variant': 'outline',
        'data-busy': action.phase === 'busy' ? '1' : '0',
        disabled: actionDisabled(action),
        'aria-label': actionAriaLabel(action),
        onClick: press,
      }, Glyph(14), actionLabel(action)))
  }

  /** 重启完成后的浮层提示（只在页面重新加载后出现一次）。 */
  function BootNotice() {
    const notice = useStore(noticeStore)
    if (notice === null) return null
    return React.createElement('div', { className: 'dsrd-toast', role: 'status' }, notice)
  }

  /** 插件自己的设置分区。 */
  function RestartSettingsSection() {
    const entries = useStore(entriesStore)
    const action = useAction()
    const status = useStore(statusStore)
    const bridge = useStore(bridgeStore)
    const [busy, setBusy] = React.useState(false)

    React.useEffect(() => {
      void refreshStatus()
    }, [])

    const desktop = status?.desktop !== false
    const settings = status?.settings ?? {}
    const guardReasons = Array.isArray(status?.guard?.reasons) ? status.guard.reasons : []

    /** 一个带标题/说明/开关的行。 */
    const switchRow = (title, description, checked, onChange, disabled) => React.createElement('div', { className: 'dsrd-set-row', key: title },
      React.createElement('div', { className: 'dsrd-set-text' },
        React.createElement('span', { className: 'dsrd-set-label' }, title),
        React.createElement('span', { className: 'dsrd-hint' }, description)),
      React.createElement('div', { className: 'dsrd-set-actions' },
        React.createElement('input', {
          type: 'checkbox',
          className: 'dsrd-switch',
          checked: checked === true,
          disabled: disabled === true,
          'aria-label': title,
          onChange: (event) => onChange(event.target.checked),
        })))

    /** 一条只读事实。 */
    const fact = (text, tone) => React.createElement('li', { key: text, 'data-tone': tone }, text)

    const facts = []
    facts.push(fact(desktop ? '当前是桌面版宿主。' : '当前不是桌面版：重启入口只在桌面应用里可用。'))
    if (guardReasons.length > 0) facts.push(fact(`现在停掉会打断：${guardReasons.join('；')}`, 'warn'))
    else facts.push(fact('现在没有正在跑的任务。', 'ok'))
    if (status?.restart) {
      const geometry = status.restart.geometry
      facts.push(fact(
        `上一次重启：${status.restart.ok === true ? '成功' : `未完成（${String(status.restart.stage ?? '未知阶段')}）`}`
        + (geometry === null || geometry === undefined
          ? ''
          : geometry.captured === true
            ? `；窗口几何已捕获${geometry.maximized === true ? '（最大化）' : geometry.minimized === true ? '（最小化）' : ''}并还原`
            : '；没有捕获到窗口几何'),
      ))
    }
    if (status?.resume) {
      facts.push(fact(
        `上一次自动恢复：${status.resume.resumed === true
          ? `已把会话 ${String(status.resume.sessionId ?? '')} 恢复并发出一条恢复消息`
          : `没有恢复（${String(status.resume.reason ?? '未知原因')}）`}`,
        status.resume.resumed === true ? 'ok' : undefined,
      ))
    }
    facts.push(fact(`账号浮窗入口：${bridge.supported !== true ? '本页不支持' : bridge.injected > 0 ? '已注入' : '尚未找到账号浮窗（打开一次账号菜单即可）'}`))

    return React.createElement('div', { className: 'dsrd-page' },
      React.createElement('h3', { className: 'dsrd-title' }, '重启桌面版'),
      React.createElement('p', { className: 'dsrd-desc' }, '重启整个 DeepSeek Harness 桌面应用：只结束 Electron 主进程，让 host 把会话日志正常落盘，随后自动拉起新实例并还原窗口的位置、大小与最大化状态。'),
      React.createElement('h4', { className: 'dsrd-subtitle' }, '入口'),
      ...ENTRY_KEYS.map((key) => switchRow(ENTRY_LABELS[key][0], ENTRY_LABELS[key][1], entries[key], (value) => setEntry(key, value))),
      React.createElement('h4', { className: 'dsrd-subtitle' }, '重启行为'),
      switchRow(
        '重启后还原窗口位置与大小',
        '应用自己不记窗口几何（每次启动都回到 1280×820），所以由本插件在重启前后接管。关掉后重启会回到默认尺寸。',
        settings.geometry,
        (value) => void setHostSetting('geometry', value),
        !desktop,
      ),
      switchRow(
        '重启后自动续上被打断的那一轮对话',
        '只处理「触发重启的那个会话」，而且只在重启排程那一刻它确实在跑时才发恢复消息；空闲会话不会被唤醒，历史会话更不会被扫到。',
        settings.resume,
        (value) => void setHostSetting('resume', value),
        !desktop,
      ),
      React.createElement('h4', { className: 'dsrd-subtitle' }, '现在'),
      React.createElement('div', { className: 'dsrd-set-row' },
        React.createElement('div', { className: 'dsrd-set-text' },
          React.createElement('span', { className: 'dsrd-set-label' }, actionLabel(action)),
          React.createElement('span', { className: 'dsrd-hint', 'data-tone': toneOf(action) }, action.message === '' ? '点右侧按钮重启；有任务在跑时会先警告一次。' : action.message)),
        React.createElement('div', { className: 'dsrd-set-actions' },
          React.createElement('button', {
            type: 'button',
            className: 'dsrd-btn',
            'data-variant': 'outline',
            disabled: busy,
            onClick: async () => {
              setBusy(true)
              await refreshStatus()
              setBusy(false)
            },
          }, '刷新状态'),
          React.createElement('button', {
            type: 'button',
            className: 'dsrd-btn',
            'data-variant': 'primary',
            'data-busy': action.phase === 'busy' ? '1' : '0',
            disabled: actionDisabled(action),
            onClick: press,
          }, Glyph(14), actionLabel(action)))),
      React.createElement('ul', { className: 'dsrd-facts' }, facts))
  }

  // ---- 注册与重挂 ----------------------------------------------------------

  /** 三个入口的 disposer；开关变化时整批撤掉重挂。 */
  let entryDisposers = []
  /** 浮窗桥的句柄。 */
  let bridge = null

  /** 撤掉已经注册的入口。 */
  const clearEntries = () => {
    for (const dispose of entryDisposers) {
      try {
        dispose()
      } catch {
        /* 已经撤掉了 */
      }
    }
    entryDisposers = []
    try {
      bridge?.stop()
    } catch {
      /* 停不掉无所谓 */
    }
    bridge = null
  }

  /** 按当前开关注册一轮入口。 */
  const applyEntries = () => {
    if (disposed) return
    clearEntries()
    const entries = entriesStore.getSnapshot()
    const push = (disposer) => { if (typeof disposer === 'function') entryDisposers.push(disposer) }
    try {
      if (entries.footer) {
        push(slots.inject(SIDEBAR_FOOTER_SLOT, () => slots.register({
          name: SIDEBAR_FOOTER_SLOT,
          id: SLOT_ID,
          order: 100,
          label: '重启 DSH',
        }, SidebarRestartAction)))
      }
      if (entries.settingsRow) {
        push(slots.inject(SETTINGS_ROW_SLOT, () => slots.register({
          name: SETTINGS_ROW_SLOT,
          id: SLOT_ID,
          order: 91,
        }, SettingsRestartRow)))
      }
      if (entries.accountMenu) {
        bridge = startAccountMenuBridge({
          label: '重启 DSH',
          onActivate: press,
          onStatus: (status) => bridgeStore.set(status),
        })
        bridgeStore.set(bridge.status())
      }
    } catch (error) {
      console.error(`[${PLUGIN_ID}] 注册入口失败`, error)
    }
  }

  // 插件自己的设置分区不受开关影响：否则关掉入口就再也回不来了。
  ctx.effect(() => slots.inject(SETTINGS_SECTION_SLOT, () => slots.register({
    name: SETTINGS_SECTION_SLOT,
    id: SLOT_ID,
    order: 90,
    label: () => '重启桌面版',
  }, RestartSettingsSection)))

  // 重启完成后的浮层提示。
  ctx.effect(() => slots.inject(OVERLAY_SLOT, () => slots.register({
    name: OVERLAY_SLOT,
    id: SLOT_ID,
    order: 90,
    label: () => '重启提示',
  }, BootNotice)))

  applyEntries()
  ctx.effect(() => () => {
    disposed = true
    clearEntries()
  })

  // 页面重新加载过 = 上一次排程的重启应该已经发生：提示一次，并问宿主拿恢复结果。
  const pending = readJson(PENDING_KEY, null)
  if (pending !== null) {
    removeKey(PENDING_KEY)
    const parts = ['桌面版已重启。']
    if (typeof pending.sessionId === 'string' && pending.sessionId !== '') parts.push('窗口位置与大小已按重启前还原。')
    noticeStore.set(parts.join(''))
    const timer = setTimeout(() => { noticeStore.set(null) }, 8000)
    timer?.unref?.()
  }

  void refreshStatus()

  ctx.logger?.info?.(`[${PLUGIN_ID}] 客户端半 v${BUNDLE_VERSION} 已启动：入口 ${JSON.stringify(entriesStore.getSnapshot())}`)

  // ---- 诊断入口（排障与端到端验证用）--------------------------------------
  try {
    globalThis.__DSH_RESTART_DESKTOP__ = {
      version: BUNDLE_VERSION,
      entries: () => ({ ...entriesStore.getSnapshot() }),
      setEntry,
      status: () => statusStore.getSnapshot(),
      action: () => ({ ...actionStore.getSnapshot() }),
      bridge: () => (bridge === null ? null : bridge.status()),
      sweepMenu: () => (bridge === null ? null : bridge.sweep()),
      refreshStatus,
      restart: (force) => requestRestart(force === true),
    }
  } catch {
    /* 只读全局对象等极端环境下放弃暴露诊断入口 */
  }
}

export { apply, inject }
