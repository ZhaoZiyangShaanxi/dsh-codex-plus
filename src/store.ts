/**
 * 账号与凭据的存取层（host 侧）。
 *
 * 凭据只落在 DSH 的 credentials 服务里，绝不写进插件配置或日志。
 * 多处会并发刷新同一个账号的 token，所以所有读-改-写都串行化，
 * 否则一次慢刷新会用旧 token 覆盖掉轮换后的新 token。
 */

/** 订阅帐号在 DSH 凭据服务中的记录键。 */
export const CREDENTIAL_SCOPE = 'codex-plus'
export const VAULT_ID = 'accounts'

/** 单条 OAuth 凭据的形状。refresh 只在 host 内部使用。 */
/** @typedef {{ type: 'oauth', access: string, refresh: string, expires: number, email?: string, accountId?: string, label?: string }} OAuthCredential */

/** token 被认为过期的提前量：留足一次请求的余量，避免边界上失败。 */
export const EXPIRY_SKEW_MS = 60_000

export function isOAuthCredential(value) {
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
export function decodeClaims(accessToken) {
  const payload = decodeJwtPayload(accessToken)
  const auth = payload?.['https://api.openai.com/auth']
  const accountId = typeof auth?.chatgpt_account_id === 'string' && auth.chatgpt_account_id !== '' ? auth.chatgpt_account_id : undefined
  const profile = payload?.['https://api.openai.com/profile']
  const email = typeof profile?.email === 'string' && profile.email !== '' ? profile.email : typeof payload?.email === 'string' ? payload.email : undefined
  return { accountId, email }
}

export function decodeJwtPayload(token) {
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

export function isExpired(credential, now = Date.now()) {
  return credential.expires - EXPIRY_SKEW_MS <= now
}

/**
 * 账号仓库。一个 DSH 凭据记录存全部账号，避免 N 个账号 N 条记录不一致。
 */
export class AccountVault {
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

export function emptyVault() {
  return { version: 1, accounts: [] }
}

export function normalizeVault(payload) {
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
export function activeAccount(record) {
  if (record.accounts.length === 0) return undefined
  return record.accounts.find(account => account.id === record.activeId) ?? record.accounts[0]
}

/** 生成一个不会与既有账号冲突的 stable id。 */
export function newAccountId(existing) {
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
export function publicAccount(account, activeId) {
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
