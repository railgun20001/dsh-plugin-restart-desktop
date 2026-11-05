/**
 * dsh-plugin-restart-desktop —— 宿主半。
 *
 * ## 为什么需要这个插件
 *
 * 桌面版（Electron 壳）的进程模型与 `dsh web` 完全不同：
 *
 *   DeepSeek Harness.exe            ← Electron 主进程：窗口、托盘、更新、spawn host
 *     └── DeepSeek Harness.exe      ← host 子进程：同一个 exe，ELECTRON_RUN_AS_NODE=1，
 *           （ELECTRON_RUN_AS_NODE=1）  监听 127.0.0.1:19387
 *           └── 本插件就在这里
 *
 * 两件在别处拿不到的事：
 *
 * 1. **主进程没有暴露任何「重启」通道。** 完整 IPC 表只有 shutdown / quit-inspection /
 *    update-tasks（主进程 → host）与 ready / fatal / shutdown-complete / platform-session
 *    （host → 主进程）；渲染进程侧的 `dshDesktop` API 里也没有 restart。
 *    内置的「重启应用与 Host」菜单项只在 development 分支里存在，打包版永远看不到。
 * 2. **窗口几何从不落盘。** `createWindow()` 硬编码 1280x820，主进程里没有
 *    `getBounds` 保存、没有 window-state 存储，正常退出再开一定回到 1280x820。
 *
 * 本插件的宿主半只做四件事，其余交给分离的 helper（见 lib/helper.mjs）：
 * 校验目标是不是桌面宿主、把「会打断什么」讲清楚、写一份交接描述并把 helper 拉起来、
 * 以及在下次启动时把重启那一刻真正在跑的那些会话接上（见 lib/resume.mjs）。
 *
 * ## 关键取舍：只杀主进程，不带 /T
 *
 * helper 结束 Electron 主进程时故意不带 `/T`：主进程一死，host 子进程到它的 IPC
 * 通道断开，host 的 `process.once('disconnect')` 会走 `application.shutdown.shutdown(0)`，
 * 会话日志正常落盘。带 `/T` 会把 host 一起强杀，那才是真的可能丢数据。
 *
 * ## 安全模型
 *
 * 路由只接受同源 loopback 的 POST（带转发头一律拒绝），非桌面宿主直接拒绝并说明原因，
 * 同一时刻只允许一次重启交接。有任务在跑时**只警告、不硬拦** —— 硬拦会在 helper
 * 卡住时把重启按钮永久锁死，而解除它恰恰需要重启应用。
 *
 * @module dsh-plugin-restart-desktop
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { platformCapabilities } from './lib/platform.mjs'
import { inspectMarker, lastRequestRoute, markerSessionIds, runResume } from './lib/resume.mjs'

/** 插件标识：路由前缀、日志名、客户端 id 共用。 */
export const PLUGIN_ID = 'dsh-plugin-restart-desktop'

/** Cordis 插件名（诊断与 patch 行定位用）。 */
export const name = 'restart-desktop'

/** 硬依赖：没有 HTTP carrier 就没有路由，客户端半无从发起重启。 */
export const inject = ['webServer']

/** 本插件拥有的路由前缀（客户端用文档相对路径 `dsh-plugin-restart-desktop/...` 访问）。 */
export const ROUTE_PREFIX = '/dsh-plugin-restart-desktop'

/** 分离 helper 的绝对路径。 */
export const HELPER_PATH = fileURLToPath(new URL('./lib/helper.mjs', import.meta.url))

/** 交接描述与日志的落盘位置（与 DSH 自己的 home 保持一致）。 */
export const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
export const STATE_DIR = join(DSH_HOME, 'restart-desktop')

/** 插件自己的宿主侧设置文件（还原窗口几何 / 自动续接对话两个开关）。 */
export const SETTINGS_FILE = join(STATE_DIR, 'settings.json')
/** 待恢复标记：排程重启时写下，下次启动时消费。 */
export const PENDING_FILE = join(STATE_DIR, 'pending-resume.json')
/** 上一次恢复的结果，供状态路由讲给客户端听。 */
export const LAST_RESUME_FILE = join(STATE_DIR, 'last-resume.json')

/** 交接目录保留的组数：每次重启写一份 handoff + 一份 log，旧的要清掉。 */
export const STATE_KEEP = 20

/** helper 动手前的等待，让 HTTP 响应先送达页面。 */
export const HANDOFF_DELAY_MS = 1_500

/** 一次交接的总兜底时限：超过就允许重试，避免标志永久卡在「交接中」。 */
export const HANDOFF_DEADLINE_MS = 60_000

/**
 * 启动后多久再去处理待恢复标记。
 *
 * 让宿主先把启动 I/O（装配插件、读会话）做完；自动恢复要 resume 一个 Agent，
 * 早做只会和启动抢资源。
 */
export const RESUME_START_DELAY_MS = 6_000

/** helper 探活的两轮等待（毫秒）：先短后长，负载高时它可能启动得慢。 */
export const HELPER_PROBE_WAITS_MS = [300, 700]

/** 读取本包自己的版本号（单一事实来源）。 */
const VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
    return typeof pkg.version === 'string' && pkg.version !== '' ? pkg.version : 'unknown'
  } catch {
    return 'unknown'
  }
})()

/**
 * 读一个 JSON 文件；读不到、内容坏了、形状不对一律回 null。
 * @param {string} file 路径。
 * @returns {any | null} 解析结果或 null。
 */
export function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/u, ''))
  } catch {
    return null
  }
}

/**
 * 原子写一个 JSON 文件（临时文件 + 改名，读者要么见旧完整文件、要么见新完整文件）。
 * @param {string} file 路径。
 * @param {any} value 内容。
 * @returns {boolean} 是否写成功。
 */
export function writeJson(file, value) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.${String(process.pid)}.tmp`
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}

/**
 * 读宿主侧设置（`~/.dsh/restart-desktop/settings.json`）。
 * @param {string} [file] 路径（测试传临时路径）。
 * @returns {Record<string, unknown>} 设置；读不到时为空对象。
 */
export function readSettings(file = SETTINGS_FILE) {
  const parsed = readJson(file)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  return parsed
}

/**
 * 合并写宿主侧设置。
 * @param {Record<string, unknown>} patch 要改的字段。
 * @param {string} [file] 路径（测试传临时路径）。
 * @returns {Record<string, unknown>} 写入后的设置（失败时是写入前的值）。
 */
export function writeSettings(patch, file = SETTINGS_FILE) {
  const next = { ...readSettings(file), ...patch }
  return writeJson(file, next) ? next : readSettings(file)
}

/**
 * 从 config 与用户设置里解出宿主侧的有效开关。
 *
 * 优先级：用户改过的设置文件 > config > 内置默认。两者都只认布尔值，
 * 其余形状一律当作「没配」——一个坏文件不该把功能锁死。
 * @param {Record<string, unknown>} [config] 本插件那一行的 config。
 * @param {Record<string, unknown>} [stored] 设置文件内容。
 * @returns {{ enabled: boolean, geometry: boolean, resume: boolean }} 有效开关。
 */
export function resolveOptions(config = {}, stored = {}) {
  const pick = (key, fallback) => {
    if (typeof stored[key] === 'boolean') return stored[key]
    if (typeof config[key] === 'boolean') return config[key]
    return fallback
  }
  return {
    enabled: pick('enabled', true),
    geometry: pick('geometry', true),
    resume: pick('resume', true),
  }
}

/**
 * 判断当前 host 是否跑在 Electron 桌面壳下，并取出重启所需的目标。
 *
 * 判据全部来自进程本身，不依赖任何环境变量约定：
 * - `ELECTRON_RUN_AS_NODE=1`：说明这个「node」其实是一个 Electron 可执行文件；
 * - `process.execPath` 的 basename 不是 node：排除普通的 Node 宿主；
 * - `process.ppid` 是主进程：桌面壳 spawn host 时就是父子关系。
 *
 * 任何一条不成立都返回 null，插件于是只注册状态路由、拒绝重启，绝不误杀进程。
 * @param {NodeJS.Process} [proc] 进程对象（测试注入）。
 * @returns {{ mainPid: number, exe: string, hostPid: number } | null} 重启目标，或 null。
 */
export function desktopTarget(proc = process) {
  if (proc.env?.ELECTRON_RUN_AS_NODE !== '1') return null
  const exe = proc.execPath
  if (typeof exe !== 'string' || exe === '') return null
  const image = basename(exe).toLowerCase()
  if (image === 'node' || image === 'node.exe') return null
  const mainPid = proc.ppid
  if (!Number.isInteger(mainPid) || mainPid <= 1) return null
  return { mainPid, exe, hostPid: proc.pid }
}

/** Host 头是否指向回环地址（含 IPv6 字面量写法）。 */
export function isLoopbackHost(host) {
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]' || name === '::1'
}

/** TCP 对端是否就是本机。 */
export function loopbackPeer(req) {
  const address = req.socket?.remoteAddress
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * 桌面壳转发过来的请求是否可以信任。
 *
 * 桌面版的页面是以 `dsh-app://` 协议装载的，页面里的 `fetch('/…')` 由壳层转发到
 * host 的 HTTP 端口 —— 这种转发的请求**没有 Origin 头**。所以无 Origin 不能直接
 * 判为不可信，而是要求其余每一条都成立：没有代理痕迹、Host 是回环名字、TCP 对端
 * 是回环地址，且 `Sec-Fetch-Site` 缺省或就是 same-origin。
 * @param {import('node:http').IncomingMessage} req 请求。
 * @returns {boolean} 可信任时为 true。
 */
export function desktopForwarded(req) {
  const site = req.headers['sec-fetch-site']
  if (site !== undefined && site !== 'same-origin') return false
  if (req.headers.forwarded !== undefined
    || req.headers['x-forwarded-for'] !== undefined
    || req.headers['x-real-ip'] !== undefined) return false
  const host = req.headers.host
  if (host === undefined || !isLoopbackHost(host)) return false
  return loopbackPeer(req)
}

/**
 * 请求是否来自可信的调用方。
 *
 * 两种可信形态：浏览器直接发来的同源请求（Origin 正好是本次请求的 authority），
 * 或桌面壳转发来的请求（见 {@link desktopForwarded}）。两者都要求 TCP 对端是回环地址。
 * @param {import('node:http').IncomingMessage} req 请求。
 * @returns {boolean} 可信时为 true。
 */
export function trustedRequest(req) {
  if (!loopbackPeer(req)) return false
  const host = req.headers.host
  if (host === undefined) return false
  const origin = req.headers.origin
  if (origin === undefined) return desktopForwarded(req)
  try {
    const parsed = new URL(origin)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host === host
  } catch {
    return false
  }
}

/**
 * 解析一次请求的查询参数。
 * @param {string | undefined} url `req.url`。
 * @returns {URLSearchParams} 参数（解析失败时为空集）。
 */
export function parseQuery(url) {
  try {
    return new URL(url ?? '/', 'http://127.0.0.1').searchParams
  } catch {
    return new URLSearchParams()
  }
}

/**
 * 请求是否显式要求「我知道有东西在跑，照样重启」。
 * @param {string | undefined} url `req.url`。
 * @returns {boolean} 带 `?force=1` 时为 true。
 */
export function forceRequested(url) {
  return parseQuery(url).get('force') === '1'
}

/**
 * 一个目录是不是可用的 profile 目录。
 *
 * 只认同时具备 `package.json` 与 `node_modules` 的目录：桌面宿主把它当 argv 传进来，
 * `dsh web` 下同样的位置是别的东西，猜错就会去读错文件。
 * @param {unknown} candidate 待检查的路径。
 * @returns {string | null} 可用时返回该路径，否则 null。
 */
export function validProfileDir(candidate) {
  if (typeof candidate !== 'string' || candidate === '') return null
  try {
    if (!statSync(candidate).isDirectory()) return null
    if (!existsSync(join(candidate, 'package.json'))) return null
    if (!existsSync(join(candidate, 'node_modules'))) return null
    return candidate
  } catch {
    return null
  }
}

/**
 * 定位当前 profile 目录（用于查「有没有安装正在进行」）。
 * @param {NodeJS.Process} [proc] 进程对象（测试注入）。
 * @returns {string | null} 目录，或 null（定位不到时守卫静默跳过）。
 */
export function resolveProfileDir(proc = process) {
  return validProfileDir(proc.env?.DSH_PROFILE_DIR)
    ?? validProfileDir(proc.argv?.[3])
    ?? validProfileDir(join(DSH_HOME, 'profiles', 'desktop'))
}

/**
 * profile 上是否有一个 pnpm 运行正在写它。
 *
 * 凭据是应用自己的 `.plugin-manager/run.json`：每次包操作开始时写下、结束时删除。
 * 它存在就说明有一次安装/更新没走完 —— 此时结束主进程会把 pnpm 腰斩，依赖树可能
 * 半新半旧。只读不写：判断不了就返回 `known: false`，绝不因为读不到而拦住用户。
 * @param {string | null} dir profile 目录。
 * @returns {{ known: boolean, active: boolean, pid: number | null, record: string | null }} 状态。
 */
export function installInProgress(dir) {
  if (dir === null) return { known: false, active: false, pid: null, record: null }
  const record = join(dir, '.plugin-manager', 'run.json')
  if (!existsSync(record)) return { known: true, active: false, pid: null, record: null }
  let pid = null
  const parsed = readJson(record)
  if (Number.isInteger(parsed?.pid) && parsed.pid > 0) pid = parsed.pid
  // 读不动或内容坏了照样按「有」处理：宁可多问一次。
  return { known: true, active: true, pid, record }
}

/**
 * 现在停掉宿主会打断什么工作。
 *
 * 判据复刻应用自己的 `hasDesktopActiveTasks`：有正在生成/跑工具的智能体、有排队消息、
 * 或有正在跑/正在停的后台任务。`agents` 与 `jobs` 都是可选服务，取不到就如实回
 * `known: false`（于是守卫静默跳过），绝不因为服务形状变了就把重启按钮拦死。
 * @param {{ get?: (name: string) => unknown }} ctx host 上下文。
 * @returns {{ known: boolean, active: boolean, turns: number, queued: number, jobs: number, sessions: number }} 快照。
 */
export function taskSnapshot(ctx) {
  try {
    const agents = typeof ctx?.get === 'function' ? ctx.get('agents') : undefined
    const jobs = typeof ctx?.get === 'function' ? ctx.get('jobs') : undefined
    if (agents === undefined || jobs === undefined) return { known: false, active: false, turns: 0, queued: 0, jobs: 0, sessions: 0 }
    if (typeof agents.list !== 'function' || typeof jobs.list !== 'function') return { known: false, active: false, turns: 0, queued: 0, jobs: 0, sessions: 0 }
    const live = agents.list()
    if (!Array.isArray(live)) return { known: false, active: false, turns: 0, queued: 0, jobs: 0, sessions: 0 }
    let turns = 0
    let queued = 0
    for (const agent of live) {
      if (agent?.status === 'running') turns += 1
      const inbox = agent?.inbox
      const nextTurn = Array.isArray(inbox?.nextTurn) ? inbox.nextTurn.length : 0
      const nextStep = Array.isArray(inbox?.nextStep) ? inbox.nextStep.length : 0
      if (nextTurn > 0 || nextStep > 0) queued += 1
    }
    let running = 0
    // 第一个 undefined 是全局花名册，后面每个是各会话自己的任务 —— 与应用的写法一致。
    for (const agent of [undefined, ...live]) {
      const list = jobs.list(agent?.id)
      if (!Array.isArray(list)) continue
      for (const job of list) if (job?.status === 'running' || job?.status === 'stopping') running += 1
    }
    return { known: true, active: turns > 0 || queued > 0 || running > 0, turns, queued, jobs: running, sessions: live.length }
  } catch {
    return { known: false, active: false, turns: 0, queued: 0, jobs: 0, sessions: 0 }
  }
}

/**
 * 重启排程这一刻「真的在跑的会话」。
 *
 * 这是自动恢复的判据来源，也是本插件最容易搞错的一处：早先只认客户端交上来的
 * `sessionId`（也就是「当前打开的那个会话」），于是「在一个会话里挂着长任务、切到
 * 另一个会话点重启」会把后台那个真正被打断的会话整个漏掉。这里改成问宿主自己的实况：
 *
 *   - agent 状态是 `running`（正在生成或跑工具）；
 *   - 收件箱里有排队消息（重启会把它们一起吞掉）。
 *
 * **后台任务不算判据。** `jobs` 里 status=running 只说明有个进程还活着，不说明那一轮
 * 对话没结束：真实事故里 `session-986cedfa` 挂着一个跑了 34 小时的 `pnpm dev`，而它的
 * 最后一轮对话在前一天 17:20 就 turn/end 了 —— 重启杀掉的只是 dev server，把这个历史
 * 会话唤醒一轮纯属打扰。任务数仍写进明细，仅供排障查看。
 *
 * 服务缺失、形状不认识、抛错一律返回空数组：宁可一条都不恢复，也绝不凭猜测唤醒会话
 * （自动恢复会真的花钱、真的跑模型）。顺序固定，便于日志与单测比对。
 * @param {{ get?: (name: string) => unknown }} ctx host 上下文。
 * @returns {{ id: string, running: boolean, queued: number, jobs: number }[]} 会话清单。
 */
export function interruptedSessions(ctx) {
  try {
    const agents = typeof ctx?.get === 'function' ? ctx.get('agents') : undefined
    if (agents === undefined || typeof agents.list !== 'function') return []
    const live = agents.list()
    if (!Array.isArray(live)) return []
    const jobs = typeof ctx?.get === 'function' ? ctx.get('jobs') : undefined
    const found = []
    for (const agent of live) {
      const id = agent?.id
      if (typeof id !== 'string' || id === '') continue
      const running = agent?.status === 'running'
      const nextTurn = Array.isArray(agent?.inbox?.nextTurn) ? agent.inbox.nextTurn.length : 0
      const nextStep = Array.isArray(agent?.inbox?.nextStep) ? agent.inbox.nextStep.length : 0
      const queued = nextTurn + nextStep
      // 后台任务只作明细，不作唤醒依据 —— 见函数头「后台任务不算判据」。
      if (!running && queued === 0) continue
      let runningJobs = 0
      // 后台任务挂在会话上（`jobs.list(agentId)`）；查不到就按 0 算，不影响判据。
      if (jobs !== undefined && typeof jobs.list === 'function') {
        const list = jobs.list(id)
        if (Array.isArray(list)) {
          for (const job of list) if (job?.status === 'running' || job?.status === 'stopping') runningJobs += 1
        }
      }
      found.push({ id, running, queued, jobs: runningJobs })
    }
    return found.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
  } catch {
    return []
  }
}

/**
 * 把「会打断什么」写成一句人话。
 * @param {ReturnType<typeof taskSnapshot>} tasks 任务快照。
 * @param {ReturnType<typeof installInProgress>} installs 安装状态。
 * @returns {string[]} 逐条原因；没有则空数组。
 */
export function guardReasons(tasks, installs) {
  const reasons = []
  if (tasks.known && tasks.active) {
    const parts = []
    if (tasks.turns > 0) parts.push(`${String(tasks.turns)} 项正在生成或运行工具`)
    if (tasks.queued > 0) parts.push(`${String(tasks.queued)} 个会话有排队消息`)
    if (tasks.jobs > 0) parts.push(`${String(tasks.jobs)} 个后台任务在跑`)
    reasons.push(`有任务在跑（${parts.join('、')}）`)
  }
  if (installs.active) {
    reasons.push(installs.pid === null
      ? '插件目录上留着一条安装记录（进程已退出，可能是残留）'
      : '插件正在安装或更新')
  }
  return reasons
}

/**
 * 一次守卫检查。
 * @param {{ get?: (name: string) => unknown }} ctx host 上下文。
 * @param {string | null} dir profile 目录。
 * @returns {{ active: boolean, reasons: string[], tasks: object, installs: object }} 守卫结果。
 */
export function guardSnapshot(ctx, dir) {
  const tasks = taskSnapshot(ctx)
  const installs = installInProgress(dir)
  const reasons = guardReasons(tasks, installs)
  return { active: reasons.length > 0, reasons, tasks, installs }
}

/**
 * 交接目录只保留最近 {@link STATE_KEEP} 组。
 *
 * 一次交接会写下多个同戳文件（handoff / restart 日志 / 结果 / 几何），所以按
 * 「第一个点之前的那一段」当组名，整组一起删；`settings.json`、`pending-resume.json`、
 * `last-resume.json` 没有时间戳前缀，永远不参与清理。
 * @param {string} dir 交接目录。
 */
export function pruneState(dir) {
  try {
    const groups = new Map()
    for (const entry of readdirSync(dir)) {
      const match = /^(?:handoff|restart)-([^.]+)\./u.exec(entry)
      if (match === null) continue
      if (!groups.has(match[1])) groups.set(match[1], [])
      groups.get(match[1]).push(entry)
    }
    const doomed = [...groups.keys()].sort().reverse().slice(STATE_KEEP)
    for (const stamp of doomed) {
      for (const entry of groups.get(stamp) ?? []) {
        try {
          unlinkSync(join(dir, entry))
        } catch {
          /* 已经被删掉或本来就没有 */
        }
      }
    }
  } catch {
    /* 清理失败不该拖累重启 */
  }
}

/**
 * helper 是否还活着。
 *
 * `spawn` 只表示「创建进程的请求发出去了」：helper 立刻崩掉同样是成功返回。
 * 所以按 {@link HELPER_PROBE_WAITS_MS} 探两轮，信号 0 能送到就说明它挺过了启动。
 * @param {number | undefined} pid helper 的 pid。
 * @returns {Promise<boolean>} 还活着时为 true。
 */
export async function helperAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  for (const wait of HELPER_PROBE_WAITS_MS) {
    await new Promise((resolve) => { setTimeout(resolve, wait) })
    try {
      process.kill(pid, 0)
      return true
    } catch {
      /* 还没起来，或已经死了：进入下一轮 */
    }
  }
  return false
}

/**
 * 写交接描述，并拉起分离的 helper。
 *
 * helper 用 `process.execPath`（就是桌面应用本身）加 `ELECTRON_RUN_AS_NODE=1` 启动，
 * 因此不依赖系统 Node、也不依赖 `dsh` 在 PATH 里。
 * @param {{ mainPid: number, exe: string, hostPid: number }} target 重启目标。
 * @param {{ port: number | null, geometry: boolean, stateDir?: string, delayMs?: number }} options 选项。
 * @returns {{ hostPid: number, mainPid: number, helperPid: number | undefined, logPath: string, resultPath: string }} 交接结果。
 */
export function scheduleRestart(target, options) {
  const dir = options.stateDir ?? STATE_DIR
  mkdirSync(dir, { recursive: true })
  pruneState(dir)
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-').slice(0, 19)
  const logPath = join(dir, `restart-${stamp}.log`)
  const resultPath = join(dir, `restart-${stamp}.result.json`)
  const handoffPath = join(dir, `handoff-${stamp}.json`)
  writeFileSync(handoffPath, JSON.stringify({
    mainPid: target.mainPid,
    exe: target.exe,
    hostPid: target.hostPid,
    port: options.port ?? null,
    logPath,
    resultPath,
    geometry: options.geometry !== false,
    geometryStatePath: join(dir, `restart-${stamp}.geometry.json`),
    delayMs: options.delayMs ?? HANDOFF_DELAY_MS,
    startedAt: new Date().toISOString(),
  }, null, 2), 'utf8')

  const helper = spawn(process.execPath, [HELPER_PATH, handoffPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: dirname(HELPER_PATH),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  })
  // spawn 的失败是**异步**送达的（可执行文件不存在、被 ACL 挡住等）：不挂监听器的话
  // 它会变成未捕获异常，把整个宿主带崩。这里只记一笔，结果由 helperAlive 判定。
  helper.on('error', () => { /* 由 helperAlive 判定为「没能启动」 */ })
  helper.unref()
  return { hostPid: target.hostPid, mainPid: target.mainPid, helperPid: helper.pid, logPath, resultPath }
}

/**
 * 把宿主服务接到恢复模块的服务缝上。
 * @param {object} ctx host 上下文。
 * @param {(message: string) => void} log 日志写入。
 * @returns {object} 服务缝。
 */
export function buildResumeServices(ctx, log) {
  const agents = () => (typeof ctx.get === 'function' ? ctx.get('agents') : undefined)
  const persistence = () => (typeof ctx.get === 'function' ? ctx.get('sessionPersistence') : undefined)
  const presets = () => (typeof ctx.get === 'function' ? ctx.get('agentPresets') : undefined)
  /**
   * 从一份 agent options / 模型选择里取出可用的 provider+model。
   * @param {any} options 候选对象。
   * @returns {{ provider: string, model: string } | null} 两者都齐时返回路由，否则 null。
   */
  const routeOf = (options) => (
    typeof options?.provider === 'string' && options.provider !== ''
    && typeof options?.model === 'string' && options.model !== ''
      ? { provider: options.provider, model: options.model }
      : null
  )
  return {
    async header(id) {
      const service = persistence()
      if (service === undefined || typeof service.stat !== 'function') return undefined
      const snapshot = await service.stat(id)
      return snapshot?.header
    },
    isLive: (id) => agents()?.get(id) !== undefined,
    /**
     * 这个会话是不是正在跑一个回合。
     *
     * 和 `isLive` 分开：一个会话可以是活的但空闲（用户刚打开、还没发消息），那种情况
     * 注入恢复消息是对的；而正在跑的回合里再插一条「桌面版重启过」，就成了拿过期的
     * 现场记录干扰它正在进行的工作。
     * @param {string} id 会话 id。
     * @returns {boolean} 正在跑时为 true。
     */
    isRunning: (id) => agents()?.get(id)?.status === 'running',
    /**
     * 恢复这个会话该用哪条模型路由。
     *
     * 首选**会话自己日志里最近一次请求**的路由（与官方冷恢复
     * `agent.session.requestHeader()` 同源，用的是官方只读句柄 `open(id, 'read')`），
     * 退路才是部署默认模型（`@deepseek-ai/dsh-agent-default-model` 的 `currentSelection()`）。
     * 两条都拿不到就返回 null：调用方据此**拒绝恢复** —— 见 lib/resume.mjs 模块头，
     * 恢复出来的 Agent 缺 provider/model 会在组装提示词时直接失败，而且会一直坏着。
     * @param {string} id 会话 id。
     * @returns {Promise<{ provider: string, model: string } | null>} 路由或 null。
     */
    async route(id) {
      const service = persistence()
      if (service !== undefined && typeof service.open === 'function') {
        let handle
        try {
          handle = await service.open(id, 'read')
          const slice = await handle.read(0, undefined)
          const found = lastRequestRoute(slice?.events)
          if (found !== null) return found
        } catch (error) {
          log(`could not read the last model route of session ${id}: ${String((error && error.message) || error)}`)
        } finally {
          try {
            await handle?.close?.()
          } catch {
            /* 关不上不影响恢复 */
          }
        }
      }
      try {
        return routeOf(ctx.get('agentDefaultModel')?.currentSelection?.())
      } catch {
        return null
      }
    },
    /** 活着的 Agent 实际拿到的路由（用于发消息前复检）。 */
    liveRoute: (id) => routeOf(agents()?.get(id)?.options),
    async resumeAgent(id, preset, route) {
      const service = agents()
      if (service === undefined || typeof service.resume !== 'function') throw new Error('the agents service is unavailable')
      // preset 挂载失败不该让整个恢复失败：恢复优先于完整。
      const setup = preset === undefined ? undefined : async (agentCtx) => {
        const registry = presets()
        if (registry === undefined) return
        try {
          const resolved = await registry.resolve(preset)
          await registry.mount(agentCtx, resolved.id)
        } catch (error) {
          log(`preset "${preset}" could not be mounted; resuming without its tools: ${String((error && error.message) || error)}`)
        }
      }
      // `agentOptions` 不能省：系统提示词的 `{{model}}` 取自 `agent.options.model`，
      // 缺了 provider/model 的 Agent 每一轮都会在组装提示词时失败。
      await service.resume({
        resumeSessionId: id,
        agentOptions: { provider: route.provider, model: route.model },
        ...(setup === undefined ? {} : { setup }),
      })
    },
    followup(id, message) {
      const agent = agents()?.get(id)
      if (agent === undefined || typeof agent.followup !== 'function') throw new Error('the resumed agent is unavailable')
      agent.followup(message)
    },
    log,
  }
}

/**
 * 挂载插件。
 * @param {import('@deepseek-ai/cordis').Context} ctx host 上下文。
 * @param {{ enabled?: boolean, geometry?: boolean, resume?: boolean, stabilizeMs?: number }} [config] 本插件那一行的 config。
 */
export function apply(ctx, config = {}) {
  const target = desktopTarget()
  // 「是不是桌面宿主」与「这个平台能不能重启」是两件事，分开判：
  // macOS / Linux 的桌面版也会被认成桌面宿主，但今天还没有进程控制驱动。
  const platform = platformCapabilities()
  const profileDir = resolveProfileDir()
  let scheduled = false
  let lastRestart = null
  let lastResume = readJson(LAST_RESUME_FILE)

  /**
   * 写一行日志。日志不可用绝不影响功能。
   * @param {string} message 内容。
   */
  const log = (message) => {
    try {
      const logger = typeof ctx.logger === 'function' ? ctx.logger(PLUGIN_ID) : ctx.logger
      logger?.info?.(message)
    } catch {
      /* 日志不可用不影响功能 */
    }
  }

  /** 当前有效开关（每次读，用户改了设置文件不需要重启插件）。 */
  const options = () => resolveOptions(config, readSettings())

  // ── 启动后处理「待恢复标记」────────────────────────────────────────────────
  // 标记是上一次排程重启时写下的。这里先把它取走（删除），再决定要不要恢复：
  // 取走保证了「一次重启最多恢复一次」，即使恢复本身失败也不会在下次启动时重放。
  const resumeDelay = Number(config.stabilizeMs) > 0 ? Number(config.stabilizeMs) : RESUME_START_DELAY_MS
  ctx.effect(() => {
    const timer = setTimeout(() => {
      const marker = readJson(PENDING_FILE)
      if (marker === null) return
      try {
        unlinkSync(PENDING_FILE)
      } catch {
        /* 删不掉也要继续：最坏情况是下次启动再判断一次，而那时它已经过期 */
      }
      const verdict = inspectMarker(marker, Date.now())
      if (!verdict.usable) {
        const ids = markerSessionIds(marker)
        lastResume = {
          resumed: false,
          reason: verdict.reason,
          sessionId: typeof marker?.sessionId === 'string' ? marker.sessionId : ids[0] ?? null,
          sessions: [],
          at: Date.now(),
        }
        writeJson(LAST_RESUME_FILE, lastResume)
        if (verdict.reason !== 'no-marker') log(`resume marker discarded: ${String(verdict.reason)}`)
        return
      }
      if (!options().resume) {
        lastResume = { resumed: false, reason: 'disabled', sessionId: marker.sessionId, sessions: [], at: Date.now() }
        writeJson(LAST_RESUME_FILE, lastResume)
        log('resume marker discarded: auto-resume is disabled in the plugin settings')
        return
      }
      log(`resume marker armed with ${String(markerSessionIds(marker).length)} interrupted session(s)`)
      void runResume(buildResumeServices(ctx, log), marker)
        .then((result) => {
          lastResume = { ...result, at: Date.now() }
          writeJson(LAST_RESUME_FILE, lastResume)
        })
        .catch((error) => {
          lastResume = { resumed: false, reason: String((error && error.message) || error), sessionId: marker.sessionId, at: Date.now() }
          writeJson(LAST_RESUME_FILE, lastResume)
        })
    }, resumeDelay)
    timer.unref?.()
    return () => clearTimeout(timer)
  }, `${PLUGIN_ID}: pending resume`)

  // 上一次重启的结果由 helper 写在交接目录里；启动时读一次，讲给用户听。
  try {
    const results = readdirSync(STATE_DIR).filter((entry) => entry.endsWith('.result.json')).sort()
    const newest = results.at(-1)
    if (newest !== undefined) lastRestart = readJson(join(STATE_DIR, newest))
  } catch {
    /* 目录还不存在：说明从来没重启过 */
  }

  /**
   * 排程一次重启。路由与斜杠命令共用这一条路径，因此守卫只需要维护一份。
   * @param {{ force?: boolean, sessionId?: string | null, resume?: boolean }} [request] 调用方意图。
   * @returns {Promise<{ status: number, body: Record<string, unknown> }>} 给调用方的结果。
   */
  async function scheduleOnce(request = {}) {
    const current = options()
    if (!current.enabled) {
      return { status: 403, body: { ok: false, error: '插件配置里把 enabled 设成了 false，重启功能已停用' } }
    }
    if (target === null) {
      return {
        status: 409,
        body: { ok: false, error: '当前不是 DeepSeek Harness 桌面版；本插件只负责重启桌面应用' },
      }
    }
    // 平台能力是**硬拒绝**：与「不是桌面版」同级，force 也绕不过去 ——
    // 这个平台上根本没有 taskkill / tasklist / PowerShell，放行只会白等 15 秒再空拉三次。
    if (!platform.restart) {
      return {
        status: 409,
        body: { ok: false, platform: platform.id, error: platform.reason },
      }
    }
    if (scheduled) {
      return { status: 409, body: { ok: false, error: '已经有一次重启正在准备中' } }
    }
    // 守卫排在「已经在交接中」之后：那一条是状态冲突，不是「要不要继续」的问题，
    // 不该被 force 绕过去。这里只警告，不硬拦 —— 见文件头关于死锁的说明。
    if (request.force !== true) {
      const guard = guardSnapshot(ctx, profileDir)
      if (guard.active) {
        return {
          status: 409,
          body: {
            ok: false,
            guard,
            error: `${guard.reasons.join('；')}。继续重启会打断它们（正在写的文件可能停在半路），确认要继续吗？`,
          },
        }
      }
    }

    // 「被打断」的判据是**宿主自己看到的实况**，不是「客户端当前打开的那个会话」：
    // 在一个会话里挂着长任务、切到另一个会话点重启时，被打断的是后台那个。
    // 客户端传来的 sessionId 只用来在它确实在跑、而 agents.list() 又没列到它时补一笔。
    let sessionId = null
    if (typeof request.sessionId === 'string' && request.sessionId !== '') sessionId = request.sessionId
    const interrupted = current.resume ? interruptedSessions(ctx) : []
    if (current.resume && sessionId !== null && !interrupted.some((entry) => entry.id === sessionId)) {
      try {
        const agent = typeof ctx.get === 'function' ? ctx.get('agents')?.get(sessionId) : undefined
        if (agent?.status === 'running') {
          interrupted.push({ id: sessionId, running: true, queued: 0, jobs: 0 })
          interrupted.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
        }
      } catch {
        /* 服务形状不认识：只按宿主自己看到的实况 */
      }
    }
    if (current.resume) {
      writeJson(PENDING_FILE, {
        // 名单是主判据；`sessionId` 留给旧读取方（以及状态路由里的单个会话展示）。
        sessions: interrupted.map((entry) => entry.id),
        details: interrupted,
        interrupted: interrupted.length > 0,
        sessionId: sessionId ?? interrupted[0]?.id ?? null,
        at: Date.now(),
        host: process.pid,
        requestedResume: request.resume !== false,
      })
    } else {
      try {
        unlinkSync(PENDING_FILE)
      } catch {
        /* 本来就没有 */
      }
    }

    scheduled = true

    let result
    try {
      result = scheduleRestart(target, {
        port: typeof ctx.webServer?.port === 'number' ? ctx.webServer.port : null,
        geometry: current.geometry,
      })
    } catch (error) {
      scheduled = false
      return { status: 500, body: { ok: false, error: String((error && error.message) || error) } }
    }

    // spawn 成功不等于 helper 活着：等它挺过启动再确认。它已经死了就说明这次交接
    // 根本没开始，必须复位标志，否则用户会被永久锁在「交接中」。
    if (!await helperAlive(result.helperPid)) {
      scheduled = false
      return {
        status: 500,
        body: { ok: false, error: '负责重启的辅助进程没能启动，这次重启没有开始；可以再试一次' },
      }
    }

    // 兜底：helper 活着却迟迟没让应用重启（卡住、主进程杀不掉）时，放行重试。
    // 正常路径下应用已经重启，这个定时器随旧进程一起消失。
    const deadline = setTimeout(() => { scheduled = false }, HANDOFF_DEADLINE_MS)
    deadline.unref?.()

    const armed = interrupted.map((entry) => entry.id)
    log(`restart scheduled: host pid ${String(result.hostPid)}, main pid ${String(result.mainPid)}, helper pid ${String(result.helperPid)}, resume=${armed.length === 0 ? 'none' : armed.join(',')}`)
    return {
      status: 202,
      body: {
        ok: true,
        hostPid: result.hostPid,
        mainPid: result.mainPid,
        geometry: current.geometry,
        resume: {
          armed: current.resume && armed.length > 0,
          interrupted: armed.length > 0,
          sessions: armed,
          sessionId: sessionId ?? armed[0] ?? null,
        },
      },
    }
  }

  /** 写一个 JSON 响应。 */
  const respond = (res, status, body) => {
    try {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(body))
    } catch {
      /* 连接已经断了：忽略 */
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (req, res) => {
      const action = typeof req.url === 'string' && req.url.startsWith(`${ROUTE_PREFIX}/`)
        ? req.url.slice(ROUTE_PREFIX.length + 1).split('?')[0]
        : ''
      req.resume?.()

      if (!trustedRequest(req)) {
        respond(res, 403, { ok: false, error: '本插件的路由只接受来自本机页面的请求' })
        return
      }

      const current = options()

      if (action === 'api/status' && req.method === 'GET') {
        const guard = guardSnapshot(ctx, profileDir)
        respond(res, 200, {
          host: PLUGIN_ID,
          version: VERSION,
          desktop: target !== null,
          platform: platform.id,
          // 能力是**平台**级事实，desktop 是**宿主形态**级事实：两者分开给，
          // 客户端才能把「不是桌面版」与「这个平台还不支持」讲成两句不同的话。
          capabilities: {
            restart: platform.restart,
            launchArgs: platform.launchArgs,
            geometry: platform.geometry,
            alert: platform.alert,
            reason: platform.reason,
          },
          enabled: current.enabled,
          settings: { geometry: current.geometry, resume: current.resume },
          // 只给计数与人话，不含任何本机路径（它们会把用户名交给任何能访问这个端口的人）。
          guard: { active: guard.active, reasons: guard.reasons, known: guard.tasks.known, sessions: guard.tasks.sessions },
          restart: lastRestart === null ? null : {
            ok: lastRestart.ok === true,
            stage: lastRestart.stage ?? null,
            // 失败原因（例如「平台不支持」「辅助进程没能启动」）要能直接看到，
            // 否则用户只能看到一个内部阶段名。
            reason: lastRestart.reason ?? null,
            finishedAt: lastRestart.finishedAt ?? null,
            geometry: lastRestart.geometry === undefined ? null : {
              captured: lastRestart.geometry?.ok === true,
              maximized: lastRestart.geometry?.maximized === true,
              minimized: lastRestart.geometry?.minimized === true,
            },
          },
          resume: lastResume === null ? null : {
            resumed: lastResume.resumed === true,
            reason: lastResume.reason ?? null,
            sessionId: lastResume.sessionId ?? null,
            // 一次重启可能接上多个会话（后台任务被打断的情形），这里如实给出全部。
            sessions: Array.isArray(lastResume.sessions) ? lastResume.sessions : [],
            at: lastResume.at ?? null,
          },
        })
        return
      }

      if (action === 'api/restart' && req.method === 'POST') {
        const query = parseQuery(req.url)
        const sessionId = query.get('session')
        const { status, body } = await scheduleOnce({
          force: forceRequested(req.url),
          sessionId: sessionId === null || sessionId === '' ? null : sessionId,
          resume: query.get('resume') !== '0',
        })
        respond(res, status, body)
        return
      }

      if (action === 'api/settings' && req.method === 'POST') {
        const query = parseQuery(req.url)
        const patch = {}
        for (const key of ['geometry', 'resume']) {
          const value = query.get(key)
          if (value === '0' || value === '1') patch[key] = value === '1'
        }
        if (Object.keys(patch).length > 0) writeSettings(patch)
        const next = options()
        respond(res, 200, { ok: true, settings: { geometry: next.geometry, resume: next.resume } })
        return
      }

      if (action === 'api/ping' && req.method === 'POST') {
        respond(res, 200, { host: PLUGIN_ID, version: VERSION })
        return
      }

      respond(res, 404, { error: 'unknown-action' })
    },
  }), `${PLUGIN_ID}: routes`)

  // 斜杠命令：在输入框里打 /restart-desktop 就能重启，不必翻到浮窗或设置页。
  // commands 是可选服务；config.command === false 时整个不注册。
  if (config.command !== false) {
    ctx.inject(['commands'], (commandCtx) => {
      commandCtx.effect(() => commandCtx.commands.register({
        name: 'restart-desktop',
        description: '重启整个 DeepSeek Harness 桌面应用（保留窗口位置与大小）',
        handler: async (invocation) => {
          // 有任务在跑时先只回警告，`/restart-desktop --force` 才是「我看过了」。
          const rawInput = typeof invocation?.rawInput === 'string' ? invocation.rawInput : ''
          const force = /(?:^|\s)--force(?:\s|$)/u.test(rawInput.trim())
          const sessionId = typeof invocation?.agent?.id === 'string' ? invocation.agent.id : null
          const { status, body } = await scheduleOnce({ force, sessionId })
          if (body.ok === true) {
            return { kind: 'success', text: '已排程重启：窗口会关闭，随后自动打开并还原到原来的位置与大小。' }
          }
          const hint = body.guard === undefined ? '' : '。确认要继续就再执行一次：/restart-desktop --force'
          return { kind: 'error', text: String(body.error ?? `重启被拒绝（HTTP ${String(status)}）`) + hint }
        },
      }), `${PLUGIN_ID}: /restart-desktop command`)
    })
  }

  log(`host half v${VERSION} loaded: desktop=${String(target !== null)} platform=${platform.id} restart=${String(target !== null && platform.restart)} routes=${ROUTE_PREFIX}`)
}

/**
 * 给离线测试用的内部函数（不参与运行时行为）。
 * @internal
 */
export const __test = {
  VERSION,
  resolveOptions,
  desktopTarget,
  taskSnapshot,
  interruptedSessions,
  installInProgress,
  guardReasons,
  guardSnapshot,
  trustedRequest,
  desktopForwarded,
  parseQuery,
  forceRequested,
  validProfileDir,
  resolveProfileDir,
  pruneState,
  readSettings,
  writeSettings,
  readJson,
  writeJson,
}

export default { name, inject, apply }
