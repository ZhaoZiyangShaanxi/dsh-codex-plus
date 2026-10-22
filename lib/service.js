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

var __entry = __m("service")
export default __entry
export var SubscriptionService = __entry["SubscriptionService"]
export var isOAuthLike = __entry["isOAuthLike"]
export var isRefreshResponse = __entry["isRefreshResponse"]
export var classifyRefreshFailure = __entry["classifyRefreshFailure"]
