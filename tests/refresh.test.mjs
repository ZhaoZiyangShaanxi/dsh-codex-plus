/**
 * 刷新语义测试：这里出错会让用户被强制登出，必须有覆盖。
 *
 * 覆盖三件事：
 *   1) 轮换后服务端没返回新 refresh token 时，旧的要保留；
 *   2) 并发刷新只发一次（单飞），否则服务端判定 reused；
 *   3) 永久性失败被归类成「需要重新登录」，而不是无脑重试。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { SubscriptionService, classifyRefreshFailure } from '../lib/service.js'

/** 一个内存仓库，接口形状对齐 store.ts 的 AccountVault。 */
function fakeVault(accounts) {
  const state = { version: 1, ...(accounts[0] === undefined ? {} : { activeId: accounts[0].id }), accounts }
  return {
    state,
    read: async () => JSON.parse(JSON.stringify(state)),
    transact: async mutate => {
      const { record, result } = await mutate(JSON.parse(JSON.stringify(state)))
      state.version = record.version
      state.activeId = record.activeId
      state.accounts = record.accounts
      return result
    },
  }
}

/** 构造一个已经过期的凭据，逼服务层走刷新路径。 */
function expiredCredential(overrides = {}) {
  return {
    type: 'oauth',
    access: 'access-old',
    refresh: 'refresh-old',
    expires: Date.now() - 60_000,
    email: 'user@example.com',
    accountId: 'acct_123',
    ...overrides,
  }
}

test('刷新：服务端没返回新 refresh token 时保留旧的', async () => {
  const vault = fakeVault([{ id: 'a1', label: 'A', credential: expiredCredential() }])
  let calls = 0
  const service = new SubscriptionService({
    vault,
    userAgent: 'test',
    refresh: async () => {
      calls++
      // 只换 access；refresh 缺省，表示服务端没有轮换。
      return { type: 'oauth', access: 'access-new', expires: Date.now() + 3600_000 }
    },
  })

  const account = await service.currentAccount()
  assert.equal(calls, 1)
  assert.equal(account.credential.access, 'access-new')
  assert.equal(account.credential.refresh, 'refresh-old', '没有新 refresh 时必须保留旧值')
  assert.equal(vault.state.accounts[0].credential.refresh, 'refresh-old')
})

test('刷新：服务端返回新 refresh token 时替换旧的', async () => {
  const vault = fakeVault([{ id: 'a1', label: 'A', credential: expiredCredential() }])
  const service = new SubscriptionService({
    vault,
    userAgent: 'test',
    refresh: async () => ({
      type: 'oauth',
      access: 'access-new',
      refresh: 'refresh-rotated',
      expires: Date.now() + 3600_000,
    }),
  })

  await service.currentAccount()
  assert.equal(vault.state.accounts[0].credential.refresh, 'refresh-rotated')
})

test('刷新：并发调用只触发一次真实刷新（单飞）', async () => {
  const vault = fakeVault([{ id: 'a1', label: 'A', credential: expiredCredential() }])
  let calls = 0
  let release
  const gate = new Promise(resolve => {
    release = resolve
  })
  const service = new SubscriptionService({
    vault,
    userAgent: 'test',
    refresh: async () => {
      calls++
      await gate
      return { type: 'oauth', access: 'access-new', refresh: 'refresh-rotated', expires: Date.now() + 3600_000 }
    },
  })

  const first = service.currentAccount()
  const second = service.currentAccount()
  const third = service.currentAccount()
  release()
  await Promise.all([first, second, third])

  assert.equal(calls, 1, '并发刷新必须合并成一次，否则服务端会判定 refresh_token_reused')
})

test('刷新失败：永久性错误归类为需要重新登录', () => {
  const permanent = classifyRefreshFailure(new Error('refresh failed (400): refresh_token_reused'))
  assert.equal(permanent.code, 'reauthorization-required')

  const expired = classifyRefreshFailure(new Error('token refresh failed (401): unauthorized'))
  assert.equal(expired.code, 'reauthorization-required')

  const transient = classifyRefreshFailure(new Error('fetch failed: ECONNRESET'))
  assert.equal(transient.code, 'refresh-failed')
})

test('额度：没登录时返回 signedIn:false 且不打网络', async () => {
  const vault = fakeVault([])
  let called = false
  const service = new SubscriptionService({
    vault,
    userAgent: 'test',
    refresh: async () => {
      called = true
      throw new Error('不该被调用')
    },
  })
  const usage = await service.usage()
  assert.equal(usage.signedIn, false)
  assert.equal(called, false)
})