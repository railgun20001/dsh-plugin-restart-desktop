/**
 * 客户端半纯逻辑的单元测试。
 *
 * 覆盖三块：账号行触发按钮的识别判据、当前会话 id 的解析、重启按钮的状态机与文案。
 * 运行：`node --test test/client-core-test.mjs`
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  actionAriaLabel,
  actionDisabled,
  actionTitle,
  createActionState,
  currentSessionIdOf,
  isAccountRowButton,
  isAccountTrigger,
  isButtonElement,
  reduceAction,
  sessionIdFromStorage,
  toneOf,
} from '../src/client-core.js'

/** 一个只带属性的假元素：判据只看属性，不需要真的 DOM。 */
function fakeElement(tagName, attributes = {}) {
  return {
    tagName,
    getAttribute: (name) => (name in attributes ? String(attributes[name]) : null),
  }
}

test('isButtonElement：只认 button（大小写不敏感、坏形状回 false）', () => {
  assert.equal(isButtonElement(fakeElement('button')), true)
  assert.equal(isButtonElement(fakeElement('BUTTON')), true)
  assert.equal(isButtonElement(fakeElement('div')), false)
  assert.equal(isButtonElement(null), false)
  assert.equal(isButtonElement({}), false)
})

test('账号行判据：data-signed-out + aria-haspopup 同时成立才算严格命中', () => {
  const trigger = fakeElement('button', { 'aria-haspopup': 'menu', 'data-signed-out': 'false' })
  assert.equal(isAccountTrigger(trigger), true, '未登录时 data-signed-out="false" 也算账号行')
  assert.equal(isAccountRowButton(trigger), true)

  // 只有 aria-haspopup 的按钮页面上不止一个（模型选择器等），不能认。
  assert.equal(isAccountTrigger(fakeElement('button', { 'aria-haspopup': 'menu' })), false)
  // 只有 data-signed-out 的按钮：宽松判据认，严格判据不认。
  const loose = fakeElement('button', { 'data-signed-out': 'true' })
  assert.equal(isAccountRowButton(loose), true)
  assert.equal(isAccountTrigger(loose), false)
  // 不是 button 的元素一律不认。
  assert.equal(isAccountRowButton(fakeElement('div', { 'data-signed-out': 'true' })), false)
  assert.equal(isAccountTrigger(null), false)
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

test('状态机：一次点击就直接进入执行，且带 force（宿主半不会再拦）', () => {
  const state = reduceAction({ ...createActionState(), desktop: true }, { type: 'press' })
  assert.equal(state.phase, 'busy', '不该再有「确认」这一档')
  assert.equal(state.force, true)
  assert.equal(actionDisabled(state), true)
  assert.equal(toneOf(state), 'plain')
})

test('状态机：有任务在跑也照样一次点击执行（只是提示里说明会打断）', () => {
  const state = reduceAction(
    { ...createActionState(), desktop: true, guardHint: '有任务在跑（1 项正在生成）' },
    { type: 'press' },
  )
  assert.equal(state.phase, 'busy')
  assert.equal(state.force, true)
  assert.match(actionTitle(state), /正在排程重启/)
})

test('状态机：非桌面版给出错误态并禁用按钮', () => {
  const state = reduceAction({ ...createActionState(), desktop: false }, { type: 'press' })
  assert.equal(state.phase, 'error')
  assert.equal(actionDisabled(state), true)
  assert.match(actionAriaLabel(state), /仅在桌面版可用/)
})

test('状态机：成功与失败', () => {
  const busy = { ...createActionState(), desktop: true, phase: 'busy' }
  const done = reduceAction(busy, { type: 'result', ok: true, text: '已排程重启' })
  assert.equal(done.phase, 'done')
  assert.equal(toneOf(done), 'plain', '成功也不变色：按钮始终与侧栏文字同色')
  assert.equal(actionDisabled(done), true)

  const failed = reduceAction(busy, { type: 'result', ok: false, text: '请求失败：boom' })
  assert.equal(failed.phase, 'error')
  assert.equal(toneOf(failed), 'error')
  assert.equal(actionDisabled(failed), false, '失败要能再点一次重试')
  assert.match(actionAriaLabel(failed), /单击重试/)
})

test('状态机：busy / done 期间再按无效（不是要再确认一次，而是这一枪已经打出去了）', () => {
  const busy = { ...createActionState(), desktop: true, phase: 'busy' }
  assert.equal(reduceAction(busy, { type: 'press' }), busy)
  const done = { ...createActionState(), desktop: true, phase: 'done' }
  assert.equal(reduceAction(done, { type: 'press' }), done)
})

test('状态机：失败后再点一次回到执行态', () => {
  const failed = { ...createActionState(), desktop: true, phase: 'error', message: 'boom' }
  const retry = reduceAction(failed, { type: 'press' })
  assert.equal(retry.phase, 'busy')
  assert.equal(retry.force, true)
})

test('状态机：status 事件只更新桌面判定与实况，不动相位', () => {
  const state = reduceAction({ ...createActionState(), desktop: true }, { type: 'status', desktop: true, guardHint: '有任务在跑' })
  assert.equal(state.guardHint, '有任务在跑')
  assert.equal(state.phase, 'idle')
  assert.equal(toneOf(state), 'plain', '有任务在跑也不变色：只写进提示文案')
})

test('文案：默认态、有任务在跑的实况与失败态', () => {
  const idle = { ...createActionState(), desktop: true }
  assert.equal(actionTitle(idle), '重启 DSH（保留窗口位置与大小）')
  assert.equal(actionAriaLabel(idle), '重启桌面应用，保留窗口位置与大小')

  const guarded = { ...idle, guardHint: '有任务在跑' }
  assert.match(actionTitle(guarded), /单击仍会重启并打断它们/)
  assert.match(actionAriaLabel(guarded), /单击会打断它们/)

  const failed = { ...idle, phase: 'error', message: '请求失败：boom' }
  assert.equal(actionTitle(failed), '请求失败：boom')
})
