/**
 * dsh-plugin-restart-desktop —— 平台能力（「本机能不能做」的唯一事实来源）。
 *
 * 这里只回答**能不能**，不回答**怎么做**：真正的执行仍在 lib/helper.mjs。
 * 这样在只有一个平台适配器的阶段（Windows）不会凭空多出一层空转调；等 POSIX
 * 适配器落地时，这个接口不变，只是更多平台的 restart 变成 true。
 *
 * 为什么需要有这个模块：重启链路原本把 Windows 假设写在六个调用点上 ——
 * `taskkill`、`tasklist`、PowerShell CIM 查询、WPF 弹窗、user32 窗口几何、
 * 反斜杠路径比较。后果不是「多写几个 if」，而是任何一次平台判断都要在调用点
 * 重新知道一遍全部假设；并且非 Windows 的桌面宿主会一路走到 helper 才失败
 * （先空等 15 秒，再空拉三次，最后留下一条误导性的日志）。
 *
 * @module dsh-plugin-restart-desktop/platform
 */

/**
 * 进程平台 id。
 *
 * 只从传入的进程对象读，不读全局 `process.platform` —— 测试要能在任何机器上
 * 断言三个平台的行为，靠的就是这个注入点。
 * @param {NodeJS.Process} [proc] 进程对象。
 * @returns {string} 平台 id；取不到时回 `'unknown'`（只用于诊断与拒绝文案）。
 */
export function platformId(proc = process) {
  return typeof proc?.platform === 'string' && proc.platform !== '' ? proc.platform : 'unknown'
}

/**
 * 当前平台的能力快照。
 *
 * 字段含义都是「这台机器上有没有可用的实现」，不是「理论上能不能」：
 * - `restart`：能结束主进程并重新拉起（helper 的进程控制驱动是否齐备）；
 * - `launchArgs`：能读到主进程的完整命令行（重启时复用原参数）；
 * - `geometry`：窗口几何捕获 / 还原驱动的名字，`null` 表示没有；
 * - `alert`：重启失败时能弹窗告知用户的驱动名字，`null` 表示没有；
 * - `reason`：`restart === false` 时给用户看的一句话，否则为 `null`。
 *
 * 今天只有 Windows 是完整的：进程表、强杀、失败弹窗、逐像素几何都在那里。
 * 其它平台一律如实说「不支持」，而不是让调用方猜或者走到一半才失败。
 * @param {NodeJS.Process} [proc] 进程对象（测试注入）。
 * @returns {{
 *   id: string,
 *   restart: boolean,
 *   launchArgs: boolean,
 *   geometry: string | null,
 *   alert: string | null,
 *   reason: string | null,
 * }} 能力快照。
 */
export function platformCapabilities(proc = process) {
  const id = platformId(proc)
  if (id === 'win32') {
    return {
      id,
      restart: true,
      launchArgs: true,
      geometry: 'win32-powershell',
      alert: 'win32-wpf',
      reason: null,
    }
  }
  return {
    id,
    restart: false,
    launchArgs: false,
    geometry: null,
    alert: null,
    reason: `当前平台（${id}）还没有实现进程控制驱动；本插件目前只支持 Windows 桌面版`,
  }
}
