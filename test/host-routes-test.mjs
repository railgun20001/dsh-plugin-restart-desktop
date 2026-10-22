/**
 * 宿主半的挂载与路由冒烟测试。
 *
 * 用一个假 ctx 把插件真正 `apply` 一遍，然后按真实 HTTP 形状调用它注册的路由，
 * 验证：状态路由的契约、可信请求判定、非桌面宿主拒绝重启、设置写入、未知动作 404。
 *
 * 刻意把 `DSH_HOME` 指到临时目录**之后**再 import —— `STATE_DIR` 是模块级常量，
 * 否则这个测试会去写用户真实的 `~/.dsh/restart-desktop/settings.json`。
 *
 * 运行：`node --test test/host-routes-test.mjs`
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const home = mkdtempSync(join(tmpdir(), 'dsrd-routes-'))
process.env.DSH_HOME = home

const { ROUTE_PREFIX, apply } = await import('../index.js')
const { markerSessionIds } = await import('../lib/resume.mjs')

/** 造一个够用的假 host ctx。 */
function fakeContext({ agents, jobs } = {}) {
  const registered = []
  const commands = []
  const disposers = []
  const ctx = {
    logger: () => ({ info: () => {} }),
    get: (name) => {
      if (name === 'agents') return agents
      if (name === 'jobs') return jobs
      return undefined
    },
    effect: (fn) => {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {}
    },
    inject: (deps, callback) => {
      // 本插件只对 commands 做软注入；测试里直接满足它。
      const scoped = {
        effect: ctx.effect,
        commands: { register: (definition) => { commands.push(definition); return () => {} } },
      }
      callback(scoped)
      return () => {}
    },
    webServer: {
      port: 19387,
      register: (route) => {
        registered.push(route)
        return () => {}
      },
    },
  }
  return { ctx, registered, commands, disposers }
}

/** 造一个假的 node:http 请求。 */
function request({ method = 'GET', url = '/', origin = 'http://127.0.0.1:19387', headers = {}, remoteAddress = '127.0.0.1' } = {}) {
  return {
    method,
    url,
    headers: { host: '127.0.0.1:19387', ...(origin === null ? {} : { origin }), ...headers },
    socket: { remoteAddress },
    resume() {},
  }
}

/** 造一个假的 node:http 响应，把写出的内容收集起来。 */
function response() {
  const captured = { status: null, body: null }
  return {
    captured,
    writeHead(status) { captured.status = status },
    end(text) { captured.body = text === undefined ? null : JSON.parse(text) },
  }
}

/** 挂载一次插件，返回它注册的路由处理器。 */
function mount(options) {
  const { ctx, registered, commands } = fakeContext(options)
  apply(ctx, {})
  const route = registered.find((entry) => entry.path === ROUTE_PREFIX)
  assert.notEqual(route, undefined, '插件应当注册前缀路由')
  return { route, commands, registered }
}

/** 调一次路由。 */
async function call(route, req) {
  const res = response()
  await route.handler(req, res)
  return res.captured
}

test('状态路由：返回版本、桌面判定、开关与守卫', async () => {
  const { route } = mount()
  const result = await call(route, request({ url: `${ROUTE_PREFIX}/api/status` }))
  assert.equal(result.status, 200)
  assert.equal(result.body.host, 'dsh-restart-desktop')
  assert.equal(typeof result.body.version, 'string')
  // 测试跑在 node.exe 下，不是 Electron 桌面宿主。
  assert.equal(result.body.desktop, false)
  assert.equal(result.body.enabled, true)
  assert.equal(result.body.entries, undefined, '客户端已经没有入口开关了')
  // 平台能力与宿主形态是两件事：这里不是桌面宿主，但平台能力仍应如实给出。
  assert.equal(result.body.platform, process.platform)
  assert.equal(result.body.capabilities.restart, process.platform === 'win32')
  assert.equal(result.body.capabilities.geometry, process.platform === 'win32' ? 'win32-powershell' : null)
  assert.equal(result.body.capabilities.reason === null, process.platform === 'win32', '能重启时没有拒绝原因，不能时必须有')
  assert.deepEqual(result.body.settings, { geometry: true, resume: true })
  assert.equal(result.body.guard.active, false)
})

test('桌面版但平台不支持：能力如实报告，重启在动手之前就被拒绝', async () => {
  // 模拟「macOS 上的桌面版」：桌面宿主判据成立，但这个平台还没有进程控制驱动。
  // 期望行为是明确拒绝（409 + 原因），而不是放行后空等 15 秒、再空拉三次。
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  const originalExecPath = Object.getOwnPropertyDescriptor(process, 'execPath')
  const originalRunAsNode = process.env.ELECTRON_RUN_AS_NODE
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
  Object.defineProperty(process, 'execPath', {
    value: '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness',
    configurable: true,
  })
  process.env.ELECTRON_RUN_AS_NODE = '1'
  try {
    const { route } = mount()

    const status = await call(route, request({ url: `${ROUTE_PREFIX}/api/status` }))
    assert.equal(status.body.desktop, true, 'macOS 桌面版仍然是桌面宿主')
    assert.equal(status.body.platform, 'darwin')
    assert.equal(status.body.capabilities.restart, false)
    assert.equal(status.body.capabilities.geometry, null)
    assert.match(status.body.capabilities.reason, /darwin/)

    const plain = await call(route, request({ method: 'POST', url: `${ROUTE_PREFIX}/api/restart` }))
    assert.equal(plain.status, 409)
    assert.equal(plain.body.ok, false)
    assert.equal(plain.body.platform, 'darwin')
    assert.match(plain.body.error, /只支持 Windows 桌面版/)
    assert.equal(plain.body.guard, undefined, '平台不支持是硬拒绝，与「要不要继续」无关')

    // force 也绕不过去：这个平台上根本没有可执行的结束/拉起手段。
    const forced = await call(route, request({ method: 'POST', url: `${ROUTE_PREFIX}/api/restart?force=1` }))
    assert.equal(forced.status, 409)
    assert.match(forced.body.error, /darwin/)
  } finally {
    if (originalPlatform === undefined) delete process.platform
    else Object.defineProperty(process, 'platform', originalPlatform)
    if (originalExecPath === undefined) delete process.execPath
    else Object.defineProperty(process, 'execPath', originalExecPath)
    if (originalRunAsNode === undefined) delete process.env.ELECTRON_RUN_AS_NODE
    else process.env.ELECTRON_RUN_AS_NODE = originalRunAsNode
  }
})

test('可信请求：非回环来源一律 403', async () => {
  const { route } = mount()
  const foreign = await call(route, request({ url: `${ROUTE_PREFIX}/api/status`, origin: 'http://evil.example' }))
  assert.equal(foreign.status, 403)
  const remote = await call(route, request({ url: `${ROUTE_PREFIX}/api/status`, remoteAddress: '10.0.0.9' }))
  assert.equal(remote.status, 403)
})

test('非桌面宿主：重启被拒绝并说明原因（不能误杀进程）', async () => {
  const { route } = mount()
  const result = await call(route, request({ method: 'POST', url: `${ROUTE_PREFIX}/api/restart` }))
  assert.equal(result.status, 409)
  assert.equal(result.body.ok, false)
  assert.match(result.body.error, /不是 DeepSeek Harness 桌面版/)
})

test('非桌面宿主是硬拒绝：force 也绕不过去，守卫根本不会被问到', async () => {
  const agents = {
    list: () => [{ id: 'a', status: 'running', inbox: { nextTurn: [], nextStep: [] } }],
  }
  const jobs = { list: () => [] }
  const { route } = mount({ agents, jobs })

  const plain = await call(route, request({ method: 'POST', url: `${ROUTE_PREFIX}/api/restart` }))
  assert.equal(plain.status, 409)
  assert.equal(plain.body.guard, undefined, '「不是桌面版」是硬拒绝，不该被当成「要不要继续」的问题')
  assert.match(plain.body.error, /不是 DeepSeek Harness 桌面版/)

  const forced = await call(route, request({ method: 'POST', url: `${ROUTE_PREFIX}/api/restart?force=1` }))
  assert.equal(forced.status, 409)
  assert.match(forced.body.error, /不是 DeepSeek Harness 桌面版/)
})

test('假装是桌面宿主：守卫先拦一次，force=1 才真的去交接', async () => {
  // 把进程伪装成 Electron-as-Node 宿主。`desktopTarget()` 只看这三件事，
  // 因此这是对「守卫 → 交接」这条真实路径的完整演练。
  const originalExecPath = Object.getOwnPropertyDescriptor(process, 'execPath')
  const originalRunAsNode = process.env.ELECTRON_RUN_AS_NODE
  Object.defineProperty(process, 'execPath', { value: 'C:\\nonexistent\\DeepSeek Harness.exe', configurable: true })
  process.env.ELECTRON_RUN_AS_NODE = '1'
  try {
    const agents = { list: () => [{ id: 'a', status: 'running', inbox: { nextTurn: [], nextStep: [] } }] }
    const jobs = { list: () => [] }
    const { route } = mount({ agents, jobs })

    const status = await call(route, request({ url: `${ROUTE_PREFIX}/api/status` }))
    assert.equal(status.body.desktop, true, '伪装后应当被认成桌面宿主')

    // 守卫先拦：带原因、带 guard.active，且尚未写任何交接描述。
    const guarded = await call(route, request({ method: 'POST', url: `${ROUTE_PREFIX}/api/restart?session=session-x` }))
    assert.equal(guarded.status, 409)
    assert.equal(guarded.body.guard.active, true)
    assert.match(guarded.body.error, /有任务在跑/)
    assert.match(guarded.body.error, /确认要继续吗/)

    // force=1：跳过守卫，真的走到「写交接描述 + 拉起 helper」。
    // 可执行文件是假的，helper 起不来 —— 必须如实回 500 且**不能**把宿主带崩
    // （spawn 的失败是异步事件，没挂监听器就是未捕获异常）。
    const forced = await call(route, request({ method: 'POST', url: `${ROUTE_PREFIX}/api/restart?force=1&session=session-x` }))
    assert.equal(forced.status, 500)
    assert.equal(forced.body.ok, false)
    assert.match(forced.body.error, /辅助进程没能启动/)

    // 恢复标记按「宿主自己看到的实况」写：这一刻在跑的是 a，不是请求里那个 session-x。
    // 早先只认 session-x，于是后台被打断的会话一条恢复消息都拿不到。
    const marker = JSON.parse(readFileSync(join(home, 'restart-desktop', 'pending-resume.json'), 'utf8'))
    assert.deepEqual(marker.sessions, ['a'])
    assert.equal(marker.interrupted, true)
    assert.equal(marker.sessionId, 'session-x', 'sessionId 保留客户端报的那个，供状态页展示')
    assert.deepEqual(
      markerSessionIds(marker),
      ['a'],
      'sessionId 只是展示值：客户端当前会话不在实况名单里，重启后不能把它一起唤醒',
    )
  } finally {
    if (originalExecPath === undefined) delete process.execPath
    else Object.defineProperty(process, 'execPath', originalExecPath)
    if (originalRunAsNode === undefined) delete process.env.ELECTRON_RUN_AS_NODE
    else process.env.ELECTRON_RUN_AS_NODE = originalRunAsNode
  }
})

test('设置路由：写入宿主侧设置并立即回读', async () => {
  const { route } = mount()
  const off = await call(route, request({ method: 'POST', url: `${ROUTE_PREFIX}/api/settings?resume=0&geometry=0` }))
  assert.equal(off.status, 200)
  assert.deepEqual(off.body.settings, { geometry: false, resume: false })

  const status = await call(route, request({ url: `${ROUTE_PREFIX}/api/status` }))
  assert.deepEqual(status.body.settings, { geometry: false, resume: false }, '设置应当立刻在状态里生效')

  const settingsFile = join(home, 'restart-desktop', 'settings.json')
  assert.equal(existsSync(settingsFile), true)
  assert.deepEqual(JSON.parse(readFileSync(settingsFile, 'utf8')), { resume: false, geometry: false })

  // 坏值忽略，不改动已有设置。
  const bad = await call(route, request({ method: 'POST', url: `${ROUTE_PREFIX}/api/settings?resume=maybe` }))
  assert.deepEqual(bad.body.settings, { geometry: false, resume: false })

  // 恢复默认，避免影响后面的用例。
  await call(route, request({ method: 'POST', url: `${ROUTE_PREFIX}/api/settings?resume=1&geometry=1` }))
})

test('ping / 未知动作 / 方法不匹配', async () => {
  const { route } = mount()
  const ping = await call(route, request({ method: 'POST', url: `${ROUTE_PREFIX}/api/ping` }))
  assert.equal(ping.status, 200)
  assert.equal(ping.body.host, 'dsh-restart-desktop')

  const unknown = await call(route, request({ url: `${ROUTE_PREFIX}/api/nope` }))
  assert.equal(unknown.status, 404)
  assert.equal(unknown.body.error, 'unknown-action')

  // 动作对了但方法不对：同样落到 404（路由只认它自己那一种方法）。
  const wrongMethod = await call(route, request({ method: 'GET', url: `${ROUTE_PREFIX}/api/restart` }))
  assert.equal(wrongMethod.status, 404)
})

test('斜杠命令：注册 /restart-desktop，非桌面宿主时给出可操作的错误', async () => {
  const { commands } = mount()
  const command = commands.find((entry) => entry.name === 'restart-desktop')
  assert.notEqual(command, undefined, '应当注册 /restart-desktop')
  assert.match(command.description, /重启整个 DeepSeek Harness 桌面应用/)

  const result = await command.handler({ rawInput: '/restart-desktop', agent: { id: 'session-1' } })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /不是 DeepSeek Harness 桌面版/)
})

test('commands 服务缺失时插件照常挂载（斜杠命令是软依赖）', () => {
  const { ctx, registered } = fakeContext()
  // Cordis 的 inject 在服务缺失时只是「不执行回调」，不抛错 —— 这里照此建模。
  ctx.inject = () => {}
  assert.doesNotThrow(() => apply(ctx, {}))
  assert.equal(registered.some((entry) => entry.path === ROUTE_PREFIX), true)
})

test.after(() => {
  rmSync(home, { recursive: true, force: true })
})
