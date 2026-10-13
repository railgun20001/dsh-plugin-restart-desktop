/**
 * 宿主半纯逻辑的单元测试。
 *
 * 覆盖：桌面宿主判据、开关优先级、任务守卫、安装守卫、可信请求判定、查询参数解析、
 * 交接目录清理、设置文件读写、profile 目录校验。
 * 运行：`node --test test/host-core-test.mjs`
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  desktopTarget,
  forceRequested,
  guardReasons,
  guardSnapshot,
  installInProgress,
  interruptedSessions,
  parseQuery,
  pruneState,
  readSettings,
  resolveOptions,
  resolveProfileDir,
  taskSnapshot,
  trustedRequest,
  validProfileDir,
  writeSettings,
} from '../index.js'

/** 造一个临时目录，测试结束自动清理。 */
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'dsrd-test-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** 造一个假的 http 请求。 */
function request({ host = '127.0.0.1:19387', origin, headers = {}, remoteAddress = '127.0.0.1' } = {}) {
  return { headers: { host, ...(origin === undefined ? {} : { origin }), ...headers }, socket: { remoteAddress } }
}

test('desktopTarget：只有 Electron-as-Node 的桌面宿主才算目标', () => {
  const target = desktopTarget({
    env: { ELECTRON_RUN_AS_NODE: '1' },
    execPath: 'C:\\Users\\x\\AppData\\Local\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe',
    ppid: 1234,
    pid: 5678,
  })
  assert.deepEqual(target, {
    mainPid: 1234,
    exe: 'C:\\Users\\x\\AppData\\Local\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe',
    hostPid: 5678,
  })

  // 普通 Node 宿主（dsh web / headless）不算。
  assert.equal(desktopTarget({ env: {}, execPath: 'C:\\nodejs\\node.exe', ppid: 1, pid: 2 }), null)
  // 没有 ELECTRON_RUN_AS_NODE 的 Electron 主进程本身也不算。
  assert.equal(desktopTarget({ env: {}, execPath: 'C:\\app\\DeepSeek Harness.exe', ppid: 1, pid: 2 }), null)
  // 父进程拿不到时拒绝，绝不误杀。
  assert.equal(desktopTarget({ env: { ELECTRON_RUN_AS_NODE: '1' }, execPath: 'C:\\app\\app.exe', ppid: 0, pid: 2 }), null)
})

test('resolveOptions：用户设置 > config > 默认', () => {
  assert.deepEqual(resolveOptions({}, {}), {
    enabled: true,
    geometry: true,
    resume: true,
    entries: { accountMenu: true, footer: true, settingsRow: true },
  })
  assert.equal(resolveOptions({ resume: false }, { resume: true }).resume, true, '用户设置优先于 config')
  assert.equal(resolveOptions({ geometry: false }, {}).geometry, false)
  assert.equal(resolveOptions({}, { enabled: false }).enabled, false)
  assert.deepEqual(resolveOptions({ entries: { footer: false } }, {}).entries, {
    accountMenu: true,
    footer: false,
    settingsRow: true,
  })
  // 坏形状按「没配」处理。
  assert.equal(resolveOptions({ resume: 'yes' }, { resume: 'no' }).resume, true)
})

test('installInProgress：认 .plugin-manager/run.json，读不动也按「有」处理', () => {
  const { dir, cleanup } = tempDir()
  try {
    assert.deepEqual(installInProgress(null), { known: false, active: false, pid: null, record: null })
    assert.deepEqual(installInProgress(dir), { known: true, active: false, pid: null, record: null })

    mkdirSync(join(dir, '.plugin-manager'), { recursive: true })
    writeFileSync(join(dir, '.plugin-manager', 'run.json'), '{"pid":4242}', 'utf8')
    const active = installInProgress(dir)
    assert.equal(active.known, true)
    assert.equal(active.active, true)
    assert.equal(active.pid, 4242)

    writeFileSync(join(dir, '.plugin-manager', 'run.json'), '{ not json', 'utf8')
    const broken = installInProgress(dir)
    assert.equal(broken.active, true, '内容坏了照样按「有」处理：宁可多问一次')
    assert.equal(broken.pid, null)
  } finally {
    cleanup()
  }
})

test('taskSnapshot / guardReasons：复刻应用的「有没有活在跑」判据', () => {
  const agents = {
    list: () => [
      { id: 'a', status: 'running', inbox: { nextTurn: [], nextStep: [] } },
      { id: 'b', status: 'inactive', inbox: { nextTurn: [{}], nextStep: [] } },
      { id: 'c', status: 'inactive', inbox: { nextTurn: [], nextStep: [] } },
    ],
  }
  const jobs = {
    list: (id) => (id === undefined ? [{ status: 'running' }] : [{ status: 'done' }]),
  }
  const ctx = { get: (name) => (name === 'agents' ? agents : name === 'jobs' ? jobs : undefined) }

  const snapshot = taskSnapshot(ctx)
  assert.equal(snapshot.known, true)
  assert.equal(snapshot.turns, 1)
  assert.equal(snapshot.queued, 1)
  assert.equal(snapshot.jobs, 1)
  assert.equal(snapshot.sessions, 3)
  assert.equal(snapshot.active, true)

  const reasons = guardReasons(snapshot, { active: false, pid: null })
  assert.equal(reasons.length, 1)
  assert.match(reasons[0], /有任务在跑/)
  assert.match(reasons[0], /1 项正在生成或运行工具/)
  assert.match(reasons[0], /1 个会话有排队消息/)
  assert.match(reasons[0], /1 个后台任务在跑/)

  // 服务缺失 → known:false → 守卫静默跳过，绝不把按钮拦死。
  const unknown = taskSnapshot({ get: () => undefined })
  assert.equal(unknown.known, false)
  assert.equal(unknown.active, false)
  assert.deepEqual(guardReasons(unknown, { active: false, pid: null }), [])

  // 形状不认识也不能抛。
  assert.equal(taskSnapshot({ get: (name) => (name === 'agents' ? {} : {}) }).known, false)
  assert.equal(taskSnapshot({}).known, false)
})

test('lib/geometry.ps1 必须保持 ASCII-only（5.1 按 ANSI 读无 BOM 脚本）', () => {
  // 这条不是洁癖：实测踩过 —— 一句中文注释的字节被按 GBK 解码后吞掉了行尾换行，
  // 于是下一行（`$wantedMonitor = ConvertTo-Monitor $saved.monitor`）整行变成了注释的
  // 一部分，还原时静默拿不到目标显示器（wanted: null、onTarget: false，且不再纠偏）。
  // 脚本自己也在文件头写明了这条约束，这里把它钉成断言。
  const text = readFileSync(new URL('../lib/geometry.ps1', import.meta.url), 'utf8')
  const offenders = text.split(/\r?\n/u)
    .map((line, index) => ({ line, number: index + 1 }))
    .filter((entry) => /[^\u0000-\u007F]/u.test(entry.line))
  assert.deepEqual(
    offenders.map((entry) => entry.number),
    [],
    `lib/geometry.ps1 第 ${offenders.map((entry) => String(entry.number)).join('、')} 行含非 ASCII 字符：PowerShell 5.1 会把它们解码坏，可能连行尾换行一起吞掉`,
  )
})

test('interruptedSessions：只列出「重启那一刻真的在跑」的会话', () => {
  // 这就是上报现场的那个形状：用户当前打开的是 codefree 会话（空闲，最后一轮 7 分钟前
  // 就完成了），真正被打断的是另一个会话里挂着的长任务。名单必须以后者为准。
  const agents = {
    list: () => [
      { id: 'idle-current', status: 'inactive', inbox: { nextTurn: [], nextStep: [] } },
      { id: 'long-task', status: 'running', inbox: { nextTurn: [], nextStep: [] } },
      { id: 'queued', status: 'inactive', inbox: { nextTurn: [{}, {}], nextStep: [] } },
      { id: 'with-job', status: 'inactive', inbox: { nextTurn: [], nextStep: [] } },
    ],
  }
  const jobs = {
    list: (id) => (id === 'with-job' ? [{ status: 'running' }, { status: 'done' }] : []),
  }
  const ctx = { get: (name) => (name === 'agents' ? agents : name === 'jobs' ? jobs : undefined) }

  assert.deepEqual(interruptedSessions(ctx), [
    { id: 'long-task', running: true, queued: 0, jobs: 0 },
    { id: 'queued', running: false, queued: 2, jobs: 0 },
    { id: 'with-job', running: false, queued: 0, jobs: 1 },
  ])

  // 一个都没在跑：名单为空 —— 重启空闲应用不该凭空唤醒任何会话。
  const quiet = { get: (name) => (name === 'agents' ? { list: () => [{ id: 'a', status: 'inactive' }] } : { list: () => [] }) }
  assert.deepEqual(interruptedSessions(quiet), [])

  // 服务缺失 / 形状不认识 / 抛错：一律空名单（宁可一条都不恢复，也不凭猜测发消息）。
  assert.deepEqual(interruptedSessions({ get: () => undefined }), [])
  assert.deepEqual(interruptedSessions({}), [])
  assert.deepEqual(interruptedSessions({ get: (name) => (name === 'agents' ? { list: () => { throw new Error('boom') } } : undefined) }), [])
  assert.deepEqual(interruptedSessions({ get: (name) => (name === 'agents' ? { list: () => 'nope' } : undefined) }), [])
})

test('guardSnapshot：安装记录也算守卫原因', () => {
  const { dir, cleanup } = tempDir()
  try {
    mkdirSync(join(dir, '.plugin-manager'), { recursive: true })
    writeFileSync(join(dir, '.plugin-manager', 'run.json'), '{"pid":7}', 'utf8')
    const guard = guardSnapshot({ get: () => undefined }, dir)
    assert.equal(guard.active, true)
    assert.equal(guard.reasons.length, 1)
    assert.match(guard.reasons[0], /插件正在安装或更新/)
  } finally {
    cleanup()
  }
})

test('trustedRequest：同源、桌面壳转发、以及各种不可信形态', () => {
  assert.equal(trustedRequest(request({ origin: 'http://127.0.0.1:19387' })), true)
  assert.equal(trustedRequest(request({ origin: 'http://evil.example' })), false)
  assert.equal(trustedRequest(request({ remoteAddress: '10.0.0.5' })), false)
  // 完全没有 Host 头（不是「host 为 undefined 的键」，那样会触发默认值）。
  assert.equal(trustedRequest({ headers: {}, socket: { remoteAddress: '127.0.0.1' } }), false)

  // 桌面壳转发：无 Origin、回环 Host、无代理头、same-origin。
  assert.equal(trustedRequest(request({ headers: { 'sec-fetch-site': 'same-origin' } })), true)
  assert.equal(trustedRequest(request({ headers: { 'sec-fetch-site': 'cross-site' } })), false)
  assert.equal(trustedRequest(request({ headers: { 'x-forwarded-for': '1.2.3.4' } })), false)
  assert.equal(trustedRequest(request({ host: 'example.com' })), false)
  assert.equal(trustedRequest(request({ host: '[::1]:19387', remoteAddress: '::1' })), true)
})

test('parseQuery / forceRequested', () => {
  assert.equal(parseQuery('/dsh-restart-desktop/api/restart?session=s-1&force=1').get('session'), 's-1')
  assert.equal(forceRequested('/x?force=1'), true)
  assert.equal(forceRequested('/x?force=0'), false)
  assert.equal(forceRequested('/x'), false)
  assert.equal(parseQuery(undefined).get('force'), null)
})

test('validProfileDir / resolveProfileDir', () => {
  const { dir, cleanup } = tempDir()
  try {
    assert.equal(validProfileDir(undefined), null)
    assert.equal(validProfileDir(join(dir, 'missing')), null)
    assert.equal(validProfileDir(dir), null, '缺 package.json / node_modules 的目录不算 profile')

    writeFileSync(join(dir, 'package.json'), '{}', 'utf8')
    mkdirSync(join(dir, 'node_modules'), { recursive: true })
    assert.equal(validProfileDir(dir), dir)
    assert.equal(resolveProfileDir({ env: { DSH_PROFILE_DIR: dir }, argv: [] }), dir)
    // 定位不到时不抛错，返回 null（守卫静默跳过）。
    assert.equal(resolveProfileDir({ env: {}, argv: ['node', 'x', join(dir, 'nope')] }) !== null
      || resolveProfileDir({ env: {}, argv: [] }) === null, true)
  } finally {
    cleanup()
  }
})

test('pruneState：只保留最近 STATE_KEEP 组', () => {
  const { dir, cleanup } = tempDir()
  try {
    for (let index = 0; index < 25; index += 1) {
      const stamp = `2026-01-01T00-00-${String(index).padStart(2, '0')}`
      writeFileSync(join(dir, `handoff-${stamp}.json`), '{}', 'utf8')
      writeFileSync(join(dir, `restart-${stamp}.log`), '', 'utf8')
      writeFileSync(join(dir, `restart-${stamp}.result.json`), '{}', 'utf8')
    }
    writeFileSync(join(dir, 'pending-resume.json'), '{}', 'utf8')
    pruneState(dir)
    const left = readdirSync(dir)
    assert.equal(left.filter((name) => name.startsWith('handoff-')).length, 20)
    assert.equal(left.filter((name) => name.endsWith('.result.json')).length, 20)
    assert.equal(left.includes('pending-resume.json'), true, '待恢复标记不属于交接组，不能被清掉')
  } finally {
    cleanup()
  }
})

test('readSettings / writeSettings：合并写，坏文件回空对象', () => {
  const { dir, cleanup } = tempDir()
  try {
    const file = join(dir, 'settings.json')
    assert.deepEqual(readSettings(file), {})
    writeSettings({ resume: false }, file)
    assert.deepEqual(readSettings(file), { resume: false })
    writeSettings({ geometry: false }, file)
    assert.deepEqual(readSettings(file), { resume: false, geometry: false })
    writeFileSync(file, '[1,2,3]', 'utf8')
    assert.deepEqual(readSettings(file), {}, '形状不对按空对象处理')
  } finally {
    cleanup()
  }
})
