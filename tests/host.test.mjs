/**
 * host 侧装载冒烟测试：用一个最小的假 DSH 上下文跑 apply()，
 * 检查插件确实注册了授权流与 RPC 路由，并且 RPC 分发按契约返回。
 *
 * 不触网：所有对账号后端的调用都在 fetch 层被替换成立即返回的假响应。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

/** 假凭据服务：内存里的记录表，行为对齐 DSH 的 credentials 服务。 */
function fakeCredentials() {
  const records = new Map()
  return {
    records,
    credentialKey: (scope, id) => scope + '/' + id,
    readRecord: async key => records.get(key),
    modifyRecord: async (key, mutator) => {
      const next = await mutator(records.get(key))
      records.set(key, next)
      return next
    },
    set: async (key, value) => {
      records.set(key, { kind: 'grant', payload: { value } })
      return undefined
    },
    unset: async key => {
      records.delete(key)
    },
  }
}

/** 假 settings 服务：describe() 返回一行 llm-pi-ai 配置，update() 记录写入。 */
function fakeSettings(initialProviders) {
  const writes = []
  const row = {
    ns: 'llm-pi-ai',
    revision: 0,
    value: { providers: initialProviders ?? {} },
  }
  return {
    writes,
    describe: () => [row],
    update: async (ns, patch, revision) => {
      writes.push({ ns, patch, revision })
      row.value = { ...row.value, ...patch }
      row.revision += 1
    },
  }
}

/** 假 connection 服务：记录 fetch 路由。 */
function fakeConnection() {
  const routes = []
  return {
    routes,
    fetch: {
      register: route => {
        routes.push(route)
        return async () => undefined
      },
    },
  }
}

/** 一个够用的假 ctx：inject 立即执行回调，effect 立即执行并记录 dispose。 */
function fakeCtx(services) {
  const effects = []
  const logs = []
  const ctx = {
    logger: {
      info: message => logs.push(message),
      warn: message => logs.push(message),
      debug: () => undefined,
    },
    get: name => services[name],
    effect: (fn, label) => {
      const dispose = fn()
      effects.push({ label, dispose })
      return () => undefined
    },
    inject: (names, callback) => {
      const scoped = fakeCtx(services)
      // 授权与连接服务在这里挂到 scope 上，等价于 DSH 的服务就绪语义。
      scoped.authorization = services.authorization
      scoped.connection = services.connection
      callback(scoped)
      return scoped
    },
  }
  return { ctx, effects, logs }
}

/** 假授权服务：记录注册的 flow。 */
function fakeAuthorization() {
  const flows = []
  return {
    flows,
    registerFlow: flow => {
      flows.push(flow)
      return () => undefined
    },
  }
}

test('host 插件：apply 注册授权流与 RPC 路由', async () => {
  const credentials = fakeCredentials()
  const settings = fakeSettings({})
  const connection = fakeConnection()
  const authorization = fakeAuthorization()

  const { ctx, logs } = fakeCtx({ credentials, settings, connection, authorization })

  const mod = await import('../lib/index.js')
  assert.equal(mod.name, 'codex-plus')
  assert.ok(Array.isArray(mod.inject))

  mod.apply(ctx)

  assert.equal(authorization.flows.length, 1)
  const flow = authorization.flows[0]
  assert.equal(flow.key, 'codex-plus/accounts')
  assert.equal(typeof flow.run, 'function')
  assert.deepEqual(flow.methods.map(method => method.id), ['oauth', 'device_code'])

  // 每个端点一条精确路由：DSH 的 /api 桥按精确路径分发，客户端请求
  // /api/codex-plus/<endpoint>，所以这里必须是逐端点的 path。
  assert.ok(connection.routes.length >= 15, '应为每个端点注册一条路由, 实际 ' + connection.routes.length)
  for (const route of connection.routes) {
    assert.ok(route.path.startsWith('/api/codex-plus/'), '路由前缀错误: ' + route.path)
    assert.deepEqual(route.methods, ['POST'])
    assert.equal(route.requestBody, 'buffered')
  }
  const statusRoute = connection.routes.find(r => r.path === '/api/codex-plus/status')
  assert.ok(statusRoute !== undefined, '必须存在 status 端点路由')
  // 路径不能出现空的/点的段——与 DSH assertTarget 的规则一致
  for (const route of connection.routes) {
    const segments = route.path.slice('/api/codex-plus/'.length).split('/')
    for (const seg of segments) {
      assert.ok(seg !== '' && seg !== '.' && seg !== '..', '非法路径段: ' + route.path)
      assert.match(seg, /^[A-Za-z0-9_$.-]+$/, '路径段含非法字符: ' + route.path)
    }
  }
  assert.ok(logs.some(line => line.includes('quota console ready')))
})

test('RPC：未登录时 status 返回 signedIn:false，未知端点返回 not-found', async () => {
  const credentials = fakeCredentials()
  const settings = fakeSettings({})
  const connection = fakeConnection()
  const authorization = fakeAuthorization()
  const { ctx } = fakeCtx({ credentials, settings, connection, authorization })

  const mod = await import('../lib/index.js')
  mod.apply(ctx)

  const call = async (method, payload) => {
    const route = connection.routes.find(r => r.path === '/api/codex-plus/' + method)
    if (route === undefined) {
      return { type: 'server-response', rpcId: 'r1', result: { ok: false, error: { code: 'not-found', message: 'no route for ' + method, details: {} } } }
    }
    const response = await route.fetch(
      new Request('http://127.0.0.1/api/codex-plus/' + method, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method, payload }),
      }),
    )
    return response.json()
  }

  const status = await call('status', {})
  assert.equal(status.type, 'server-response')
  assert.equal(status.rpcId, 'r1')
  assert.equal(status.result.ok, true)
  assert.equal(status.result.value.signedIn, false)
  assert.deepEqual(status.result.value.accounts, [])

  const unknown = await call('does-not-exist', {})
  assert.equal(unknown.result.ok, false)
  assert.equal(unknown.result.error.code, 'not-found')

  const usage = await call('usage', {})
  assert.equal(usage.result.ok, true)
  assert.equal(usage.result.value.signedIn, false)
})

test('RPC：信封校验——非 JSON、错误 content-type、错误 method 都被拒', async () => {
  const credentials = fakeCredentials()
  const settings = fakeSettings({})
  const connection = fakeConnection()
  const authorization = fakeAuthorization()
  const { ctx } = fakeCtx({ credentials, settings, connection, authorization })

  const mod = await import('../lib/index.js')
  mod.apply(ctx)
  const route = connection.routes.find(r => r.path === '/api/codex-plus/status')

  const wrongContentType = await route.fetch(
    new Request('http://127.0.0.1/api/codex-plus', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'hi' }),
  )
  assert.equal(wrongContentType.status, 415)

  const badJson = await route.fetch(
    new Request('http://127.0.0.1/api/codex-plus', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    }),
  )
  assert.equal(badJson.status, 400)

  const wrongGet = await route.fetch(new Request('http://127.0.0.1/api/codex-plus', { method: 'GET' }))
  assert.equal(wrongGet.status, 405)
})

test('provider 同步：没有账号时不写入 llm-pi-ai 配置', async () => {
  const credentials = fakeCredentials()
  const settings = fakeSettings({})
  const connection = fakeConnection()
  const authorization = fakeAuthorization()
  const { ctx } = fakeCtx({ credentials, settings, connection, authorization })

  const mod = await import('../lib/index.js')
  mod.apply(ctx)

  // 等初始同步跑完（apply 里是 fire-and-forget）。
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.deepEqual(settings.writes, [])
})
test('provider 同步：loader 里装了会接管路由的插件时不写配置（防加载顺序竞态）', async () => {
  const credentials = fakeCredentials()
  const settings = fakeSettings({})
  const connection = fakeConnection()
  const authorization = fakeAuthorization()
  const { ctx } = fakeCtx({ credentials, settings, connection, authorization })
  // 关键场景：llm.listProviders() 还没看到对方注册（加载顺序未定），
  // 但 loader 里已经有 dsh-codex-subscription，此时必须保守不写。
  const services = { credentials, settings, connection, authorization }
  ctx.get = name => {
    if (name === 'llm') return { listProviders: () => [] }
    if (name === 'loader') return { entries: () => [{ options: { name: 'dsh-codex-subscription' } }] }
    return services[name]
  }

  const mod = await import('../lib/index.js')
  mod.apply(ctx)
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.deepEqual(settings.writes, [], '有已知路由接管者时不得写 provider 配置')
})

test('provider 同步：路由已被别的插件接管时不写配置（共存安全）', async () => {
  const credentials = fakeCredentials()
  const settings = fakeSettings({})
  const connection = fakeConnection()
  const authorization = fakeAuthorization()
  const { ctx } = fakeCtx({ credentials, settings, connection, authorization })
  // 模拟 dsh-codex-subscription 已接管 openai-codex 路由。
  ctx.get = name => (name === 'llm' ? { listProviders: () => ['openai-codex'] } : { credentials, settings, connection, authorization }[name])

  const mod = await import('../lib/index.js')
  mod.apply(ctx)
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.deepEqual(settings.writes, [], '路由被占用时不得改写别人的 provider 配置')
})