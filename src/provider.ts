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
import { decodeClaims } from './store.ts'

const PROVIDER_ROUTE = 'openai-codex'

/**
 * 已知会直接注册 openai-codex 适配器的插件包名。
 * 它们存在时，本插件绝不写 llm-pi-ai 的同名路由。
 */
const ROUTE_OWNER_PACKAGES = ['dsh-codex-subscription']
/** 我们在凭据服务里给「当前 access token」用的引用名，llm-pi-ai 按请求解析。 */
export const PI_AI_ACCESS_REF = 'CODEX_PLUS_ACCESS_TOKEN'

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
export function routeOwnedElsewhere(ctx) {
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

export async function syncPiAiProfile(ctx, vault) {
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