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

export const BACKEND_BASE = 'https://chatgpt.com/backend-api'

/** 订阅接口失败分类。code 供 UI 分流，message 供人读。 */
export class CodexPlusError extends Error {
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
export async function fetchUsage(auth, options) {
  const { body } = await call(auth, '/wham/usage', { signal: options.signal, timeoutMs: options.timeoutMs, userAgent: options.userAgent })
  return normalizeUsage(body)
}

/**
 * 把服务端额度负载归一为稳定结构。
 * 与账号实际返回不同步的字段一律留 undefined。
 */
export function normalizeUsage(raw) {
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
export async function fetchPlanHistory(auth, options) {
  const days = options.days ?? 7
  try {
    const { body } = await call(auth, '/wham/usage/plan_limit_history', { query: { days }, signal: options.signal, userAgent: options.userAgent })
    return normalizeHistory(body, days)
  } catch (error) {
    if (error instanceof CodexPlusError && (error.code === 'http-error' || error.code === 'unauthorized')) return undefined
    throw error
  }
}

export function normalizeHistory(raw, days) {
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
export async function fetchProfile(auth, options) {
  try {
    const { body } = await call(auth, '/wham/profiles/me', { signal: options.signal, userAgent: options.userAgent })
    return normalizeProfile(body)
  } catch {
    return undefined
  }
}

export function normalizeProfile(raw) {
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
export async function fetchModelCatalog(auth, options) {
  const { body, etag } = await call(auth, '/codex/models', { query: { client_version: options.clientVersion }, signal: options.signal, userAgent: options.userAgent })
  return { catalog: normalizeCatalog(body), etag }
}

export function normalizeCatalog(raw) {
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
export async function fetchResetCredits(auth, options) {
  const { body } = await call(auth, '/wham/rate-limit-reset-credits', { signal: options.signal, userAgent: options.userAgent })
  return normalizeResetCredits(body)
}

export function normalizeResetCredits(raw) {
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
export async function consumeResetCredit(auth, creditId, options) {
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
export function redeemRequestId(creditId) {
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