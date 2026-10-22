/**
 * 分离 helper 纯逻辑的单元测试（不需要 Windows，也不碰任何真实进程）。
 *
 * 这里钉住的是一条**失败路径**：在不支持的平台上，helper 必须在动手之前就掉头，
 * 而不是先等 1.5 秒、再拿不存在的 taskkill 空拉三次、最后留一条误导性的日志。
 * 以前这条路径只有一个 Windows 专属的端到端测试覆盖，非 Windows 上等于零覆盖。
 *
 * 运行：`node --test test/helper-core-test.mjs`
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { performRestart } from '../lib/helper.mjs'

/** 不支持的平台能力（macOS 今天的真实形状）。 */
const unsupported = {
  id: 'darwin',
  restart: false,
  launchArgs: false,
  geometry: null,
  alert: null,
  reason: '当前平台（darwin）还没有实现进程控制驱动；本插件目前只支持 Windows 桌面版',
}

/** 一份形状合法、但永远不会被真正执行的交接描述（平台检查在它之前就返回）。 */
function handoff() {
  return {
    mainPid: 4_000_000,
    exe: 'C:\\nonexistent\\DeepSeek Harness.exe',
    hostPid: 4_000_001,
    port: 19_387,
    logPath: 'C:\\nonexistent\\restart.log',
    geometry: true,
    delayMs: 1_500,
    relaunchAttempts: 3,
    relaunchVerifyMs: 2_500,
  }
}

test('performRestart：平台不支持时立刻拒绝，不等待、不结束进程、不拉起', async () => {
  const lines = []
  const startedAt = Date.now()
  const result = await performRestart(handoff(), (line) => lines.push(line), unsupported)
  const elapsed = Date.now() - startedAt

  assert.equal(result.ok, false)
  assert.equal(result.stage, 'unsupported-platform', '必须是一个明确的阶段名，不能混成 relaunch-failed')
  assert.match(result.reason, /darwin/)
  assert.equal(result.geometry, null, '没有几何驱动时不该留下半份几何结果')

  // 拒绝必须发生在 delayMs 之前：1.5 秒的「让 HTTP 响应先出去」在这里毫无意义。
  assert.ok(elapsed < 500, `拒绝应当立即返回，实际用了 ${String(elapsed)}ms`)
  assert.equal(lines.length, 2, '只应写「helper started」与「refusing」两行')
  assert.match(lines[1], /refusing: 当前平台（darwin）/)
})

test('performRestart：平台允许时不会走「不支持」这条捷径（用无效 pid 验证判定顺序）', async () => {
  // 给一份主进程 pid 非法的交接描述：平台检查通过后应当落到 refused-main-pid，
  // 证明这个分支没有被平台判定短路掉。不支持平台上的 taskkill 在这之前就返回了，
  // 所以这里不会真的去结束任何进程。
  const lines = []
  const supported = {
    id: 'win32',
    restart: true,
    launchArgs: true,
    geometry: 'win32-powershell',
    alert: 'win32-wpf',
    reason: null,
  }
  const result = await performRestart({ ...handoff(), mainPid: 0 }, (line) => lines.push(line), supported)

  assert.equal(result.stage, 'refused-main-pid')
  assert.equal(result.reason, null)
  assert.match(lines.join('\n'), /refusing: the handoff carries no usable main process id/)
})
