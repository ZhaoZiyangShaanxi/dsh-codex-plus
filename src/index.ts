/**
 * dsh-codex-plus — ChatGPT / Codex 订阅在 DSH 中的额度、账号与用量控制台。
 *
 * 职责边界（这是本插件与「又造一个 provider 插件」的关键区别）：
 *
 *   1. 模型路由不归本插件。DSH 的 llm-pi-ai 适配器已经装了 pi-ai 目录里的
 *      openai-codex provider（含 codex transport、模型目录、token 刷新）。
 *      本插件通过 settings 把该路由打开并指向我们存下的凭据，不重复注册
 *      同名 provider —— 重复注册会让插件加载直接失败。
 *
 *   2. 登录走 DSH 的 authorization flow 注册表。插件只注册一个 flow，
 *      由 DSH 自己的 OAuth 流程（浏览器/设备码、PKCE、回调）完成登录，
 *      我们拿到凭据后存进凭据服务。绝不自造 OAuth。
 *
 *   3. 额度、用量、模型目录、重置卡由本插件的 RPC 提供，前端据此渲染。
 *      这些读数全部来自账号后端真实返回，不编造。
 */
import { CodexPlusError } from './api.ts'
import { AccountVault, decodeClaims, newAccountId } from './store.ts'
import { SubscriptionService } from './service.ts'
import { syncPiAiProfile } from './provider.ts'
import { LoginBroker } from './login.ts'

export const name = 'codex-plus'
export const inject = ['credentials']

/** 我们在 pi-ai 目录里驱动的路由名。 */
const SUBSCRIPTION_PROVIDER = 'openai-codex'
/** 凭据记录键的 scope/id。DSH 的记录键就是 "<scope>/<id>"。 */
const CREDENTIAL_SCOPE = 'codex-plus'
const VAULT_ID = 'accounts'

/**
 * 拼一条 DSH 凭据记录键。
 *
 * DSH 自己导出的 credentialKey(scope, id) 就是做这件事，这里内联是为了
 * 让 host 模块在没有 DSH 运行时（单测、离线诊断）的情况下也能被 import——
 * 它没有任何副作用，只是一个字符串拼接。
 */
function credentialKey(scope, id) {
  return scope + '/' + id
}
/** RPC 通道：/api/codex-plus/<endpoint>。 */
const CHANNEL = '/api/codex-plus'

const USER_AGENT = 'dsh-codex-plus/0.1.0'

export function apply(ctx) {
  const vaultKey = credentialKey(CREDENTIAL_SCOPE, VAULT_ID)
  const vault = new AccountVault(ctx.credentials, vaultKey)

  const service = new SubscriptionService({
    vault,
    userAgent: USER_AGENT,
    logger: ctx.logger,
    // token 刷新交给 pi-ai 的 codex provider：它实现的是账号后端认的刷新语义
    // （含 refresh token 轮换），我们只负责把结果写回自己的仓库。
    refresh: async (credential, signal) => {
      const provider = await codexProvider()
      return provider.auth.oauth.refresh(credential, signal)
    },
  })

  /* ---- 登录：注册到 DSH 的 authorization 服务 ---- */

  ctx.inject(['authorization'], authorizationCtx => {
    const authorization = authorizationCtx.authorization
    const dispose = authorization.registerFlow({
      key: vaultKey,
      label: 'ChatGPT (Codex 订阅)',
      methods: [
        { id: 'oauth', label: '使用 ChatGPT 登录' },
        { id: 'device_code', label: '使用设备码登录（无浏览器）' },
      ],
      async run(session) {
        await loginThroughPiAi(ctx, vault, session)
        await syncPiAiProfile(ctx, vault)
      },
    })
    ctx.effect(() => dispose, 'codex-plus: authorization flow')
  })

  /* ---- 登录会话（设置页一键登录走这里） ---- */

  const broker = new LoginBroker(async () => {
    const provider = await codexProvider()
    const oauth = provider.auth.oauth
    if (oauth === undefined) throw new CodexPlusError('当前 pi-ai 版本不提供 ChatGPT 登录', 'unsupported')
    return oauth
  })

  /* ---- RPC：/api/codex-plus/<endpoint> ---- */

  ctx.inject(['connection'], connectionCtx => {
    const connection = connectionCtx.connection
    const handler = createRpcHandler({ ctx, vault, service, broker })
    const dispose = connection.fetch.register({
      path: CHANNEL,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        return handleRpcRequest(request, handler)
      },
    })
    ctx.effect(() => dispose, 'codex-plus: rpc channel')
  })

  /* ---- 启动时把已有账号接到模型路由上 ---- */

  ctx.effect(() => {
    let cancelled = false
    void syncPiAiProfile(ctx, vault).catch(error => {
      if (!cancelled) ctx.logger.warn('codex-plus: initial provider sync failed: ' + messageOf(error))
    })
    return () => {
      cancelled = true
    }
  }, 'codex-plus: initial provider sync')

  ctx.logger.info('codex-plus: quota console ready')
}

/* ------------------------------------------------------------------ *
 * 登录：把 DSH 的授权会话接到 pi-ai 的 Codex OAuth 上
 * ------------------------------------------------------------------ */

/**
 * 通过 pi-ai 的 openai-codex OAuth 完成一次登录，并把凭据存进我们的仓库。
 *
 * 这里复用的是 pi-ai 已经验证过的那套流程（浏览器回调 1455、设备码兜底、
 * PKCE、account id 提取）。DSH 的 authorization 会话只负责把「去哪里、做什么」
 * 转达给人，以及等待/取消。
 */
async function loginThroughPiAi(ctx, vault, session) {
  const provider = await codexProvider()
  const oauth = provider.auth.oauth
  if (oauth === undefined) throw new CodexPlusError('当前 pi-ai 版本不提供 ChatGPT 登录', 'unsupported')

  const deviceCode = session.method === 'device_code'
  const credential = await oauth.login({
    method: deviceCode ? 'device_code' : 'browser',
    signal: session.signal,
    // pi-ai 用 notify 报告「去这个地址」和「设备码是多少」，直接转达给人。
    notify: event => {
      if (event?.type === 'auth_url' && typeof event.url === 'string') {
        session.notify({ message: '在浏览器中完成 ChatGPT 登录', url: event.url })
        return
      }
      if (event?.type === 'device_code') {
        session.notify({
          message: '在浏览器打开 ' + event.verificationUri + '，输入代码 ' + event.userCode,
          url: event.verificationUri,
        })
        return
      }
      if (typeof event?.message === 'string') session.notify({ message: event.message })
    },
    // 需要人输入时（粘贴回调地址/验证码），借用 authorization 会话的 prompt。
    prompt: async prompt => {
      const answer = await session.prompt({
        kind: 'text',
        message: prompt?.message ?? '请粘贴回调地址或验证码',
      })
      return answer
    },
  })

  await persistCredential(ctx, vault, credential)
}

/**
 * 惰性拿到 pi-ai 的 openai-codex catalog provider。
 * 用动态 import 是因为 pi-ai 是 DSH 运行时的依赖，不打包进本插件。
 */
let cachedProvider
async function codexProvider() {
  if (cachedProvider !== undefined) return cachedProvider
  const mod = await import('@earendil-works/pi-ai/providers/all')
  const provider = mod.openaiCodexProvider?.()
  if (provider === undefined) throw new CodexPlusError('pi-ai 未提供 openai-codex provider', 'unsupported')
  cachedProvider = provider
  return provider
}

/* ------------------------------------------------------------------ *
 * RPC 分发
 * ------------------------------------------------------------------ */

/** 每个端点一个函数，用 Map 分发而不是一串 if。 */
function createRpcHandler(deps) {
  const { ctx, vault, service, broker } = deps

  const routes = new Map()
  routes.set('status', async () => service.status())
  routes.set('usage', async (_payload, signal) => service.usage({ signal }))
  routes.set('usage/refresh', async (_payload, signal) => service.usage({ signal, force: true }))
  routes.set('usage/history', async (payload, signal) => service.history({ signal, days: numberOr(payload?.days) }))
  routes.set('models', async (payload, signal) => service.models({ signal, force: payload?.force === true }))
  routes.set('reset-credits', async (payload, signal) => service.resetCredits({ signal, force: payload?.force === true }))
  routes.set('reset-credits/consume', async payload => {
    const creditId = typeof payload?.creditId === 'string' ? payload.creditId : undefined
    if (creditId === undefined) throw new CodexPlusError('缺少 creditId', 'invalid-input')
    return service.consumeReset(creditId)
  })
  routes.set('accounts/select', async payload => {
    const id = typeof payload?.id === 'string' ? payload.id : undefined
    if (id === undefined) throw new CodexPlusError('缺少账号 id', 'invalid-input')
    await vault.transact(record => {
      if (!record.accounts.some(account => account.id === id)) throw new CodexPlusError('找不到这个账号', 'not-found')
      return { record: { ...record, activeId: id }, result: undefined }
    })
    service.invalidateAll()
    await syncPiAiProfile(ctx, vault)
    return service.status()
  })
  routes.set('accounts/remove', async payload => {
    const id = typeof payload?.id === 'string' ? payload.id : undefined
    if (id === undefined) throw new CodexPlusError('缺少账号 id', 'invalid-input')
    await vault.transact(record => {
      const accounts = record.accounts.filter(account => account.id !== id)
      const activeId = record.activeId === id ? accounts[0]?.id : record.activeId
      return { record: { version: 1, ...(activeId === undefined ? {} : { activeId }), accounts }, result: undefined }
    })
    service.invalidateAll()
    await syncPiAiProfile(ctx, vault)
    return service.status()
  })
  routes.set('logout', async () => {
    await vault.transact(() => ({ record: { version: 1, accounts: [] }, result: undefined }))
    service.invalidateAll()
    await syncPiAiProfile(ctx, vault)
    return service.status()
  })
  routes.set('login/start', async payload => broker.start(typeof payload?.method === 'string' ? payload.method : 'browser'))
  routes.set('login/status', async payload => {
    const id = typeof payload?.id === 'string' ? payload.id : undefined
    if (id === undefined) throw new CodexPlusError('缺少登录会话 id', 'invalid-input')
    const state = broker.status(id)
    // 登录完成且成功：把凭据落库，再同步 provider，最后清掉会话结果。
    if (state.phase === 'done' && state.error === undefined) {
      const credential = broker.result(id)
      if (credential !== undefined) await persistCredential(ctx, vault, credential)
      await syncPiAiProfile(ctx, vault)
      service.invalidateAll()
    }
    broker.prune()
    return state
  })
  routes.set('login/submit', async payload => {
    const id = typeof payload?.id === 'string' ? payload.id : undefined
    if (id === undefined) throw new CodexPlusError('缺少登录会话 id', 'invalid-input')
    return broker.submit(id, typeof payload?.answer === 'string' ? payload.answer : '')
  })
  routes.set('login/cancel', async payload => {
    const id = typeof payload?.id === 'string' ? payload.id : undefined
    if (id === undefined) throw new CodexPlusError('缺少登录会话 id', 'invalid-input')
    return broker.cancel(id)
  })
  routes.set('diagnostics', async () => ({
    status: await service.status(),
    provider: SUBSCRIPTION_PROVIDER,
    channel: CHANNEL,
    userAgent: USER_AGENT,
  }))

  return async (endpoint, payload, signal) => {
    const route = routes.get(endpoint)
    if (route === undefined) throw new CodexPlusError('未知端点 ' + endpoint, 'not-found')
    return route(payload, signal)
  }
}

/**
 * RPC 的 HTTP 外壳：校验信封 → 分发 → 统一 {ok,value}|{ok,error} 返回。
 * 与 DSH 自己的 connection 通道保持同一份 JSON 协议。
 */
async function handleRpcRequest(request, handler) {
  if (request.method !== 'POST') return new Response('method not allowed', { status: 405 })
  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') return new Response('content type must be application/json', { status: 415 })

  let envelope
  try {
    envelope = await request.json()
  } catch {
    return new Response('body is not JSON', { status: 400 })
  }
  const rpcId = typeof envelope?.rpcId === 'string' ? envelope.rpcId : 'invalid-request'
  if (envelope?.type !== 'client-request' || typeof envelope?.method !== 'string') {
    return Response.json({ type: 'server-response', rpcId, result: { ok: false, error: { code: 'bad-request', message: 'invalid client-request envelope', details: {} } } })
  }

  try {
    const value = await handler(envelope.method, envelope.payload, request.signal)
    return Response.json({ type: 'server-response', rpcId, result: { ok: true, value } })
  } catch (error) {
    return Response.json({ type: 'server-response', rpcId, result: { ok: false, error: failureOf(error) } })
  }
}

function failureOf(error) {
  if (error instanceof CodexPlusError) {
    return { code: error.code, message: error.message, details: error.details ?? {} }
  }
  return { code: 'internal', message: messageOf(error), details: {} }
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function numberOr(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * 把一条 OAuth 凭据写进账号仓库（多账号追加，并设为当前账号）。
 * authorization flow 与设置页一键登录共用这条路径。
 */
async function persistCredential(ctx, vault, credential) {
  if (typeof credential?.access !== 'string' || credential.access === '') {
    throw new CodexPlusError('登录未返回有效凭据', 'login-failed')
  }

  const claims = decodeClaims(credential.access)
  const accountId = credential.accountId ?? claims.accountId
  const stored = {
    type: 'oauth',
    access: credential.access,
    refresh: credential.refresh,
    expires: credential.expires,
    ...(claims.email === undefined ? {} : { email: claims.email }),
    ...(accountId === undefined ? {} : { accountId }),
  }

  await vault.transact(record => {
    const id = newAccountId(record.accounts)
    const label = stored.email ?? 'ChatGPT 账号'
    return {
      record: { version: 1, activeId: id, accounts: [...record.accounts, { id, label, credential: stored }] },
      result: undefined,
    }
  })
  ctx.logger.info('codex-plus: signed in ' + (stored.email ?? '(no email)'))
}
