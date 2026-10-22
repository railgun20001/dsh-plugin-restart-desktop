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
 *    把被打断的会话恢复成活 Agent，注入一条**只陈述事实**的恢复消息（什么时候重启过、
 *    这个会话当时是什么状态），剩下的交给模型判断。
 *
 *    刻意不写「继续」「不要盲目重试」这类指令：重试判据已经由宿主写在会话记录里
 *    （被打断的工具调用上有一条 `ToolOutcomeUnknownError` 结果，原文就是判据），
 *    插件再讲一遍既重复又容易把插件的主观判断混进任务语义 —— 一条说错的指令会被
 *    永久写进历史，模型随后可能为了「对齐」它去改动本来没坏的东西。
 *
 * ## 恢复谁：宿主看到的实况，而不是「用户当前打开的那个会话」
 *
 * 自动发消息会真的花钱、真的跑模型，所以判据必须严，但**不能严错对象**：
 *
 *   - 早先的实现只认客户端随请求交上来的 `sessionId`（即「当前打开的会话」）。这在
 *     多会话 / 后台长任务下是错的：用户在一个会话里挂着长任务、切到另一个会话点重启，
 *     被打断的是后台那个，而标记却落在空闲的当前会话上 —— 结果是 `not-interrupted`，
 *     真正被打断的任务一条恢复消息都拿不到。
 *   - 现在由宿主半在**排程那一刻**问自己：哪些会话真的在跑（agent `running`）或有排队
 *     消息。这份名单写进标记，重启后逐个续接。**跑着的后台任务不算**：它只说明有个
 *     进程活着，不说明对话没结束（`pnpm dev` 能跑几十个小时），按它唤醒历史会话是骚扰。
 *   - 标记里的 `sessionId` 只是状态页展示用的「客户端当前会话」，不参与恢复名单；
 *     否则用户在哪个会话里点重启，哪个早已结束的会话就会凭空续一轮。
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
 * **还必须带上 `agentOptions: { provider, model }`。** 系统提示词里的 `{{model}}`
 * 取自 `agent.options.model`（见 `dsh-agent-loop` 的
 * `ctx.systemPrompt.variable("model", (context) => context.agent?.options.model)`），
 * 缺了它这一轮会在「组装提示词」那一步直接失败：
 *
 *   prompt variable "{{model}}" has no value for this assembly (section "deployment:persona-prefix")
 *
 * 而且这个 Agent 会**一直坏着** —— 它已经活在宿主里，之后连客户端发起的回合也一样失败。
 * 所以路由必须一起恢复（取自该会话日志里最近一次 `request/header`，退路是部署默认模型），
 * 拿不到路由就**不恢复**（宁可留一个「用户打开会话时由客户端正常创建」的机会，也不要造一个
 * 坏 Agent）；恢复后再复检活 Agent 的 provider/model，没拿到就不发恢复消息。
 * 这是实践里踩出来的：真实重启后，唯一被漏掉的正是这个 `agentOptions`。
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
 * 把时刻格式化成宿主本机的 `YYYY-MM-DD HH:mm:ss`。
 *
 * 用本地时间而不是 ISO/UTC：这条消息是给人看的现场记录，模型读本地时间与用户看到的
 * 界面一致。拿不到有效时刻时返回 null，由调用方退化成不带时间的说法 —— 宁可少一句，
 * 也不编一个时间。
 * @param {number | string | null | undefined} at 时刻（epoch 毫秒）。
 * @returns {string | null} 格式化结果。
 */
export function formatResumeTime(at) {
  if (at === null || at === undefined || at === '') return null
  const value = Number(at)
  if (!Number.isFinite(value)) return null
  const date = new Date(value)
  const pad = (part) => String(part).padStart(2, '0')
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * 把一个会话在重启那一刻的状态写成一个英文谓语片段。
 *
 * 只认标记里明确记下来的字段，**不认识就返回 null，绝不退化成「回合被切断」**：
 * 这条消息一旦说了没发生过的事，模型可能为了对齐它去改动本来没坏的文件。
 * @param {any} detail 标记 `details` 里对应这个会话的那一项。
 * @returns {string | null} 状态片段（接在 "this session …" 之后）；没有可陈述的事实时 null。
 */
function describeSessionState(detail) {
  if (detail === null || typeof detail !== 'object') return null
  // 只认真正的整数：被手改成 "3" / true / 3.5 的字段一律不采信，宁可说「没有记录」。
  const count = (value) => (typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0)
  const parts = []
  if (detail.running === true) parts.push('was running a turn')
  const queued = count(detail.queued)
  if (queued > 0) parts.push(`had ${String(queued)} messages queued that had not started`)
  const jobs = count(detail.jobs)
  if (jobs > 0) parts.push(`had ${String(jobs)} background jobs running`)
  return parts.length === 0 ? null : parts.join(', and ')
}

/**
 * 生成注入的恢复消息正文：**纯报告**，不含限定词、祈使句或推测。
 *
 * 两句话，各自都可指认证据：
 *   1. 桌面版在什么时候重启过（时刻来自标记，由插件排程）；
 *   2. 这个会话当时在做什么（状态来自标记的 `details`，没有记录就如实说没有记录）。
 *
 * 用英文而不是中文：宿主自己注入的元信息（如被打断工具调用上的
 * `ToolOutcomeUnknownError`）本来就是英文，同一层上下文保持同一种语言，
 * 不会在中文会话里突然插进一句另一种语言的系统注记。
 *
 * 不写 "continue" / "verify first" / "do not retry blindly"：前者是模型看着未完成的记录
 * 自己会得出的结论，后者宿主已经在会话记录里写过了。少写一层判断，就少一层污染。
 * @param {any} detail 标记 `details` 里对应这个会话的那一项（可为 null）。
 * @param {number | string | null | undefined} at 重启排程时刻（epoch 毫秒）。
 * @returns {string} 消息正文。
 */
export function describeResume(detail, at) {
  const when = formatResumeTime(at)
  const state = describeSessionState(detail)
  return [
    when === null
      ? 'The desktop app restarted (scheduled by dsh-restart-desktop).'
      : `The desktop app restarted at ${when} (scheduled by dsh-restart-desktop).`,
    state === null
      ? 'The state of this session at that moment was not recorded.'
      : `At that moment this session ${state}.`,
  ].join('\n')
}

/**
 * 注入的恢复消息正文（没有明细时的兜底）。
 *
 * 旧版标记只有 `sessionId`、没有 `details`，那种情况下插件确实只知道「重启过」，
 * 就只说这一句 —— 不拿名单里的 `interrupted` 去推断这个会话当时在干什么。
 */
export const RESUME_PROMPT = describeResume(null, null)

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
 * 以及旧版只有 `sessionId` 的单个会话。
 *
 * **新版的 `sessionId` 只是给状态页展示的「客户端当前会话」，不参与恢复。**
 * 它经常是一个早已结束、只是还开在页面上的空闲会话：用户在那个会话里点了重启，
 * 旧实现把 `[...sessions, sessionId]` 一起续，于是这个会话凭空多出一轮
 * （真实事故：8f7c… 的最后一轮比重启早 3 分钟就结束了）。名单存在时以名单为准；
 * 只有旧版标记（没有 `sessions` 字段）才回退到 `sessionId`。
 * @param {any} marker 标记。
 * @returns {string[]} 会话 id 列表（可能为空）。
 */
export function markerSessionIds(marker) {
  if (marker === null || typeof marker !== 'object') return []
  const candidates = Array.isArray(marker.sessions) ? marker.sessions : [marker.sessionId]
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
 * 取出一条标记里某个会话的明细（`details` 里 `id` 对得上的那一项）。
 *
 * 明细只用于**陈述事实**，不参与「恢复谁」的判定；形态不认识就返回 null，
 * 文案据此退化成「状态没有记录」，而不是猜一个状态。
 * @param {any} marker 标记。
 * @param {string} sessionId 会话 id。
 * @returns {any | null} 明细项；没有时 null。
 */
export function markerDetail(marker, sessionId) {
  if (marker === null || typeof marker !== 'object') return null
  if (!Array.isArray(marker.details)) return null
  for (const entry of marker.details) {
    if (entry === null || typeof entry !== 'object') continue
    if (entry.id !== sessionId) continue
    return entry
  }
  return null
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
 * 从会话事件里找**最近一次模型请求路由**。
 *
 * 恢复出来的 Agent 必须带 `provider`/`model`（见模块头），而这两个值就在会话自己的日志里：
 * 每一轮调用模型前都会写下 `request/header`（`data.header.config = { provider, model, … }`），
 * 冷启动到一半的会话则可能只有 `request/context`。从尾部往前找，取最近的一条。
 * @param {any[] | null | undefined} events 会话事件（persistence `handle.read()` 的 `events`）。
 * @returns {{ provider: string, model: string } | null} 路由，找不到时 null。
 */
export function lastRequestRoute(events) {
  if (!Array.isArray(events)) return null
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    const type = event?.type
    if (type !== 'request/header' && type !== 'request/context') continue
    // request/header 的配置嵌在 data.header.config；request/context 就是 provider/model 本身。
    const candidate = type === 'request/header' ? event?.data?.header?.config : event?.data
    const provider = candidate?.provider
    const model = candidate?.model
    if (typeof provider !== 'string' || provider === '') continue
    if (typeof model !== 'string' || model === '') continue
    return { provider, model }
  }
  return null
}

/**
 * 恢复一个会话并注入一条恢复消息。
 *
 * 单个会话的失败只影响它自己：多会话恢复时，一个会话恢复不了不该连累其余会话。
 * @param {{ header: (id: string) => Promise<any>, isLive: (id: string) => boolean, isRunning?: (id: string) => boolean, route?: (id: string) => Promise<{ provider: string, model: string } | null>, resumeAgent: (id: string, preset: string | undefined, route: { provider: string, model: string }) => Promise<void>, liveRoute?: (id: string) => { provider: string, model: string } | null, followup: (id: string, message: object) => void, log: (message: string) => void }} services 服务缝。
 * @param {string} sessionId 会话 id。
 * @param {any} detail 该会话在重启那一刻的明细（可能没有：旧版标记没有 `details`）。
 * @param {number | string | null | undefined} at 重启排程时刻。
 * @returns {Promise<{ sessionId: string, resumed: boolean, reason: string | null, preset: string | null }>} 单个会话的结果。
 */
async function resumeOne(services, sessionId, detail, at) {
  try {
    const header = await services.header(sessionId)
    if (header === undefined || header === null) {
      services.log(`resume skipped: session ${sessionId} is not in durable storage`)
      return { sessionId, resumed: false, reason: 'session-missing', preset: null }
    }
    const preset = typeof header.agentPreset === 'string' && header.agentPreset !== '' ? header.agentPreset : undefined

    // 已经在跑一个回合（用户先一步重开了会话）：这条消息会落进正在进行的那一轮，
    // 等于拿一条过期的现场记录去干扰别人的任务，一条都不发。
    if (services.isRunning !== undefined && services.isRunning(sessionId) === true) {
      services.log(`resume skipped: session ${sessionId} is already running a turn, so a restart notice would land inside it`)
      return { sessionId, resumed: false, reason: 'already-running', preset: preset ?? null }
    }

    if (!services.isLive(sessionId)) {
      const route = services.route === undefined ? null : await services.route(sessionId)
      if (route === null) {
        // 没有路由就**不要**恢复：恢复出来的 Agent 会在第一轮就因 {{model}} 没有值而失败，
        // 而且它会一直坏着（后续客户端发起的回合也一样）。
        services.log(`resume skipped: session ${sessionId} has no provider/model to resume with (no request route in its log and no deployment default)`)
        return { sessionId, resumed: false, reason: 'no-route', preset: preset ?? null }
      }
      await services.resumeAgent(sessionId, preset, route)
      services.log(`resumed session ${sessionId}${preset === undefined ? ' without a preset' : ` under preset "${preset}"`} on ${route.provider}/${route.model}`)
    } else {
      services.log(`session ${sessionId} is already live; injecting the resume message only`)
    }

    // 复检：活着的 Agent 真的拿到了 provider/model 才发消息 —— 否则这条消息必然以
    // 「本轮运行失败」收场，不如不发（用户看到的会是一个看不懂的报错）。
    if (services.liveRoute !== undefined && services.liveRoute(sessionId) === null) {
      services.log(`resume skipped injection: the live agent of session ${sessionId} has no provider/model, so a turn would fail prompt assembly`)
      return { sessionId, resumed: false, reason: 'no-model', preset: preset ?? null }
    }

    services.followup(sessionId, buildResumeMessage(describeResume(detail, at)))
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
 * @param {{ header: (id: string) => Promise<any>, isLive: (id: string) => boolean, isRunning?: (id: string) => boolean, route?: (id: string) => Promise<{ provider: string, model: string } | null>, resumeAgent: (id: string, preset: string | undefined, route: { provider: string, model: string }) => Promise<void>, liveRoute?: (id: string) => { provider: string, model: string } | null, followup: (id: string, message: object) => void, log: (message: string) => void }} services 服务缝。
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
    results.push(await resumeOne(services, sessionId, markerDetail(marker, sessionId), marker.at))
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
