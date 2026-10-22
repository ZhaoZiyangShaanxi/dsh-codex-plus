
/**
 * 登录会话桥接测试：验证 LoginBroker 把 pi-ai 的阻塞式 login 桥接成
 * 「开始 → 状态轮询 → 提交 → 完成」的状态机，不碰网络。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { LoginBroker } from '../lib/login.js'

/** 轮询直到断言满足或超时。 */
async function until(check, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs
  let value
  while (Date.now() < deadline) {
    value = check()
    if (value !== undefined && value !== false) return value
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  return value
}


/** 造一个假的 pi-ai oauth：login 会先 notify(auth_url) 再 resolve 凭据。 */
function fakeOauth(flow) {
  return {
    login: async interaction => flow(interaction),
  }
}

test('登录：浏览器流 —— start 后 authUrl 可用，完成时能取到凭据', async () => {
  const broker = new LoginBroker(async () =>
    fakeOauth(async interaction => {
      interaction.notify({ type: 'auth_url', url: 'https://auth.openai.com/authorize?x=1' })
      // 模拟用户授权完成。
      return { type: 'oauth', access: 'access-token', refresh: 'refresh-token', expires: Date.now() + 3600_000 }
    }),
  )

  const started = await broker.start('browser')
  // start() 立即返回会话 id，阶段由后台流程推进，客户端靠轮询观察。
  const waiting = await until(() => {
    const s = broker.status(started.id)
    return s.phase === 'waiting_browser' ? s : false
  })
  assert.ok(waiting.authUrl.startsWith('https://auth.openai.com/authorize'))

  const status = await until(() => {
    const s = broker.status(started.id)
    return s.done ? s : false
  })
  assert.equal(status.phase, 'done')
  assert.equal(status.error, undefined)

  const credential = broker.result(started.id)
  assert.equal(credential.access, 'access-token')
  assert.equal(credential.refresh, 'refresh-token')
})

test('登录：设备码流 —— notify 携带 verificationUri 与 userCode', async () => {
  const broker = new LoginBroker(async () =>
    fakeOauth(async interaction => {
      interaction.notify({ type: 'device_code', verificationUri: 'https://auth.openai.com/codex/device', userCode: 'ABCD-EFGH' })
      return { type: 'oauth', access: 'a', refresh: 'r', expires: Date.now() + 3600_000 }
    }),
  )

  const started = await broker.start('device_code')
  const state = await until(() => {
    const s = broker.status(started.id)
    return s.phase === 'waiting_device' ? s : false
  })
  assert.equal(state.verificationUri, 'https://auth.openai.com/codex/device')
  assert.equal(state.userCode, 'ABCD-EFGH')
})

test('登录：select prompt 自动按指定方式作答，不挂起', async () => {
  let asked
  const broker = new LoginBroker(async () =>
    fakeOauth(async interaction => {
      // pi-ai 会先 prompt select；我们已指定 device_code，应自动返回 device_code。
      asked = await interaction.prompt({
        type: 'select',
        message: '选择登录方式',
        options: [{ id: 'browser', label: '浏览器' }, { id: 'device_code', label: '设备码' }],
      })
      interaction.notify({ type: 'device_code', verificationUri: 'u', userCode: 'c' })
      return { type: 'oauth', access: 'a', refresh: 'r', expires: Date.now() + 3600_000 }
    }),
  )

  await broker.start('device_code')
  await until(() => asked !== undefined)
  assert.equal(asked, 'device_code', 'select prompt 应按指定方式自动作答')
})

test('登录：text prompt 挂起，submit 后继续', async () => {
  const broker = new LoginBroker(async () =>
    fakeOauth(async interaction => {
      interaction.notify({ type: 'auth_url', url: 'https://auth.openai.com/authorize' })
      // 模拟浏览器回调失败，pi-ai 让用户粘贴回调地址。
      const answer = await interaction.prompt({ type: 'text', message: '请粘贴回调地址' })
      return { type: 'oauth', access: 'a', refresh: 'r', expires: Date.now() + 3600_000, pasted: answer }
    }),
  )

  const started = await broker.start('browser')

  // 等到出现挂起的 text prompt。
  let state
  for (let i = 0; i < 50; i++) {
    await new Promise(resolve => setTimeout(resolve, 5))
    state = broker.status(started.id)
    if (state.prompt !== undefined) break
  }
  assert.equal(state.prompt.kind, 'text')

  await broker.submit(started.id, 'https://127.0.0.1:1455/auth/callback?code=xyz')

  let done
  for (let i = 0; i < 50; i++) {
    await new Promise(resolve => setTimeout(resolve, 5))
    done = broker.status(started.id)
    if (done.done) break
  }
  assert.equal(done.phase, 'done')
  assert.equal(done.error, undefined)
})

test('登录：cancel 中止会话', async () => {
  const broker = new LoginBroker(async () =>
    fakeOauth(async interaction => {
      interaction.notify({ type: 'auth_url', url: 'https://auth.openai.com/authorize' })
      // 永远不完成，等待取消信号。
      await new Promise(resolve => interaction.signal.addEventListener('abort', resolve, { once: true }))
      throw new Error('unreachable')
    }),
  )

  const started = await broker.start('browser')
  await broker.cancel(started.id)

  await new Promise(resolve => setTimeout(resolve, 10))
  const state = broker.status(started.id)
  assert.equal(state.phase, 'cancelled')
  assert.equal(state.done, true)
})