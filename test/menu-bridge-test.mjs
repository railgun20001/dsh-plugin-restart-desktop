/**
 * 账号浮窗注入桥的单元测试（用极简假 DOM，不依赖浏览器）。
 *
 * 覆盖：认出账号浮窗才注入、注入项的标记与文案、点击回调、幂等、认不出来时不动别人、
 * stop 之后不再扫描。
 * 运行：`node --test test/menu-bridge-test.mjs`
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ITEM_MARKER, MENU_MARKER, startAccountMenuBridge } from '../src/menu-bridge.js'

/** 一个够用的假元素：只实现桥真正用到的那一小片 DOM API。 */
class FakeElement {
  constructor(tagName) {
    this.tagName = tagName
    this.children = []
    this.parentNode = null
    this.attributes = new Map()
    this.listeners = new Map()
    this.className = ''
    this.innerHTML = ''
    this.type = ''
    this._text = undefined
  }

  /** 与真实 DOM 同语义：显式设过就是那个值，否则由子节点拼出来。 */
  get textContent() {
    if (this._text !== undefined) return this._text
    return this.children.map((child) => child.textContent).join('')
  }

  set textContent(value) {
    this._text = String(value)
    this.children = []
  }

  get firstElementChild() {
    return this.children[0] ?? null
  }

  get nextElementSibling() {
    const siblings = this.parentNode?.children ?? []
    const index = siblings.indexOf(this)
    return index >= 0 ? siblings[index + 1] ?? null : null
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value))
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null
  }

  appendChild(child) {
    child.parentNode = this
    this.children.push(child)
    return child
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, [])
    this.listeners.get(type).push(listener)
  }

  dispatchEvent(event) {
    for (const listener of this.listeners.get(event.type) ?? []) listener(event)
    return true
  }

  /** 只支持桥用到的两种选择器：`[role="menu"]` 与 `button[role="menuitem"]`。 */
  querySelectorAll(selector) {
    const found = []
    const visit = (node) => {
      for (const child of node.children) {
        if (matches(child, selector)) found.push(child)
        visit(child)
      }
    }
    visit(this)
    return found
  }
}

/** 极简选择器匹配。 */
function matches(element, selector) {
  if (selector === '[role="menu"]') return element.getAttribute('role') === 'menu'
  if (selector === 'button[role="menuitem"]') {
    return element.tagName === 'button' && element.getAttribute('role') === 'menuitem'
  }
  throw new Error(`假 DOM 不支持的选择器：${selector}`)
}

/** 造一个菜单项：图标 span + 文案 span，与官方 Menu 的结构一致。 */
function menuItem(label) {
  const button = new FakeElement('button')
  button.setAttribute('role', 'menuitem')
  button.className = 'menu-item-hash'
  const icon = new FakeElement('span')
  icon.className = 'menu-icon-hash'
  const text = new FakeElement('span')
  text.className = 'menu-label-hash'
  text.textContent = label
  button.appendChild(icon)
  button.appendChild(text)
  return button
}

/** 造一个 `[role="menu"]`，其结构为 menu > viewport > items（与官方 MenuSurface 一致）。 */
function buildMenu(labels) {
  const menu = new FakeElement('div')
  menu.setAttribute('role', 'menu')
  const viewport = new FakeElement('div')
  viewport.setAttribute('role', 'presentation')
  menu.appendChild(viewport)
  for (const label of labels) viewport.appendChild(menuItem(label))
  return { menu, viewport }
}

/** 造一个假 document。 */
function fakeDocument() {
  const body = new FakeElement('body')
  const doc = {
    body,
    documentElement: body,
    createElement: (tag) => new FakeElement(tag),
    querySelectorAll: (selector) => body.querySelectorAll(selector),
    defaultView: {
      KeyboardEvent: class {
        constructor(type, init) {
          this.type = type
          this.key = init?.key
        }
      },
    },
  }
  return doc
}

test('认出账号浮窗后，在最后一项下方注入同款菜单项', () => {
  const doc = fakeDocument()
  const { menu, viewport } = buildMenu(['设置', '意见反馈', '退出登录'])
  doc.body.appendChild(menu)

  let activated = 0
  const bridge = startAccountMenuBridge({ document: doc, onActivate: () => { activated += 1 } })

  const items = viewport.querySelectorAll('button[role="menuitem"]')
  assert.equal(items.length, 4, '应当多出一项')
  const injected = items[3]
  assert.equal(injected.getAttribute(ITEM_MARKER), '1')
  assert.equal(injected.getAttribute('role'), 'menuitem')
  assert.equal(injected.className, 'menu-item-hash', '类名要抄自同菜单的邻居，才能跟着官方改版走')
  assert.equal(injected.children[0].className, 'menu-icon-hash')
  assert.equal(injected.children[1].className, 'menu-label-hash')
  assert.equal(injected.children[1].textContent, '重启 DSH')
  assert.equal(menu.getAttribute(MENU_MARKER), '1')

  injected.dispatchEvent({ type: 'click', preventDefault() {}, stopPropagation() {} })
  assert.equal(activated, 1)

  const status = bridge.status()
  assert.equal(status.found, 1)
  assert.equal(status.injected, 1)
  bridge.stop()
})

test('幂等：同一菜单不会被注入两次', () => {
  const doc = fakeDocument()
  const { menu, viewport } = buildMenu(['设置', '退出登录'])
  doc.body.appendChild(menu)

  const bridge = startAccountMenuBridge({ document: doc, onActivate: () => {} })
  assert.equal(viewport.querySelectorAll('button[role="menuitem"]').length, 3)
  assert.deepEqual(bridge.sweep(), { found: 0, injected: 0 })
  assert.equal(viewport.querySelectorAll('button[role="menuitem"]').length, 3)
  bridge.stop()
})

test('认不出来就不动别人的菜单', () => {
  const doc = fakeDocument()
  const other = buildMenu(['重命名', '归档', '删除'])
  const onlySettings = buildMenu(['设置', '关于'])
  doc.body.appendChild(other.menu)
  doc.body.appendChild(onlySettings.menu)

  const bridge = startAccountMenuBridge({ document: doc, onActivate: () => {} })
  assert.equal(other.viewport.querySelectorAll('button[role="menuitem"]').length, 3)
  assert.equal(onlySettings.viewport.querySelectorAll('button[role="menuitem"]').length, 2)
  assert.equal(bridge.status().injected, 0)
  bridge.stop()
})

test('英文界面的账号浮窗同样认得出', () => {
  const doc = fakeDocument()
  const { menu, viewport } = buildMenu(['Settings', 'Feedback', 'Sign out'])
  doc.body.appendChild(menu)

  const bridge = startAccountMenuBridge({ document: doc, onActivate: () => {} })
  assert.equal(viewport.querySelectorAll('button[role="menuitem"]').length, 4)
  assert.equal(bridge.status().injected, 1)
  bridge.stop()
})

test('没有 document 时优雅降级，不抛错', () => {
  const bridge = startAccountMenuBridge({ document: undefined, MutationObserver: undefined, onActivate: () => {} })
  const status = bridge.status()
  assert.equal(status.supported, false)
  assert.equal(status.lastReason, 'no-document')
  assert.deepEqual(bridge.sweep(), { found: 0, injected: 0 })
  bridge.stop()
})

test('stop 之后不再扫描', () => {
  const doc = fakeDocument()
  const bridge = startAccountMenuBridge({ document: doc, onActivate: () => {} })
  bridge.stop()
  const { menu, viewport } = buildMenu(['设置', '退出登录'])
  doc.body.appendChild(menu)
  assert.deepEqual(bridge.sweep(), { found: 0, injected: 0 })
  assert.equal(viewport.querySelectorAll('button[role="menuitem"]').length, 2)
})

test('MutationObserver 存在时会被挂上，并在 DOM 变动后自动注入', async () => {
  const doc = fakeDocument()
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

  const bridge = startAccountMenuBridge({ document: doc, MutationObserver: FakeObserver, onActivate: () => {}, coalesceMs: 1 })
  assert.notEqual(observed, null)
  assert.equal(observed.options.subtree, true)

  const { menu, viewport } = buildMenu(['设置', '退出登录'])
  doc.body.appendChild(menu)
  callback?.()
  await new Promise((resolve) => { setTimeout(resolve, 20) })

  assert.equal(viewport.querySelectorAll('button[role="menuitem"]').length, 3)
  bridge.stop()
})
