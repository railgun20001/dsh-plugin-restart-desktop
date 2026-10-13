/**
 * dsh-restart-desktop —— 重启后「自动续上被打断的会话」。
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
 * ## 恢复谁：宿主看到的实况，而不是「用户当前打开的那个会话」
 *
 * 自动发消息会真的花钱、真的跑模型，所以判据必须严，但**不能严错对象**：
 *
 *   - 早先的实现只认客户端随请求交上来的 `sessionId`（即「当前打开的会话」）。这在
 *     多会话 / 后台长任务下是错的：用户在一个会话里挂着长任务、切到另一个会话点重启，
 *     被打断的是后台那个，而标记却落在空闲的当前会话上 —— 结果是 `not-interrupted`，
 *     真正被打断的任务一条恢复消息都拿不到。
 *   - 现在由宿主半在**排程那一刻**问自己：哪些会话真的在跑（agent `running`）、
 *     有排队消息、或有正在跑的后台任务。这份名单写进标记，重启后逐个续接。
 *   - 名单里没有的会话一个都不碰：空闲会话、历史会话永远不会被凭空唤醒。
 *   - 标记带 TTL，宿主要是在几分钟之后才起来（比如用户手动重开），就不再自动发消息。
 *
 * 这几条让「自动恢复」的副作用面收敛到「重启那一刻确实有活在跑的那几个会话」上。
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
 * 一条标记最多承载多少个会话。
 *
 * 名单来自宿主自己的实况快照，正常只有个位数；设上限是防御被手改过的标记文件 ——
 * 一个坏文件不该让下次启动一口气唤醒几十个会话。
 */
export const RESUME_MARKER_MAX_SESSIONS = 32

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
 * 取出一条标记里要恢复的会话 id（去重、保序、带上限）。
 *
 * 兼容两种标记形态：新版 `sessions: string[]`（宿主按实况快照写下的名单），
 * 以及旧版只有 `sessionId` 的单个会话。两者同时存在时名单优先、缺的补在后面，
 * 所以新旧宿主混装也不会漏掉会话。
 * @param {any} marker 标记。
 * @returns {string[]} 会话 id 列表（可能为空）。
 */
export function markerSessionIds(marker) {
  if (marker === null || typeof marker !== 'object') return []
  const candidates = Array.isArray(marker.sessions) ? [...marker.sessions, marker.sessionId] : [marker.sessionId]
  const ids = []
  for (const value of candidates) {
    if (typeof value !== 'string' || value === '') continue
    if (ids.includes(value)) continue
    ids.push(value)
    if (ids.length >= RESUME_MARKER_MAX_SESSIONS) break
  }
  return ids
}

/**
 * 一条恢复标记是否仍然可用。
 *
 * 四条判据缺一不可：调用方没有要求跳过、确实有会话要恢复、确实是「被打断」、
 * 而且还没过期。
 * @param {any} marker 标记。
 * @param {number} now 当前时间（epoch 毫秒）。
 * @param {number} [ttlMs] TTL。
 * @returns {{ usable: boolean, reason: string | null }} 判定结果与原因。
 */
export function inspectMarker(marker, now, ttlMs = RESUME_MARKER_TTL_MS) {
  if (marker === null || typeof marker !== 'object') return { usable: false, reason: 'no-marker' }
  if (marker.requestedResume === false) return { usable: false, reason: 'not-requested' }
  if (marker.interrupted !== true) return { usable: false, reason: 'not-interrupted' }
  if (markerSessionIds(marker).length === 0) return { usable: false, reason: 'no-session-id' }
  const at = Number(marker.at)
  if (!Number.isFinite(at)) return { usable: false, reason: 'no-timestamp' }
  if (now - at > ttlMs) return { usable: false, reason: 'stale' }
  // 时钟回拨（系统时间被改过）会让 at 落在未来；这种情况按「刚发生」处理，
  // 而不是当成过期 —— 否则一个正确排程的重启会因为时间被调过而永远不恢复。
  return { usable: true, reason: null }
}

/**
 * 恢复一个会话并注入一条恢复消息。
 *
 * 单个会话的失败只影响它自己：多会话恢复时，一个会话恢复不了不该连累其余会话。
 * @param {{ header: (id: string) => Promise<any>, isLive: (id: string) => boolean, resumeAgent: (id: string, preset: string | undefined) => Promise<void>, followup: (id: string, message: object) => void, log: (message: string) => void }} services 服务缝。
 * @param {string} sessionId 会话 id。
 * @returns {Promise<{ sessionId: string, resumed: boolean, reason: string | null, preset: string | null }>} 单个会话的结果。
 */
async function resumeOne(services, sessionId) {
  try {
    const header = await services.header(sessionId)
    if (header === undefined || header === null) {
      services.log(`resume skipped: session ${sessionId} is not in durable storage`)
      return { sessionId, resumed: false, reason: 'session-missing', preset: null }
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
    return { sessionId, resumed: true, reason: null, preset: preset ?? null }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    services.log(`resume failed for session ${sessionId}: ${reason}`)
    return { sessionId, resumed: false, reason, preset: null }
  }
}

/**
 * 跑一次恢复：把标记里的每个会话都接上。
 *
 * 服务由调用方注入（见 index.js 的 `buildResumeServices`），因此这里可以完全离线单测。
 * @param {{ header: (id: string) => Promise<any>, isLive: (id: string) => boolean, resumeAgent: (id: string, preset: string | undefined) => Promise<void>, followup: (id: string, message: object) => void, log: (message: string) => void }} services 服务缝。
 * @param {any} marker 恢复标记。
 * @param {{ now?: number, ttlMs?: number }} [options] 选项。
 * @returns {Promise<{ resumed: boolean, reason: string | null, sessionId: string | null, sessions: string[], preset: string | null, results: { sessionId: string, resumed: boolean, reason: string | null, preset: string | null }[] }>} 结果。
 */
export async function runResume(services, marker, options = {}) {
  const now = options.now ?? Date.now()
  const verdict = inspectMarker(marker, now, options.ttlMs ?? RESUME_MARKER_TTL_MS)
  if (!verdict.usable) return { resumed: false, reason: verdict.reason, sessionId: null, sessions: [], preset: null, results: [] }

  const results = []
  for (const sessionId of markerSessionIds(marker)) {
    results.push(await resumeOne(services, sessionId))
  }

  const succeeded = results.filter((entry) => entry.resumed)
  if (succeeded.length === 0) {
    // 一个都没成：报第一个失败原因；多会话时每个会话的原因在 results 与日志里。
    return {
      resumed: false,
      reason: results[0]?.reason ?? 'no-session-id',
      sessionId: results[0]?.sessionId ?? null,
      sessions: [],
      preset: null,
      results,
    }
  }
  if (succeeded.length < results.length) {
    services.log(`resumed ${String(succeeded.length)} of ${String(results.length)} interrupted session(s)`)
  }
  return {
    resumed: true,
    reason: null,
    sessionId: succeeded[0].sessionId,
    sessions: succeeded.map((entry) => entry.sessionId),
    preset: succeeded[0].preset,
    results,
  }
}
