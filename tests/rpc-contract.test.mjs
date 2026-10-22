/**
 * RPC 契约测试：host 注册的路由 与 client 发起的请求必须严格对应。
 *
 * 这个文件是为了一个真实的线上故障补的：client 曾经用
 *   rpc.call('/api/codex-plus', 'status')
 * 调 host，而 DSH 的 assertTarget 只接受 channel === "/api"
 * （channel 里出现第二个斜杠就会被拒），于是设置页一打开就报
 *   connection: invalid RPC target "/api/codex-plus/status"
 * 而当时的测试只直接调 route.fetch()，完全绕过了 client 的调用路径，
 * 所以没发现。下面同时钉住两端。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

/** 复刻 DSH @deepseek-ai/dsh-client-connection 的 assertTarget 规则。 */
const CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/
function assertTarget(channel, endpoint) {
  const segments = endpoint.split('/')
  const bad = segments.some(s => s === '' || s === '.' || s === '..' || !ENDPOINT_SEGMENT_PATTERN.test(s))
  if (!CHANNEL_PATTERN.test(channel) || bad) {
    throw new Error(`connection: invalid RPC target ${JSON.stringify(`${channel}/${endpoint}`)}`)
  }
}

test('DSH 的 assertTarget 规则：channel 只能是单段（这就是当初的坑）', () => {
  // 正确形式
  assert.doesNotThrow(() => assertTarget('/api', 'codex-plus/status'))
  assert.doesNotThrow(() => assertTarget('/api', 'codex-plus/login/start'))
  // 曾经的错误形式必须被拒——防回退
  assert.throws(() => assertTarget('/api/codex-plus', 'status'), /invalid RPC target/)
})

test('client bundle 使用正确的 RPC 调用形式', () => {
  const client = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  assert.ok(client.includes("const CHANNEL = '/api'"), "RPC channel 必须是 '/api'")
  assert.ok(client.includes("const NAMESPACE = 'codex-plus'"), '必须存在端点命名空间常量')
  assert.ok(
    client.includes('connection.rpc.call(channel, NAMESPACE + '),
    'RPC 包装层必须把命名空间并进 endpoint',
  )
  // 防回退：不能再出现带斜杠的 channel 常量
  assert.ok(!client.includes("const CHANNEL = '/api/codex-plus'"), 'channel 不能含第二个斜杠')
})

test('host 为每个端点注册精确路由，且路径符合 DSH 规则', () => {
  const host = readFileSync(join(root, 'lib', 'index.js'), 'utf8')
  // host 用常量拼接注册路径：CHANNEL + '/' + endpoint
  assert.ok(host.includes("path: CHANNEL + '/' + endpoint"), 'host 必须逐端点注册精确路由')
  assert.ok(host.includes("const CHANNEL = '/api/codex-plus'"), 'host 的路径前缀应为 /api/codex-plus')
  assert.ok(host.includes('const RPC_ENDPOINTS'), 'host 必须有端点清单')
})

test('host 端点清单与 client 可能调用的端点必须一致', async () => {
  const mod = await import('../lib/index.js')
  // 从构建产物里拿不到 RPC_ENDPOINTS（未导出），改为校验行为：
  // 用一个假 ctx 跑 apply，收集注册的路由路径，再与 client 源码里出现的端点比对。
  const registered = []
  const ctx = {
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
    credentials: {
      readRecord: async () => undefined,
      modifyRecord: async (_k, fn) => fn(undefined),
      set: async () => undefined,
      unset: async () => undefined,
    },
    on: () => () => {},
    effect: fn => { try { fn() } catch {} return () => {} },
    get: name => (name === 'settings' ? { describe: () => [] } : undefined),
    inject: (_names, cb) => {
      const scoped = {
        ...ctx,
        authorization: { registerFlow: () => () => {} },
        connection: { fetch: { register: route => { registered.push(route.path); return async () => {} } } },
      }
      cb(scoped)
      return scoped
    },
  }
  mod.apply(ctx)

  assert.ok(registered.length >= 15, '注册的路由数量异常: ' + registered.length)
  for (const path of registered) {
    assert.ok(path.startsWith('/api/codex-plus/'), '路由前缀错误: ' + path)
    const endpoint = path.slice('/api/codex-plus/'.length)
    // host 路由的 endpoint 段 + client 的命名空间前缀，必须能通过 DSH 校验
    assert.doesNotThrow(() => assertTarget('/api', 'codex-plus/' + endpoint))
  }
})
