// ---- runtime ----
var __modules = new Map()
var __cache = new Map()
function __define(id, factory) { __modules.set(id, factory) }
function __m(id) {
  if (__cache.has(id)) return __cache.get(id)
  var factory = __modules.get(id)
  if (factory === undefined) throw new Error("missing module " + id)
  var exports = {}
  __cache.set(id, exports)
  factory(exports, __m)
  return exports
}

// ---- api.ts ----
__define("api", function (__exports, __m) {
/**
 * ChatGPT / Codex 订阅账号后端 API 客户端（host 侧）。
 *
 * 只做一件事：拿着 OAuth access token 和 account id，读账号真实返回的
 * 额度、模型目录、用量报告与重置卡。不猜测、不编造窗口——服务端没给的
 * 字段就保持 undefined，由 UI 决定是否显示。
 *
 * 所有出站请求统一：redirect:'error' 防重定向泄漏 Bearer、AbortSignal
 * 超时、失败归类为 CodexPlusError 而不抛裸 fetch 错误。
 */

const BACKEND_BASE = 'https://chatgpt.com/backend-api'

/** 订阅接口失败分类。code 供 UI 分流，message 供人读。 */
class CodexPlusError extends Error {
  constructor(message, code = 'subscription-error', details = {}) {
    super(message)
    this.name = 'CodexPlusError'
    this.code = code
    this.details = details
  }
}

const DEFAULT_TIMEOUT_MS = 20_000

/**
 * 一个账号的最小身份：token + account id。
 * @typedef {{ access: string, accountId: string, email?: string }} AccountAuth
 */

/** @param {Record<string, string>} extra */
function headersFor(auth, userAgent, extra) {
  return {
    authorization: `Bearer ${auth.access}`,
    'chatgpt-account-id': auth.accountId,
    accept: 'application/json',
    originator: 'pi',
    'user-agent': userAgent,
    ...extra,
  }
}

/**
 * 调一次账号后端。
 * @param {AccountAuth} auth
 * @param {string} path 以 / 开头的后端路径
 * @param {{ method?: string, body?: unknown, query?: Record<string, string|number|undefined>, signal?: AbortSignal, timeoutMs?: number, userAgent: string }} options
 */
async function call(auth, path, options) {
  const { method = 'GET', body, query, signal, timeoutMs = DEFAULT_TIMEOUT_MS, userAgent } = options
  let url = path.startsWith('http') ? path : BACKEND_BASE + path
  if (query !== undefined) {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params.set(key, String(value))
    }
    const qs = params.toString()
    if (qs !== '') url += (url.includes('?') ? '&' : '?') + qs
  }

  // 调用方的取消信号与自身超时合并：任一触发都中止，避免悬挂请求。
  const own = new AbortController()
  const timer = setTimeout(() => own.abort(new Error('timeout')), timeoutMs)
  const onAbort = () => own.abort(signal?.reason)
  if (signal !== undefined) {
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }

  let response
  try {
    response = await fetch(url, {
      method,
      headers: headersFor(auth, userAgent, body === undefined ? {} : { 'content-type': 'application/json' }),
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: own.signal,
    })
  } catch (error) {
    if (signal?.aborted === true) throw new CodexPlusError('请求已取消', 'aborted', { path })
    throw new CodexPlusError(`无法连接订阅服务：${describe(error)}`, 'network', { path })
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }

  if (response.status === 304) return { status: 304, etag: response.headers.get('etag') ?? undefined, body: undefined }

  const text = await response.text().catch(() => '')
  if (!response.ok) throw failureOf(response.status, text, path)
  if (text === '') return { status: response.status, etag: response.headers.get('etag') ?? undefined, body: {} }
  try {
    return { status: response.status, etag: response.headers.get('etag') ?? undefined, body: JSON.parse(text) }
  } catch {
    throw new CodexPlusError('订阅服务返回了非 JSON 响应', 'malformed-response', { path, status: response.status })
  }
}

function describe(error) {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError') return '请求超时'
    if (error.name === 'AbortError') return '请求超时'
    return error.message
  }
  return String(error)
}

/** 把 HTTP 失败归类，认证/额度/限流分开，UI 才能给出不同处置。 */
function failureOf(status, text, path) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = undefined
  }
  const detail = parsed?.error ?? parsed?.detail ?? parsed
  const serverCode = typeof detail?.code === 'string' ? detail.code : typeof detail?.type === 'string' ? detail.type : undefined
  const serverMessage = typeof detail?.message === 'string' ? detail.message : typeof detail === 'string' ? detail : undefined

  if (status === 401 || status === 403) {
    return new CodexPlusError(serverMessage ?? '登录已失效，请重新登录 ChatGPT', 'unauthorized', { status, path, serverCode })
  }
  if (status === 429) {
    const plan = typeof detail?.plan_type === 'string' ? `（${detail.plan_type} 套餐）` : ''
    const mins = typeof detail?.resets_at === 'number' ? Math.max(0, Math.round((detail.resets_at * 1000 - Date.now()) / 60_000)) : undefined
    const when = mins === undefined ? '' : `，约 ${mins} 分钟后恢复`
    return new CodexPlusError(`额度已用尽${plan}${when}`, 'rate-limited', { status, path, serverCode, detail })
  }
  const suffix = serverMessage === undefined ? '' : `：${serverMessage}`
  return new CodexPlusError(`订阅服务返回 ${status}${suffix}`, 'http-error', { status, path, serverCode, detail })
}

/* ------------------------------------------------------------------ *
 * 额度
 * ------------------------------------------------------------------ */

/**
 * 读当前账号的额度窗口。
 *
 * 服务端返回 rate_limit.primary_window（短周期，通常 5h）与
 * secondary_window（周额度），窗口大小与重置时间都由服务端给，
 * 我们只做单位归一（秒 → 毫秒）与缺失容忍。
 *
 * @param {AccountAuth} auth
 * @param {{ signal?: AbortSignal, userAgent: string, timeoutMs?: number }} options
 */
async function fetchUsage(auth, options) {
  const { body } = await call(auth, '/wham/usage', { signal: options.signal, timeoutMs: options.timeoutMs, userAgent: options.userAgent })
  return normalizeUsage(body)
}

/**
 * 把服务端额度负载归一为稳定结构。
 * 与账号实际返回不同步的字段一律留 undefined。
 */
function normalizeUsage(raw) {
  const payload = isRecord(raw) ? raw : {}
  const limit = isRecord(payload.rate_limit) ? payload.rate_limit : undefined

  const windows = []
  if (limit !== undefined) {
    const primary = limitWindow(limit.primary_window, 'primary')
    if (primary !== undefined) windows.push(primary)
    const secondary = limitWindow(limit.secondary_window, 'secondary')
    if (secondary !== undefined) windows.push(secondary)
  }

  // 代码审查等入口可能有独立的周额度，服务端单独给一个分组。
  const review = isRecord(payload.code_review_rate_limit) ? limitWindow(payload.code_review_rate_limit.primary_window, 'review') : undefined
  if (review !== undefined) windows.push({ ...review, group: reviewGroupName(payload) })

  // 账号可能另有独立的额度分组（例如按功能计费的另一条限额）。
  const extra = Array.isArray(payload.additional_rate_limits) ? payload.additional_rate_limits : []
  for (const [index, entry] of extra.entries()) {
    if (!isRecord(entry)) continue
    const nested = isRecord(entry.rate_limit) ? entry.rate_limit : undefined
    const window = nested === undefined ? undefined : limitWindow(nested.primary_window, `extra:${index}`)
    if (window === undefined) continue
    windows.push({
      ...window,
      group: typeof entry.limit_name === 'string' ? entry.limit_name : `额外额度 ${index + 1}`,
      feature: typeof entry.metered_feature === 'string' ? entry.metered_feature : undefined,
    })
  }

  return {
    planType: typeof payload.plan_type === 'string' ? payload.plan_type : undefined,
    windows,
    credits: creditsOf(payload.credits),
    limitReached: limit !== undefined && limit.limit_reached === true,
    allowed: limit !== undefined && typeof limit.allowed === 'boolean' ? limit.allowed : undefined,
    // 额度用尽的原因（工作区额度、成员额度……），服务端给才显示。
    reachedType: reachedTypeOf(payload.rate_limit_reached_type),
    // 重置卡数量内嵌在额度负载里，和单独的 /wham/rate-limit-reset-credits 是同一份事实。
    resetCreditsAvailable: resetCreditsAvailableOf(payload.rate_limit_reset_credits),
    promo: promoOf(payload.promo),
    fetchedAt: Date.now(),
  }
}

function limitWindow(raw, kind) {
  if (!isRecord(raw)) return undefined
  const used = numberOr(raw.used_percent)
  if (used === undefined) return undefined
  const windowSeconds = numberOr(raw.limit_window_seconds)
  const resetAt = numberOr(raw.reset_at)
  const resetAfter = numberOr(raw.reset_after_seconds)
  return {
    kind,
    label: typeof raw.label === 'string' ? raw.label : undefined,
    usedPercent: clamp(used, 0, 100),
    remainingPercent: clamp(100 - used, 0, 100),
    windowSeconds,
    // Codex 自己按 (seconds + 59) / 60 向上取整得到窗口分钟数；沿用它的算法，
    // 这样我们显示的天/小时与官方界面一致。
    windowMinutes: windowSeconds === undefined || windowSeconds <= 0 ? undefined : Math.floor((windowSeconds + 59) / 60),
    // 服务端偶尔只给 reset_after_seconds；换算成绝对时间，UI 就能只认一种。
    resetsAt: resetAt !== undefined ? resetAt * 1000 : resetAfter !== undefined ? Date.now() + resetAfter * 1000 : undefined,
  }
}

/** 代码审查额度分组的显示名；服务端没给就用固定文案。 */
function reviewGroupName(payload) {
  const raw = payload.code_review_rate_limit
  return isRecord(raw) && typeof raw.limit_name === 'string' ? raw.limit_name : '代码审查'
}

/**
 * rate_limit_reached_type 在线上是 {"type": "..."} 也可能直接是字符串。
 * @returns 归一后的原因字符串，没有则 undefined
 */
function reachedTypeOf(raw) {
  if (typeof raw === 'string' && raw !== '') return raw
  if (isRecord(raw) && typeof raw.type === 'string' && raw.type !== '') return raw.type
  return undefined
}

function resetCreditsAvailableOf(raw) {
  if (!isRecord(raw)) return undefined
  return numberOr(raw.available_count)
}

function creditsOf(raw) {
  if (!isRecord(raw)) return undefined
  const has = raw.has_credits === true
  const unlimited = raw.unlimited === true
  const balance = typeof raw.balance === 'string' ? raw.balance : typeof raw.balance === 'number' ? String(raw.balance) : undefined
  // 三者皆无意义时不返回空壳，避免 UI 显示一行「余额 —」。
  if (!has && !unlimited && balance === undefined) return undefined
  return { hasCredits: has, unlimited, balance }
}

function promoOf(raw) {
  if (isRecord(raw)) {
    const text = typeof raw.message === 'string' ? raw.message : typeof raw.title === 'string' ? raw.title : undefined
    return text === undefined ? undefined : { message: text }
  }
  return typeof raw === 'string' && raw !== '' ? { message: raw } : undefined
}

/* ------------------------------------------------------------------ *
 * 用量报告 / 账号资料 / 模型目录
 * ------------------------------------------------------------------ */

/**
 * 计划的限额历史（按天），用于趋势图。
 * 该报告并非所有账号都返回；失败时返回 undefined 而不是抛错。
 */
async function fetchPlanHistory(auth, options) {
  const days = options.days ?? 7
  try {
    const { body } = await call(auth, '/wham/usage/plan_limit_history', { query: { days }, signal: options.signal, userAgent: options.userAgent })
    return normalizeHistory(body, days)
  } catch (error) {
    if (error instanceof CodexPlusError && (error.code === 'http-error' || error.code === 'unauthorized')) return undefined
    throw error
  }
}

function normalizeHistory(raw, days) {
  const payload = isRecord(raw) ? raw : {}
  const rows = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.history) ? payload.history : Array.isArray(payload.days) ? payload.days : []
  const points = []
  for (const row of rows) {
    if (!isRecord(row)) continue
    const date = typeof row.date === 'string' ? row.date : typeof row.day === 'string' ? row.day : undefined
    const used = numberOr(row.used_percent) ?? numberOr(row.usage_percent) ?? numberOr(row.percent)
    if (date !== undefined && used !== undefined) points.push({ date, usedPercent: clamp(used, 0, 100) })
  }
  return points.length === 0 && days > 0 ? undefined : { days, points: points.sort((a, b) => a.date.localeCompare(b.date)) }
}

/** 账号资料（套餐、邮箱、组织等），失败不该挡住额度显示。 */
async function fetchProfile(auth, options) {
  try {
    const { body } = await call(auth, '/wham/profiles/me', { signal: options.signal, userAgent: options.userAgent })
    return normalizeProfile(body)
  } catch {
    return undefined
  }
}

function normalizeProfile(raw) {
  const payload = isRecord(raw) ? raw : {}
  /** @param {string} key */
  const str = key => (typeof payload[key] === 'string' && payload[key] !== '' ? payload[key] : undefined)
  const profile = {
    email: str('email'),
    name: str('name') ?? str('display_name'),
    planType: str('plan_type') ?? str('plan'),
    accountId: str('account_id') ?? str('chatgpt_account_id'),
  }
  return Object.values(profile).some(value => value !== undefined) ? profile : undefined
}

/**
 * 账号可用的模型目录。
 *
 * ChatGPT 后端会按 client_version 放行新模型；版本号由调用方传入。
 * 目录是唯一真源：拿不到就不显示模型，绝不回落到内置列表。
 */
async function fetchModelCatalog(auth, options) {
  const { body, etag } = await call(auth, '/codex/models', { query: { client_version: options.clientVersion }, signal: options.signal, userAgent: options.userAgent })
  return { catalog: normalizeCatalog(body), etag }
}

function normalizeCatalog(raw) {
  const payload = isRecord(raw) ? raw : {}
  const list = Array.isArray(payload.models) ? payload.models : Array.isArray(payload.data) ? payload.data : []
  const models = []
  for (const entry of list) {
    if (!isRecord(entry)) continue
    const id = typeof entry.id === 'string' ? entry.id : typeof entry.slug === 'string' ? entry.slug : typeof entry.model === 'string' ? entry.model : undefined
    if (id === undefined || id === '') continue
    models.push({
      id,
      name: typeof entry.name === 'string' && entry.name !== '' ? entry.name : typeof entry.display_name === 'string' ? entry.display_name : id,
      description: typeof entry.description === 'string' ? entry.description : undefined,
      contextWindow: numberOr(entry.context_window) ?? numberOr(entry.contextWindow),
      maxOutputTokens: numberOr(entry.max_output_tokens) ?? numberOr(entry.maxTokens),
      retiredAt: typeof entry.retired_at === 'string' ? entry.retired_at : typeof entry.deprecated_at === 'string' ? entry.deprecated_at : undefined,
      // 推理档位名字各级不同，原样保留由 UI 决定展示顺序。
      reasoningEfforts: Array.isArray(entry.reasoning_efforts)
        ? entry.reasoning_efforts.filter(effort => typeof effort === 'string')
        : Array.isArray(entry.supported_reasoning_efforts)
          ? entry.supported_reasoning_efforts.filter(effort => typeof effort === 'string')
          : undefined,
      speeds: Array.isArray(entry.speeds) ? entry.speeds.filter(speed => typeof speed === 'string') : undefined,
      vision: entry.supports_vision === true || entry.supports_images === true ? true : undefined,
    })
  }
  return { models, fetchedAt: Date.now() }
}

/* ------------------------------------------------------------------ *
 * 重置卡
 * ------------------------------------------------------------------ */

/** 列出租借账号上可用的「额度重置卡」。 */
async function fetchResetCredits(auth, options) {
  const { body } = await call(auth, '/wham/rate-limit-reset-credits', { signal: options.signal, userAgent: options.userAgent })
  return normalizeResetCredits(body)
}

function normalizeResetCredits(raw) {
  const payload = isRecord(raw) ? raw : {}
  const list = Array.isArray(payload.credits) ? payload.credits : []
  const credits = []
  for (const entry of list) {
    if (!isRecord(entry)) continue
    const id = typeof entry.id === 'string' ? entry.id : undefined
    if (id === undefined) continue
    credits.push({
      id,
      title: typeof entry.title === 'string' ? entry.title : undefined,
      description: typeof entry.description === 'string' ? entry.description : undefined,
      status: typeof entry.status === 'string' ? entry.status : undefined,
      kind: typeof entry.reset_type === 'string' ? entry.reset_type : undefined,
      grantedAt: typeof entry.granted_at === 'string' ? entry.granted_at : undefined,
      expiresAt: typeof entry.expires_at === 'string' ? entry.expires_at : undefined,
      redeemedAt: typeof entry.redeemed_at === 'string' ? entry.redeemed_at : undefined,
      pending: typeof entry.redeem_started_at === 'string' && entry.redeem_started_at !== '',
    })
  }
  return {
    credits,
    availableCount: numberOr(payload.available_count) ?? credits.filter(credit => credit.status === 'available' && !credit.pending).length,
  }
}

/**
 * 使用一张重置卡。
 *
 * 服务端按 (credit_id, redeem_request_id) 做幂等，所以 redeem_request_id
 * 由 credit id 稳定派生：重试或超时后重发同一对参数，只会结算一次。
 * 派生是纯函数且与时钟无关，调用方不必持久化任何中间状态。
 *
 * @param {AccountAuth} auth
 * @param {string} creditId
 * @param {{ signal?: AbortSignal, userAgent: string }} options
 */
async function consumeResetCredit(auth, creditId, options) {
  const { body } = await call(auth, '/wham/rate-limit-reset-credits/consume', {
    method: 'POST',
    body: { credit_id: creditId, redeem_request_id: redeemRequestId(creditId) },
    signal: options.signal,
    userAgent: options.userAgent,
  })
  const payload = isRecord(body) ? body : {}
  return {
    code: typeof payload.code === 'string' ? payload.code : undefined,
    windowsReset: numberOr(payload.windows_reset) ?? 0,
    credit: isRecord(payload.credit) ? normalizeResetCredits({ credits: [payload.credit] }).credits[0] : undefined,
  }
}

/**
 * 由 credit id 稳定派生幂等键（UUIDv5 形状）。
 * 用 FNV-1a 双通道生成 128 位，无加密强度需求——它只需要稳定且不撞。
 */
function redeemRequestId(creditId) {
  const hash = (seed) => {
    let h1 = 0x811c9dc5 ^ seed
    let h2 = 0x9e3779b9 ^ (seed * 0x85ebca6b)
    for (let i = 0; i < creditId.length; i++) {
      const code = creditId.charCodeAt(i)
      h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0
      h2 = Math.imul(h2 ^ code, 0x85ebca6b) >>> 0
    }
    return [h1, h2]
  }
  const [a, b] = hash(0x5f356495)
  const [c, d] = hash(0x2545f491)
  const hex = [a, b, c, d].map(value => value.toString(16).padStart(8, '0')).join('')
  // 按 RFC 4122 打上 version 5 与 variant 位，让它对幂等层看起来像真正的 UUID。
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function numberOr(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}
__exports["BACKEND_BASE"] = BACKEND_BASE
__exports["CodexPlusError"] = CodexPlusError
__exports["fetchUsage"] = fetchUsage
__exports["normalizeUsage"] = normalizeUsage
__exports["fetchPlanHistory"] = fetchPlanHistory
__exports["normalizeHistory"] = normalizeHistory
__exports["fetchProfile"] = fetchProfile
__exports["normalizeProfile"] = normalizeProfile
__exports["fetchModelCatalog"] = fetchModelCatalog
__exports["normalizeCatalog"] = normalizeCatalog
__exports["fetchResetCredits"] = fetchResetCredits
__exports["normalizeResetCredits"] = normalizeResetCredits
__exports["consumeResetCredit"] = consumeResetCredit
__exports["redeemRequestId"] = redeemRequestId
});

// ---- store.ts ----
__define("store", function (__exports, __m) {
/**
 * 账号与凭据的存取层（host 侧）。
 *
 * 凭据只落在 DSH 的 credentials 服务里，绝不写进插件配置或日志。
 * 多处会并发刷新同一个账号的 token，所以所有读-改-写都串行化，
 * 否则一次慢刷新会用旧 token 覆盖掉轮换后的新 token。
 */

/** 订阅帐号在 DSH 凭据服务中的记录键。 */
const CREDENTIAL_SCOPE = 'codex-plus'
const VAULT_ID = 'accounts'

/** 单条 OAuth 凭据的形状。refresh 只在 host 内部使用。 */
/** @typedef {{ type: 'oauth', access: string, refresh: string, expires: number, email?: string, accountId?: string, label?: string }} OAuthCredential */

/** token 被认为过期的提前量：留足一次请求的余量，避免边界上失败。 */
const EXPIRY_SKEW_MS = 60_000

function isOAuthCredential(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    value.type === 'oauth' &&
    typeof value.access === 'string' &&
    value.access !== '' &&
    typeof value.refresh === 'string' &&
    value.refresh !== '' &&
    typeof value.expires === 'number' &&
    Number.isFinite(value.expires)
  )
}

/** 从 JWT 载荷里读 ChatGPT 账号 id 与邮箱——这两项决定请求头，必须准确。 */
function decodeClaims(accessToken) {
  const payload = decodeJwtPayload(accessToken)
  const auth = payload?.['https://api.openai.com/auth']
  const accountId = typeof auth?.chatgpt_account_id === 'string' && auth.chatgpt_account_id !== '' ? auth.chatgpt_account_id : undefined
  const profile = payload?.['https://api.openai.com/profile']
  const email = typeof profile?.email === 'string' && profile.email !== '' ? profile.email : typeof payload?.email === 'string' ? payload.email : undefined
  return { accountId, email }
}

function decodeJwtPayload(token) {
  const parts = token.split('.')
  if (parts.length !== 3) return undefined
  try {
    const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    const parsed = JSON.parse(json)
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined
  } catch {
    return undefined
  }
}

function isExpired(credential, now = Date.now()) {
  return credential.expires - EXPIRY_SKEW_MS <= now
}

/**
 * 账号仓库。一个 DSH 凭据记录存全部账号，避免 N 个账号 N 条记录不一致。
 */
class AccountVault {
  #credentials
  #key
  #tail = Promise.resolve()

  constructor(credentials, key) {
    this.#credentials = credentials
    this.#key = key
  }

  /**
   * 串行执行一次读-改-写，返回该次修改的可观察结果。
   * 队列本身绝不被单次失败打断：前一次抛错不影响后一次。
   * @template T
   * @param {(record: VaultRecord) => Promise<{ record: VaultRecord, result: T }>} mutate
   * @returns {Promise<T>}
   */
  transact(mutate) {
    const run = this.#tail.then(async () => {
      const current = await this.read()
      const { record, result } = await mutate(current)
      await this.#write(record)
      return result
    })
    this.#tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /** 读当前记录；不存在或损坏时退化为空仓库而不是抛错。 */
  async read() {
    try {
      const stored = await this.#credentials.readRecord(this.#key)
      const payload = stored?.kind === 'grant' ? stored.payload : undefined
      return normalizeVault(payload)
    } catch {
      return emptyVault()
    }
  }

  async #write(record) {
    await this.#credentials.modifyRecord(this.#key, () => Promise.resolve({ kind: 'grant', payload: record }))
  }
}

/** @typedef {{ version: 1, activeId?: string, accounts: Array<{ id: string, label: string, credential: OAuthCredential }> }} VaultRecord */

function emptyVault() {
  return { version: 1, accounts: [] }
}

function normalizeVault(payload) {
  if (typeof payload !== 'object' || payload === null) return emptyVault()
  const raw = Array.isArray(payload.accounts) ? payload.accounts : []
  const accounts = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    if (typeof entry.id !== 'string' || entry.id === '') continue
    if (!isOAuthCredential(entry.credential)) continue
    accounts.push({
      id: entry.id,
      label: typeof entry.label === 'string' && entry.label !== '' ? entry.label : 'ChatGPT 账号',
      credential: entry.credential,
    })
  }
  const activeId = typeof payload.activeId === 'string' && accounts.some(account => account.id === payload.activeId) ? payload.activeId : accounts[0]?.id
  return { version: 1, ...(activeId === undefined ? {} : { activeId }), accounts }
}

/** 在仓库记录里挑出当前生效账号。 */
function activeAccount(record) {
  if (record.accounts.length === 0) return undefined
  return record.accounts.find(account => account.id === record.activeId) ?? record.accounts[0]
}

/** 生成一个不会与既有账号冲突的 stable id。 */
function newAccountId(existing) {
  const taken = new Set(existing.map(account => account.id))
  for (let attempt = 0; ; attempt++) {
    const id = `acct-${Date.now().toString(36)}${attempt === 0 ? '' : `-${attempt}`}`
    if (!taken.has(id)) return id
  }
}

/**
 * 账号在 UI 上可暴露的身份：只有非密字段。
 * access/refresh 绝不过这条边界。
 */
function publicAccount(account, activeId) {
  const { accountId, email } = decodeClaims(account.credential.access)
  return {
    id: account.id,
    label: account.label,
    email: account.credential.email ?? email,
    accountId: account.credential.accountId ?? accountId,
    expiresAt: account.credential.expires,
    active: account.id === activeId,
    // 仅用于显示：前端据此提示「即将过期」，不会自行刷新。
    expiresSoon: account.credential.expires - EXPIRY_SKEW_MS <= Date.now(),
  }
}

__exports["CREDENTIAL_SCOPE"] = CREDENTIAL_SCOPE
__exports["VAULT_ID"] = VAULT_ID
__exports["EXPIRY_SKEW_MS"] = EXPIRY_SKEW_MS
__exports["isOAuthCredential"] = isOAuthCredential
__exports["decodeClaims"] = decodeClaims
__exports["decodeJwtPayload"] = decodeJwtPayload
__exports["isExpired"] = isExpired
__exports["AccountVault"] = AccountVault
__exports["emptyVault"] = emptyVault
__exports["normalizeVault"] = normalizeVault
__exports["activeAccount"] = activeAccount
__exports["newAccountId"] = newAccountId
__exports["publicAccount"] = publicAccount
});

// ---- service.ts ----
__define("service", function (__exports, __m) {
/**
 * 订阅数据服务（host 侧）：把 api.ts 的读取能力包成一份带缓存的快照，
 * 并负责 token 刷新与「当前账号」的解析。
 *
 * 缓存的意义在于：额度面板会在会话里频繁重挂载，而 /wham/usage 这类
 * 接口不该被每次挂载打一次。窗口数据 30 秒内复用，重置卡 5 分钟。
 */
const { CodexPlusError, consumeResetCredit, fetchModelCatalog, fetchPlanHistory, fetchProfile, fetchResetCredits, fetchUsage } = __m("api")
const { activeAccount, decodeClaims, isExpired } = __m("store")
const USAGE_TTL_MS = 30_000
const CATALOG_TTL_MS = 10 * 60_000
const RESET_TTL_MS = 5 * 60_000

class SubscriptionService {
  #vault
  #userAgent
  #refresh
  #logger
  #cache = new Map()
  /** 单飞：accountId → 正在进行的刷新。 */
  #refreshing = new Map()

  constructor(options) {
    this.#vault = options.vault
    this.#userAgent = options.userAgent
    this.#refresh = options.refresh
    this.#logger = options.logger
  }

  /** 当前生效账号（含刷新后的 token 与派生出的 account id）。 */
  async currentAccount(signal) {
    const record = await this.#vault.read()
    const account = activeAccount(record)
    if (account === undefined) return undefined
    const credential = await this.#ensured(account.id, signal)
    const claims = decodeClaims(credential.access)
    const accountId = credential.accountId ?? claims.accountId
    if (accountId === undefined) {
      throw new CodexPlusError('这个账号的凭据里没有 ChatGPT 账号 id，请重新登录', 'credential-malformed')
    }
    return {
      id: account.id,
      label: account.label,
      email: credential.email ?? claims.email,
      accountId,
      credential,
      auth: { access: credential.access, accountId },
    }
  }

  /**
   * 取一个账号可用（未过期）的凭据，必要时刷新并回写仓库。
   *
   * 刷新按 codex-rs 的语义实现，三条都是必须的：
   *   1) 单飞：同一个账号同一时刻只允许一次刷新。两个并发刷新用同一个
   *      refresh token 会让服务端判定 refresh_token_reused，直接导致强制登出。
   *   2) 合并而非覆盖：刷新响应里的 refresh token 是「可选」的——服务端
   *      没给就说明旧的仍然有效，必须保留，不能写成 undefined。
   *   3) 不重放：刷新请求的响应一旦丢失，旧 token 可能已经被消费，
   *      重放会拿到 reused 错误。这里不做自动重试，把判定权交给人。
   */
  async #ensured(accountId, signal) {
    const record = await this.#vault.read()
    const account = record.accounts.find(entry => entry.id === accountId)
    if (account === undefined) throw new CodexPlusError('找不到这个账号', 'not-found')
    if (!isExpired(account.credential)) return account.credential

    const inflight = this.#refreshing.get(accountId)
    if (inflight !== undefined) return inflight

    const task = this.#refreshOnce(accountId, account.credential, signal).finally(() => {
      this.#refreshing.delete(accountId)
    })
    this.#refreshing.set(accountId, task)
    return task
  }

  /** 单次刷新：调用 pi-ai 的刷新实现，再按「合并」语义写回。 */
  async #refreshOnce(accountId, stale, signal) {
    let next
    try {
      next = await this.#refresh(stale, signal)
    } catch (error) {
      throw classifyRefreshFailure(error)
    }
    // 刷新响应里 refresh 是「可选」的：服务端没轮换就只回 access。
    // 因此这里只要求 access + expires，refresh 缺失时沿用旧的。
    if (!isRefreshResponse(next)) throw new CodexPlusError('刷新返回了无法识别的凭据', 'credential-malformed')

    const claims = decodeClaims(next.access)
    // refresh 只在新值存在时替换；access/expires 一定换新。
    const merged = {
      type: 'oauth',
      access: next.access,
      expires: next.expires,
      refresh: typeof next.refresh === 'string' && next.refresh !== '' ? next.refresh : stale.refresh,
      email: next.email ?? stale.email ?? claims.email,
      accountId: next.accountId ?? stale.accountId ?? claims.accountId,
    }

    // 条件写回：只有仓库里仍是本次用作输入的 refresh token 才覆盖。
    // 若已被别的路径换掉，说明有更新的 token 在，直接采用它。
    const winner = await this.#vault.transact(current => {
      const entry = current.accounts.find(candidate => candidate.id === accountId)
      if (entry === undefined) return { record: current, result: merged }
      if (entry.credential.refresh !== stale.refresh) return { record: current, result: entry.credential }
      return {
        record: {
          ...current,
          accounts: current.accounts.map(candidate =>
            candidate.id === accountId ? { ...candidate, credential: merged } : candidate,
          ),
        },
        result: merged,
      }
    })
    this.#logger?.info?.('codex-plus: refreshed credential for ' + accountId)
    return winner
  }

  /** 账号总览：登录状态、账号列表、当前账号。不含任何密钥。 */
  async status() {
    const record = await this.#vault.read()
    const accounts = record.accounts.map(account => {
      const claims = decodeClaims(account.credential.access)
      return {
        id: account.id,
        label: account.label,
        email: account.credential.email ?? claims.email,
        accountId: account.credential.accountId ?? claims.accountId,
        expiresAt: account.credential.expires,
        active: account.id === record.activeId,
        expiresSoon: isExpired(account.credential),
      }
    })
    return { signedIn: accounts.length > 0, accounts, activeId: record.activeId }
  }

  /** 额度快照（带缓存）。 */
  async usage(options = {}) {
    const account = await this.currentAccount(options.signal)
    if (account === undefined) return { signedIn: false }
    const key = 'usage:' + account.id
    const cached = this.#cached(key, USAGE_TTL_MS, options.force === true)
    if (cached !== undefined) return cached

    const [usage, profile] = await Promise.all([
      fetchUsage(account.auth, { signal: options.signal, userAgent: this.#userAgent }),
      fetchProfile(account.auth, { signal: options.signal, userAgent: this.#userAgent }),
    ])
    const value = {
      signedIn: true,
      account: { id: account.id, label: account.label, email: account.email },
      planType: usage.planType ?? profile?.planType,
      windows: usage.windows,
      credits: usage.credits,
      limitReached: usage.limitReached,
      allowed: usage.allowed,
      promo: usage.promo,
      fetchedAt: usage.fetchedAt,
    }
    this.#remember(key, value)
    return value
  }

  /** 限额历史；账号没有该报告时返回 undefined 而不是报错。 */
  async history(options = {}) {
    const account = await this.currentAccount(options.signal)
    if (account === undefined) return undefined
    const key = 'history:' + account.id + ':' + (options.days ?? 7)
    const cached = this.#cached(key, 5 * 60_000, false)
    if (cached !== undefined) return cached
    const value = await fetchPlanHistory(account.auth, {
      days: options.days ?? 7,
      signal: options.signal,
      userAgent: this.#userAgent,
    })
    if (value !== undefined) this.#remember(key, value)
    return value
  }

  /** 账号可用模型目录。 */
  async models(options = {}) {
    const account = await this.currentAccount(options.signal)
    if (account === undefined) return { signedIn: false, models: [] }
    const key = 'models:' + account.id
    const cached = this.#cached(key, CATALOG_TTL_MS, options.force === true)
    if (cached !== undefined) return cached
    try {
      const { catalog } = await fetchModelCatalog(account.auth, {
        clientVersion: options.clientVersion ?? '1.0.0',
        signal: options.signal,
        userAgent: this.#userAgent,
      })
      const value = { signedIn: true, ...catalog }
      this.#remember(key, value)
      return value
    } catch (error) {
      // 目录读不到时给出空目录：模型选择器据此不显示任何 Codex 模型，
      // 绝不用内置列表冒充账号可用模型。
      const detail = error instanceof Error ? error.message : String(error)
      this.#logger?.warn?.('codex-plus: model catalog unavailable: ' + detail)
      return { signedIn: true, models: [], fetchedAt: Date.now(), unavailable: true }
    }
  }

  /** 重置卡列表（带缓存）。 */
  async resetCredits(options = {}) {
    const account = await this.currentAccount(options.signal)
    if (account === undefined) return { signedIn: false, credits: [], availableCount: 0 }
    const key = 'resets:' + account.id
    const cached = this.#cached(key, RESET_TTL_MS, options.force === true)
    if (cached !== undefined) return cached
    const value = await fetchResetCredits(account.auth, { signal: options.signal, userAgent: this.#userAgent })
    this.#remember(key, value)
    return value
  }

  /** 使用一张重置卡；成功后清掉额度缓存，让下次读取拿到真实的新窗口。 */
  async consumeReset(creditId, options = {}) {
    const account = await this.currentAccount(options.signal)
    if (account === undefined) throw new CodexPlusError('尚未登录 ChatGPT', 'unauthorized')
    const outcome = await consumeResetCredit(account.auth, creditId, { signal: options.signal, userAgent: this.#userAgent })
    this.#invalidate(account.id, ['usage', 'resets', 'history'])
    return outcome
  }

  /** 切换、移除账号后清缓存。 */
  invalidateAll() {
    this.#cache.clear()
  }

  #cached(key, ttl, force) {
    if (force) return undefined
    const hit = this.#cache.get(key)
    if (hit === undefined) return undefined
    if (Date.now() - hit.at > ttl) {
      this.#cache.delete(key)
      return undefined
    }
    return hit.value
  }

  #remember(key, value) {
    this.#cache.set(key, { at: Date.now(), value })
  }

  #invalidate(accountId, prefixes) {
    for (const key of [...this.#cache.keys()]) {
      if (!key.includes(accountId)) continue
      if (prefixes.some(prefix => key.startsWith(prefix + ':'))) this.#cache.delete(key)
    }
  }
}

/** 一条完整的、可存进仓库的 OAuth 凭据（必须有 refresh）。 */
function isOAuthLike(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof value.access === 'string' &&
    value.access !== '' &&
    typeof value.refresh === 'string' &&
    value.refresh !== '' &&
    typeof value.expires === 'number'
  )
}

/**
 * 刷新响应：access 与 expires 必有，refresh 可选。
 * 按 codex-rs 的 persist_tokens 语义，缺失即表示「未轮换、旧值仍有效」。
 */
function isRefreshResponse(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof value.access === 'string' &&
    value.access !== '' &&
    typeof value.expires === 'number' &&
    Number.isFinite(value.expires)
  )
}
/**
 * 把刷新失败归类成「需要重新登录」与「稍后重试」两类。
 *
 * 依据 codex-rs 的 classify_refresh_token_failure：refresh_token_expired /
 * _reused / _invalidated、invalid_grant、HTTP 401 都是永久失败，重试只会
 * 继续失败并把用户困在错误里；其余（5xx、网络）当作可重试。
 */
function classifyRefreshFailure(error) {
  const text = error instanceof Error ? error.message : String(error)
  if (/refresh_token_(expired|reused|invalidated)|invalid_grant|unauthorized|\b401\b/i.test(text)) {
    return new CodexPlusError('登录已失效，需要重新登录 ChatGPT', 'reauthorization-required', { detail: text })
  }
  return new CodexPlusError('刷新登录状态失败：' + text, 'refresh-failed', { detail: text })
}
__exports["SubscriptionService"] = SubscriptionService
__exports["isOAuthLike"] = isOAuthLike
__exports["isRefreshResponse"] = isRefreshResponse
__exports["classifyRefreshFailure"] = classifyRefreshFailure
});

// ---- provider.ts ----
__define("provider", function (__exports, __m) {
/**
 * 把本插件保存的 ChatGPT 凭据接到 DSH 的 llm-pi-ai 路由上。
 *
 * DSH 的 llm-pi-ai 插件本来就装了 pi-ai 目录里的 openai-codex provider，
 * 只是默认没有任何 route profile（所以休眠）。本插件通过 settings 写入
 * 一条 llm-pi-ai 的 provider 配置，让它用我们的凭据引用解析 access token，
 * 并用目录里的 codex transport 发请求。
 *
 * 这样就不必重复注册同名 provider（重复会让插件加载失败），也能自动
 * 跟着 DSH 上游升级 pi-ai 得到新的模型与协议。
 */
const { decodeClaims } = __m("store")
const PROVIDER_ROUTE = 'openai-codex'

/**
 * 已知会直接注册 openai-codex 适配器的插件包名。
 * 它们存在时，本插件绝不写 llm-pi-ai 的同名路由。
 */
const ROUTE_OWNER_PACKAGES = ['dsh-codex-subscription']
/** 我们在凭据服务里给「当前 access token」用的引用名，llm-pi-ai 按请求解析。 */
const PI_AI_ACCESS_REF = 'CODEX_PLUS_ACCESS_TOKEN'

/**
 * 把当前生效账号的 access token 写进凭据服务，供 llm-pi-ai 逐请求解析。
 * 只写 access（短期、会轮换），refresh 始终留在我们自己的仓库里。
 */
/**
 * 判断 openai-codex 这条路由是否已经被别的插件接管。
 *
 * DSH 对同一个 provider 路由只允许一个适配器；dsh-codex-subscription 这类
 * 插件会直接注册 'openai-codex'。在那种部署里我们只做「额度控制台」，
 * 绝不抢路由——抢了会让插件加载直接失败，把用户整个环境搞坏。
 */
function routeOwnedElsewhere(ctx) {
  // 1) 已经注册到 llm 服务上的路由——最直接的证据。
  try {
    const providers = ctx.get('llm')?.listProviders?.()
    if (Array.isArray(providers) && providers.includes(PROVIDER_ROUTE)) return true
  } catch {
    // 服务尚未就绪：继续用下面更保守的判据。
  }

  // 2) loader 里存在已知会接管这条路由的插件。
  //    这一步是必需的：插件加载顺序不保证，listProviders() 在我们同步配置时
  //    可能还没看到对方注册。若此时我们抢先写入 llm-pi-ai 的 openai-codex
  //    路由，对方的 registerAdapter 会以 DUPLICATE_ADAPTER 失败，可能把
  //    llm-pi-ai 整个插件带崩。所以宁可退化成纯额度控制台。
  try {
    const entries = ctx.get('loader')?.entries?.()
    for (const entry of entries ?? []) {
      const name = entry?.options?.name
      if (typeof name === 'string' && ROUTE_OWNER_PACKAGES.some(owner => name === owner || name.startsWith(owner + '/'))) {
        return true
      }
    }
  } catch {
    // loader 不可用时按「未占用」处理，后面还有最后一道 try/catch 兜底。
  }

  return false
}

async function syncPiAiProfile(ctx, vault) {
  const record = await vault.read()
  const account = record.accounts.find(entry => entry.id === record.activeId) ?? record.accounts[0]

  const settings = ctx.get('settings')
  const credentials = ctx.get('credentials')

  if (account === undefined) {
    // 没有账号：移除 token 引用并把路由配置清空，模型选择器里随之消失。
    await credentials?.unset?.(PI_AI_ACCESS_REF)
    await patchPiAiProfiles(settings, profiles => {
      if (profiles[PROVIDER_ROUTE] === undefined) return undefined
      const next = { ...profiles }
      delete next[PROVIDER_ROUTE]
      return next
    })
    return
  }

  await credentials?.set?.(PI_AI_ACCESS_REF, account.credential.access)

  await patchPiAiProfiles(settings, profiles => ({
    ...profiles,
    [PROVIDER_ROUTE]: {
      // 只声明我们真正要控制的字段；其余（端点、模型目录、协议）
      // 全部交给 pi-ai 已安装的目录默认值，升级时自动跟随。
      displayName: 'ChatGPT 订阅',
      apiKeyEnv: PI_AI_ACCESS_REF,
    },
  }))

  const claims = decodeClaims(account.credential.access)
  ctx.logger?.debug?.(PROVIDER_ROUTE + ' route pointed at ' + (claims.email ?? account.id))
}

/**
 * 读-改-写 llm-pi-ai 的 providers 配置。
 * mutate 返回 undefined 表示「无需变更」，避免每次同步都触发一次配置写入，
 * 那会白白让 DSH 重载路由。
 */
async function patchPiAiProfiles(settings, mutate) {
  if (settings === undefined) return
  const row = findPiAiRow(settings)
  if (row === undefined) {
    // llm-pi-ai 没挂载时静默跳过：额度面板照常工作，只是模型路由不可用。
    return
  }
  const current = readPiAiProviders(row)
  const next = mutate(current)
  if (next === undefined) return
  if (JSON.stringify(next) === JSON.stringify(current)) return
  try {
    await settings.update(row.ns, { providers: next }, row.revision)
  } catch (error) {
    // 写入失败（版本冲突、路由已被占用等）不该让登录本身失败，也不该留下
    // 半截配置：把原因留日志，并把 providers 恢复成写入前的样子。
    console.warn('codex-plus: failed to update llm-pi-ai providers:', error)
    try {
      await settings.update(row.ns, { providers: current }, row.revision + 1)
    } catch {
      // 回滚也失败时保持沉默：配置本来就是用户可见且可手改的。
    }
  }
}

/** settings.describe() 里找到承载 providers 的那一行（即 llm-pi-ai 条目）。 */
function findPiAiRow(settings) {
  let rows
  try {
    rows = settings.describe?.()
  } catch {
    return undefined
  }
  if (!Array.isArray(rows)) return undefined
  for (const row of rows) {
    const value = row?.value
    if (value === null || typeof value !== 'object') continue
    if (value.providers === null || typeof value.providers !== 'object') continue
    return row
  }
  return undefined
}

function readPiAiProviders(row) {
  const providers = row?.value?.providers
  return providers !== null && typeof providers === 'object' && !Array.isArray(providers) ? providers : {}
}
__exports["PI_AI_ACCESS_REF"] = PI_AI_ACCESS_REF
__exports["routeOwnedElsewhere"] = routeOwnedElsewhere
__exports["syncPiAiProfile"] = syncPiAiProfile
});

// ---- login.ts ----
__define("login", function (__exports, __m) {
/**
 * 登录会话桥接器（host 侧）。
 *
 * 参考 dsh-openai-oauth 的做法：设置页里点「登录」，host 侧后台启动 OAuth
 * 流程，把「去哪个地址」「设备码是多少」通过状态回传，用户在浏览器里授权
 * 完成后，凭据落库。
 *
 * 但 pi-ai 的 openaiCodexOAuth.login(interaction) 是「阻塞式」的：它在内部
 * 通过 interaction.notify() 上报 authUrl / device code，通过 interaction.prompt()
 * 向人要输入（选登录方式、粘贴回调地址），然后一直等到回调完成。这里把它
 * 桥接成「登录会话」状态机：
 *   - notify → 写入 session 的 events（客户端据此打开浏览器 / 显示设备码）
 *   - prompt → 挂起，等客户端的 submit 端点把答案交回来再继续
 *   - signal  → 客户端 cancel 时中止
 */
const { CodexPlusError } = __m("api")
/** 登录方式：浏览器回调 / 设备码。 */
const LOGIN_METHODS = new Set(['browser', 'device_code'])

/**
 * 一个进行中的登录会话。
 * 会话暴露给客户端的永远只是「非密」状态：地址、设备码、进行到哪一步、错误。
 */
class LoginBroker {
  #oauth
  #sessions = new Map()
  #seq = 0

  /**
   * @param {() => Promise<{ login: (interaction: any) => Promise<any> }>} oauthProvider
   *        惰性拿到 pi-ai 的 oauth 实现。
   */
  constructor(oauthProvider) {
    this.#oauth = oauthProvider
  }

  /** 开始一次登录，返回会话 id 与初始状态。 */
  async start(method) {
    if (method !== undefined && !LOGIN_METHODS.has(method)) {
      throw new CodexPlusError('不支持的登录方式 ' + method, 'invalid-input')
    }

    const id = 'login-' + (++this.#seq)
    const controller = new AbortController()
    const session = {
      id,
      phase: 'starting',
      method: method ?? 'browser',
      authUrl: undefined,
      verificationUri: undefined,
      userCode: undefined,
      error: undefined,
      done: false,
      pendingPrompt: undefined,
      controller,
    }
    this.#sessions.set(id, session)

    // 后台启动登录，不阻塞这个请求。会话状态由下面的 notify/prompt 更新。
    void this.#run(session)
    return snapshot(session)
  }

  /** 当前会话状态（非密）。 */
  status(id) {
    const session = this.#sessions.get(id)
    if (session === undefined) throw new CodexPlusError('找不到登录会话 ' + id, 'not-found')
    return snapshot(session)
  }

  /** 客户端向会话里挂起的 prompt 提交答案（例如粘贴设备码回调地址）。 */
  submit(id, answer) {
    const session = this.#sessions.get(id)
    if (session === undefined) throw new CodexPlusError('找不到登录会话 ' + id, 'not-found')
    const pending = session.pendingPrompt
    if (pending === undefined) throw new CodexPlusError('当前没有等待输入的步骤', 'invalid-state')
    session.pendingPrompt = undefined
    pending.resolve(answer)
    return snapshot(session)
  }

  /**
   * 取走登录结果（一次性）：成功时返回凭据并清空，失败时返回 undefined。
   * 调用方在拿到凭据后负责落库；这里只负责把内存里的会话标记为「已消费」。
   */
  result(id) {
    const session = this.#sessions.get(id)
    if (session === undefined) throw new CodexPlusError('找不到登录会话 ' + id, 'not-found')
    if (session.phase !== 'done') return undefined
    const credential = session.credential
    session.credential = undefined
    session.consumed = true
    return credential
  }

  /** 中止会话。 */
  cancel(id) {
    const session = this.#sessions.get(id)
    if (session === undefined) throw new CodexPlusError('找不到登录会话 ' + id, 'not-found')
    session.controller.abort()
    return snapshot(session)
  }

  /** 清掉已结束的会话，避免无限累积。 */
  prune() {
    for (const [id, session] of this.#sessions) {
      if (session.done && Date.now() - session.finishedAt > 5 * 60_000) this.#sessions.delete(id)
    }
  }

  async #run(session) {
    try {
      const oauth = await this.#oauth()
      const interaction = this.#interaction(session)

      // pi-ai 会先 prompt 让用户选登录方式；如果我们已经指定了，就跳过选择。
      const credential = await oauth.login(interaction, { method: session.method })

      // 登录成功：把凭据留在会话里，由调用方（index.ts）决定何时落库。
      session.credential = credential
      session.phase = 'done'
      session.done = true
      session.finishedAt = Date.now()
    } catch (error) {
      if (session.controller.signal.aborted) {
        session.phase = 'cancelled'
      } else {
        session.phase = 'error'
        session.error = error instanceof Error ? error.message : String(error)
      }
      session.done = true
      session.finishedAt = Date.now()
    }
  }

  /**
   * 构造 pi-ai 期望的 interaction 对象。
   * notify → 更新会话状态；prompt → 挂起等待 submit；signal → 会话的取消信号。
   */
  #interaction(session) {
    return {
      signal: session.controller.signal,

      notify: event => {
        if (event === null || typeof event !== 'object') return
        if (event.type === 'auth_url' && typeof event.url === 'string') {
          session.phase = 'waiting_browser'
          session.authUrl = event.url
          if (typeof event.instructions === 'string') session.instructions = event.instructions
          return
        }
        if (event.type === 'device_code') {
          session.phase = 'waiting_device'
          session.verificationUri = typeof event.verificationUri === 'string' ? event.verificationUri : undefined
          session.userCode = typeof event.userCode === 'string' ? event.userCode : undefined
          return
        }
      },

      prompt: request => {
        // pi-ai 的 login() 会先 prompt({type:'select'}) 让用户选登录方式。
        // 我们已经在 start(method) 里定好了方式，所以这里直接自动作答，
        // 不让用户再做一次无意义的选择。
        if (request?.type === 'select' && session.method !== undefined) {
          return Promise.resolve(session.method)
        }

        // 其余 prompt（例如浏览器回调失败后让用户粘贴回调地址）挂起，
        // 等客户端的 submit 端点把答案交回来。
        return new Promise((resolve, reject) => {
          if (session.controller.signal.aborted) {
            reject(new Error('登录已取消'))
            return
          }
          const onAbort = () => reject(new Error('登录已取消'))
          session.controller.signal.addEventListener('abort', onAbort, { once: true })

          session.pendingPrompt = {
            kind: request?.type === 'select' ? 'select' : 'text',
            message: typeof request?.message === 'string' ? request.message : '请完成登录',
            options: Array.isArray(request?.options)
              ? request.options.map(option => ({ id: option?.id, label: option?.label }))
              : undefined,
            resolve: value => {
              session.controller.signal.removeEventListener('abort', onAbort)
              resolve(value)
            },
          }
        })
      },
    }
  }
}

/** 会话的可暴露快照：不含任何密钥或内部对象。 */
function snapshot(session) {
  return {
    id: session.id,
    phase: session.phase,
    method: session.method,
    authUrl: session.authUrl,
    verificationUri: session.verificationUri,
    userCode: session.userCode,
    instructions: session.instructions,
    done: session.done,
    error: session.error,
    prompt: session.pendingPrompt === undefined
      ? undefined
      : {
          kind: session.pendingPrompt.kind,
          message: session.pendingPrompt.message,
          options: session.pendingPrompt.options,
        },
  }
}
__exports["LOGIN_METHODS"] = LOGIN_METHODS
__exports["LoginBroker"] = LoginBroker
});

// ---- index.ts ----
__define("index", function (__exports, __m) {
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
const { CodexPlusError } = __m("api")
const { AccountVault, decodeClaims, newAccountId } = __m("store")
const { SubscriptionService } = __m("service")
const { syncPiAiProfile } = __m("provider")
const { LoginBroker } = __m("login")
const name = 'codex-plus'
const inject = ['credentials']

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
/** RPC 路由前缀：完整路径是 /api/codex-plus/<endpoint>。 */
const CHANNEL = '/api/codex-plus'

/**
 * 所有端点。host 为每个端点注册一条精确路由，
 * 客户端则用 rpc.call('/api', 'codex-plus/<endpoint>') 调用。
 */
const RPC_ENDPOINTS = [
  'status',
  'usage',
  'usage/refresh',
  'usage/history',
  'models',
  'reset-credits',
  'reset-credits/consume',
  'accounts/select',
  'accounts/remove',
  'logout',
  'login/start',
  'login/status',
  'login/submit',
  'login/cancel',
  'diagnostics',
]

const USER_AGENT = 'dsh-codex-plus/0.1.0'

function apply(ctx) {
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

    // DSH 的 /api 桥按「精确路径」分发，而客户端用 rpc.call('/api', '<ns>/<endpoint>')
    // 会请求 /api/<ns>/<endpoint>。所以每个端点注册一条精确路由，
    // 而不是给 /api/<ns> 挂一个前缀路由。
    for (const endpoint of RPC_ENDPOINTS) {
      const dispose = connection.fetch.register({
        path: CHANNEL + '/' + endpoint,
        methods: ['POST'],
        requestBody: 'buffered',
        async fetch(request) {
          return handleRpcRequest(request, endpoint, handler)
        },
      })
      ctx.effect(() => dispose, 'codex-plus: rpc ' + endpoint)
    }
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
async function handleRpcRequest(request, endpoint, handler) {
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

  // 路由已经确定了端点；信封里的 method 必须与之一致，否则是客户端拼错了路径。
  if (envelope.method !== endpoint) {
    return Response.json({ type: 'server-response', rpcId, result: { ok: false, error: { code: 'bad-request', message: 'method does not match endpoint', details: {} } } })
  }

  try {
    const value = await handler(endpoint, envelope.payload, request.signal)
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

__exports["name"] = name
__exports["inject"] = inject
__exports["apply"] = apply
});

var __entry = __m("index")
export default __entry
export var name = __entry["name"]
export var inject = __entry["inject"]
export var apply = __entry["apply"]
