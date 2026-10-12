/**
 * dsh-restart-desktop —— 客户端半的纯逻辑层。
 *
 * 这里刻意不碰 DOM、不碰 React、不碰 fetch：入口开关的归一化、账号浮窗的识别判据、
 * 重启按钮的确认状态机都放在这里，因此可以完全离线单测（见 test/client-core-test.mjs）。
 * 真正的接线在 src/client-main.js，DOM 注入在 src/menu-bridge.js。
 *
 * @module dsh-restart-desktop/client-core
 */

/** 三个客户端入口的名字（宿主 config 与浏览器本地开关共用同一组键）。 */
const ENTRY_KEYS = ['accountMenu', 'footer', 'settingsRow']

/** 第一次点击「武装」按钮的有效期（毫秒）。 */
const CONFIRM_MS = 5000

/**
 * 警告态的最小冷却（毫秒）。
 *
 * 宿主半只认 `?force=1`，而 force 只在警告态被点出来，所以这里挡的是「双击 = 忽略警告」：
 * 连点两下不能把「有任务在跑」这句话点过去。
 */
const WARN_ARM_MS = 900

/**
 * 账号浮窗里出现的、可用来识别「这就是那个菜单」的标签。
 *
 * 官方没给第三方留「账号菜单项」插槽（`settings.launcher` 是 single 座位，整块由
 * `@deepseek-ai/dsh-client-ui-settings-account` 渲染），所以想精确落在「退出登录」下方
 * 只能观察 DOM。识别靠标签而不是靠类名：类名是构建期哈希（`yHnPSG_*`），每个版本都变；
 * 标签只在官方改文案时才变，且这里同时收中文与英文两套。
 */
const SIGN_OUT_LABELS = ['退出登录', 'Sign out']
const SIGN_IN_LABELS = ['登录', 'Sign in']
const SETTINGS_LABELS = ['设置', 'Settings']
const CONTACT_LABELS = ['意见反馈', '联系我们', 'Feedback']

/**
 * 归一化入口开关。
 *
 * 读不到的键走默认值，非布尔值一律丢弃 —— 一个坏掉的 localStorage 值不该让入口消失。
 * @param {unknown} stored 浏览器里存的值。
 * @param {Record<string, boolean> | undefined} defaults 宿主 config 给的默认值。
 * @returns {{ accountMenu: boolean, footer: boolean, settingsRow: boolean }} 归一化后的开关。
 */
function normalizeEntries(stored, defaults) {
  const source = stored !== null && typeof stored === 'object' ? stored : {}
  const fallback = defaults !== null && typeof defaults === 'object' ? defaults : {}
  const out = {}
  for (const key of ENTRY_KEYS) {
    if (typeof source[key] === 'boolean') out[key] = source[key]
    else if (typeof fallback[key] === 'boolean') out[key] = fallback[key]
    else out[key] = true
  }
  return out
}

/**
 * 把 `[role="menu"]` 里的菜单项文字归一化成可比对的标签集合。
 * @param {string[]} labels 菜单项的 `textContent.trim()`。
 * @returns {Set<string>} 标签集合（已去掉空串）。
 */
function toLabelSet(labels) {
  const set = new Set()
  for (const label of Array.isArray(labels) ? labels : []) {
    if (typeof label !== 'string') continue
    const text = label.trim()
    if (text !== '') set.add(text)
  }
  return set
}

/**
 * 这个菜单是不是侧栏底部的账号浮窗。
 *
 * 判据：同时含一个「退出登录 / 登录」项和一个「设置」项。两个条件都要，是因为
 * 只有「设置」或只有「登录」的菜单在别处也可能出现（例如模型选择器的菜单里有
 * 「设置」），而「退出登录」与「设置」同时出现在同一个菜单里的只有账号浮窗。
 *
 * 认不出来就返回 false —— 认不出来的代价是「浮窗里少一个入口」，而认错的代价是
 * 「在别人的菜单里塞了一个重启按钮」，后者严重得多。
 * @param {string[]} labels 菜单项文字。
 * @returns {boolean} 是账号浮窗时为 true。
 */
function isAccountMenuLabels(labels) {
  const set = toLabelSet(labels)
  if (set.size === 0) return false
  let hasSign = false
  let hasSettings = false
  for (const label of set) {
    if (SIGN_OUT_LABELS.includes(label) || SIGN_IN_LABELS.includes(label)) hasSign = true
    if (SETTINGS_LABELS.includes(label)) hasSettings = true
  }
  // 「意见反馈」是加分项，不参与判定：它是这一版才有的文案。
  void CONTACT_LABELS
  return hasSign && hasSettings
}

/**
 * 从会话列表快照里解析「当前打开的那个会话」。
 *
 * 判据与侧栏一致：`retainedBy.mainView > 0` 的那一行就是主视图中的会话
 * （`dsh-client-ui-workspace` 的 mainSessionId 同款）。
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

/** 重启动作的初始状态。 */
function createActionState() {
  return {
    phase: 'idle',
    armed: false,
    force: false,
    message: '',
    guardHint: '',
    desktop: null,
    pressedAt: 0,
  }
}

/**
 * 重启动作的状态机（纯函数）。
 *
 * 相位：idle → confirm → busy → done / error；有任务在跑时走 warn 分支。
 * @param {ReturnType<typeof createActionState>} state 当前状态。
 * @param {{ type: string, [key: string]: any }} event 事件。
 * @param {number} now 当前时间（epoch 毫秒）。
 * @returns {ReturnType<typeof createActionState>} 新状态。
 */
function reduceAction(state, event, now) {
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
        return { ...state, phase: 'error', armed: false, force: false, message: '当前不是桌面版，这一项只在桌面应用里可用' }
      }
      // 有任务在跑：先只警告。第二次点击必须等过冷却，连点不算「我看过了」。
      if (state.guardHint !== '' && state.phase !== 'confirm' && state.phase !== 'warn') {
        return { ...state, phase: 'warn', armed: true, force: false, pressedAt: now, message: `${state.guardHint}；再点一次仍会执行，但那会打断它们` }
      }
      if (state.phase === 'warn') {
        if (now - state.pressedAt < WARN_ARM_MS) return state
        return { ...state, phase: 'busy', armed: false, force: true, message: '正在排程重启…' }
      }
      if (state.phase === 'confirm') {
        if (now - state.pressedAt > CONFIRM_MS) {
          return { ...state, phase: 'idle', armed: false, force: false, message: '' }
        }
        return { ...state, phase: 'busy', armed: false, force: state.force === true, message: '正在排程重启…' }
      }
      if (state.phase === 'error') {
        return { ...state, phase: 'busy', armed: false, force: false, message: '正在重试…' }
      }
      return { ...state, phase: 'confirm', armed: true, force: false, pressedAt: now, message: '再点一次确认重启' }
    }
    case 'result': {
      if (event.ok === true) {
        return { ...state, phase: 'done', armed: false, force: false, message: typeof event.text === 'string' ? event.text : '已排程重启' }
      }
      if (event.guard === true) {
        return {
          ...state,
          phase: 'warn',
          armed: true,
          force: false,
          pressedAt: now,
          guardHint: typeof event.guardHint === 'string' ? event.guardHint : state.guardHint,
          message: typeof event.text === 'string' ? event.text : '有任务在跑',
        }
      }
      return { ...state, phase: 'error', armed: false, force: false, message: typeof event.text === 'string' ? event.text : '重启请求失败' }
    }
    case 'reset':
      return { ...createActionState(), desktop: state.desktop, guardHint: state.guardHint }
    default:
      return state
  }
}

/**
 * 按钮上显示的字。
 * @param {ReturnType<typeof createActionState>} state 动作状态。
 * @returns {string} 文案。
 */
function actionLabel(state) {
  if (state.phase === 'busy') return '重启中…'
  if (state.phase === 'done') return '已排程'
  if (state.phase === 'warn') return '仍要重启？'
  if (state.phase === 'confirm') return '确认重启？'
  if (state.phase === 'error') return '重试'
  return '重启 DSH'
}

/**
 * 按钮的 `aria-label`：按钮上的字很短，状态要在这里说全。
 * @param {ReturnType<typeof createActionState>} state 动作状态。
 * @returns {string} 无障碍标签。
 */
function actionAriaLabel(state) {
  if (state.desktop === false) return '重启桌面应用（仅在桌面版可用）'
  if (state.phase === 'busy') return '正在排程重启桌面应用'
  if (state.phase === 'done') return '已排程重启，页面即将断开'
  if (state.phase === 'warn') return '仍要重启桌面应用，会打断正在运行的任务'
  if (state.phase === 'confirm') return '再次点击以确认重启桌面应用'
  if (state.phase === 'error') return '重启失败，点击重试'
  return state.guardHint === '' ? '重启桌面应用，保留窗口位置与大小' : `重启桌面应用（${state.guardHint}）`
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
 * 提示文字与按钮的语气。
 * @param {ReturnType<typeof createActionState>} state 动作状态。
 * @returns {'plain' | 'warn' | 'ok' | 'error'} 语气。
 */
function toneOf(state) {
  if (state.phase === 'error') return 'error'
  if (state.phase === 'done') return 'ok'
  if (state.phase === 'warn') return 'warn'
  return 'plain'
}

export {
  ENTRY_KEYS,
  CONFIRM_MS,
  WARN_ARM_MS,
  SIGN_OUT_LABELS,
  SIGN_IN_LABELS,
  SETTINGS_LABELS,
  CONTACT_LABELS,
  normalizeEntries,
  toLabelSet,
  isAccountMenuLabels,
  currentSessionIdOf,
  sessionIdFromStorage,
  createActionState,
  reduceAction,
  actionLabel,
  actionAriaLabel,
  actionDisabled,
  toneOf,
}
