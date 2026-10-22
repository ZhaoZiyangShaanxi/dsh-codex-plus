/**
 * 纯逻辑单测：不碰网络、不碰 DSH 运行时。
 * 覆盖额度归一、重置卡幂等键、凭据仓库并发语义这三处最容易出错的地方。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeUsage, normalizeResetCredits, normalizeCatalog, redeemRequestId, CodexPlusError } from '../lib/core.js'

test('额度归一：读服务端真实窗口，不编造缺失字段', () => {
  const usage = normalizeUsage({
    plan_type: 'plus',
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: { used_percent: 96, limit_window_seconds: 18000, reset_at: 1730947200 },
      secondary_window: { used_percent: 70, limit_window_seconds: 604800, reset_after_seconds: 43200 },
    },
    credits: { has_credits: false, unlimited: true, balance: null },
  })

  assert.equal(usage.planType, 'plus')
  assert.equal(usage.windows.length, 2)

  const [primary, secondary] = usage.windows
  assert.equal(primary.kind, 'primary')
  assert.equal(primary.usedPercent, 96)
  assert.equal(primary.remainingPercent, 4)
  assert.equal(primary.windowSeconds, 18000)
  assert.equal(primary.resetsAt, 1730947200 * 1000)

  // 只给 reset_after_seconds 的窗口也要换算成绝对时间。
  assert.equal(secondary.kind, 'secondary')
  assert.ok(secondary.resetsAt > Date.now())

  assert.deepEqual(usage.credits, { hasCredits: false, unlimited: true, balance: undefined })
  assert.equal(usage.limitReached, false)
})

test('额度归一：空负载不抛错，也不产出假窗口', () => {
  const usage = normalizeUsage({})
  assert.deepEqual(usage.windows, [])
  assert.equal(usage.credits, undefined)
  assert.equal(usage.planType, undefined)
})

test('额度归一：越界百分比被夹到 0..100', () => {
  const usage = normalizeUsage({ rate_limit: { primary_window: { used_percent: 140 } } })
  assert.equal(usage.windows[0].usedPercent, 100)
  assert.equal(usage.windows[0].remainingPercent, 0)
})

test('额度归一：额外额度分组保留自己的名字', () => {
  const usage = normalizeUsage({
    rate_limit: { primary_window: { used_percent: 10 } },
    additional_rate_limits: [{ limit_name: 'codex_other', metered_feature: 'other', rate_limit: { primary_window: { used_percent: 55 } } }],
  })
  assert.equal(usage.windows.length, 2)
  const extra = usage.windows.find(window => window.group !== undefined)
  assert.equal(extra.group, 'codex_other')
  assert.equal(extra.usedPercent, 55)
  assert.equal(extra.feature, 'other')
})

test('重置卡：状态与可用数量来自服务端', () => {
  const credits = normalizeResetCredits({
    available_count: 1,
    credits: [
      { id: 'c1', status: 'available', reset_type: 'weekly', title: '每周重置' },
      { id: 'c2', status: 'redeemed', redeemed_at: '2026-01-01T00:00:00Z' },
    ],
  })
  assert.equal(credits.availableCount, 1)
  assert.equal(credits.credits.length, 2)
  assert.equal(credits.credits[0].title, '每周重置')
  assert.equal(credits.credits[1].pending, false)
})

test('重置卡：幂等键对同一 credit 稳定，对不同 credit 不同', () => {
  const a1 = redeemRequestId('credit-alpha')
  const a2 = redeemRequestId('credit-alpha')
  const b = redeemRequestId('credit-beta')
  assert.equal(a1, a2)
  assert.notEqual(a1, b)
  // 形状要是 UUID：retry 时服务端按字符串比对，形状不对会被拒。
  assert.match(a1, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
})

test('模型目录：只认服务端返回的模型，缺失字段保持 undefined', () => {
  const catalog = normalizeCatalog({
    models: [
      { id: 'gpt-5.5', name: 'GPT-5.5', context_window: 272000, reasoning_efforts: ['low', 'high'], supports_vision: true },
      { slug: 'gpt-5.3-codex-spark' },
      { name: '没有 id 的条目' },
    ],
  })
  assert.equal(catalog.models.length, 2)
  assert.equal(catalog.models[0].id, 'gpt-5.5')
  assert.equal(catalog.models[0].contextWindow, 272000)
  assert.deepEqual(catalog.models[0].reasoningEfforts, ['low', 'high'])
  assert.equal(catalog.models[0].vision, true)
  assert.equal(catalog.models[1].id, 'gpt-5.3-codex-spark')
  assert.equal(catalog.models[1].contextWindow, undefined)
})

test('错误分类：401 归为 unauthorized，429 带出套餐与恢复时间', () => {
  const unauthorized = new CodexPlusError('登录已失效', 'unauthorized')
  assert.equal(unauthorized.code, 'unauthorized')
  const limited = new CodexPlusError('额度已用尽（plus 套餐），约 12 分钟后恢复', 'rate-limited')
  assert.equal(limited.code, 'rate-limited')
  assert.match(limited.message, /plus/)
})