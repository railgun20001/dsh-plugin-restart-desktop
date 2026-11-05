/**
 * dsh-plugin-restart-desktop 客户端 bundle 构建脚本。
 *
 * 产物 `lib/client.js` 是**手写协议**的浏览器 bundle：DSH 的客户端模块系统
 * （@deepseek-ai/dsh-client-modules）用 classic `<script>` 加载每个插件的客户端半，
 * 脚本执行时只做一件事——把自己注册进 `window.__ModuleLoader__`：
 *
 *   window.__ModuleLoader__.load({ id: '<包名>', factory: (require) => exports })
 *
 * 客户端 bundle 里不能出现 `import`/`export`（它不是 ES 模块），也不能依赖包外的
 * 相对路径（浏览器只拿到这一个文件）。因此本脚本做一次极简的源码内联：把三个源文件
 * 按依赖顺序拼进同一个函数作用域，去掉导出关键字。
 *
 * 顺序即依赖：client-core（纯逻辑）→ account-button（DOM 注入）→ client-main（接线）。
 *
 * 用法：
 *   node build/bundle.mjs            # 生成 lib/client.js
 *   node build/bundle.mjs --check    # 只校验产物是当前源码的等价生成（CI 用）
 *
 * @module dsh-plugin-restart-desktop/build
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

/** 包名：注册到 `__ModuleLoader__` 的 id，必须与 package.json 的 name 一致。 */
const PACKAGE_NAME = 'dsh-plugin-restart-desktop'

/** 按依赖顺序内联的源文件。 */
const MODULES = [
  join(ROOT, 'src', 'client-core.js'),
  join(ROOT, 'src', 'account-button.js'),
  join(ROOT, 'src', 'client-main.js'),
]

const PACKAGE_JSON = join(ROOT, 'package.json')
const OUTPUT = join(ROOT, 'lib', 'client.js')

/**
 * 把一个「只有本插件自己写的」ESM 模块转成同一作用域内的普通声明。
 *
 * 只处理本插件自己的模块：导出只有 `export const` / `export function` 前缀与末尾的
 * `export { ... }` 列表，import 只有**包内相对路径**（内联后同处一个作用域，直接删掉）。
 * 任何超出该假设的形状都直接报错，而不是悄悄生成一个坏 bundle。
 * @param {string} source 源码文本。
 * @param {string} file 文件名（报错用）。
 * @returns {string} 去掉模块语法后的源码。
 */
function inlineEsModule(source, file) {
  if (/^\s*export\s+default\b/m.test(source)) {
    throw new Error(`${file} 不允许 export default（内联后无法表达）`)
  }
  if (/^\s*export\s+\*/m.test(source)) {
    throw new Error(`${file} 不允许 export * （内联后无法表达）`)
  }
  const stripped = source.replace(/^import\s[\s\S]*?from\s*['"][^'"]+['"]\s*;?[ \t]*$/gm, '')
  const leftover = /^import\s[^\n]*$/m.exec(stripped)
  if (leftover !== null) {
    throw new Error(`${file} 里还有没被内联的 import：${leftover[0].trim()}`)
  }
  return stripped
    .replace(/^export\s*\{[^}]*\}\s*;?/gm, '')
    .replace(/^export\s+/gm, '')
}

/**
 * 缩进一段源码，方便产物阅读。
 * @param {string} source 源码。
 * @param {string} pad 前缀。
 * @returns {string} 缩进后的源码。
 */
function indent(source, pad) {
  return source
    .split('\n')
    .map((line) => (line.length === 0 ? line : `${pad}${line}`))
    .join('\n')
}

/**
 * 生成 bundle 文本。
 * @returns {string} lib/client.js 的完整内容。
 */
function build() {
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'))
  const version = typeof pkg.version === 'string' && pkg.version !== '' ? pkg.version : 'unknown'

  const header = `/**
 * dsh-plugin-restart-desktop —— 客户端 bundle（由 build/bundle.mjs 生成，请不要手改）
 *
 * 内联自：
 *   - src/client-core.js     纯逻辑：账号行识别判据、重启状态机、提示文案
 *   - src/account-button.js  账号行右侧图标按钮的 DOM 注入
 *   - src/client-main.js     接线：DSH 座位服务 → 图标按钮 + 官方座位回落 + 提示浮层
 *
 * 协议：DSH 客户端模块系统用 classic <script> 加载本文件，脚本执行时通过
 * window.__ModuleLoader__.load({ id, factory }) 注册工厂；工厂在首次
 * import/require 时物化，并作为 Cordis 插件激活（apply + inject）。
 */
window.__ModuleLoader__.load({
\tid: ${JSON.stringify(PACKAGE_NAME)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

\t\t/** 客户端半的构建版本；由 build/bundle.mjs 从 package.json 注入。 */
\t\tconst BUNDLE_VERSION = ${JSON.stringify(version)};
`

  const footer = `
\t\texports.apply = apply;
\t\texports.inject = inject;
\t\treturn module.exports;
\t}
});
`

  const body = [header]
  for (const file of MODULES) {
    const name = file.slice(ROOT.length + 1).replace(/\\/gu, '/')
    body.push(`\n\t\t//#region ${name}\n`)
    body.push(indent(inlineEsModule(readFileSync(file, 'utf8'), name).trimEnd(), '\t\t'))
    body.push('\n')
  }
  body.push(footer)

  const bundle = body.join('')

  // 语法自检：产物必须是可解析的脚本。
  try {
    // eslint-disable-next-line no-new-func
    new Function(bundle)
  } catch (error) {
    throw new Error(`生成的 bundle 语法非法：${error.message}`)
  }
  return bundle
}

const bundle = build()
const checkOnly = process.argv.includes('--check')

if (checkOnly) {
  let existing = ''
  try {
    existing = readFileSync(OUTPUT, 'utf8')
  } catch {
    console.error('lib/client.js 不存在，请先运行：node build/bundle.mjs')
    process.exit(1)
  }
  if (existing !== bundle) {
    console.error('lib/client.js 与源码不一致，请重新运行：node build/bundle.mjs')
    process.exit(1)
  }
  console.log('lib/client.js 与源码一致')
  process.exit(0)
}

mkdirSync(dirname(OUTPUT), { recursive: true })
writeFileSync(OUTPUT, bundle, 'utf8')
console.log(`已生成 ${OUTPUT}（${Buffer.byteLength(bundle, 'utf8')} 字节）`)
