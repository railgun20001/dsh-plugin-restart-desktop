/**
 * 分离 helper 的端到端集成测试（**不碰正在运行的 DSH**）。
 *
 * 两件事各证一遍：
 *
 * 1. **重启链路**：用一个临时编译出来的 WinForms 靶子程序当「应用」，把
 *    lib/helper.mjs 的完整链路跑一遍 —— 捕获几何 → 结束靶子主进程 → 拉起新实例
 *    → 逐像素还原窗口几何。靶子第二次启动刻意用**默认几何**（320x220 @ 20,20），
 *    所以「还原成功」只能来自 helper 的 SetWindowPos。
 * 2. **helper 的启动方式**：宿主半是用「桌面应用本身 + ELECTRON_RUN_AS_NODE=1」+
 *    `detached` 把 helper 拉起来的。这里用同一个可执行文件做一次最小验证 ——
 *    它必须能在 detached 下跑完并留下痕迹。
 *
 * 为什么靶子必须是**编译出来的 GUI 程序**而不是 powershell.exe：Windows 上
 * `detached: true` 会带 `DETACHED_PROCESS`，而 Windows PowerShell 5.1 没有控制台时
 * 会立刻退出（实测 exit code 0、什么都没做）。GUI 子系统的可执行文件没有这个问题，
 * 真实应用（Electron 壳）也正是这一类。
 *
 * 只在 Windows 上运行；没有桌面会话时跳过。
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
