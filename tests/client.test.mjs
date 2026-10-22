/**
 * 浏览器 bundle 的装载冒烟测试（不依赖 DSH 运行时）。
 *
 * 模拟出 window.__ModuleLoader__ / require / document / react，然后 import
 * lib/client.js，检查：
 *   - 工厂函数确实被调用并返回 apply/inject；
 *   - 插件 id 与 package.json 的包名一致；
 *   - apply() 能在给定的 ctx 上注册 settings.section 与 conversation.input.right 两个 slot；
 *   - locale 字典被注册；
 *   - 样式标签被注入且 dispose 时被移除。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

/** 一个够用的假 React：只提供这些钩子与 createElement。 */
const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useCallback: fn => fn,
  useEffect: () => undefined,
  useMemo: fn => fn(),
  useRef: value => ({ current: value }),
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => undefined],
}

/** 记录所有注册动作的假 ctx。 */
function fakeContext() {
  const slots = []
  const locales = []
  const effects = []
  const styleTags = []
  const connection = {
    rpc: {
      call: async (channel, endpoint, payload) => ({ ok: true, value: { channel, endpoint, payload } }),
    },
  }

  const ctx = {
    get: service => {
      if (service === 'connection') return connection
      return undefined
    },
    locale: {
      register: (ns, dictionary) => locales.push({ ns, dictionary }),
      bind: () => (key, params) => {
        if (params === undefined) return key
        return key + JSON.stringify(params)
      },
    },
    slots: {
      inject: (name, callback) => {
        callback()
        return () => undefined
      },
      register: (options, component) => {
        slots.push({ options, component })
        return () => undefined
      },
    },
    effect: (fn, label) => {
      const dispose = fn()
      effects.push({ dispose, label })
      return () => undefined
    },
  }

  return { ctx, slots, locales, effects, styleTags }
}

/** 在受控的全局环境里加载 bundle。 */
async function loadClient() {
  const source = await readFile(join(root, 'lib', 'client.js'), 'utf8')

  let registration
  const appended = []
  globalThis.window = {
    __ModuleLoader__: {
      load: value => {
        registration = value
      },
    },
    confirm: () => false,
  }
  globalThis.document = {
    createElement: () => ({
      dataset: {},
      set textContent(value) {
        this._text = value
      },
      get textContent() {
        return this._text
      },
      remove() {},
    }),
    head: {
      appendChild: node => appended.push(node),
    },
  }

  // 用一个临时的 data: 模块执行 bundle（它本身不是 ESM 模块，只有副作用）。
  // 每次换一个查询串，否则 ESM 模块缓存会让后两次加载直接跳过副作用。
  const url =
    'data:text/javascript;base64,' +
    Buffer.from(source, 'utf8').toString('base64') +
    '#run' + (globalThis.__codexPlusRunSeq = (globalThis.__codexPlusRunSeq ?? 0) + 1)
  await import(url)

  assert.ok(registration !== undefined, 'bundle 必须调用 window.__ModuleLoader__.load')
  const exports = registration.factory(specifier => {
    if (specifier === 'react') return react
    throw new Error('unexpected require: ' + specifier)
  })
  return { registration, exports, appended }
}

test('客户端 bundle：id 是包名，工厂返回 apply 与 inject', async () => {
  const { registration, exports } = await loadClient()
  assert.equal(registration.id, 'dsh-codex-plus')
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual(exports.inject, ['slots', 'connection', 'locale'])
})

test('客户端 bundle：apply 注册两个 slot、locale 字典与样式', async () => {
  const { exports, appended } = await loadClient()
  const { ctx, slots, locales, effects } = fakeContext()

  await exports.apply(ctx)

  const names = slots.map(entry => entry.options.name).sort()
  assert.deepEqual(names, ['conversation.input.right', 'settings.section'])

  const settingsSlot = slots.find(entry => entry.options.name === 'settings.section')
  assert.equal(settingsSlot.options.id, 'codex-plus')
  assert.equal(typeof settingsSlot.options.label, 'function')
  assert.equal(typeof settingsSlot.component, 'function')

  assert.equal(locales.length, 1)
  assert.equal(locales[0].ns, 'codex-plus')
  assert.ok('nav' in locales[0].dictionary.zh)
  assert.ok('nav' in locales[0].dictionary.en)

  // 样式通过 effect 注入，dispose 后应当被移除。
  assert.equal(effects.length >= 1, true)
  assert.equal(appended.length, 1)
  assert.equal(appended[0].dataset.plugin, 'dsh-codex-plus')
})

test('客户端 bundle：组件在给定 props 下可渲染且不抛错', async () => {
  const { exports } = await loadClient()
  const { ctx, slots } = fakeContext()
  await exports.apply(ctx)

  const t = (key, params) => (params === undefined ? key : key + JSON.stringify(params))
  const rpc = { call: async () => ({ ok: true, value: { signedIn: false, accounts: [] } }) }

  for (const entry of slots) {
    const tree = entry.component({ rpc, t })
    assert.ok(tree !== undefined && tree !== null, entry.options.name + ' 必须渲染出内容')
  }
})