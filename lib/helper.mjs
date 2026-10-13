/**
 * dsh-restart-desktop —— 分离 helper（重启的实际执行者）。
 *
 * 由宿主半用「桌面应用本身 + ELECTRON_RUN_AS_NODE=1」启动，因此不依赖系统 Node，
 * 也不依赖 `dsh` 在 PATH 里。它是交接期间唯一能活过宿主的东西，所以整件事由它做完：
 *
 *   1. 等一小会儿，让宿主的 HTTP 响应先送达页面；
 *   2. **趁主进程还活着**捕获窗口几何（位置 / 大小 / 最大化 / 最小化）；
 *   3. 结束 Electron 主进程 —— 故意不带 `/T`：host 子进程必须活下来，才能在 IPC
 *      断开后走自己的优雅关闭（`application.shutdown`），把会话日志正常落盘。
 *      带 `/T` 会把 host 一起强杀，那才是真的会丢数据；
 *   4. 等主进程消失，再等监听端口释放（用「连接」探测，不用「绑定」——试探性绑定
 *      恰恰会占住替代进程要用的那个端口）；
 *   5. 端口迟迟不放时兜底清理残留进程（helper 自己、已结束的主进程与 **host** 都
 *      排除在外；host 另有单独的最后一步，因为它本该自己优雅退出）；
 *   6. 用干净的环境拉起新实例 —— 必须去掉 ELECTRON_RUN_AS_NODE，否则新的「应用」
 *      会以 Node 模式启动，变成一个没有窗口的进程；
 *   7. 等新窗口出现，用 Win32 `SetWindowPos` / `ShowWindow` 把几何逐像素还原回去。
 *
 * 两条贯穿全程的原则：
 *
 *   - **「问不出来」不等于「没有」**。tasklist / PowerShell 查不到时返回 null 而不是
 *     空结果，调用方据此区分「这个进程已经没了」与「进程表读不到」——后者若被当成
 *     前者，就会跳过结束主进程，随后在旧实例还活着时再拉起一个。
 *   - **几何失败不影响重启**。窗口几何是「更好」，重启是「目的」；捕获或还原失败
 *     只写日志，绝不因此放弃重启。
 *
 * 用法：`node helper.mjs <handoff.json>`
 * 所有诊断写入 handoff 里指定的 logPath；这个进程的 stdio 是 ignore。
 *
 * @module dsh-restart-desktop/helper
 */

import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 主进程消失的等待上限。 */
export const MAIN_EXIT_TIMEOUT_MS = 15_000
/** 端口释放的等待上限。 */
export const PORT_FREE_TIMEOUT_MS = 30_000
/** 默认的交接前等待（让 HTTP 响应先出去）。 */
export const DEFAULT_DELAY_MS = 1_500
/** 默认的拉起尝试次数与每次的存活观察窗口。 */
export const DEFAULT_RELAUNCH_ATTEMPTS = 3
export const DEFAULT_RELAUNCH_VERIFY_MS = 2_500
/** 两次拉起尝试之间的间隔。 */
export const RELAUNCH_RETRY_GAP_MS = 1_500
/** 新实例接管端口的等待上限。 */
export const PORT_RELISTEN_TIMEOUT_MS = 20_000
/** 查进程表的超时（PowerShell 冷启动约 1 秒，留足余量）。 */
export const PROCESS_QUERY_TIMEOUT_MS = 8_000
/** 一次几何捕获 / 还原调用允许占用的时间。 */
export const GEOMETRY_TIMEOUT_MS = 90_000

/** 本文件旁边的 geometry.ps1。 */
export const GEOMETRY_SCRIPT = fileURLToPath(new URL('./geometry.ps1', import.meta.url))

/** 等待若干毫秒。 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 比较路径时统一分隔符、大小写与尾部分隔符。
 * @param {unknown} value 原始路径。
 * @returns {string} 归一化后的路径。
 */
export function normalizePath(value) {
  return String(value ?? '').replace(/\//gu, '\\').replace(/\\+$/u, '').toLowerCase()
}

/**
 * 按 Windows 的规则把命令行拆成参数。
 *
 * 只需要处理常见的两种写法：引号包裹、以及引号里的 `\"`。刻意不实现完整的反斜杠
 * 连写规则 —— 遇到 `\"` 时调用方会直接放弃复用原始参数（见 {@link relaunchArgsFrom}），
 * 所以这里不需要为罕见形态承担有损解析的风险。
 * @param {string} text 命令行原文。
 * @returns {string[]} 参数列表（含第 0 个可执行文件）。
 */
export function tokenizeCommandLine(text) {
  const tokens = []
  let current = ''
  let started = false
  let inQuotes = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === '\\' && text[index + 1] === '"') {
      current += '"'
      started = true
      index += 1
      continue
    }
    if (char === '"') {
      inQuotes = !inQuotes
      started = true
      continue
    }
    if (!inQuotes && (char === ' ' || char === '\t')) {
      if (started) {
        tokens.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += char
    started = true
  }
  if (started) tokens.push(current)
  return tokens
}

/**
 * 从主进程的命令行里取出「除可执行文件之外」的启动参数。
 *
 * 重启必须把原来的参数带上：否则一个用 `--user-data-dir` 或别的开关启动的实例，
 * 重启后会悄悄变成默认形态。拿不准就返回 null —— 调用方退回「不带参数拉起」，
 * 绝不会因为解析而拉错东西。
 * @param {string | null | undefined} commandLine 主进程命令行。
 * @param {string} exe 期望的可执行文件绝对路径。
 * @returns {string[] | null} 参数数组（可能为空），或 null 表示放弃复用。
 */
export function relaunchArgsFrom(commandLine, exe) {
  if (typeof commandLine !== 'string' || commandLine.trim() === '') return null
  // 带转义引号的命令行不做有损解析，直接放弃。
  if (commandLine.includes('\\"')) return null
  const tokens = tokenizeCommandLine(commandLine)
  if (tokens.length === 0) return null
  if (normalizePath(tokens[0]) !== normalizePath(exe)) return null
  const args = tokens.slice(1)
  // 同一个可执行文件有好几种身份：主进程、host、渲染/GPU 子进程都用它。
  // 带上 `--type=` 或 `--expose-internals` 说明抓到的是 Chromium 子进程或宿主，
  // 那不是「用户当初怎么启动这个应用」的答案 —— 宁可退回不带参数。
  for (const arg of args) {
    if (/^--type=/u.test(arg) || arg === '--expose-internals') return null
  }
  return args
}

/**
 * 兜底清理时应当结束哪些 pid。
 *
 * 兜底强杀按可执行文件路径匹配，不按映像名 —— 同名但来自别的目录的副本不动。
 * 拿不到路径的条目一律跳过。
 * @param {{ pid: number, path: string | null }[]} processes 进程表。
 * @param {string} exe 目标可执行文件。
 * @param {(number | undefined)[]} [skip] 不参与批量清理的 pid。
 * @returns {number[]} 应当结束的 pid。
 */
export function leftoverPids(processes, exe, skip = []) {
  const wanted = normalizePath(exe)
  const skipSet = new Set((Array.isArray(skip) ? skip : []).filter((pid) => Number.isInteger(pid) && pid > 0))
  const pids = []
  for (const entry of Array.isArray(processes) ? processes : []) {
    if (!Number.isInteger(entry?.pid) || entry.pid <= 0) continue
    if (typeof entry.path !== 'string' || entry.path === '') continue
    if (normalizePath(entry.path) !== wanted) continue
    if (skipSet.has(entry.pid)) continue
    pids.push(entry.pid)
  }
  return pids
}

/**
 * 查同名进程的 pid、可执行文件路径与命令行。
 *
 * 用 `-EncodedCommand` 送脚本：Windows 上把带引号的 PowerShell 脚本塞进 `-Command`
 * 的转义规则很容易出错，base64 完全绕开它。任何失败都返回 null，调用方各自退回
 * 保守行为（不复用参数、按映像名兜底）。
 * @param {string} exeName 映像名（含扩展名）。
 * @returns {{ pid: number, path: string | null, commandLine: string | null }[] | null} 进程表，或 null。
 */
export function queryApplicationProcesses(exeName) {
  const safeName = String(exeName).replace(/'/gu, "''")
  const script = [
    "$ProgressPreference='SilentlyContinue'",
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
    `Get-CimInstance Win32_Process -Filter "Name='${safeName}'" | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress`,
  ].join('; ')
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  let out = ''
  for (const shell of ['powershell.exe', 'pwsh.exe']) {
    try {
      out = execFileSync(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
        encoding: 'utf8',
        timeout: PROCESS_QUERY_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      })
      break
    } catch (error) {
      out = ''
      if (error && error.code !== 'ENOENT') return null
    }
  }
  const text = out.trim()
  if (text === '') return []
  try {
    const parsed = JSON.parse(text)
    const list = Array.isArray(parsed) ? parsed : [parsed]
    return list.map((entry) => ({
      pid: Number(entry?.ProcessId),
      path: typeof entry?.ExecutablePath === 'string' ? entry.ExecutablePath : null,
      commandLine: typeof entry?.CommandLine === 'string' ? entry.CommandLine : null,
    })).filter((entry) => Number.isInteger(entry.pid) && entry.pid > 0)
  } catch {
    return null
  }
}

/**
 * 找到可用的 PowerShell 宿主。
 *
 * 优先 Windows PowerShell 5.1（系统自带、一定存在），找不到才回落到 `pwsh`。
 * @returns {string} 可执行文件路径（可能是裸命令名，交给 PATH 解析）。
 */
export function powershellHost() {
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
  return join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

/**
 * 读一个 JSON 文件，容忍 BOM；读不到或形状不对时返回 null。
 *
 * Windows PowerShell 5.1 的 `Set-Content -Encoding UTF8` 会写 BOM，Node 的
 * `JSON.parse` 遇到 BOM 会直接抛错，所以这里必须先剥掉。
 * @param {string} file 文件路径。
 * @returns {any | null} 解析结果或 null。
 */
export function readJsonTolerant(file) {
  try {
    const text = readFileSync(file, 'utf8').replace(/^\uFEFF/u, '')
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * 调一次 geometry.ps1，并读回它写的 JSON 结果。
 * @param {'capture' | 'restore'} mode 模式。
 * @param {number} pid 目标进程。
 * @param {{ state?: string, out: string, timeoutSeconds?: number, note: (line: string) => void }} options 选项。
 * @returns {any | null} 结果对象，或 null 表示脚本没能给出结论。
 */
export function runGeometryScript(mode, pid, options) {
  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', GEOMETRY_SCRIPT,
    '-Mode', mode,
    '-ProcessId', String(pid),
    '-Out', options.out,
  ]
  if (mode === 'restore') {
    args.push('-State', String(options.state ?? ''))
    args.push('-TimeoutSeconds', String(options.timeoutSeconds ?? 90))
  }
  try {
    execFileSync(powershellHost(), args, {
      encoding: 'utf8',
      timeout: GEOMETRY_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    })
  } catch (error) {
    // 非零退出不代表没有结论：脚本内部已经把失败写进了 -Out。先读文件。
    options.note(`geometry ${mode} exited with an error: ${String((error && error.message) || error)}`)
  }
  return readJsonTolerant(options.out)
}

/**
 * 重启没成功时叫人手动打开应用。
 *
 * 只在「主进程已经结束、新实例又起不来」这条路上出现 —— 那时窗口再也不会回来，
 * 日志没人看，弹窗是唯一能把话说到用户眼前的办法。尽力而为：弹不出来就算了，
 * 绝不因此影响别的流程。
 *
 * **刻意不用 `detached: true`**：Windows 上 detached 会带 `DETACHED_PROCESS`，
 * 而 Windows PowerShell 5.1 没有控制台时会**立刻退出**（实测 exit code 0、什么都没做）。
 * 这里改用「非 detached + unref」：Windows 默认不会因父进程退出而结束子进程，
 * 弹窗照常留在屏幕上，helper 也可以立刻退出。
 * @param {string} text 提示内容。
 * @returns {boolean} 是否已把请求发出去。
 */
export function alertUser(text) {
  const script = `Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show(${JSON.stringify(text)}, 'DeepSeek Harness') | Out-Null`
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  for (const shell of ['powershell.exe', 'pwsh.exe']) {
    try {
      const child = spawn(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
        stdio: 'ignore',
        windowsHide: true,
      })
      child.unref()
      return true
    } catch {
      /* 换下一个 shell */
    }
  }
  return false
}

/**
 * 交接并重启。
 * @param {object} handoff 交接描述（见 index.js 的 scheduleRestart）。
 * @param {(line: string) => void} note 诊断写入。
 * @returns {Promise<{ ok: boolean, stage: string, geometry: object | null }>} 结果摘要。
 */
export async function performRestart(handoff, note) {
  const mainPid = Number(handoff.mainPid)
  const exe = String(handoff.exe ?? '')
  const hostPid = Number(handoff.hostPid)
  const port = Number(handoff.port)
  const delayMs = Number(handoff.delayMs) > 0 ? Number(handoff.delayMs) : DEFAULT_DELAY_MS
  const attempts = Number(handoff.relaunchAttempts) > 0 ? Number(handoff.relaunchAttempts) : DEFAULT_RELAUNCH_ATTEMPTS
  const verifyMs = Number(handoff.relaunchVerifyMs) > 0 ? Number(handoff.relaunchVerifyMs) : DEFAULT_RELAUNCH_VERIFY_MS
  // 三个等待上限同样可以被交接描述覆盖：冒烟测试要靠它把「端口迟迟不放」那条兜底
  // 路径在几百毫秒内跑完，而不是真的等满 30 秒。缺省仍是正式的那三个值。
  const mainExitTimeoutMs = Number(handoff.mainExitTimeoutMs) > 0 ? Number(handoff.mainExitTimeoutMs) : MAIN_EXIT_TIMEOUT_MS
  const portFreeTimeoutMs = Number(handoff.portFreeTimeoutMs) > 0 ? Number(handoff.portFreeTimeoutMs) : PORT_FREE_TIMEOUT_MS
  const portRelistenTimeoutMs = Number(handoff.portRelistenTimeoutMs) > 0 ? Number(handoff.portRelistenTimeoutMs) : PORT_RELISTEN_TIMEOUT_MS
  const alertOnFailure = handoff.alertOnFailure !== false
  const wantGeometry = handoff.geometry !== false
  /** 几何中间文件落在交接目录里，与日志同级，便于事后核对。 */
  const geometryStatePath = String(handoff.geometryStatePath ?? `${String(handoff.logPath ?? '')}.geometry.json`)
  const geometryResultPath = `${geometryStatePath}.result.json`

  const result = { ok: false, stage: 'start', geometry: null }

  /** 进程是否还活着（信号 0 只做存在性检查）。 */
  const alive = (pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  /**
   * 端口上是否有人监听。
   * @param {number} p 端口。
   * @returns {Promise<boolean>} 有人应答时为 true。
   */
  const listening = (p) => new Promise((resolve) => {
    let settled = false
    const probe = connect({ host: '127.0.0.1', port: p })
    const finish = (value) => {
      if (settled) return
      settled = true
      probe.destroy()
      resolve(value)
    }
    probe.on('connect', () => finish(true))
    probe.on('error', () => finish(false))
    probe.setTimeout(500, () => finish(false))
  })

  /**
   * 强杀一个 pid。
   * @param {number} pid 目标。
   * @returns {boolean} taskkill 是否成功。
   */
  const killPid = (pid) => {
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore', windowsHide: true })
      return true
    } catch {
      return false
    }
  }

  /**
   * 解析 tasklist 的 CSV 输出。只取 `"名字","pid"` 这种 ASCII 结构，
   * 因此中文系统上的提示行不会干扰解析。
   *
   * **查不出来返回 `null`，不是空数组。** 「没有这个进程」和「问不出来」是两件事。
   * @param {string[]} args 传给 tasklist 的参数。
   * @returns {{ image: string, pid: number }[] | null} 进程列表，或 null 表示查不出来。
   */
  const tasklist = (args) => {
    try {
      const out = execFileSync('tasklist', args, { encoding: 'utf8', windowsHide: true })
      return [...out.matchAll(/"([^"]*)","(\d+)"/gu)]
        .map((match) => ({ image: match[1], pid: Number(match[2]) }))
        .filter((entry) => Number.isInteger(entry.pid) && entry.pid > 0)
    } catch {
      return null
    }
  }

  /**
   * 目标 pid 当前的映像名，用于确认它确实是我们要结束的那个进程。
   * @param {number} pid 目标。
   * @returns {{ known: boolean, image: string | null }} `known: false` 表示查不出来
   *   （不是「这个进程不存在」）；`known: true` 且 `image: null` 才是它确实已经不在了。
   */
  const imageNameOf = (pid) => {
    const rows = tasklist(['/FI', `PID eq ${String(pid)}`, '/FO', 'CSV', '/NH'])
    if (rows === null) return { known: false, image: null }
    const found = rows.find((entry) => entry.pid === pid)
    return { known: true, image: found === undefined ? null : found.image }
  }

  /** 当前所有同名桌面应用进程（含 helper 自己）；查不出来时回 null。 */
  const applicationPids = () => {
    if (exe === '') return []
    const rows = tasklist(['/FI', `IMAGENAME eq ${basename(exe)}`, '/FO', 'CSV', '/NH'])
    return rows === null ? null : rows.map((entry) => entry.pid)
  }

  note(`helper started: helper=${process.pid} host=${hostPid} main=${mainPid} port=${port} exe=${exe}`)

  if (!Number.isInteger(mainPid) || mainPid <= 1) {
    note('refusing: the handoff carries no usable main process id')
    result.stage = 'refused-main-pid'
    return result
  }
  if (exe === '') {
    note('refusing: the handoff carries no application executable')
    result.stage = 'refused-exe'
    return result
  }

  // 1. 先让页面拿到「已排程重启」的响应。
  await sleep(delayMs)

  // 2. 趁主进程还活着捕获窗口几何。失败只记日志：窗口几何是「更好」，重启是「目的」。
  if (wantGeometry) {
    const captured = runGeometryScript('capture', mainPid, { out: geometryStatePath, note })
    result.geometry = captured
    if (captured?.ok === true) {
      const rect = captured.restoreRect
      const shape = captured.maximized ? 'maximized' : captured.minimized ? 'minimized' : 'normal'
      // 显示器名要一起记：最大化窗口的还原是「在哪块屏上最大化」的问题，
      // 事后核对日志时只看矩形看不出落在哪块屏。
      const device = typeof captured.monitor?.device === 'string' && captured.monitor.device !== ''
        ? ` on ${captured.monitor.device}`
        : ''
      note(`geometry captured (${shape}): restore rect ${rect ? `${String(rect.left)},${String(rect.top)} ${String(rect.right - rect.left)}x${String(rect.bottom - rect.top)}` : 'unavailable'}${device}`)
    } else {
      note(`geometry capture failed: ${String(captured?.reason ?? 'no result')} — the restart continues, the window just keeps the app default`)
    }
  } else {
    note('geometry capture disabled by handoff')
  }

  // 3. 趁主进程还活着，问一次它的命令行与可执行文件路径：重启要带上原参数，
  //    兜底强杀也要按路径认人。查不到就走老路，不影响重启本身。
  const processes = queryApplicationProcesses(basename(exe))
  const mainEntry = Array.isArray(processes) ? processes.find((entry) => entry.pid === mainPid) ?? null : null
  const relaunchArgs = relaunchArgsFrom(mainEntry?.commandLine, exe)
  note(relaunchArgs === null
    ? 'launch arguments unavailable; relaunching with no arguments'
    : `preserving ${String(relaunchArgs.length)} launch argument(s): ${JSON.stringify(relaunchArgs)}`)

  // 4. 确认目标身份，然后结束主进程（不带 /T）。
  const expected = basename(exe).toLowerCase()
  const probe = imageNameOf(mainPid)
  if (probe.known && probe.image !== null && probe.image.toLowerCase() !== expected) {
    note(`refusing: pid ${mainPid} is "${probe.image}", not "${expected}"`)
    result.stage = 'refused-image-mismatch'
    return result
  }
  if (!probe.known) {
    // 问不出进程表（tasklist 不可用之类）：身份核不了，但目标 pid 是宿主亲口给的。
    // 这里照样结束它 —— 不结束的话，下面会在旧实例还活着的时候再拉起一个。
    note(`could not read the process table; ending pid ${mainPid} without an image-name check`)
    note(killPid(mainPid) ? `taskkill /PID ${mainPid} /F ok` : `taskkill /PID ${mainPid} /F reported an error`)
  } else if (probe.image === null) {
    note(`main process ${mainPid} is already gone; skipping the kill`)
  } else {
    note(`ending the Electron main process ${mainPid} ("${probe.image}") without /T, so the host can close gracefully`)
    note(killPid(mainPid) ? `taskkill /PID ${mainPid} /F ok` : `taskkill /PID ${mainPid} /F reported an error`)
  }

  // 5. 等主进程消失。
  const goneBy = Date.now() + mainExitTimeoutMs
  while (Date.now() < goneBy && alive(mainPid)) await sleep(200)
  note(alive(mainPid) ? `main process still alive after ${mainExitTimeoutMs}ms` : 'main process exited')
  result.stage = 'main-exited'

  // 6. 等端口释放；迟迟不放就兜底清理残留进程。
  if (Number.isInteger(port) && port > 0) {
    const freeBy = Date.now() + portFreeTimeoutMs
    while (Date.now() < freeBy && await listening(port)) await sleep(300)
    if (await listening(port)) {
      note(`port ${port} is still held; terminating leftover application processes`)
      // 优先只杀「同一份可执行文件」的进程（同名但来自别的目录的副本不动）；
      // 一条路径都拿不到时才退回按映像名匹配 —— 那是唯一还能把应用救回来的办法。
      // host 与主进程、helper 自己都排除在外：host 另有单独的一步（见下）。
      const skip = [process.pid, mainPid, hostPid]
      const own = Array.isArray(processes) ? leftoverPids(processes, exe, skip) : null
      let candidates
      if (own !== null && own.length > 0) {
        candidates = own
      } else {
        const byImage = applicationPids()
        if (byImage === null) {
          note('the process table is unavailable; no leftover process could be identified')
          candidates = []
        } else {
          note(own === null ? 'process paths unavailable; falling back to image-name matching' : 'no matching executable path; falling back to image-name matching')
          candidates = byImage.filter((pid) => !skip.includes(pid))
        }
      }
      for (const pid of candidates) {
        note(`killing leftover pid ${pid}`)
        killPid(pid)
      }
      await sleep(1500)

      // 最后一道，且只有这一道会碰到 host：端口到现在还没放，说明卡住的正是它 ——
      // 它本该在主进程消失后自己优雅退出。到这里只能结束它，代价是它的会话日志
      // 可能不完整，所以先如实写进日志。
      if (Number.isInteger(hostPid) && hostPid > 1 && hostPid !== process.pid && hostPid !== mainPid
        && await listening(port) && alive(hostPid)) {
        note(`the host (pid ${hostPid}) still holds port ${port}; ending it as a last resort — its session logs may be incomplete`)
        note(killPid(hostPid) ? `taskkill /PID ${hostPid} /F ok` : `taskkill /PID ${hostPid} /F reported an error`)
        await sleep(1500)
      }
    } else {
      note(`port ${port} released`)
    }
  }
  result.stage = 'port-free'

  // 7. 给文件系统和端口一点收尾时间，然后拉起新实例。
  await sleep(800)

  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    const upper = key.toUpperCase()
    // Node 模式下这两个变量会跟着继承；不清掉，新实例会变成一个没有窗口的进程。
    if (upper === 'ELECTRON_RUN_AS_NODE' || upper === 'DSH_DESKTOP_NODE_EXECUTABLE') delete env[key]
  }

  let childPid = null
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (attempt > 1) {
      note(`relaunch attempt ${attempt}/${attempts} in ${RELAUNCH_RETRY_GAP_MS}ms`)
      await sleep(RELAUNCH_RETRY_GAP_MS)
    }
    let spawned = null
    try {
      const child = spawn(exe, relaunchArgs ?? [], {
        detached: true,
        stdio: 'ignore',
        // **必须 false**：Windows 上 `windowsHide: true` 会带 STARTF_USESHOWWINDOW +
        // SW_HIDE，新实例的主窗口会以隐藏状态创建 —— 应用起来了、端口也接上了，
        // 但用户看不到窗口。实测过：同一个靶子程序 windowsHide:true 时
        // MainWindowHandle 为 0，false 时正常。
        windowsHide: false,
        cwd: dirname(exe),
        env,
      })
      child.on('error', (error) => note(`relaunch failed: ${String((error && error.message) || error)}`))
      spawned = child.pid
      child.unref()
      note(`relaunched "${exe}" as pid ${String(spawned)}${attempt > 1 ? ` (attempt ${attempt})` : ''}`)
    } catch (error) {
      note(`relaunch threw: ${String((error && error.stack) || error)}`)
      continue
    }

    // spawn 成功只表示「创建进程的请求发出去了」—— 与交接那一头是同一类问题，
    // 只不过这次在链路的末端。等几秒确认新实例真的还在：它若立刻退出（端口没真正
    // 释放、单实例锁还没放），用户只会看到页面永远不回来，而日志里却写着成功。
    await sleep(verifyMs)
    if (Number.isInteger(spawned) && alive(spawned)) {
      note(`relaunched process (pid ${String(spawned)}) is still alive after ${verifyMs}ms`)
      childPid = spawned
      break
    }
    note(`the relaunched process (pid ${String(spawned)}) is already gone — attempt ${attempt} did not take`)
  }

  if (childPid === null) {
    note(`the restart did not take after ${attempts} attempt(s); the application is not running`)
    result.stage = 'relaunch-failed'
    if (alertOnFailure) {
      note(alertUser(`重启失败：应用没能自动打开。\n\n请手动启动 DeepSeek Harness（日志：${String(handoff.logPath ?? '')}）。`)
        ? 'failure notice dispatched to the user'
        : 'could not dispatch the failure notice')
    }
    return result
  }
  result.stage = 'relaunched'

  // 8. 还原窗口几何。新进程的主窗口通常几百毫秒内出现，脚本自己会等。
  if (wantGeometry && result.geometry?.ok === true) {
    const restored = runGeometryScript('restore', childPid, {
      state: geometryStatePath,
      out: geometryResultPath,
      timeoutSeconds: 90,
      note,
    })
    if (restored?.ok === true) {
      // 显示器是「最大化/最小化」这两条路径唯一能证明还原对了的东西：
      // 矩形吻合但落在笔记本屏上，用户看到的仍然是「窗口跑到主屏去了」。
      const wantedDevice = restored.wanted?.device ?? restored.wantedMonitor?.device ?? null
      const actualDevice = restored.actual?.device ?? restored.actualMonitor?.device ?? null
      const onTarget = restored.onTarget === true
      const where = actualDevice === null
        ? ''
        : ` on ${actualDevice}${wantedDevice !== null && wantedDevice !== actualDevice ? ` (wanted ${wantedDevice})` : ''}`
      const monitorNote = actualDevice === null || onTarget || wantedDevice === null
        ? ''
        : ' — NOT the captured display'
      if (restored.applied === 'rect' && restored.actual) {
        const want = restored.wanted
        const got = restored.actual
        const exact = want && got
          && want.left === got.left && want.top === got.top
          && want.width === got.width && want.height === got.height
        note(`geometry restored (${restored.applied}): wanted ${String(want?.left)},${String(want?.top)} ${String(want?.width)}x${String(want?.height)}; actual ${String(got.left)},${String(got.top)} ${String(got.width)}x${String(got.height)}${exact ? ' — pixel exact' : ' — differs from the request'}${where}${monitorNote}`)
      } else {
        note(`geometry restored (${restored.applied})${where}${monitorNote}${restored.corrected === true ? ' (re-centred on the captured display)' : ''}`)
      }
    } else {
      note(`geometry restore failed: ${String(restored?.reason ?? 'no result')} — the app is running at its default geometry`)
    }
  } else if (wantGeometry) {
    note('no usable captured geometry; skipping the restore')
  }

  // 9. 再确认它把端口接了过去 —— 那才是「应用真的回来了」。
  if (Number.isInteger(port) && port > 0) {
    const listenBy = Date.now() + portRelistenTimeoutMs
    while (Date.now() < listenBy && !(await listening(port))) await sleep(300)
    note(await listening(port)
      ? `the new instance is listening on port ${port} — restart complete`
      : `the new instance is alive but has not taken port ${port} within ${portRelistenTimeoutMs}ms`)
  }

  result.ok = true
  result.stage = 'complete'
  return result
}

/**
 * 脚本入口：读交接描述，然后动手。
 * @returns {Promise<void>} 完成。
 */
async function start() {
  const handoffPath = process.argv[2]
  if (typeof handoffPath !== 'string' || handoffPath === '') {
    process.exit(1)
  }

  const handoff = readJsonTolerant(handoffPath)
  if (handoff === null || typeof handoff !== 'object') {
    process.exit(1)
  }

  const logPath = String(handoff.logPath ?? '')
  /**
   * 追加一行诊断。日志不可写时静默——诊断失败不该拖垮重启本身。
   * @param {string} line 内容。
   */
  const note = (line) => {
    try {
      appendFileSync(logPath, `[${new Date().toISOString()}] ${line}\n`)
    } catch {
      /* 没有日志也要继续 */
    }
  }

  let result = null
  try {
    result = await performRestart(handoff, note)
  } catch (error) {
    note(`helper failed: ${String((error && error.stack) || error)}`)
  }

  // 结果落盘：宿主半下次启动时会读它，把「上一次重启到底成没成」讲给用户听。
  const resultPath = String(handoff.resultPath ?? '')
  if (resultPath !== '') {
    try {
      writeFileSync(resultPath, `${JSON.stringify({ ...result, finishedAt: new Date().toISOString() })}\n`, 'utf8')
    } catch {
      /* 结果写不下去也不影响已经完成的重启 */
    }
  }
}

// 只有被当作脚本直接执行时才动手；被测试 import 时不产生副作用。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start().catch(() => { process.exitCode = 0 })
}
