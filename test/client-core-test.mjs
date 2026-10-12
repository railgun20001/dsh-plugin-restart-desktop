/**
 * 客户端半纯逻辑的单元测试。
 *
 * 覆盖三块：入口开关归一化、账号浮窗识别判据、重启按钮的确认状态机。
 * 运行：`node --test test/client-core-test.mjs`
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  CONFIRM_MS,
  WARN_ARM_MS,
  actionAriaLabel,
  actionDisabled,
  actionLabel,
  createActionState,
  currentSessionIdOf,
  isAccountMenuLabels,
  normalizeEntries,
  reduceAction,
  sessionIdFromStorage,
  toLabelSet,
  toneOf,
} from '../src/client-core.js'

test('normalizeEntries：本机值优先，其次宿主默认，最后 true', () => {
  assert.deepEqual(normalizeEntries({ footer: false }, { footer: true, settingsRow: false }), {
    accountMenu: true,
    footer: false,
    settingsRow: false,
  })
  assert.deepEqual(normalizeEntries(null, undefined), { accountMenu: true, footer: true, settingsRow: true })
  // 非布尔值一律丢弃，回落默认 —— 一个坏掉的 localStorage 值不该让入口消失。
  assert.deepEqual(normalizeEntries({ footer: 'yes' }, { footer: false }), {
    accountMenu: true,
    footer: false,
    settingsRow: true,
  })
})

test('toLabelSet：去空串、去空白', () => {
  assert.deepEqual([...toLabelSet([' 设置 ', '', '   ', '退出登录'])], ['设置', '退出登录'])
  assert.deepEqual([...toLabelSet(null)], [])
})

test('isAccountMenuLabels：中英文账号浮窗都认', () => {
  assert.equal(isAccountMenuLabels(['设置', '意见反馈', '退出登录']), true)
  assert.equal(isAccountMenuLabels(['Settings', 'Feedback', 'Sign out']), true)
  // 未登录时是「登录」而不是「退出登录」。
  assert.equal(isAccountMenuLabels(['设置', '意见反馈', '登录']), true)
  assert.equal(isAccountMenuLabels(['Settings', 'Feedback', 'Sign in']), true)
})

test('isAccountMenuLabels：认不出来时一律 false（认错比漏认严重得多）', () => {
  assert.equal(isAccountMenuLabels([]), false)
  assert.equal(isAccountMenuLabels(['设置']), false, '只有「设置」的菜单不能算账号浮窗')
  assert.equal(isAccountMenuLabels(['退出登录']), false, '只有「退出登录」的菜单不能算账号浮窗')
  assert.equal(isAccountMenuLabels(['重命名', '删除', '归档']), false)
  assert.equal(isAccountMenuLabels(null), false)
})

test('currentSessionIdOf：取 retainedBy.mainView > 0 的那一行', () => {
  assert.equal(currentSessionIdOf({
    byId: {
      'session-a': { retainedBy: { mainView: 0 } },
      'session-b': { retainedBy: { mainView: 1 } },
    },
  }), 'session-b')
  assert.equal(currentSessionIdOf({ byId: {} }), undefined)
  assert.equal(currentSessionIdOf(undefined), undefined)
  assert.equal(currentSessionIdOf({ byId: null }), undefined)
})

test('sessionIdFromStorage：解析 dsh.sessions.current，坏值回 undefined', () => {
  assert.equal(sessionIdFromStorage('{"sessionId":"session-1"}'), 'session-1')
  assert.equal(sessionIdFromStorage('{"sessionId":""}'), undefined)
  assert.equal(sessionIdFromStorage('{'), undefined)
  assert.equal(sessionIdFromStorage(null), undefined)
})

test('状态机：空闲 → 确认 → 执行；确认窗口过期则回到空闲', () => {
  let state = { ...createActionState(), desktop: true }
  state = reduceAction(state, { type: 'press' }, 1000)
  assert.equal(state.phase, 'confirm')
  assert.equal(state.force, false)

  // 超过确认窗口：视为放弃，回到空闲。
  state = reduceAction(state, { type: 'press' }, 1000 + CONFIRM_MS + 1)
  assert.equal(state.phase, 'idle')

  // 窗口内再点一次：进入执行，且不带 force。
  state = reduceAction({ ...createActionState(), desktop: true }, { type: 'press' }, 1000)
  state = reduceAction(state, { type: 'press' }, 1000 + CONFIRM_MS - 1)
  assert.equal(state.phase, 'busy')
  assert.equal(state.force, false)
})

test('状态机：有任务在跑时先警告，连点不算「我看过了」', () => {
  let state = { ...createActionState(), desktop: true, guardHint: '有任务在跑（1 项正在生成）' }
  state = reduceAction(state, { type: 'press' }, 1000)
  assert.equal(state.phase, 'warn')
  assert.match(state.message, /有任务在跑/)

  // 冷却期内的第二次点击必须被忽略 —— 否则双击就等于忽略警告。
  const duringCooldown = reduceAction(state, { type: 'press' }, 1000 + WARN_ARM_MS - 1)
  assert.equal(duringCooldown.phase, 'warn')

  const afterCooldown = reduceAction(state, { type: 'press' }, 1000 + WARN_ARM_MS + 1)
  assert.equal(afterCooldown.phase, 'busy')
  assert.equal(afterCooldown.force, true)
})

test('状态机：非桌面版直接给出错误态，不再进入确认', () => {
  let state = { ...createActionState(), desktop: false }
  state = reduceAction(state, { type: 'press' }, 1000)
  assert.equal(state.phase, 'error')
  assert.equal(actionDisabled(state), true)
  assert.match(actionAriaLabel(state), /仅在桌面版可用/)
})

test('状态机：宿主返回守卫拒绝时进入警告态并带 force 语义', () => {
  let state = { ...createActionState(), desktop: true }
  state = reduceAction(state, { type: 'press' }, 1000)
  state = reduceAction(state, { type: 'press' }, 1500)
  assert.equal(state.phase, 'busy')

  state = reduceAction(state, { type: 'result', ok: false, guard: true, text: '有任务在跑', guardHint: '有任务在跑（1 项正在生成）' }, 2000)
  assert.equal(state.phase, 'warn')
  assert.equal(state.guardHint, '有任务在跑（1 项正在生成）')

  const forced = reduceAction(state, { type: 'press' }, 2000 + WARN_ARM_MS + 1)
  assert.equal(forced.force, true)
})

test('状态机：成功与失败', () => {
  const busy = { ...createActionState(), desktop: true, phase: 'busy' }
  const done = reduceAction(busy, { type: 'result', ok: true, text: '已排程重启' }, 1000)
  assert.equal(done.phase, 'done')
  assert.equal(actionLabel(done), '已排程')
  assert.equal(toneOf(done), 'ok')
  assert.equal(actionDisabled(done), true)

  const failed = reduceAction(busy, { type: 'result', ok: false, text: '请求失败：boom' }, 1000)
  assert.equal(failed.phase, 'error')
  assert.equal(actionLabel(failed), '重试')
  assert.equal(toneOf(failed), 'error')
  assert.equal(actionDisabled(failed), false)
})

test('状态机：busy / done 期间再按无效', () => {
  const busy = { ...createActionState(), desktop: true, phase: 'busy' }
  assert.equal(reduceAction(busy, { type: 'press' }, 1000), busy)
  const done = { ...createActionState(), desktop: true, phase: 'done' }
  assert.equal(reduceAction(done, { type: 'press' }, 1000), done)
})

test('状态机：status 事件不会覆盖正在显示的文案', () => {
  const state = reduceAction({ ...createActionState(), desktop: true }, { type: 'status', desktop: true, guardHint: 'x' }, 1)
  assert.equal(state.guardHint, 'x')
  assert.equal(state.phase, 'idle')
  assert.equal(toneOf(state), 'plain')
})

test('文案：默认态与守卫态', () => {
  const idle = { ...createActionState(), desktop: true }
  assert.equal(actionLabel(idle), '重启 DSH')
  assert.equal(actionAriaLabel(idle), '重启桌面应用，保留窗口位置与大小')
  const guarded = { ...idle, guardHint: '有任务在跑' }
  assert.match(actionAriaLabel(guarded), /有任务在跑/)
})
