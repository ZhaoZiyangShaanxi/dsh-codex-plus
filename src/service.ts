/**
 * 订阅数据服务（host 侧）：把 api.ts 的读取能力包成一份带缓存的快照，
 * 并负责 token 刷新与「当前账号」的解析。
 *
 * 缓存的意义在于：额度面板会在会话里频繁重挂载，而 /wham/usage 这类
 * 接口不该被每次挂载打一次。窗口数据 30 秒内复用，重置卡 5 分钟。
 */
import { CodexPlusError, consumeResetCredit, fetchModelCatalog, fetchPlanHistory, fetchProfile, fetchResetCredits, fetchUsage } from './api.ts'
import { activeAccount, decodeClaims, isExpired } from './store.ts'

const USAGE_TTL_MS = 30_000
const CATALOG_TTL_MS = 10 * 60_000
const RESET_TTL_MS = 5 * 60_000

export class SubscriptionService {
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
export function isOAuthLike(value) {
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
export function isRefreshResponse(value) {
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
export function classifyRefreshFailure(error) {
  const text = error instanceof Error ? error.message : String(error)
  if (/refresh_token_(expired|reused|invalidated)|invalid_grant|unauthorized|\b401\b/i.test(text)) {
    return new CodexPlusError('登录已失效，需要重新登录 ChatGPT', 'reauthorization-required', { detail: text })
  }
  return new CodexPlusError('刷新登录状态失败：' + text, 'refresh-failed', { detail: text })
}