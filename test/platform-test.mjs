/**
 * 平台能力的单元测试。
 *
 * 这三个平台的行为必须在**任何机器上**都能断言 —— 所以 capability 只从传入的
 * 进程对象里读 `platform`，不读全局 `process.platform`。这条性质本身就是本文件
 * 最重要的断言：它是非 Windows CI 上唯一能验证「拒绝而非静默失败」的地方。
 *
 * 运行：`node --test test/platform-test.mjs`
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { platformCapabilities, platformId } from '../lib/platform.mjs'

test('platformId：注入优先，坏形状回 unknown', () => {
  assert.equal(platformId({ platform: 'darwin' }), 'darwin')
  assert.equal(platformId({ platform: 'linux' }), 'linux')
  assert.equal(platformId({ platform: '' }), 'unknown')
  assert.equal(platformId({}), 'unknown')
  assert.equal(platformId(undefined), process.platform, '不传时应回落到真实进程')
})

test('platformCapabilities：Windows 保留全部能力（现有行为不变）', () => {
  const capabilities = platformCapabilities({ platform: 'win32' })
  assert.deepEqual(capabilities, {
    id: 'win32',
    restart: true,
    launchArgs: true,
    geometry: 'win32-powershell',
    alert: 'win32-wpf',
    reason: null,
  })
})

test('platformCapabilities：macOS / Linux 明确声明不能重启，并给出人话原因', () => {
  for (const id of ['darwin', 'linux']) {
    const capabilities = platformCapabilities({ platform: id })
    assert.equal(capabilities.id, id)
    assert.equal(capabilities.restart, false, `${id} 上不能放行重启：进程控制驱动还不存在`)
    assert.equal(capabilities.launchArgs, false, `${id} 上读不到命令行，别假装能复用参数`)
    assert.equal(capabilities.geometry, null, `${id} 上没有几何驱动`)
    assert.equal(capabilities.alert, null, `${id} 上没有失败提示驱动`)
    assert.equal(typeof capabilities.reason, 'string')
    assert.match(capabilities.reason, new RegExp(`（${id}）`), '原因里要点明是哪个平台')
    assert.match(capabilities.reason, /只支持 Windows 桌面版/, '原因要给出用户能行动的结论')
  }
})

test('platformCapabilities：未知平台同样拒绝，绝不靠猜', () => {
  for (const id of ['freebsd', 'aix', 'unknown']) {
    const capabilities = platformCapabilities({ platform: id })
    assert.equal(capabilities.restart, false)
    assert.match(capabilities.reason, /只支持 Windows 桌面版/)
  }
})

test('platformCapabilities：每次返回新对象（调用方改了也不影响下一次）', () => {
  const first = platformCapabilities({ platform: 'win32' })
  first.restart = false
  assert.equal(platformCapabilities({ platform: 'win32' }).restart, true)
})
