<div align="center">

# dsh-codex-plus

**ChatGPT / Codex 订阅的额度、账号与用量控制台 — 给 DeepSeek Harness**

[![npm](https://img.shields.io/npm/v/dsh-codex-plus?logo=npm&label=npm)](https://www.npmjs.com/package/dsh-codex-plus)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![dsh](https://img.shields.io/badge/dsh-%3E%3D0.2.0--rc.2-4f7cff)](https://github.com/deepseek-ai/deepseek-harness)

[中文](#中文) · [English](#english)

</div>

---

## 中文

在 DSH 里用 ChatGPT 订阅登录，然后**随时看清额度还剩多少、什么时候重置、有没有可用的重置卡**。

DSH 本身已经内置了 Codex 的模型路由（`llm-pi-ai` + pi-ai 的 `openai-codex`），但**没有任何地方能看额度**。这个插件补上那一块，并且不重复造路由。

### 功能

| 能力 | 说明 |
|---|---|
| **真实额度** | 读账号后端 `/wham/usage`：短周期（5h）、每周、独立额度分组、代码审查额度，含已用 %、剩余 %、重置时间、套餐类型 |
| **重置卡** | 列出并使用额度重置卡；幂等键由 credit id 稳定派生，重试只结算一次 |
| **一键登录** | 设置页内直接登录：浏览器授权或设备码，自动打开授权页并轮询结果；回调被拦截时可粘贴地址 |
| **多账号** | 添加、切换、移除多个 ChatGPT 账号，凭据只存在 DSH 凭据服务 |
| **模型目录** | 读账号真实可用模型（`/codex/models`），带上下文窗口与退役标记；拿不到就显示为空，绝不用内置列表冒充 |
| **常驻指示** | 输入框右侧的剩余额度徽标，低于阈值自动变色，点开看明细 |
| **中英双语** | 跟随 DSH 界面语言 |

### 安装

```sh
# 先完全退出 DeepSeek Harness（含托盘）
dsh plugin --profile desktop add dsh-codex-plus
# 重新打开 DSH
```

打开 **设置 → Codex 订阅**，点「登录 ChatGPT」即可。

### 设计边界（刻意的）

- **不抢 provider 路由。** 模型调用交给 DSH 自带的 `llm-pi-ai` 适配器。若这条路由已被别的插件（例如 `dsh-codex-subscription`）接管，本插件自动退化为**纯额度控制台**，绝不注册第二条适配器——抢路由会让 DSH 拒绝加载其中一个插件。
- **不自造 OAuth。** 登录复用 pi-ai 已验证过的流程，凭据存进 DSH 凭据服务。
- **不静默降级。** 所有失败如实呈现：未登录、登录失效、额度用尽、网络错误分开处理。
- **不泄漏密钥。** access token 只在 host 内存与凭据服务；refresh token 只存在凭据仓库。

### 刷新 token 的三条铁律

照 `codex-rs` 源码语义实现，`tests/refresh.test.mjs` 覆盖：

1. **单飞** —— 同一账号同一时刻只允许一次刷新。两个并发刷新用同一个 refresh token 会让服务端判定 `refresh_token_reused`，直接强制登出。
2. **合并而非覆盖** —— 刷新响应里的 refresh token 是**可选**的。服务端没返回就说明旧的仍有效，必须保留。
3. **不自动重放** —— 刷新响应一旦丢失，旧 token 可能已被消费。永久性失败归类为「需要重新登录」，交由人处理。

### 开发

```sh
node scripts/build.mjs   # 产出 lib/index.js（host ESM）+ lib/client.js（浏览器 bundle）
node scripts/test.mjs    # 27 项测试，不联网、不依赖 DSH 运行时
```

构建脚本零外部依赖：源码只使用可当 JS 直接运行的 ESM（类型在 JSDoc 里），构建做的是「模块表解析 + 拼接」，不引入打包器。

| 路径 | 职责 |
|---|---|
| `src/api.ts` | 账号后端客户端：额度、目录、用量报告、重置卡；纯归一化函数 |
| `src/store.ts` | 凭据仓库：JWT 解析、多账号记录、并发安全读-改-写 |
| `src/service.ts` | 服务层：缓存、单飞刷新、轮换合并、失败分类 |
| `src/login.ts` | 登录会话：把 pi-ai 的阻塞式 login 桥接成状态机 |
| `src/provider.ts` | 把凭据接到 `llm-pi-ai` 的 Codex 路由；含路由占用检测 |
| `src/index.ts` | 插件入口：授权流 + `/api/codex-plus` RPC 通道 |
| `src/client/index.ts` | 浏览器侧：设置页、登录卡片、输入框额度徽标、中英字典 |

### 许可

MIT

---

## English

Sign in with your ChatGPT subscription inside DSH, then **see exactly how much quota is left, when it resets, and whether you have reset cards**.

DSH already ships the Codex model route (`llm-pi-ai` + pi-ai's `openai-codex`), but **nothing surfaces the quota**. This plugin fills that gap without duplicating the route.

### Features

| Capability | Detail |
|---|---|
| **Real quota** | Reads `/wham/usage`: short window (5h), weekly, extra limit groups, code-review limit — with used %, remaining %, reset time, plan type |
| **Reset cards** | Lists and redeems reset credits; the idempotency key derives stably from the credit id, so a retry settles once |
| **One-click sign-in** | Sign in from Settings: browser or device code, auto-opens the auth page and polls; paste the callback URL if it was blocked |
| **Multi-account** | Add, switch, remove ChatGPT accounts; credentials live only in DSH's credential service |
| **Model catalog** | Reads the account's real models (`/codex/models`) with context window and retirement flags; empty when unavailable, never a built-in guess |
| **Composer badge** | Remaining-quota chip beside the input, colour-coded when low, click for detail |
| **Bilingual** | Follows the DSH UI language |

### Install

```sh
# Quit DeepSeek Harness completely (tray included) first
dsh plugin --profile desktop add dsh-codex-plus
# Reopen DSH
```

Open **Settings → Codex Subscription** and click "Sign in with ChatGPT".

### Deliberate boundaries

- **Never claims a provider route.** Model calls go through DSH's own `llm-pi-ai` adapter. If another plugin (e.g. `dsh-codex-subscription`) already owns that route, this plugin degrades to a **pure quota console** instead of registering a second adapter — two adapters on one route make DSH refuse to load one of them.
- **No hand-rolled OAuth.** Sign-in reuses pi-ai's proven flow; credentials are stored in DSH's credential service.
- **No silent fallback.** Every failure is surfaced: not signed in, expired session, quota exhausted, network error.
- **No secret leakage.** The access token stays in host memory and the credential service; the refresh token lives only in the credential vault.

### The three refresh rules

Implemented against `codex-rs` semantics, covered by `tests/refresh.test.mjs`:

1. **Single-flight** — one refresh per account at a time. Two concurrent refreshes with the same refresh token make the server report `refresh_token_reused` and force a logout.
2. **Merge, never overwrite** — the refresh response's refresh token is **optional**. Absent means the old one is still valid and must be kept.
3. **Never replay** — once a refresh response is lost the old token may already be consumed. Permanent failures are classified as "re-authenticate required" and handed to the human.

### Development

```sh
node scripts/build.mjs   # lib/index.js (host ESM) + lib/client.js (browser bundle)
node scripts/test.mjs    # 27 tests, no network, no DSH runtime
```

Zero build dependencies: sources are ESM that runs as plain JS (types live in JSDoc), and the build only resolves a module table and concatenates — no bundler.

### License

MIT
