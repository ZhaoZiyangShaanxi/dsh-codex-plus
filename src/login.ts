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

import { CodexPlusError } from './api.ts'

/** 登录方式：浏览器回调 / 设备码。 */
export const LOGIN_METHODS = new Set(['browser', 'device_code'])

/**
 * 一个进行中的登录会话。
 * 会话暴露给客户端的永远只是「非密」状态：地址、设备码、进行到哪一步、错误。
 */
export class LoginBroker {
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