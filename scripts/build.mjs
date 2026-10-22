#!/usr/bin/env node
/**
 * 构建脚本（零外部依赖）。
 *
 * 本机 npm 在 pwsh 里不可达、app 里也没有 tsdown/esbuild，所以不引入打包器。
 * 源码只写「可当 JS 直接运行」的 ESM（类型信息全在 JSDoc 里）。
 *
 * 拼接策略：每个模块包进一个 IIFE，模块之间通过一个极小的运行时表交换导出。
 * 这样各模块的顶层名字互不可见，不会出现同名常量互相覆盖的问题。
 *
 * 产物保持 ESM，node 直接可跑。客户端产物额外包一层 window.__ModuleLoader__。
 */
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const lib = join(root, 'lib')
const srcRoot = join(root, 'src')

/**
 * 每个 bundle 收集自己的外部 import（每个 specifier 只留一条）。
 * 必须按 bundle 隔离：host 的 @deepseek-ai 依赖不能漏进给测试用的 core.js。
 */
const EXTERNAL = { lines: [], seen: new Set() }
function resetExternal() {
  EXTERNAL.lines.length = 0
  EXTERNAL.seen.clear()
}

/** 模块 id：相对 src/ 的路径，去掉扩展名，统一用 / 分隔。 */
function moduleId(file) {
  return relative(srcRoot, file).replace(/\\/g, '/').replace(/\.ts$/, '')
}

/** 把 './a/b.ts' 解析成相对 src/ 的模块 id。 */
function resolveSpec(spec, selfId) {
  let target = spec.replace(/\.ts$/, '')
  if (!target.startsWith('.')) return target
  const base = selfId.split('/').slice(0, -1)
  const parts = base.concat(target.split('/'))
  const stack = []
  for (const part of parts) {
    if (part === '.' || part === '') continue
    if (part === '..') stack.pop()
    else stack.push(part)
  }
  return stack.join('/')
}

/**
 * 改写一个模块：相对 import/export-from 变成运行时查表，
 * 顶部 export 声明变成「声明 + 挂到 __exports」。
 */
let reExportSeq = 0

function transform(source, selfId) {
  const exported = []
  let out = source

  // 外部（非相对）import 必须留在文件顶层：ESM 规定 import 只能出现在模块顶层，
  // 而各模块被包进 IIFE 后就变成函数体了。这里把它们抽出来统一前置。
  out = out.replace(/^\s*import\s+([^;\n]*?)\s+from\s+['"]([^'".][^'"]*)['"];?\s*$/gm, (_m, clause, spec) => {
    const line = 'import ' + clause + ' from ' + JSON.stringify(spec)
    if (!EXTERNAL.seen.has(line)) { EXTERNAL.seen.add(line); EXTERNAL.lines.push(line) }
    return ''
  })

  // import { a, b as c } from './x.ts'
  out = out.replace(/^\s*import\s*\{([^}]*)\}\s*from\s*['"](\.[^'"]+)['"];?\s*$/gm, (_m, names, spec) => {
    const binding = names
      .split(',')
      .map(value => value.trim())
      .filter(Boolean)
      .map(value => value.replace(/\s+as\s+/, ': '))
      .join(', ')
    return 'const { ' + binding + ' } = __m(' + JSON.stringify(resolveSpec(spec, selfId)) + ')'
  })

  // import * as ns from './x.ts'
  out = out.replace(/^\s*import\s*\*\s*as\s*([A-Za-z_$][\w$]*)\s*from\s*['"](\.[^'"]+)['"];?\s*$/gm, (_m, name, spec) => {
    return 'const ' + name + ' = __m(' + JSON.stringify(resolveSpec(spec, selfId)) + ')'
  })

  // export { a, b as c } from './x.ts'  →  重新导出指定名字
  out = out.replace(/^\s*export\s*\{([^}]*)\}\s*from\s*['"](\.[^'"]+)['"];?\s*$/gm, (_m, names, spec) => {
    const id = resolveSpec(spec, selfId)
    const source = '__m(' + JSON.stringify(id) + ')'
    // 每个 re-export 语句用独立的局部变量：同一模块里可能有多条 export-from，
    // 共用一个名字会互相覆盖（最后一次赋值生效，前面的名字全部丢失）。
    const holder = '__re' + (reExportSeq++) + '_' + id.replace(/[^A-Za-z0-9]/g, '_')
    const lines = ['var ' + holder + ' = ' + source]
    for (const value of names.split(',').map(part => part.trim()).filter(Boolean)) {
      const [local, alias] = value.split(/\s+as\s+/).map(part => part.trim())
      const exportedName = alias === undefined ? local : alias
      exported.push([exportedName, holder + '[' + JSON.stringify(local) + ']'])
    }
    return lines.join('\n') + '\n'
  })

  // export { a, b }   （无 from）
  out = out.replace(/^\s*export\s*\{([^}]*)\};?\s*$/gm, (_m, names) => {
    for (const value of names.split(',').map(part => part.trim()).filter(Boolean)) {
      const [local, alias] = value.split(/\s+as\s+/).map(part => part.trim())
      exported.push([alias === undefined ? local : alias, local])
    }
    return ''
  })

  // export const/let/var/function/class/async function X
  out = out.replace(/^export\s+(const|let|var|function|class|async\s+function)\s+([A-Za-z_$][\w$]*)/gm, (_m, kind, name) => {
    exported.push([name, name])
    return kind + ' ' + name
  })

  if (/^\s*export\s+default\b/m.test(out)) throw new Error('export default 未实现，请改用具名导出')

  return { code: out, exported }
}

function wrapModule(id, code, exported) {
  const lines = ['// ---- ' + id + '.ts ----', '__define(' + JSON.stringify(id) + ', function (__exports, __m) {', code]
  for (const [exportedName, expression] of exported) {
    lines.push('__exports[' + JSON.stringify(exportedName) + '] = ' + expression)
  }
  lines.push('});')
  return lines.join('\n')
}

async function collect(entryPath) {
  const seen = new Set()
  const order = []
  async function visit(file) {
    if (seen.has(file)) return
    seen.add(file)
    const source = await readFile(file, 'utf8')
    const dir = dirname(file)
    for (const match of source.matchAll(/(?:from|import\s*\()\s*['"](\.[^'"]+)['"]/g)) {
      const spec = match[1].replace(/\.ts$/, '.js')
      await visit(resolve(dir, spec.replace(/\.js$/, '.ts')))
    }
    order.push({ file, source })
  }
  await visit(entryPath)
  return order
}

/** 入口模块对外导出的名字（从 __entry 上再具名导出一次，让 Node 能静态识别）。 */
function entryExportNames(entryPath) {
  return ENTRY_EXPORTS.get(moduleId(entryPath)) ?? []
}

const ENTRY_EXPORTS = new Map()

async function bundle(entryPath, wrap) {
  resetExternal()
  const modules = await collect(entryPath)
  const parts = modules.map(({ file, source }) => {
    const id = moduleId(file)
    const { code, exported } = transform(source, id)
    ENTRY_EXPORTS.set(id, exported.map(([exportedName]) => exportedName))
    return wrapModule(id, code, exported)
  })

  // 运行时定义必须排在所有 __define 之前；入口调用必须排在它们之后。
  const prelude = [
    '// ---- runtime ----',
    'var __modules = new Map()',
    'var __cache = new Map()',
    'function __define(id, factory) { __modules.set(id, factory) }',
    'function __m(id) {',
    '  if (__cache.has(id)) return __cache.get(id)',
    '  var factory = __modules.get(id)',
    '  if (factory === undefined) throw new Error("missing module " + id)',
    '  var exports = {}',
    '  __cache.set(id, exports)',
    '  factory(exports, __m)',
    '  return exports',
    '}',
  ].join('\n')

  const entry = [
    'var __entry = __m(' + JSON.stringify(moduleId(entryPath)) + ')',
    'export default __entry',
    ...entryExportNames(entryPath).map(name => 'export var ' + name + ' = __entry[' + JSON.stringify(name) + ']'),
  ].join('\n')

  // 浏览器 bundle 被包在工厂函数里，工厂内不能出现 import 语句：
  // 外部依赖一律改成 require(...)，由 DSH 的模块加载器解析。
  const header = wrap === undefined ? EXTERNAL.lines.join('\n') : toRequires(EXTERNAL.lines).join('\n')
  const body = (header === '' ? '' : header + '\n\n') + prelude + '\n\n' + parts.join('\n\n')
  if (wrap !== undefined) {
    // 浏览器 bundle 包在 factory 里，不能有顶层 export 语句：
    // 先求值入口模块，再把它复制到 module.exports 上，加载器才拿得到 apply/inject。
    const stripped =
      body +
      '\nvar __entry = __m(' + JSON.stringify(moduleId(entryPath)) + ')' +
      '\nObject.assign(module.exports, __entry)'
    return wrap(stripped)
  }
  return body + '\n\n' + entry
}

/** import 语句 → require 调用（浏览器 bundle 专用）。 */
function toRequires(lines) {
  return lines.map(line => {
    const named = /^import\s*\{([^}]*)\}\s*from\s*"([^"]+)"$/.exec(line)
    if (named !== null) {
      const binding = named[1]
        .split(',')
        .map(part => part.trim())
        .filter(Boolean)
        .map(part => part.replace(/\s+as\s+/, ': '))
        .join(', ')
      return 'const { ' + binding + ' } = require(' + JSON.stringify(named[2]) + ')'
    }
    const star = /^import\s*\*\s*as\s*([A-Za-z_$][\w$]*)\s*from\s*"([^"]+)"$/.exec(line)
    if (star !== null) return 'const ' + star[1] + ' = require(' + JSON.stringify(star[2]) + ')'
    const dflt = /^import\s+([A-Za-z_$][\w$]*)\s+from\s*"([^"]+)"$/.exec(line)
    if (dflt !== null) return 'const ' + dflt[1] + ' = require(' + JSON.stringify(dflt[2]) + ')'
    throw new Error('无法改写的 import：' + line)
  })
}

/** 浏览器端：DSH 用 window.__ModuleLoader__ 装载客户端插件。 */
function wrapClient(body) {
  return [
    'window.__ModuleLoader__.load({',
    '  id: "dsh-codex-plus",',
    '  factory: (require) => {',
    '    var module = { exports: {} };',
    '    var exports = module.exports;',
    '    var __entry;',
    body,
    '    return module.exports;',
    '  },',
    '});',
    '',
  ].join('\n')
}

async function exists(path) {
  try {
    await readFile(path)
    return true
  } catch {
    return false
  }
}

async function main() {
  await rm(lib, { recursive: true, force: true })
  await mkdir(lib, { recursive: true })

  const host = await bundle(join(srcRoot, 'index.ts'))
  await writeFile(join(lib, 'index.js'), host + '\n', 'utf8')

  // 纯逻辑导出面：给单测用，插件运行时不加载它。
  const core = await bundle(join(srcRoot, 'core.ts'))
  await writeFile(join(lib, 'core.js'), core + '\n', 'utf8')

  // 服务层单独出一份，供刷新语义测试直接 import（不经过插件入口）。
  const service = await bundle(join(srcRoot, 'service.ts'))
  await writeFile(join(lib, 'service.js'), service + '\n', 'utf8')

  // 登录会话桥接器也单独出一份，供登录流程测试直接 import。
  const login = await bundle(join(srcRoot, 'login.ts'))
  await writeFile(join(lib, 'login.js'), login + '\n', 'utf8')

  if (await exists(join(srcRoot, 'client', 'index.ts'))) {
    const client = await bundle(join(srcRoot, 'client', 'index.ts'), wrapClient)
    await writeFile(join(lib, 'client.js'), client, 'utf8')
    console.log('built lib/index.js + lib/client.js')
  } else {
    console.log('built lib/index.js (client entry not present yet)')
  }
}

await main()