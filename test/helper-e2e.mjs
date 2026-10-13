/**
 * 分离 helper 的端到端集成测试（**不碰正在运行的 DSH**）。
 *
 * 四件事各证一遍：
 *
 * 1. **重启链路**：用一个临时编译出来的 WinForms 靶子程序当「应用」，把
 *    lib/helper.mjs 的完整链路跑一遍 —— 捕获几何 → 结束靶子主进程 → 拉起新实例
 *    → 逐像素还原窗口几何。靶子第二次启动刻意用**默认几何**（320x220 @ 20,20），
 *    所以「还原成功」只能来自 helper 的 SetWindowPos。
 * 2. **多显示器**：靶子第一次在副屏上最大化，重新拉起的实例按默认几何落在主屏，
 *    还原必须把它放回原来那块屏（只报矩形是不够的 —— 矩形对、屏错了，用户看到的
 *    仍然是「窗口跑到笔记本屏上去了」）。
 * 3. **纠偏**：捕获到的正常矩形与记录的显示器互相矛盾时，脚本要自己翻回来一次。
 * 4. **helper 的启动方式**：宿主半是用「桌面应用本身 + ELECTRON_RUN_AS_NODE=1」+
 *    `detached` 把 helper 拉起来的。这里用同一个可执行文件做一次最小验证 ——
 *    它必须能在 detached 下跑完并留下痕迹。
 *
 * 为什么靶子必须是**编译出来的 GUI 程序**而不是 powershell.exe：Windows 上
 * `detached: true` 会带 `DETACHED_PROCESS`，而 Windows PowerShell 5.1 没有控制台时
 * 会立刻退出（实测 exit code 0、什么都没做）。GUI 子系统的可执行文件没有这个问题，
 * 真实应用（Electron 壳）也正是这一类。
 *
 * 只在 Windows 上运行；没有桌面会话时跳过。第 2、3 个用例要求至少两块屏，
 * 单屏机器上跳过（环境不足，不是没修）。
 * 运行：`node --test test/helper-e2e.mjs`
 */

import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { performRestart, powershellHost, runGeometryScript } from '../lib/helper.mjs'

const PS = powershellHost()
const CSC = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe'
const HARNESS_EXE = join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe')

/** 靶子应用源码：第一次启动用目标几何，之后每次都用默认几何。 */
const SCRATCH_APP_CS = `using System;
using System.IO;
using System.Windows.Forms;

static class ScratchApp
{
    [STAThread]
    static void Main(string[] args)
    {
        string dir = args.Length > 0 ? args[0] : Path.GetTempPath();
        string counter = Path.Combine(dir, "launch-count");
        int n = 0;
        if (File.Exists(counter)) int.TryParse(File.ReadAllText(counter).Trim(), out n);
        n += 1;
        File.WriteAllText(counter, n.ToString());
        Form form = new Form();
        form.Text = "DSH-Restart-E2E";
        form.StartPosition = FormStartPosition.Manual;
        if (n == 1) { form.Width = 700; form.Height = 500; form.Left = 300; form.Top = 200; }
        else { form.Width = 320; form.Height = 220; form.Left = 20; form.Top = 20; }
        Application.Run(form);
    }
}
`

/** 同步睡一会儿（execFileSync 调用之间需要真实等待）。 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * 靶子应用源码（多显示器场景）：第一次启动**在指定矩形上最大化**，之后每次都用
 * 默认几何（320x220 @ 20,20，也就是主屏/笔记本屏）—— 与真实应用「新建窗口落在主屏」
 * 的行为一致。第二次启动刻意忽略参数：helper 会把原始命令行带过去，
 * 若靶子照单全收，测试就会因为「应用自己又跑到副屏」而假通过。
 */
const MONITOR_APP_CS = `using System;
using System.IO;
using System.Windows.Forms;

static class MonitorApp
{
    [STAThread]
    static void Main(string[] args)
    {
        string dir = args.Length > 0 ? args[0] : Path.GetTempPath();
        string counter = Path.Combine(dir, "launch-count");
        int n = 0;
        if (File.Exists(counter)) int.TryParse(File.ReadAllText(counter).Trim(), out n);
        n += 1;
        File.WriteAllText(counter, n.ToString());

        // args: <dir> [on <left> <top> <right> <bottom>] [max]
        bool wantMax = false;
        int left = 20, top = 20, right = 340, bottom = 240;
        for (int i = 1; i < args.Length; i++)
        {
            if (args[i] == "on" && i + 4 < args.Length)
            {
                left = int.Parse(args[i + 1]) + 30;
                top = int.Parse(args[i + 2]) + 30;
                right = int.Parse(args[i + 3]) - 30;
                bottom = int.Parse(args[i + 4]) - 30;
                i += 4;
            }
            else if (args[i] == "max") { wantMax = true; }
        }

        Form form = new Form();
        form.Text = "DSH-Restart-E2E-Monitor";
        form.StartPosition = FormStartPosition.Manual;
        if (n == 1 && wantMax)
        {
            form.Left = left; form.Top = top; form.Width = right - left; form.Height = bottom - top;
            form.WindowState = FormWindowState.Maximized;
            form.Shown += delegate { form.WindowState = FormWindowState.Maximized; };
        }
        else
        {
            form.Width = 320; form.Height = 220; form.Left = 20; form.Top = 20;
        }
        Application.Run(form);
    }
}
`

/**
 * 靶子应用源码（最小窗口）：固定用默认几何（320x220 @ 20,20，主屏）启动一次。
 * 给「纠偏分支」那个用例当靶子 —— 它的状态文件是手工造的，不需要靶子配合。
 */
const PLAIN_APP_CS = `using System;
using System.Windows.Forms;

static class PlainApp
{
    [STAThread]
    static void Main()
    {
        Form form = new Form();
        form.Text = "DSH-Restart-E2E-Plain";
        form.StartPosition = FormStartPosition.Manual;
        form.Width = 320; form.Height = 220; form.Left = 20; form.Top = 20;
        Application.Run(form);
    }
}
`

/**
 * 列出当前显示器（deviceName 与 Win32 的 MONITORINFOEX.szDevice 同形）。
 * @returns {{ device: string, primary: boolean, left: number, top: number, right: number, bottom: number }[]} 显示器。
 */
function listMonitors() {
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '[System.Windows.Forms.Screen]::AllScreens | ForEach-Object { "{0}|{1}|{2}|{3}|{4}|{5}" -f $_.DeviceName, [int]$_.Primary, $_.Bounds.Left, $_.Bounds.Top, $_.Bounds.Right, $_.Bounds.Bottom }',
  ].join('; ')
  const out = execFileSync(PS, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true })
  return out.split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => {
      const [device, primary, left, top, right, bottom] = line.split('|')
      return { device, primary: primary === '1', left: Number(left), top: Number(top), right: Number(right), bottom: Number(bottom) }
    })
}

/**
 * 反复探测直到 probe 给出值。
 * @param {() => any} probe 探测。
 * @param {number} timeoutMs 超时。
 * @returns {any} 探测结果，超时返回 null。
 */
function waitFor(probe, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = probe()
    if (value !== null && value !== undefined) return value
    sleepSync(250)
  }
  return null
}

/**
 * 等一个进程出现主窗口。
 * @param {number} pid 目标进程。
 * @param {number} timeoutMs 超时。
 * @returns {boolean} 是否等到。
 */
function waitForWindow(pid, timeoutMs) {
  const script = `$p = Get-Process -Id ${String(pid)} -ErrorAction SilentlyContinue; if ($p) { $p.Refresh(); [int64]$p.MainWindowHandle } else { 0 }`
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const out = execFileSync(PS, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true }).trim()
    if (out !== '' && out !== '0') return true
    sleepSync(200)
  }
  return false
}

/** 结束一个 pid，失败也不抛。 */
function kill(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore', windowsHide: true })
  } catch {
    /* 已经没了 */
  }
}

test('helper 端到端：重启靶子进程并逐像素还原窗口几何', { timeout: 180_000, skip: process.platform !== 'win32' }, async () => {
  assert.equal(existsSync(CSC), true, `找不到 csc.exe（${CSC}），无法编译靶子程序`)
  const dir = mkdtempSync(join(tmpdir(), 'dsrd-e2e-'))
  const sourcePath = join(dir, 'scratch-app.cs')
  const appPath = join(dir, 'scratch-app.exe')
  const logPath = join(dir, 'restart.log')
  const geometryStatePath = join(dir, 'geometry.json')
  writeFileSync(sourcePath, SCRATCH_APP_CS, 'utf8')
  execFileSync(CSC, ['/nologo', '/target:winexe', `/out:${appPath}`, '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', sourcePath], { windowsHide: true })

  let firstPid = 0
  let secondPid = 0
  try {
    // ── 1. 启动靶子（第一次：目标几何 700x500 @ 300,200）──────────────────
    // windowsHide 必须是 false：true 会带 STARTF_USESHOWWINDOW + SW_HIDE，
    // 靶子的主窗口会以隐藏状态创建，MainWindowHandle 恒为 0。
    const child = spawn(appPath, [dir], { detached: true, stdio: 'ignore', windowsHide: false })
    child.unref()
    firstPid = child.pid
    assert.equal(waitForWindow(firstPid, 30_000), true, '靶子窗口没出现')

    const before = runGeometryScript('capture', firstPid, { out: geometryStatePath, note: () => {} })
    assert.equal(before?.ok, true, '靶子几何应当捕获成功')
    const want = before.restoreRect
    assert.equal(want.right - want.left, 700)
    assert.equal(want.bottom - want.top, 500)

    // ── 2. 跑完整 helper 链路 ────────────────────────────────────────────
    const lines = []
    const note = (line) => {
      lines.push(line)
      try {
        appendFileSync(logPath, `${line}\n`)
      } catch {
        /* 日志写不下去不影响断言：lines 里还有一份 */
      }
    }
    const result = await performRestart({
      mainPid: firstPid,
      exe: appPath,
      hostPid: process.pid,
      // 端口传 null：本测试不涉及 HTTP 端口，也就不会走到「兜底清理同名进程」那条路。
      port: null,
      logPath,
      geometryStatePath,
      geometry: true,
      delayMs: 100,
      relaunchAttempts: 2,
      relaunchVerifyMs: 1_200,
      mainExitTimeoutMs: 15_000,
      alertOnFailure: false,
    }, note)

    assert.equal(result.stage, 'complete', `helper 应当走完全程，日志：\n${lines.join('\n')}`)
    assert.equal(result.ok, true)
    assert.equal(result.geometry?.ok, true, '几何应当被捕获')

    const relaunchLine = lines.find((line) => line.includes('relaunched "'))
    assert.notEqual(relaunchLine, undefined, '日志里应当有拉起记录')
    secondPid = Number(/pid (\d+)/u.exec(relaunchLine)?.[1] ?? 0)
    assert.equal(secondPid > 0, true, `解析新 pid 失败：${relaunchLine}`)
    assert.notEqual(secondPid, firstPid)

    assert.equal(lines.some((line) => line.includes('geometry restored')), true, '日志里应当有几何还原记录')
    assert.equal(lines.some((line) => line.includes('pixel exact')), true, `还原应当逐像素吻合，日志：\n${lines.join('\n')}`)
    assert.equal(lines.some((line) => line.includes('without /T')), true, '结束主进程时不能带 /T（host 要靠 IPC 断开优雅落盘）')

    // ── 3. 独立复核：新窗口的实际几何必须等于重启前捕获的几何 ──────────────
    assert.equal(waitForWindow(secondPid, 30_000), true, '新靶子窗口没出现')
    const after = runGeometryScript('capture', secondPid, { out: join(dir, 'after.json'), note: () => {} })
    assert.equal(after?.ok, true)
    assert.deepEqual(
      {
        left: after.restoreRect.left,
        top: after.restoreRect.top,
        width: after.restoreRect.right - after.restoreRect.left,
        height: after.restoreRect.bottom - after.restoreRect.top,
      },
      { left: want.left, top: want.top, width: 700, height: 500 },
      '重启后窗口几何必须与重启前一致',
    )

    // 靶子确实重启过：启动计数为 2。
    const counter = readFileSync(join(dir, 'launch-count'), 'utf8').trim()
    assert.equal(counter, '2', '靶子应当被启动了两次（原实例 + 重启后的新实例）')
  } finally {
    kill(firstPid)
    kill(secondPid)
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 临时目录删不掉不影响测试结论 */
    }
  }
})

test('helper 的启动方式：Electron 可执行文件在 detached + ELECTRON_RUN_AS_NODE 下确实能跑', { timeout: 60_000, skip: process.platform !== 'win32' || !existsSync(HARNESS_EXE) }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsrd-spawn-'))
  const marker = join(dir, 'helper-started.txt')
  try {
    // 与 index.js 的 scheduleRestart 完全同构：同一个可执行文件、同一个环境变量、同样 detached。
    const helper = spawn(HARNESS_EXE, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ok')`], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    helper.unref()

    const deadline = Date.now() + 20_000
    while (Date.now() < deadline && !existsSync(marker)) sleepSync(250)
    assert.equal(existsSync(marker), true, 'detached 的 Electron-as-Node helper 没能跑起来：重启会静默失败')
    assert.equal(readFileSync(marker, 'utf8'), 'ok')
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 临时目录删不掉不影响测试结论 */
    }
  }
})

/**
 * 上报现场：笔记本 + 两块外接屏，窗口在左上那块屏上最大化；重启后窗口落回了笔记本屏。
 * 根因是「最大化的窗口在哪块屏上最大化，取决于它此刻在哪块屏」，而重新拉起的应用是把
 * 窗口创建在主屏上的 —— 直接 ShowWindow(SW_MAXIMIZE) 就等于把它拽回主屏。
 *
 * 这个用例用一块真实的副屏复现：靶子第一次启动在副屏上最大化，helper 重启后它按默认
 * 几何落在主屏，还原必须把它放回原来那块屏。只有一块屏的机器跳过（环境不足，不是没修）。
 */
test('helper 端到端：副屏上最大化的窗口重启后仍然回到那块屏', { timeout: 240_000, skip: process.platform !== 'win32' }, async () => {
  assert.equal(existsSync(CSC), true, `找不到 csc.exe（${CSC}），无法编译靶子程序`)

  const monitors = listMonitors()
  const primary = monitors.find((entry) => entry.primary) ?? monitors[0]
  const target = monitors.find((entry) => entry.device !== primary?.device
    && (entry.right - entry.left) >= 600 && (entry.bottom - entry.top) >= 500)
  if (target === undefined) {
    console.log(`跳过：本机只有 ${String(monitors.length)} 块屏，没有可作为「副屏」的目标`)
    return
  }

  const dir = mkdtempSync(join(tmpdir(), 'dsrd-monitor-'))
  const sourcePath = join(dir, 'monitor-app.cs')
  const appPath = join(dir, 'monitor-app.exe')
  const logPath = join(dir, 'restart.log')
  const geometryStatePath = join(dir, 'monitor-geometry.json')
  writeFileSync(sourcePath, MONITOR_APP_CS, 'utf8')
  execFileSync(CSC, ['/nologo', '/target:winexe', `/out:${appPath}`, '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', sourcePath], { windowsHide: true })

  let firstPid = 0
  let secondPid = 0
  try {
    // ── 1. 靶子在副屏上最大化 ────────────────────────────────────────────
    const child = spawn(appPath, [
      dir, 'on', String(target.left), String(target.top), String(target.right), String(target.bottom), 'max',
    ], { detached: true, stdio: 'ignore', windowsHide: false })
    child.unref()
    firstPid = child.pid
    assert.equal(waitForWindow(firstPid, 30_000), true, '靶子窗口没出现')

    // 最大化由构造期与 Shown 各设一次，所以轮询到「确实最大化了」再捕获。
    const before = waitFor(() => {
      const state = runGeometryScript('capture', firstPid, { out: geometryStatePath, note: () => {} })
      return state?.ok === true && state.maximized === true ? state : null
    }, 20_000)
    assert.notEqual(before, null, '靶子应当进入最大化状态')
    assert.equal(before.monitor?.device, target.device, `捕获时窗口应当在副屏 ${target.device} 上`)

    // ── 2. 跑完整 helper 链路（第二次启动落在主屏，靠还原放回副屏）────────
    const lines = []
    const note = (line) => {
      lines.push(line)
      try {
        appendFileSync(logPath, `${line}\n`)
      } catch {
        /* lines 里还有一份 */
      }
    }
    const result = await performRestart({
      mainPid: firstPid,
      exe: appPath,
      hostPid: process.pid,
      port: null,
      logPath,
      geometryStatePath,
      geometry: true,
      delayMs: 100,
      relaunchAttempts: 2,
      relaunchVerifyMs: 1_200,
      mainExitTimeoutMs: 15_000,
      alertOnFailure: false,
    }, note)

    assert.equal(result.stage, 'complete', `helper 应当走完全程，日志：\n${lines.join('\n')}`)
    const relaunchLine = lines.find((line) => line.includes('relaunched "'))
    secondPid = Number(/pid (\d+)/u.exec(relaunchLine ?? '')?.[1] ?? 0)
    assert.equal(secondPid > 0, true, `解析新 pid 失败：${String(relaunchLine)}`)

    // 几何脚本自己给出的结论：还原落在捕获时那块屏上。
    const restoreResult = JSON.parse(readFileSync(`${geometryStatePath}.result.json`, 'utf8'))
    assert.equal(restoreResult.ok, true, `几何还原应当成功：${JSON.stringify(restoreResult)}`)
    assert.equal(restoreResult.applied, 'maximize')
    assert.equal(
      restoreResult.onTarget,
      true,
      `还原必须落在捕获时的 ${target.device}，实际落在 ${String(restoreResult.actual?.device)}`,
    )
    assert.equal(restoreResult.actual?.device, target.device)

    // 日志里也要写明白落在哪块屏，且不该出现「落错屏」的告警。
    assert.equal(
      lines.some((line) => line.includes('geometry restored (maximize)') && line.includes(target.device)),
      true,
      `还原日志应当写明显示器：\n${lines.join('\n')}`,
    )
    assert.equal(lines.some((line) => line.includes('NOT the captured display')), false, '不该出现落错屏的告警')

    // ── 3. 独立复核：新窗口现在确实在副屏上最大化 ────────────────────────
    assert.equal(waitForWindow(secondPid, 30_000), true, '新靶子窗口没出现')
    const after = runGeometryScript('capture', secondPid, { out: join(dir, 'after-monitor.json'), note: () => {} })
    assert.equal(after?.ok, true)
    assert.equal(after?.maximized, true, '重启后窗口应当仍然是最大化')
    assert.equal(after?.monitor?.device, target.device, '重启后窗口必须回到重启前那块屏')
    assert.deepEqual(
      after?.rect,
      before.rect,
      '最大化矩形应当与重启前一致（同一块屏、同一个最大化矩形）',
    )
  } finally {
    kill(firstPid)
    kill(secondPid)
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 临时目录删不掉不影响测试结论 */
    }
  }
})

/**
 * 纠偏分支：目标屏还在，但捕获到的「正常矩形」落在别的屏上（真实场景里它可能跨两块屏，
 * 也可能因为用户拔过线而整块落在已拔掉的屏上）。这时第一次最大化必然落错，脚本必须
 * 自己翻回来一次，并如实把 corrected / onTarget 写在结果里。
 *
 * 状态文件是手工造的：直接构造「记录的显示器是副屏、正常矩形在主屏」这一对矛盾，
 * 比在生产路径上凑出一个跨屏矩形可靠得多。
 */
test('helper 端到端：捕获的正常矩形不在目标屏上时会纠偏一次', { timeout: 120_000, skip: process.platform !== 'win32' }, async () => {
  assert.equal(existsSync(CSC), true, `找不到 csc.exe（${CSC}），无法编译靶子程序`)

  const monitors = listMonitors()
  const primary = monitors.find((entry) => entry.primary) ?? monitors[0]
  const target = monitors.find((entry) => entry.device !== primary?.device
    && (entry.right - entry.left) >= 600 && (entry.bottom - entry.top) >= 500)
  if (target === undefined) {
    console.log(`跳过：本机只有 ${String(monitors.length)} 块屏，没有可作为「副屏」的目标`)
    return
  }

  const dir = mkdtempSync(join(tmpdir(), 'dsrd-correct-'))
  const sourcePath = join(dir, 'plain-app.cs')
  const appPath = join(dir, 'plain-app.exe')
  writeFileSync(sourcePath, PLAIN_APP_CS, 'utf8')
  execFileSync(CSC, ['/nologo', '/target:winexe', `/out:${appPath}`, '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', sourcePath], { windowsHide: true })

  let pid = 0
  try {
    const child = spawn(appPath, [], { detached: true, stdio: 'ignore', windowsHide: false })
    child.unref()
    pid = child.pid
    assert.equal(waitForWindow(pid, 30_000), true, '靶子窗口没出现')

    // 正常矩形刻意放在主屏（40,40 起），而记录的显示器是副屏 —— 一对矛盾。
    const statePath = join(dir, 'crafted-state.json')
    writeFileSync(statePath, JSON.stringify({
      ok: true,
      maximized: true,
      minimized: false,
      restoreRect: { left: 40, top: 40, right: 640, bottom: 520 },
      monitor: {
        device: target.device,
        primary: false,
        rect: { left: target.left, top: target.top, right: target.right, bottom: target.bottom },
      },
    }), 'utf8')

    const restored = runGeometryScript('restore', pid, { state: statePath, out: join(dir, 'restored.json'), timeoutSeconds: 30, note: () => {} })
    assert.equal(restored?.ok, true, `还原应当成功：${JSON.stringify(restored)}`)
    assert.equal(restored.corrected, true, `应当走一次纠偏：${JSON.stringify(restored)}`)
    assert.equal(restored.onTarget, true, `纠偏后应当落在 ${target.device}：${JSON.stringify(restored.actual)}`)

    const after = runGeometryScript('capture', pid, { out: join(dir, 'after.json'), note: () => {} })
    assert.equal(after?.maximized, true, '纠偏后仍然要是最大化')
    assert.equal(after?.monitor?.device, target.device, '纠偏后窗口必须落在目标屏上')
  } finally {
    kill(pid)
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 临时目录删不掉不影响测试结论 */
    }
  }
})
