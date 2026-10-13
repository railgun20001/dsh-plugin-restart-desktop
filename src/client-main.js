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

import {
  actionAriaLabel,
  actionDisabled,
  actionTitle,
  createActionState,
  currentSessionIdOf,
  reduceAction,
  sessionIdFromStorage,
  toneOf,
} from './client-core.js'
import { startAccountButtonBridge } from './account-button.js'

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

export { apply, inject }
