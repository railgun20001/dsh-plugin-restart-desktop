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
 *
 * `desktop` 是「宿主是不是桌面版」，`restartable` 是「这个平台有没有重启驱动」——
 * 两者分开，菜单里才能把「这里根本没有桌面版」与「桌面版有，但这个系统还不支持」
 * 讲成两句不同的话。老宿主不返回 capabilities 时 `restartable` 保持 null（按可行处理）。
 * @returns {{ phase: string, force: boolean, message: string, guardHint: string, desktop: boolean | null, restartable: boolean | null, reason: string }} 初始状态。
 */
function createActionState() {
  return {
    phase: 'idle',
    force: false,
    message: '',
    guardHint: '',
    desktop: null,
    restartable: null,
    reason: '',
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
        restartable: typeof event.capabilities?.restart === 'boolean' ? event.capabilities.restart : null,
        reason: typeof event.capabilities?.reason === 'string' ? event.capabilities.reason : '',
        guardHint: typeof event.guardHint === 'string' ? event.guardHint : '',
      }
    case 'press': {
      if (state.phase === 'busy' || state.phase === 'done') return state
      if (state.desktop === false) {
        return { ...state, phase: 'error', force: false, message: '当前不是桌面版，这一项只在桌面应用里可用' }
      }
      if (state.restartable === false) {
        return { ...state, phase: 'error', force: false, message: state.reason || '当前平台还不支持重启桌面应用' }
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
      return { ...createActionState(), desktop: state.desktop, restartable: state.restartable, reason: state.reason, guardHint: state.guardHint }
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
  if (state.restartable === false) return state.reason || '当前平台还不支持重启桌面应用'
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
  if (state.restartable === false) return '重启桌面应用（当前平台不支持）'
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
  return state.phase === 'busy' || state.phase === 'done' || state.desktop === false || state.restartable === false
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

export {
  isButtonElement,
  isAccountRowButton,
  isAccountTrigger,
  currentSessionIdOf,
  sessionIdFromStorage,
  createActionState,
  reduceAction,
  actionTitle,
  actionAriaLabel,
  actionDisabled,
  toneOf,
}
