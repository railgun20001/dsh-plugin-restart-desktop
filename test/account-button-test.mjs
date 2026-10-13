/**
 * 账号行图标按钮注入桥的单元测试（用极简假 DOM，不依赖浏览器）。
 *
 * 覆盖：落点算得对（账号行右侧）、宽松判据、点击与悬停回调、幂等、被官方重渲染踢出去
 * 后能插回来、认不出来时不动别人、状态回调、stop 之后不再扫描。
 * 运行：`node --test test/account-button-test.mjs`
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { BUTTON_CLASS, BUTTON_MARKER, startAccountButtonBridge } from '../src/account-button.js'
import { FakeDocument, FakeElement } from './fake-dom.mjs'

/** 造官方那套结构：body > area > accountRoot > menuRoot > trigger。 */
function buildAccountRow(doc, { haspopup = true } = {}) {
  const area = new FakeElement('div', doc)
  area.className = '_2H3hWW_settingsArea'
  const accountRoot = new FakeElement('div', doc)
  accountRoot.className = 'ET65mq_root'
  const menuRoot = new FakeElement('span', doc)
  menuRoot.className = 'ET65mq_anchor'
  const trigger = new FakeElement('button', doc)
  const attributes = { 'data-signed-out': 'false' }
  if (haspopup) attributes['aria-haspopup'] = 'menu'
  for (const [name, value] of Object.entries(attributes)) trigger.setAttribute(name, value)
  menuRoot.appendChild(trigger)
  accountRoot.appendChild(menuRoot)
  area.appendChild(accountRoot)
  doc.body.appendChild(area)
  return { area, accountRoot, menuRoot, trigger }
}

/** 注入进去的那个按钮（按标记找）。 */
function injectedButton(area) {
  return area.children.find((child) => child.getAttribute(BUTTON_MARKER) === '1') ?? null
}

test('把按钮插在账号行右侧（账号行的下一个兄弟节点）', () => {
  const doc = new FakeDocument()
  const { area, accountRoot } = buildAccountRow(doc)

  let activated = 0
  let hovered = 0
  const bridge = startAccountButtonBridge({
    document: doc,
    onActivate: () => { activated += 1 },
    onHover: () => { hovered += 1 },
  })

  const button = injectedButton(area)
  assert.notEqual(button, null, '按钮应当出现在账号动作区里')
  assert.equal(button.className, BUTTON_CLASS)
  assert.equal(button.type, 'button')
  assert.match(button.innerHTML, /<svg/, '图标要带上')
  assert.equal(accountRoot.nextSibling, button, '位置必须是账号行的右侧')

  button.dispatchEvent({ type: 'click' })
  assert.equal(activated, 1, '单击即触发重启动作（没有二次确认）')
  button.dispatchEvent({ type: 'pointerenter' })
  assert.equal(hovered, 1, '悬停时应当去刷新一次宿主状态')

  const status = bridge.status()
  assert.equal(status.supported, true)
  assert.equal(status.found, 1)
  assert.equal(status.injected, 1)
  assert.equal(status.lastReason, 'injected')
  bridge.stop()
})

test('update：忙碌 / 语气 / 提示 / 禁用都写进节点属性', () => {
  const doc = new FakeDocument()
  const { area } = buildAccountRow(doc)
  const bridge = startAccountButtonBridge({ document: doc })

  bridge.update({ busy: true, tone: 'warn', disabled: true, title: '有任务在跑', ariaLabel: '重启桌面应用（有任务在跑）' })
  const button = injectedButton(area)
  assert.equal(button.getAttribute('data-busy'), '1')
  assert.equal(button.getAttribute('data-tone'), 'warn')
  assert.equal(button.getAttribute('title'), '有任务在跑')
  assert.equal(button.getAttribute('aria-label'), '重启桌面应用（有任务在跑）')
  assert.equal(button.disabled, true)

  bridge.update({ busy: false, tone: 'plain', disabled: false, title: '重启 DSH', ariaLabel: '重启桌面应用' })
  assert.equal(button.getAttribute('data-busy'), '0')
  assert.equal(button.getAttribute('data-tone'), 'plain')
  assert.equal(button.disabled, false)
  bridge.stop()
})

test('update 早于注入时，视图会补到后来创建的节点上', () => {
  const doc = new FakeDocument()
  const bridge = startAccountButtonBridge({ document: doc })
  bridge.update({ busy: true, tone: 'plain', disabled: true, title: '正在排程重启…', ariaLabel: '正在排程重启桌面应用' })

  const { area } = buildAccountRow(doc)
  bridge.sweep()
  const button = injectedButton(area)
  assert.equal(button.getAttribute('data-busy'), '1')
  assert.equal(button.getAttribute('title'), '正在排程重启…')
  bridge.stop()
})

test('幂等：同一处不会被插入两次', () => {
  const doc = new FakeDocument()
  const { area } = buildAccountRow(doc)
  const bridge = startAccountButtonBridge({ document: doc })
  assert.equal(area.children.length, 2, '账号行 + 我们的按钮')

  const second = bridge.sweep()
  assert.deepEqual(second, { found: 1, injected: 0 }, '这一轮没有新插入')
  assert.equal(area.children.length, 2)
  assert.equal(bridge.status().lastReason, 'already-present')
  bridge.stop()
})

test('被官方重渲染踢出去之后，下一轮会插回来', () => {
  const doc = new FakeDocument()
  const { area } = buildAccountRow(doc)
  const bridge = startAccountButtonBridge({ document: doc })
  const button = injectedButton(area)

  button.remove()
  assert.equal(button.isConnected, false)
  const result = bridge.sweep()
  assert.deepEqual(result, { found: 1, injected: 1 })
  assert.equal(area.children.length, 2)
  assert.equal(area.children[1], button, '重新插回账号行右侧')
  bridge.stop()
})

test('宽松判据：官方哪天不再写 aria-haspopup，只要还有 data-signed-out 仍认得出', () => {
  const doc = new FakeDocument()
  const { area } = buildAccountRow(doc, { haspopup: false })
  const bridge = startAccountButtonBridge({ document: doc })
  assert.equal(bridge.status().injected, 1)
  assert.notEqual(injectedButton(area), null)
  bridge.stop()
})

test('认不出账号行时什么都不做，别的菜单按钮不受影响', () => {
  const doc = new FakeDocument()
  const other = new FakeElement('button', doc)
  other.setAttribute('aria-haspopup', 'menu')
  doc.body.appendChild(other)

  let injected = 0
  const bridge = startAccountButtonBridge({ document: doc, onStatus: () => { injected += 1 } })
  const status = bridge.status()
  assert.equal(status.found, 0)
  assert.equal(status.injected, 0)
  assert.equal(status.lastReason, 'no-account-row')
  assert.equal(doc.body.children.length, 1, '页面上不该多出任何节点')
  assert.equal(injected > 0, true, '状态要播报出去，回落入口据此决定是否挂上')
  bridge.stop()
})

test('没有 document 时优雅降级，不抛错', () => {
  const bridge = startAccountButtonBridge({ document: undefined, MutationObserver: undefined })
  const status = bridge.status()
  assert.equal(status.supported, false)
  assert.equal(status.lastReason, 'no-document')
  assert.deepEqual(bridge.sweep(), { found: 0, injected: 0 })
  bridge.stop()
})

test('stop 之后不再扫描，并把节点收走', () => {
  const doc = new FakeDocument()
  const { area } = buildAccountRow(doc)
  const bridge = startAccountButtonBridge({ document: doc })
  bridge.stop()
  assert.equal(area.children.length, 1, 'stop 之后我们的节点应当被移除')
  assert.equal(bridge.sweep().injected, 0, 'stop 之后的 sweep 不再注入')
  assert.equal(area.children.length, 1)
})

test('MutationObserver 存在时会被挂上，并在 DOM 变动后自动注入', async () => {
  const doc = new FakeDocument()
  let callback = null
  let observed = null
  class FakeObserver {
    constructor(cb) {
      callback = cb
    }
    observe(target, options) {
      observed = { target, options }
    }
    disconnect() {
      callback = null
    }
  }

  const bridge = startAccountButtonBridge({ document: doc, MutationObserver: FakeObserver, coalesceMs: 1 })
  assert.notEqual(observed, null)
  assert.equal(observed.options.subtree, true)
  assert.equal(observed.target, doc.body)

  const { area } = buildAccountRow(doc)
  callback?.()
  await new Promise((resolve) => { setTimeout(resolve, 20) })

  assert.notEqual(injectedButton(area), null)
  bridge.stop()
})
