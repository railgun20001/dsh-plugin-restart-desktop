/**
 * dsh-restart-desktop —— 重启后「自动续上被打断的那一轮对话」。
 *
 * ## 调研结论（为什么这件事可以做，以及边界在哪）
 *
 * 1. **被打断的那一轮本身无法续跑。** 主进程被结束、host 优雅关停，正在生成的
 *    那一轮就没了；官方自己的退出确认框也写「当前正在运行的任务将会中断」。
 * 2. **但会话是可以被重新拉起来的。** 宿主侧有官方通道：
 *    `ctx.agents.resume({ resumeSessionId, setup })` 把持久化会话恢复成活 Agent，
 *    `agent.followup(message)` 往它的收件箱里排一条消息并唤醒驱动。
 *    官方 `dsh-headless` 与 `@deepseek-ai/dsh-goal-round-driver` 都走这两步。
 * 3. **所以「自动恢复对话」的正确形态不是「续跑那一轮」，而是**：
 *    把被打断的会话恢复成活 Agent，注入一条说明现状的恢复消息，让模型自己判断
 *    哪些工具调用可以安全重试、哪些需要先核验外部状态。
 *
 * ## 为什么必须是「触发重启的那个会话」，而且必须是「真被打断」
 *
 * 自动发消息会真的花钱、真的跑模型。因此本模块只做最小的事：
 *   - 只处理**这次重启的发起会话**（客户端把它随重启请求一起交给宿主半），
 *     绝不去扫描、唤醒别的历史会话；
 *   - 只在**重启排程那一刻该会话确实在跑**时才标记为「被打断」；
 *   - 标记带 TTL，宿主要是在几分钟之后才起来（比如用户手动重开），就不再自动发消息。
 *
 * 这三条让「自动恢复」的副作用面收敛到用户刚刚亲眼看着被打断的那一个会话上。
 *
 * ## 恢复时的组合（不能省）
 *
 * `agents.resume` 只给基础组合；会话原本跑在哪个 agent preset 下，要靠 `setup`
 * 把那个 preset 重新挂上去，否则恢复出来的 Agent 会丢掉它那一整套工具
 * （bash / read / goal …）。官方冷恢复路径（`api/remotes` 的 agent-lookup）就是这么做的，
 * 这里照做：preset 解析不到时降级为「不带 preset 工具恢复」并记日志，而不是整个失败 ——
 * 恢复优先于完整。
 *
 * @module dsh-restart-desktop/resume
 */

import { randomUUID } from 'node:crypto'

/** 恢复消息的 TTL：标记比这更旧就不再自动发消息。 */
export const RESUME_MARKER_TTL_MS = 5 * 60 * 1000

/**
 * 注入的恢复消息正文。
 *
 * 刻意把「不确定」讲清楚：被打断的工具调用可能已经产生副作用，模型不能盲目重试。
 */
export const RESUME_PROMPT = [
  '桌面版刚刚重启，上一个回合因此被切断。',
  '你无法得知那一刻正在进行的工具调用是否已经产生副作用：',
  '只读或幂等的操作可以重试；可能已经改了外部状态的操作，先核验当前状态或询问我，不要盲目重试。',
  '然后继续原先的任务。',
].join('')

/**
 * 递归冻结一个值，与 `@deepseek-ai/dsh-llm` 的 `createMessage` 同语义。
 *
 * 宿主半不 import 任何包（link 安装的插件解析不到 profile 的 node_modules），
 * 所以消息由本模块自己构造，但必须同样不可变：会话日志按引用持有它。
 * @param {any} value 待冻结的值。
 * @returns {any} 同一个值。
 */
export function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const key of Object.keys(value)) deepFreeze(value[key])
  return value
}

/**
 * 造一条恢复用的 user 角色消息。
 *
 * `source.kind` 刻意不用 `'user'`：Chat 把 `source.kind === 'user'` 的用户消息渲染成
 * 用户气泡，其余 kind 渲染成「注入的上下文行」（见 `dsh-client-ui-chat` 的
 * `input-message` 定义）。用自定义 kind 才能让这条自动消息在对话里长得像「系统注入」
 * 而不是「用户刚说的话」—— 它确实是前者。
 * @param {string} [text] 消息正文。
 * @param {string} [pluginId] 产出方标识。
 * @returns {object} 已冻结的消息。
 */
export function buildResumeMessage(text = RESUME_PROMPT, pluginId = 'dsh-restart-desktop') {
  return deepFreeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'desktop-restart', plugin: pluginId },
  })
}

/**
 * 一条恢复标记是否仍然可用。
 *
 * 三条判据缺一不可：带会话 id、确实是「被打断」、而且还没过期。
 * @param {any} marker 标记。
 * @param {number} now 当前时间（epoch 毫秒）。
 * @param {number} [ttlMs] TTL。
 * @returns {{ usable: boolean, reason: string | null }} 判定结果与原因。
 */
export function inspectMarker(marker, now, ttlMs = RESUME_MARKER_TTL_MS) {
  if (marker === null || typeof marker !== 'object') return { usable: false, reason: 'no-marker' }
  const sessionId = marker.sessionId
  if (typeof sessionId !== 'string' || sessionId === '') return { usable: false, reason: 'no-session-id' }
  if (marker.interrupted !== true) return { usable: false, reason: 'not-interrupted' }
  const at = Number(marker.at)
  if (!Number.isFinite(at)) return { usable: false, reason: 'no-timestamp' }
  if (now - at > ttlMs) return { usable: false, reason: 'stale' }
  // 时钟回拨（系统时间被改过）会让 at 落在未来；这种情况按「刚发生」处理，
  // 而不是当成过期 —— 否则一个正确排程的重启会因为时间被调过而永远不恢复。
  return { usable: true, reason: null }
}

/**
 * 跑一次恢复。
 *
 * 服务由调用方注入（见 index.js 的 `buildResumeServices`），因此这里可以完全离线单测。
 * @param {{ header: (id: string) => Promise<any>, isLive: (id: string) => boolean, resumeAgent: (id: string, preset: string | undefined) => Promise<void>, followup: (id: string, message: object) => void, log: (message: string) => void }} services 服务缝。
 * @param {any} marker 恢复标记。
 * @param {{ now?: number, ttlMs?: number }} [options] 选项。
 * @returns {Promise<{ resumed: boolean, reason: string | null, sessionId: string | null, preset: string | null }>} 结果。
 */
export async function runResume(services, marker, options = {}) {
  const now = options.now ?? Date.now()
  const verdict = inspectMarker(marker, now, options.ttlMs ?? RESUME_MARKER_TTL_MS)
  if (!verdict.usable) return { resumed: false, reason: verdict.reason, sessionId: null, preset: null }

  const sessionId = String(marker.sessionId)
  try {
    const header = await services.header(sessionId)
    if (header === undefined || header === null) {
      services.log(`resume skipped: session ${sessionId} is not in durable storage`)
      return { resumed: false, reason: 'session-missing', sessionId, preset: null }
    }
    const preset = typeof header.agentPreset === 'string' && header.agentPreset !== '' ? header.agentPreset : undefined

    if (!services.isLive(sessionId)) {
      await services.resumeAgent(sessionId, preset)
      services.log(`resumed session ${sessionId}${preset === undefined ? ' without a preset' : ` under preset "${preset}"`}`)
    } else {
      services.log(`session ${sessionId} is already live; injecting the resume message only`)
    }

    services.followup(sessionId, buildResumeMessage())
    services.log(`injected the resume message into session ${sessionId}`)
    return { resumed: true, reason: null, sessionId, preset: preset ?? null }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    services.log(`resume failed for session ${sessionId}: ${reason}`)
    return { resumed: false, reason, sessionId, preset: null }
  }
}
