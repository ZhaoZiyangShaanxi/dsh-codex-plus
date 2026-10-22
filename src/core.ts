/**
 * 纯逻辑导出面：只给测试与诊断用，不含任何 DSH 服务依赖。
 * lib/core.js 由构建脚本单独产出，插件运行时不加载它。
 *
 * 这里刻意只导出「不碰网络、不碰 DSH 服务」的部分：额度归一、目录归一、
 * 幂等键、JWT 解析、凭据形状校验。凭据仓库依赖 DSH 的 credentials 服务，
 * 由独立的 lib/store.js 形态在运行时提供，不进这个测试面。
 */
export {
  CodexPlusError,
  normalizeUsage,
  normalizeResetCredits,
  normalizeCatalog,
  normalizeHistory,
  normalizeProfile,
  redeemRequestId,
} from './api.ts'

export {
  decodeClaims,
  decodeJwtPayload,
  isExpired,
  isOAuthCredential,
  newAccountId,
  normalizeVault,
} from './store.ts'
