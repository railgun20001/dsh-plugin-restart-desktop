/**
 * 「重启后自动续上被打断的会话」的单元测试。
 *
 * 覆盖：标记判定（TTL / 非中断 / 缺 id / 客户端要求跳过）、新旧标记形态的解析、
 * 消息形状与不可变性、恢复流程的每一条分支（会话不存在、已经活着、恢复失败、preset
 * 有无、多会话里有一个失败）。
 * 运行：`node --test test/resume-test.mjs`
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  RESUME_MARKER_MAX_SESSIONS,
  RESUME_MARKER_TTL_MS,
  buildResumeMessage,
  deepFreeze,
  inspectMarker,
  markerSessionIds,
  runResume,
} from '../lib/resume.mjs'

/** 造一个记录调用的假服务缝。 */
function fakeServices(overrides = {}) {
  const calls = { header: [], resumeAgent: [], followup: [], logs: [] }
  const services = {
    async header(id) {
      calls.header.push(id)
      return { id, agentPreset: 'standard' }
    },
    isLive: () => false,
    async resumeAgent(id, preset) {
      calls.resumeAgent.push({ id, preset })
    },
    followup(id, message) {
      calls.followup.push({ id, message })
    },
    log: (message) => calls.logs.push(message),
    ...overrides,
  }
  return { services, calls }
}

test('inspectMarker：四条判据缺一不可', () => {
  const now = 1_000_000
  const fresh = { sessionId: 's-1', interrupted: true, at: now - 1000 }
  assert.deepEqual(inspectMarker(fresh, now), { usable: true, reason: null })

  assert.equal(inspectMarker(null, now).reason, 'no-marker')
  assert.equal(inspectMarker({ interrupted: true, at: now }, now).reason, 'no-session-id')
  assert.equal(inspectMarker({ sessionId: 's-1', interrupted: false, at: now }, now).reason, 'not-interrupted')
  assert.equal(inspectMarker({ sessionId: 's-1', interrupted: true }, now).reason, 'no-timestamp')
  assert.equal(
    inspectMarker({ sessionId: 's-1', interrupted: true, at: now - RESUME_MARKER_TTL_MS - 1 }, now).reason,
    'stale',
  )
  // 时钟回拨（at 落在未来）按「刚发生」处理，而不是当成过期。
  assert.equal(inspectMarker({ sessionId: 's-1', interrupted: true, at: now + 60_000 }, now).usable, true)
  // 调用方明确要求跳过时一条都不发（客户端带 resume=0 的那次）。
  assert.equal(
    inspectMarker({ sessionId: 's-1', interrupted: true, requestedResume: false, at: now }, now).reason,
    'not-requested',
  )
})

test('markerSessionIds：新旧两种标记形态都认，去重、保序、带上限', () => {
  // 新版：宿主按实况快照写下的名单。
  assert.deepEqual(markerSessionIds({ sessions: ['b', 'a', 'b'] }), ['b', 'a'])
  // 旧版：只有单个会话。
  assert.deepEqual(markerSessionIds({ sessionId: 's-1' }), ['s-1'])
  // 两种并存：名单优先，缺的补在后面（新旧宿主混装时不漏会话）。
  assert.deepEqual(markerSessionIds({ sessions: ['a'], sessionId: 'b' }), ['a', 'b'])
  assert.deepEqual(markerSessionIds({ sessions: ['a', ''] }), ['a'])
  assert.deepEqual(markerSessionIds({ sessionId: '' }), [])
  assert.deepEqual(markerSessionIds({}), [])
  assert.deepEqual(markerSessionIds(null), [])

  // 上限：被手改坏的标记不该让下次启动一口气唤醒几十个会话。
  const many = markerSessionIds({ sessions: Array.from({ length: 100 }, (_, index) => `s-${String(index)}`) })
  assert.equal(many.length, RESUME_MARKER_MAX_SESSIONS)
})

test('buildResumeMessage：形状正确、已冻结、source 不是 user', () => {
  const message = buildResumeMessage('继续吧', 'dsh-restart-desktop')
  assert.equal(message.role, 'user')
  assert.equal(typeof message.id, 'string')
  assert.equal(message.id.length > 0, true)
  assert.deepEqual(message.content, [{ type: 'text', text: '继续吧' }])
  assert.deepEqual(message.source, { kind: 'desktop-restart', plugin: 'dsh-restart-desktop' })
  assert.notEqual(message.source.kind, 'user', 'source 必须是自定义 kind，Chat 才会渲染成「注入的上下文行」')
  assert.equal(Object.isFrozen(message), true)
  assert.equal(Object.isFrozen(message.content), true)
  assert.equal(Object.isFrozen(message.content[0]), true)
  assert.equal(Object.isFrozen(message.source), true)

  // 每次都是新的身份：同一条消息重复排队会被会话当成两次用户输入。
  assert.notEqual(buildResumeMessage().id, buildResumeMessage().id)
})

test('deepFreeze：递归冻结，标量与 null 直接返回', () => {
  const value = deepFreeze({ a: { b: [1, 2] } })
  assert.equal(Object.isFrozen(value), true)
  assert.equal(Object.isFrozen(value.a), true)
  assert.equal(Object.isFrozen(value.a.b), true)
  assert.equal(deepFreeze(1), 1)
  assert.equal(deepFreeze(null), null)
})

test('runResume：正常路径 —— 恢复会话并注入一条恢复消息', async () => {
  const { services, calls } = fakeServices()
  const result = await runResume(services, { sessionId: 's-1', interrupted: true, at: Date.now() })
  assert.deepEqual(result, {
    resumed: true,
    reason: null,
    sessionId: 's-1',
    sessions: ['s-1'],
    preset: 'standard',
    results: [{ sessionId: 's-1', resumed: true, reason: null, preset: 'standard' }],
  })
  assert.deepEqual(calls.resumeAgent, [{ id: 's-1', preset: 'standard' }])
  assert.equal(calls.followup.length, 1)
  assert.equal(calls.followup[0].id, 's-1')
  assert.equal(calls.followup[0].message.role, 'user')
})

test('runResume：多个被打断的会话逐个恢复，一个失败不连累其余', async () => {
  // 「在一个会话里挂着长任务、切到另一个会话点重启」就是这种形态：名单里既有
  // 真正在跑的后台会话，也可能夹着一个已从存储里消失的会话。
  const { services, calls } = fakeServices({
    header: async (id) => (id === 'gone' ? undefined : { id, agentPreset: 'standard' }),
  })
  const result = await runResume(services, { sessions: ['s-1', 'gone', 's-2'], interrupted: true, at: Date.now() })

  assert.equal(result.resumed, true)
  assert.deepEqual(result.sessions, ['s-1', 's-2'])
  assert.equal(result.sessionId, 's-1', '状态路由要能报出一个代表会话')
  assert.deepEqual(
    result.results.map((entry) => [entry.sessionId, entry.resumed]),
    [['s-1', true], ['gone', false], ['s-2', true]],
  )
  assert.deepEqual(calls.resumeAgent, [
    { id: 's-1', preset: 'standard' },
    { id: 's-2', preset: 'standard' },
  ])
  assert.deepEqual(calls.followup.map((entry) => entry.id), ['s-1', 's-2'])
  assert.equal(calls.followup[0].message.id === calls.followup[1].message.id, false, '每条恢复消息都要有自己的身份')
  assert.equal(calls.logs.some((line) => line.includes('resumed 2 of 3')), true, '部分成功要如实记一笔')
})

test('runResume：一个会话都没接上时如实报告，resumed 为 false', async () => {
  const { services, calls } = fakeServices({ header: async () => undefined })
  const result = await runResume(services, { sessions: ['a', 'b'], interrupted: true, at: Date.now() })
  assert.equal(result.resumed, false)
  assert.equal(result.reason, 'session-missing')
  assert.deepEqual(result.sessions, [])
  assert.equal(calls.resumeAgent.length, 0)
  assert.equal(calls.followup.length, 0)
})

test('runResume：会话已经活着时只注入消息，不重复恢复', async () => {
  const { services, calls } = fakeServices({ isLive: () => true })
  const result = await runResume(services, { sessionId: 's-1', interrupted: true, at: Date.now() })
  assert.equal(result.resumed, true)
  assert.deepEqual(calls.resumeAgent, [])
  assert.equal(calls.followup.length, 1)
})

test('runResume：没有 preset 时不传 setup', async () => {
  const { services, calls } = fakeServices({ header: async () => ({ id: 's-1' }) })
  const result = await runResume(services, { sessionId: 's-1', interrupted: true, at: Date.now() })
  assert.equal(result.preset, null)
  assert.deepEqual(calls.resumeAgent, [{ id: 's-1', preset: undefined }])
})

test('runResume：非中断 / 过期 / 缺 id / 要求跳过 一律不动', async () => {
  const cases = [
    { marker: { sessionId: 's-1', interrupted: false, at: Date.now() }, reason: 'not-interrupted' },
    { marker: { sessionId: 's-1', interrupted: true, at: 0 }, reason: 'stale' },
    { marker: { interrupted: true, at: Date.now() }, reason: 'no-session-id' },
    { marker: { sessions: [], interrupted: true, at: Date.now() }, reason: 'no-session-id' },
    { marker: { sessionId: 's-1', interrupted: true, requestedResume: false, at: Date.now() }, reason: 'not-requested' },
    { marker: null, reason: 'no-marker' },
  ]
  for (const { marker, reason } of cases) {
    const { services, calls } = fakeServices()
    const result = await runResume(services, marker)
    assert.equal(result.resumed, false, `${reason} 不该恢复`)
    assert.equal(result.reason, reason)
    assert.deepEqual(result.results, [])
    assert.equal(calls.resumeAgent.length, 0)
    assert.equal(calls.followup.length, 0)
  }
})

test('runResume：会话不在持久化存储里时如实报告，不硬造一个', async () => {
  const { services, calls } = fakeServices({ header: async () => undefined })
  const result = await runResume(services, { sessionId: 'gone', interrupted: true, at: Date.now() })
  assert.equal(result.resumed, false)
  assert.equal(result.reason, 'session-missing')
  assert.equal(calls.resumeAgent.length, 0)
  assert.equal(calls.followup.length, 0)
})

test('runResume：恢复抛错时被吞成结果，不把宿主的启动流程带崩', async () => {
  const { services, calls } = fakeServices({
    resumeAgent: async () => { throw new Error('agents service is unavailable') },
  })
  const result = await runResume(services, { sessionId: 's-1', interrupted: true, at: Date.now() })
  assert.equal(result.resumed, false)
  assert.match(result.reason, /unavailable/)
  assert.equal(calls.followup.length, 0, '恢复失败就不该再往一个不存在的 Agent 里塞消息')
})

test('runResume：followup 抛错同样被吞成结果', async () => {
  const { services } = fakeServices({
    followup: () => { throw new Error('the resumed agent is unavailable') },
  })
  const result = await runResume(services, { sessionId: 's-1', interrupted: true, at: Date.now() })
  assert.equal(result.resumed, false)
  assert.match(result.reason, /unavailable/)
})

test('runResume：header 抛错被吞成结果', async () => {
  const { services } = fakeServices({
    header: async () => { throw new Error('persistence exploded') },
  })
  const result = await runResume(services, { sessionId: 's-1', interrupted: true, at: Date.now() })
  assert.equal(result.resumed, false)
  assert.match(result.reason, /exploded/)
})
