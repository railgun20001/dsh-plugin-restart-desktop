/**
 * 客户端 bundle 的冒烟测试：在 Node 里用假 window / document / React 把
 * `lib/client.js` 真正执行一遍。
 *
 * 这一层的价值在于抓「语法合法但运行时报错」的错 —— 那种错在真实应用里的表现是
 * 整个 web boot 失败（客户端模块系统会重试同一个 bundle，第二次注册同一个 factory
 * 会以 "duplicate factory registration" 收场），代价远高于一个入口不显示。
 *
 * 覆盖：factory 能注册、apply 能跑完、账号行有按钮时只挂提示浮层、账号行认不出来时
 * 回落到官方座位、slots 缺失时优雅退出、刷新后的「已重启」提示消费掉、诊断入口可用。
 *
 * 运行：`node --test test/client-bundle-test.mjs`
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { FakeDocument, FakeElement } from './fake-dom.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')

/** 一个够用的 React 替身：这里只要求 factory 能跑完，组件不会被真正渲染。 */
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: Symbol('Fragment'),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
}

/**
 * 造一个假文档：bundle 会在模块作用域里注入 `<style>`，因此 head / createElement /
 * querySelector 都得在。
 * @param {{ accountRow?: boolean }} [options] 是否预先放一行账号。
 * @returns {FakeDocument} 假文档。
 */
function bundleDocument(options = {}) {
  const doc = new FakeDocument()
  doc.head = new FakeElement('head', doc)
  doc.defaultView = {}
  doc.querySelector = () => null
  if (options.accountRow === true) {
    const area = new FakeElement('div', doc)
    const accountRoot = new FakeElement('div', doc)
    const menuRoot = new FakeElement('span', doc)
    const trigger = new FakeElement('button', doc)
    trigger.setAttribute('data-signed-out', 'false')
    trigger.setAttribute('aria-haspopup', 'menu')
    menuRoot.appendChild(trigger)
    accountRoot.appendChild(menuRoot)
    area.appendChild(accountRoot)
    doc.body.appendChild(area)
  }
  return doc
}

/** 一个够用的 localStorage 替身。 */
function fakeLocalStorage(seed = {}) {
  const store = new Map(Object.entries(seed))
  return {
    store,
    get length() { return store.size },
    key: (index) => [...store.keys()][index] ?? null,
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)) },
    removeItem: (key) => { store.delete(key) },
  }
}

/** require 替身：只认 react，别的都当错误（用来证明 bundle 没有别的依赖）。 */
function fakeRequire(id) {
  if (id === 'react') return fakeReact
  throw new Error(`意外的 require：${id}`)
}

/**
 * 执行 bundle，取回它注册的 factory 产物。
 * @param {{ localStorage?: object, document?: object }} [options] 注入的全局替身。
 * @returns {{ apply: Function, inject: string[], id: string }} 客户端半的导出。
 */
function loadBundle(options = {}) {
  let captured = null
  const windowShim = { __ModuleLoader__: { load: (registration) => { captured = registration } } }
  // eslint-disable-next-line no-new-func
  const run = new Function('window', 'document', 'localStorage', 'fetch', 'MutationObserver', 'require', BUNDLE)
  run(
    windowShim,
    options.document ?? bundleDocument(),
    options.localStorage,
    undefined,
    undefined,
    fakeRequire,
  )
  assert.notEqual(captured, null, 'bundle 必须调用 window.__ModuleLoader__.load')
  assert.equal(captured.id, 'dsh-restart-desktop', 'factory id 必须等于包名')
  return { ...captured.factory(fakeRequire), id: captured.id }
}

/** 造一个假客户端 ctx，记录所有座位注册。 */
function fakeContext({ withSlots = true } = {}) {
  const registrations = []
  const slots = {
    inject: (_name, callback) => {
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    register: (options, component) => {
      registrations.push({ options, component })
      return () => {}
    },
  }
  const logs = []
  const ctx = {
    get: (name) => (withSlots && name === 'slots' ? slots : undefined),
    effect: (fn) => {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    logger: { info: (message) => logs.push(message), warn: (message) => logs.push(message) },
  }
  return { ctx, registrations, logs }
}

/** 已注册座位的名字（去重）。 */
const slotNames = (registrations) => [...new Set(registrations.map((entry) => entry.options.name))].sort()

/** 等观察期过去（回落入口的判定发生在观察期结束时）。 */
const afterGrace = () => new Promise((resolve) => { setTimeout(resolve, 900) })

test('bundle 注册 factory 并导出 apply / inject', () => {
  const loaded = loadBundle()
  assert.equal(typeof loaded.apply, 'function')
  assert.deepEqual(loaded.inject, ['slots'])
})

test('apply：账号行已经在了 → 只挂提示浮层，不挂官方座位的回落入口', async () => {
  const doc = bundleDocument({ accountRow: true })
  const loaded = loadBundle({ document: doc })
  const { ctx, registrations } = fakeContext()
  loaded.apply(ctx)

  const injected = doc.body.querySelectorAll('button[data-dsh-restart-desktop-button="1"]')
  assert.equal(injected.length, 1, '账号行右侧应当已经出现图标按钮')

  await afterGrace()
  assert.deepEqual(slotNames(registrations), ['shell.overlay'], '注入成功就不该再有回落入口')
  for (const entry of registrations) {
    assert.equal(typeof entry.component, 'function', `${entry.options.name} 的组件必须是函数`)
    assert.equal(typeof entry.options.id, 'string')
  }
})

test('apply：账号行认不出来 → 观察期过后回落到官方 sidebar.footer.action 座位', async () => {
  const loaded = loadBundle()
  const { ctx, registrations, logs } = fakeContext()
  loaded.apply(ctx)
  assert.deepEqual(slotNames(registrations), ['shell.overlay'], '观察期内先不挂回落入口')

  await afterGrace()
  assert.deepEqual(slotNames(registrations), ['shell.overlay', 'sidebar.footer.action'])
  assert.equal(logs.some((line) => line.includes('改用侧栏底部的官方座位')), true)
  const fallback = registrations.find((entry) => entry.options.name === 'sidebar.footer.action')
  assert.equal(fallback.options.label, '重启 DSH')
})

test('apply：没有 slots 服务时优雅退出，不抛错', () => {
  const loaded = loadBundle()
  const { ctx, registrations } = fakeContext({ withSlots: false })
  const warnings = []
  const originalWarn = console.warn
  console.warn = (...args) => { warnings.push(args.join(' ')) }
  try {
    assert.doesNotThrow(() => loaded.apply(ctx))
  } finally {
    console.warn = originalWarn
  }
  assert.equal(registrations.length, 0)
  assert.equal(warnings.some((line) => line.includes('没有拿到 slots 服务')), true)
})

test('apply：页面重载后提示一次「已重启」，并把标记消费掉', () => {
  const localStorageShim = fakeLocalStorage({
    'dsh-restart-desktop/pending-v1': JSON.stringify({ at: Date.now(), sessionId: 'session-1' }),
  })
  const loaded = loadBundle({ localStorage: localStorageShim })
  loaded.apply(fakeContext().ctx)
  assert.equal(localStorageShim.store.has('dsh-restart-desktop/pending-v1'), false, '标记必须被消费，否则每次刷新都提示')
})

test('诊断入口：暴露版本与账号行按钮状态', () => {
  const loaded = loadBundle()
  loaded.apply(fakeContext().ctx)
  const diagnostics = globalThis.__DSH_RESTART_DESKTOP__
  assert.notEqual(diagnostics, undefined, '应当暴露诊断入口')
  // 版本从 package.json 读，跟着发版走 —— 免得每次改版本都要改测试。
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(diagnostics.version, pkg.version)
  const button = diagnostics.button()
  assert.equal(button.injected, 0)
  assert.equal(button.supported, true)
  assert.equal(diagnostics.action().phase, 'idle')
  delete globalThis.__DSH_RESTART_DESKTOP__
})
