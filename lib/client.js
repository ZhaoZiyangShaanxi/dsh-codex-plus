window.__ModuleLoader__.load({
  id: "dsh-codex-plus",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var __entry;
const { createElement: h, useCallback, useEffect, useRef, useState } = require("react")

// ---- runtime ----
var __modules = new Map()
var __cache = new Map()
function __define(id, factory) { __modules.set(id, factory) }
function __m(id) {
  if (__cache.has(id)) return __cache.get(id)
  var factory = __modules.get(id)
  if (factory === undefined) throw new Error("missing module " + id)
  var exports = {}
  __cache.set(id, exports)
  factory(exports, __m)
  return exports
}

// ---- client/index.ts ----
__define("client/index", function (__exports, __m) {
/**
 * dsh-codex-plus — 浏览器侧界面。
 *
 * 两块内容，都通过 DSH 的 slot 系统挂进现有界面，不接管任何别人的位置：
 *    settings.section         → 「Codex Plus」设置页（登录、账号、额度、重置卡、模型）
 *    conversation.input.right → 输入框右侧的常驻额度指示
 *
 * 数据一律走 host 的 /api/codex-plus 通道，前端不持有任何 token。
 */

const inject = ['slots', 'connection', 'locale']
const name = 'codex-plus'

const NS = 'codex-plus'
/**
 * DSH 的 RPC channel 只能是单段的 "/api"：assertTarget 会拒绝任何含第二个
 * 斜杠的 channel。插件的命名空间由下面 rpc.call 包装层拼进去。
 */
const CHANNEL = '/api'
/** 我们在 /api 下的端点命名空间。 */
const NAMESPACE = 'codex-plus'

/** 中英双语字典；DSH 的 locale 服务据此按语言取词。 */
const dict = {
  zh: {
    nav: 'Codex Plus',
    title: 'Codex Plus · 订阅额度',
    subtitle: '用 ChatGPT 订阅在 DSH 里使用 Codex 模型，并随时看清额度。',
    signIn: '登录 ChatGPT',
    signInDevice: '用设备码登录',
    signOut: '退出登录',
    signingIn: '正在登录…',
    openAuthAgain: '授权页未自动打开？点这里',
    waitingAuth: '等待你在浏览器中完成授权…',
    deviceCode: '设备码',
    deviceCodeHint: '在浏览器打开上面的地址，输入这段代码完成登录。',
    pasteCallback: '如果授权页未自动跳转，请把浏览器地址栏里的回调地址粘贴到下面：',
    pastePlaceholder: '粘贴回调地址或授权码',
    submitCode: '提交',
    cancelLogin: '取消登录',
    loginDone: '登录成功',
    loginFailed: '登录失败',
    signedOut: '还没有登录 ChatGPT 订阅。',
    signedOutHint: '登录后即可在会话里选择 Codex 模型，并在这里查看真实额度。',
    account: '账号',
    accounts: '账号',
    switchAccount: '切换',
    remove: '移除',
    active: '当前',
    plan: '套餐',
    quota: '额度',
    quotaEmpty: '账号没有返回额度窗口。',
    remaining: '剩余',
    used: '已用',
    resetsIn: '重置倒计时',
    resets: '重置',
    credits: '额外用量',
    creditsUnlimited: '不限',
    creditsBalance: '余额',
    resetCards: '重置卡',
    resetCardsCount: '可用 {n} 张',
    resetCardsEmpty: '账号没有可用的重置卡。',
    useReset: '使用',
    useResetConfirm: '再点一次确认使用',
    resetting: '正在使用…',
    resetDone: '已使用 {n} 个窗口的重置。',
    refresh: '刷新',
    refreshing: '刷新中…',
    loading: '读取中…',
    failed: '读取失败',
    retry: '重试',
    models: '模型',
    modelsEmpty: '账号没有返回模型目录。',
    modelRetired: '已退役',
    never: '未知',
    cancel: '取消',
    confirm: '确认使用',
    close: '关闭',
    quotaLeft: '剩余额度',
    quotaLow: '额度偏低',
    limitReached: '额度已用尽',
    windowPrimary: '短周期',
    windowSecondary: '每周',
    windowExtra: '其他额度',
    days: '{n} 天',
    hours: '{n} 小时',
    minutes: '{n} 分钟',
    seconds: '{n} 秒',
  },
  en: {
    nav: 'Codex Plus',
    title: 'Codex Plus · Subscription quota',
    subtitle: 'Use Codex models through your ChatGPT subscription, with real quota insight.',
    signIn: 'Sign in with ChatGPT',
    signInDevice: 'Sign in with a device code',
    signOut: 'Sign out',
    signingIn: 'Signing in…',
    openAuthAgain: 'Page did not open? Continue here',
    waitingAuth: 'Waiting for you to finish in the browser…',
    deviceCode: 'Device code',
    deviceCodeHint: 'Open the address above in a browser and enter this code.',
    pasteCallback: 'If the page did not redirect, paste the callback URL from your address bar:',
    pastePlaceholder: 'Paste callback URL or authorization code',
    submitCode: 'Submit',
    cancelLogin: 'Cancel',
    loginDone: 'Signed in',
    loginFailed: 'Sign-in failed',
    signedOut: 'No ChatGPT subscription is connected yet.',
    signedOutHint: 'Sign in to pick Codex models in a session and see your real quota here.',
    account: 'Account',
    accounts: 'Accounts',
    switchAccount: 'Switch',
    remove: 'Remove',
    active: 'Current',
    plan: 'Plan',
    quota: 'Quota',
    quotaEmpty: 'The account returned no quota windows.',
    remaining: 'Left',
    used: 'Used',
    resetsIn: 'Resets in',
    resets: 'Resets',
    credits: 'Extra usage',
    creditsUnlimited: 'Unlimited',
    creditsBalance: 'Balance',
    resetCards: 'Reset cards',
    resetCardsCount: '{n} available',
    resetCardsEmpty: 'The account has no reset cards.',
    useReset: 'Use',
    useResetConfirm: 'Click again to confirm',
    resetting: 'Using…',
    resetDone: 'Reset {n} window(s).',
    refresh: 'Refresh',
    refreshing: 'Refreshing…',
    loading: 'Loading…',
    failed: 'Failed to load',
    retry: 'Retry',
    models: 'Models',
    modelsEmpty: 'The account returned no model catalog.',
    modelRetired: 'Retired',
    never: 'unknown',
    cancel: 'Cancel',
    confirm: 'Confirm use',
    close: 'Close',
    quotaLeft: 'Quota left',
    quotaLow: 'Quota low',
    limitReached: 'Quota exhausted',
    windowPrimary: 'Short window',
    windowSecondary: 'Weekly',
    windowExtra: 'Other limit',
    days: '{n} d',
    hours: '{n} h',
    minutes: '{n} min',
    seconds: '{n} s',
  },
}

/* ------------------------------------------------------------------ *
 * 数据层
 * ------------------------------------------------------------------ */

/**
 * 极薄的数据钩子：一个 RPC 调用 + 挂载时拉一次 + 手动刷新。
 * 失败保留错误对象而不是字符串，UI 才能按 code 分流（未登录 / 限流 / 网络）。
 */
function useRpc(rpc, endpoint, options = {}) {
  const [state, setState] = useState({ loading: true, value: undefined, error: undefined })
  const mounted = useRef(true)
  const seq = useRef(0)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const load = useCallback(
    async (payload, opts = {}) => {
      if (rpc === undefined) {
        setState({ loading: false, value: undefined, error: { code: 'unsupported', message: 'no rpc' } })
        return undefined
      }
      const ticket = ++seq.current
      if (opts.quiet !== true) setState(previous => ({ ...previous, loading: true }))
      const result = await rpc.call(CHANNEL, endpoint, payload ?? {})
      if (!mounted.current || ticket !== seq.current) return undefined
      if (result?.ok === true) {
        setState({ loading: false, value: result.value, error: undefined })
        return result.value
      }
      setState({ loading: false, value: undefined, error: result?.error ?? { code: 'internal', message: 'unknown' } })
      return undefined
    },
    [rpc, endpoint],
  )

  useEffect(() => {
    if (options.enabled === false) return
    void load(undefined, { quiet: true })
  }, [load, options.enabled])

  return { ...state, reload: load }
}

/** 把毫秒差拆成「几天几小时」，比裸数字好读。 */
function formatCountdown(ms, t) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return undefined
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return t('seconds', { n: seconds })
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return t('minutes', { n: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    const rest = minutes % 60
    return rest === 0 ? t('hours', { n: hours }) : t('hours', { n: hours }) + ' ' + t('minutes', { n: rest })
  }
  const days = Math.floor(hours / 24)
  const restHours = hours % 24
  return restHours === 0 ? t('days', { n: days }) : t('days', { n: days }) + ' ' + t('hours', { n: restHours })
}

/** 每秒重绘一次倒计时；没有重置时间时完全不起定时器。 */
function useNow(active) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return undefined
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

function windowLabel(window, t) {
  if (typeof window.group === 'string') return window.group
  if (window.kind === 'primary') return t('windowPrimary')
  if (window.kind === 'secondary') return t('windowSecondary')
  return t('windowExtra')
}

/** 额度条：颜色只表达「够不够」，不表达品牌色。 */
function QuotaBar({ window, t, now, compact }) {
  const remaining = typeof window.remainingPercent === 'number' ? window.remainingPercent : undefined
  const tone = remaining === undefined ? 'unknown' : remaining <= 10 ? 'critical' : remaining <= 30 ? 'warn' : 'ok'
  const countdown = formatCountdown(window.resetsAt === undefined ? undefined : window.resetsAt - now, t)
  return h(
    'div',
    { className: 'dsh-codex-plus-bar dsh-codex-plus-' + tone },
    h(
      'div',
      { className: 'dsh-codex-plus-bar-head' },
      h('span', { className: 'dsh-codex-plus-bar-label' }, windowLabel(window, t)),
      typeof remaining === 'number'
        ? h('span', { className: 'dsh-codex-plus-bar-value' }, t('remaining') + ' ' + Math.round(remaining) + '%')
        : null,
    ),
    h(
      'div',
      { className: 'dsh-codex-plus-bar-track', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': remaining === undefined ? 0 : Math.round(remaining) },
      h('div', { className: 'dsh-codex-plus-bar-fill', style: { width: (remaining ?? 0) + '%' } }),
    ),
    compact === true
      ? null
      : h(
          'div',
          { className: 'dsh-codex-plus-bar-foot' },
          h('span', null, t('used') + ' ' + Math.round(window.usedPercent) + '%'),
          countdown === undefined ? null : h('span', null, t('resetsIn') + ' ' + countdown),
        ),
  )
}

/* ------------------------------------------------------------------ *
 * 输入框右侧：常驻额度
 * ------------------------------------------------------------------ */

/** 输入框里只放一个极小的徽标，点开才是完整面板。 */
function ComposerQuota({ rpc, t }) {
  const quota = useRpc(rpc, 'usage')
  const usage = quota.value
  const primary = usage?.windows?.[0]
  const now = useNow(primary?.resetsAt !== undefined)
  const [open, setOpen] = useState(false)

  if (quota.loading) return h('span', { className: 'dsh-codex-plus-chip dsh-codex-plus-muted' }, t('loading'))
  if (usage?.signedIn !== true) return null

  const remaining = primary?.remainingPercent
  const tone = remaining === undefined ? 'unknown' : remaining <= 10 ? 'critical' : remaining <= 30 ? 'warn' : 'ok'
  const label = usage.limitReached === true ? t('limitReached') : t('quotaLeft')

  return h(
    'div',
    { className: 'dsh-codex-plus-chipwrap' },
    h(
      'button',
      {
        type: 'button',
        className: 'dsh-codex-plus-chip dsh-codex-plus-' + tone,
        onClick: () => setOpen(value => !value),
        title: label,
        'aria-expanded': open,
      },
      h('span', { className: 'dsh-codex-plus-dot' }),
      h('span', null, typeof remaining === 'number' ? Math.round(remaining) + '%' : '—'),
    ),
    open === true
      ? h('div', { className: 'dsh-codex-plus-popover', role: 'dialog' }, h(QuotaPanel, { usage, t, now, onClose: () => setOpen(false) }))
      : null,
  )
}

/** 输入框弹出的面板：窗口明细。 */
function QuotaPanel({ usage, t, now, onClose }) {
  return h(
    'div',
    null,
    h(
      'div',
      { className: 'dsh-codex-plus-popover-head' },
      h('strong', null, usage?.account?.email ?? t('quota')),
      h('button', { type: 'button', className: 'dsh-codex-plus-link', onClick: onClose }, t('close')),
    ),
    usage?.planType === undefined ? null : h('div', { className: 'dsh-codex-plus-muted' }, t('plan') + '：' + usage.planType),
    usage?.windows?.length === 0 ? h('div', { className: 'dsh-codex-plus-muted' }, t('quotaEmpty')) : null,
    (usage?.windows ?? []).map(window => h(QuotaBar, { key: window.kind + ':' + (window.group ?? ''), window, t, now })),
  )
}

/* ------------------------------------------------------------------ *
 * 一键登录卡片
 * ------------------------------------------------------------------ */

/**
 * 点登录 → host 启动 OAuth → 拿到 authUrl / 设备码 → 打开浏览器 →
 * 轮询会话状态直到成功或失败。设备码场景支持粘贴回调。
 */
function SignInCard({ rpc, t, onSignedIn }) {
  const [session, setSession] = useState(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(undefined)
  const [paste, setPaste] = useState('')
  const timerRef = useRef(undefined)

  const stopPolling = useCallback(() => {
    if (timerRef.current !== undefined) {
      clearInterval(timerRef.current)
      timerRef.current = undefined
    }
  }, [])

  useEffect(() => {
    return stopPolling
  }, [stopPolling])

  const poll = useCallback(
    async id => {
      const result = await rpc.call(CHANNEL, 'login/status', { id })
      if (result?.ok === true) {
        const state = result.value
        setSession(state)
        if (state.done) {
          stopPolling()
          setBusy(false)
          if (state.error === undefined) {
            setError(undefined)
            onSignedIn()
          } else {
            setError(state.error)
          }
        }
        return
      }
      setError(result?.error?.message ?? '登录状态查询失败')
      stopPolling()
      setBusy(false)
    },
    [rpc, stopPolling, onSignedIn],
  )

  const start = useCallback(
    async method => {
      setBusy(true)
      setError(undefined)
      setSession(undefined)
      setPaste('')
      const result = await rpc.call(CHANNEL, 'login/start', { method })
      if (result?.ok === true) {
        const state = result.value
        setSession(state)
        if (state.authUrl !== undefined && typeof window !== 'undefined') {
          window.open(state.authUrl, '_blank', 'noopener')
        }
        const id = state.id
        stopPolling()
        timerRef.current = setInterval(() => {
          void poll(id)
        }, 1200)
      } else {
        setBusy(false)
        setError(result?.error?.message ?? '无法开始登录')
      }
    },
    [rpc, poll, stopPolling],
  )

  const cancel = useCallback(async () => {
    if (session?.id !== undefined) await rpc.call(CHANNEL, 'login/cancel', { id: session.id })
    stopPolling()
    setBusy(false)
    setSession(undefined)
    setError(undefined)
  }, [rpc, session, stopPolling])

  const submitPaste = useCallback(async () => {
    if (session?.id === undefined) return
    setBusy(true)
    await rpc.call(CHANNEL, 'login/submit', { id: session.id, answer: paste })
    setPaste('')
    setBusy(false)
  }, [rpc, session, paste])

  const waiting = session !== undefined && session.done !== true && error === undefined

  if (session === undefined) {
    return h(
      'div',
      { className: 'dsh-codex-plus-card' },
      h('p', null, t('signedOut')),
      h('p', { className: 'dsh-codex-plus-muted' }, t('signedOutHint')),
      h(
        'div',
        { className: 'dsh-codex-plus-actions' },
        h('button', { type: 'button', className: 'dsh-codex-plus-btn dsh-codex-plus-btn-primary', onClick: () => void start('browser'), disabled: busy }, busy ? t('signingIn') : t('signIn')),
        h('button', { type: 'button', className: 'dsh-codex-plus-btn', onClick: () => void start('device_code'), disabled: busy }, t('signInDevice')),
      ),
      error === undefined ? null : h('p', { className: 'dsh-codex-plus-error', role: 'alert' }, error),
    )
  }

  if (session.method === 'browser' && waiting) {
    return h(
      'div',
      { className: 'dsh-codex-plus-card' },
      h('p', null, t('waitingAuth')),
      session.authUrl === undefined
        ? null
        : h('p', { className: 'dsh-codex-plus-muted' }, h('a', { href: session.authUrl, target: '_blank', rel: 'noreferrer' }, t('openAuthAgain'))),
      h(
        'div',
        { className: 'dsh-codex-plus-actions' },
        h('button', { type: 'button', className: 'dsh-codex-plus-btn', onClick: () => void cancel(), disabled: busy }, t('cancelLogin')),
      ),
      session.prompt === undefined
        ? null
        : h(
            'div',
            null,
            h('p', { className: 'dsh-codex-plus-muted' }, t('pasteCallback')),
            h('input', { className: 'dsh-codex-plus-input', type: 'text', value: paste, placeholder: t('pastePlaceholder'), onChange: event => setPaste(event.target.value) }),
            h(
              'div',
              { className: 'dsh-codex-plus-actions' },
              h('button', { type: 'button', className: 'dsh-codex-plus-btn', onClick: () => void submitPaste(), disabled: busy || paste.trim() === '' }, t('submitCode')),
            ),
          ),
    )
  }

  if (session.method === 'device_code' && waiting) {
    return h(
      'div',
      { className: 'dsh-codex-plus-card' },
      session.verificationUri === undefined ? null : h('p', null, h('a', { href: session.verificationUri, target: '_blank', rel: 'noreferrer' }, session.verificationUri)),
      session.userCode === undefined
        ? null
        : h(
            'div',
            { className: 'dsh-codex-plus-device' },
            h('div', { className: 'dsh-codex-plus-muted' }, t('deviceCode')),
            h('div', { className: 'dsh-codex-plus-devicecode' }, session.userCode),
          ),
      h('p', { className: 'dsh-codex-plus-muted' }, t('deviceCodeHint')),
      h(
        'div',
        { className: 'dsh-codex-plus-actions' },
        h('button', { type: 'button', className: 'dsh-codex-plus-btn', onClick: () => void cancel(), disabled: busy }, t('cancelLogin')),
      ),
    )
  }

  return h(
    'div',
    { className: 'dsh-codex-plus-card' },
    error === undefined ? h('p', null, t('loginDone')) : h('p', { className: 'dsh-codex-plus-error' }, t('loginFailed') + '：' + error),
    h(
      'div',
      { className: 'dsh-codex-plus-actions' },
      h('button', { type: 'button', className: 'dsh-codex-plus-btn', onClick: () => { setSession(undefined); setError(undefined) } }, t('signIn')),
    ),
  )
}

/* ------------------------------------------------------------------ *
 * 设置页
 * ------------------------------------------------------------------ */

function SettingsSection({ rpc, t }) {
  const status = useRpc(rpc, 'status')
  const usage = useRpc(rpc, 'usage', { enabled: status.value?.signedIn === true })
  const resets = useRpc(rpc, 'reset-credits', { enabled: false })
  const models = useRpc(rpc, 'models', { enabled: false })
  const [busy, setBusy] = useState(undefined)
  const [error, setError] = useState(undefined)
  const [notice, setNotice] = useState(undefined)
  const [pendingConsume, setPendingConsume] = useState(undefined)

  const signedIn = status.value?.signedIn === true
  const now = useNow((usage.value?.windows ?? []).some(window => window.resetsAt !== undefined))

  const run = useCallback(
    async (endpoint, payload, key) => {
      setBusy(key)
      setError(undefined)
      setNotice(undefined)
      const result = await rpc.call(CHANNEL, endpoint, payload ?? {})
      setBusy(undefined)
      if (result?.ok === true) {
        await status.reload()
        await usage.reload(undefined, { quiet: true })
        return result.value
      }
      setError(result?.error ?? { code: 'internal', message: 'unknown' })
      return undefined
    },
    [rpc, status, usage],
  )

  const loadResets = useCallback(() => {
    void run('reset-credits', { force: true }, 'resets')
  }, [run])

  const loadModels = useCallback(() => {
    void run('models', { force: true }, 'models')
  }, [run])

  const consume = useCallback(
    async creditId => {
      setPendingConsume(undefined)
      const outcome = await run('reset-credits/consume', { creditId }, 'consume')
      if (outcome !== undefined) {
        setNotice(t('resetDone', { n: outcome.windowsReset ?? 0 }))
        await resets.reload({ force: true }, { quiet: true })
      }
    },
    [run, resets, t],
  )

  return h(
    'div',
    { className: 'dsh-codex-plus-section' },
    h('h2', { className: 'dsh-codex-plus-title' }, t('title')),
    h('p', { className: 'dsh-codex-plus-muted' }, t('subtitle')),

    status.loading === true ? h('p', { className: 'dsh-codex-plus-muted' }, t('loading')) : null,

    status.loading === false && signedIn === false ? h(SignInCard, { rpc, t, onSignedIn: () => void status.reload() }) : null,

    signedIn === true
      ? h(
          'div',
          { className: 'dsh-codex-plus-card' },
          h(
            'div',
            { className: 'dsh-codex-plus-row' },
            h('strong', null, t('accounts')),
            h(
              'div',
              { className: 'dsh-codex-plus-actions' },
              h('button', { type: 'button', className: 'dsh-codex-plus-btn', onClick: () => void usage.reload(undefined, { quiet: true }), disabled: usage.loading === true }, usage.loading === true ? t('refreshing') : t('refresh')),
              h('button', { type: 'button', className: 'dsh-codex-plus-btn dsh-codex-plus-danger', onClick: () => void run('logout', undefined, 'logout'), disabled: busy === 'logout' }, t('signOut')),
            ),
          ),
          (status.value?.accounts ?? []).map(account =>
            h(
              'div',
              { key: account.id, className: 'dsh-codex-plus-account' + (account.active === true ? ' dsh-codex-plus-account-active' : '') },
              h('div', null, h('strong', null, account.label), account.email === undefined ? null : h('span', { className: 'dsh-codex-plus-muted' }, ' · ' + account.email)),
              h(
                'div',
                { className: 'dsh-codex-plus-actions' },
                account.active === true
                  ? h('span', { className: 'dsh-codex-plus-badge' }, t('active'))
                  : h('button', { type: 'button', className: 'dsh-codex-plus-link', onClick: () => void run('accounts/select', { id: account.id }, 'select') }, t('switchAccount')),
                account.active === true
                  ? null
                  : h('button', { type: 'button', className: 'dsh-codex-plus-link dsh-codex-plus-danger', onClick: () => void run('accounts/remove', { id: account.id }, 'remove') }, t('remove')),
              ),
            ),
          ),
        )
      : null,

    error === undefined ? null : h('div', { className: 'dsh-codex-plus-error' }, t('failed') + '：' + (error.message ?? error.code ?? '')),
    notice === undefined ? null : h('div', { className: 'dsh-codex-plus-notice' }, notice),

    signedIn === true
      ? h(
          'div',
          { className: 'dsh-codex-plus-card' },
          h(
            'div',
            { className: 'dsh-codex-plus-row' },
            h('strong', null, t('quota')),
            usage.value?.planType === undefined ? null : h('span', { className: 'dsh-codex-plus-badge' }, t('plan') + ' ' + usage.value.planType),
          ),
          usage.loading === true ? h('p', { className: 'dsh-codex-plus-muted' }, t('loading')) : null,
          usage.error !== undefined && error === undefined
            ? h('p', { className: 'dsh-codex-plus-error' }, t('failed') + '：' + (usage.error.message ?? usage.error.code ?? ''))
            : null,
          (usage.value?.windows ?? []).length === 0 && usage.loading === false && usage.error === undefined ? h('p', { className: 'dsh-codex-plus-muted' }, t('quotaEmpty')) : null,
          (usage.value?.windows ?? []).map(window => h(QuotaBar, { key: window.kind + ':' + (window.group ?? ''), window, t, now })),
          usage.value?.credits === undefined
            ? null
            : h(
                'div',
                { className: 'dsh-codex-plus-muted' },
                t('credits') + '：' + (usage.value.credits.unlimited === true ? t('creditsUnlimited') : usage.value.credits.balance ?? t('creditsUnlimited')),
              ),
        )
      : null,

    signedIn === true
      ? h(
          'div',
          { className: 'dsh-codex-plus-card' },
          h(
            'div',
            { className: 'dsh-codex-plus-row' },
            h('strong', null, t('resetCards')),
            h('button', { type: 'button', className: 'dsh-codex-plus-btn', onClick: loadResets, disabled: busy === 'resets' }, busy === 'resets' ? t('loading') : t('refresh')),
          ),
          resets.value === undefined
            ? h('p', { className: 'dsh-codex-plus-muted' }, t('loading'))
            : resets.value.credits.length === 0
              ? h('p', { className: 'dsh-codex-plus-muted' }, t('resetCardsEmpty'))
              : h(
                  'div',
                  null,
                  h('p', { className: 'dsh-codex-plus-muted' }, t('resetCardsCount', { n: resets.value.availableCount ?? 0 })),
                  resets.value.credits.map(credit =>
                    h(
                      'div',
                      { key: credit.id, className: 'dsh-codex-plus-account' },
                      h('div', null, h('strong', null, credit.title ?? credit.kind ?? credit.id), credit.expiresAt === undefined ? null : h('span', { className: 'dsh-codex-plus-muted' }, ' · ' + credit.expiresAt)),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'dsh-codex-plus-btn',
                          disabled: busy === 'consume' || credit.status !== 'available',
                          onClick: () => {
                            if (pendingConsume === credit.id) void consume(credit.id)
                            else setPendingConsume(credit.id)
                          },
                        },
                        busy === 'consume'
                          ? t('resetting')
                          : pendingConsume === credit.id
                            ? t('confirm')
                            : t('useReset'),
                      ),
                    ),
                  ),
                ),
        )
      : null,

    signedIn === true
      ? h(
          'div',
          { className: 'dsh-codex-plus-card' },
          h(
            'div',
            { className: 'dsh-codex-plus-row' },
            h('strong', null, t('models')),
            h('button', { type: 'button', className: 'dsh-codex-plus-btn', onClick: loadModels, disabled: busy === 'models' }, busy === 'models' ? t('loading') : t('refresh')),
          ),
          models.value === undefined
            ? h('p', { className: 'dsh-codex-plus-muted' }, t('loading'))
            : models.value.models.length === 0
              ? h('p', { className: 'dsh-codex-plus-muted' }, t('modelsEmpty'))
              : models.value.models.map(model =>
                  h(
                    'div',
                    { key: model.id, className: 'dsh-codex-plus-model' },
                    h('code', null, model.id),
                    h('span', { className: 'dsh-codex-plus-muted' }, ' ' + (model.name ?? '')),
                    model.contextWindow === undefined ? null : h('span', { className: 'dsh-codex-plus-muted' }, ' · ' + Math.round(model.contextWindow / 1000) + 'k'),
                    model.retiredAt === undefined ? null : h('span', { className: 'dsh-codex-plus-badge dsh-codex-plus-danger' }, t('modelRetired')),
                  ),
                ),
        )
      : null,
  )
}

/* ------------------------------------------------------------------ *
 * 样式
 * ------------------------------------------------------------------ */

const STYLE = `
.dsh-codex-plus-section { display: flex; flex-direction: column; gap: 16px; padding: 4px 2px 24px; }
.dsh-codex-plus-title { font-size: 18px; font-weight: 600; margin: 0; }
.dsh-codex-plus-muted { color: var(--dsh-color-text-secondary, #8b8f98); font-size: 13px; margin: 0; }
.dsh-codex-plus-card { border: 1px solid var(--dsh-color-border, rgba(128,128,128,.25)); border-radius: 10px; padding: 14px 16px; display: flex; flex-direction: column; gap: 12px; }
.dsh-codex-plus-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.dsh-codex-plus-actions { display: flex; align-items: center; gap: 8px; }
.dsh-codex-plus-account { display: flex; align-items: center; justify-content: space-between; gap: 12px; font-size: 13px; }
.dsh-codex-plus-account-active { font-weight: 600; }
.dsh-codex-plus-model { font-size: 13px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.dsh-codex-plus-btn { border: 1px solid var(--dsh-color-border, rgba(128,128,128,.35)); background: transparent; color: inherit; border-radius: 7px; padding: 4px 10px; font-size: 12px; cursor: pointer; }
.dsh-codex-plus-btn:disabled { opacity: .5; cursor: default; }
.dsh-codex-plus-btn-primary { background: var(--dsh-color-accent, #4f7cff); border-color: transparent; color: #fff; }
.dsh-codex-plus-link { border: 0; background: transparent; color: var(--dsh-color-accent, #4f7cff); font-size: 12px; cursor: pointer; padding: 2px 4px; }
.dsh-codex-plus-danger { color: #e5534b; border-color: rgba(229,83,75,.4); }
.dsh-codex-plus-badge { font-size: 11px; border-radius: 5px; padding: 1px 6px; background: rgba(128,128,128,.18); }
.dsh-codex-plus-input { width: 100%; box-sizing: border-box; border: 1px solid var(--dsh-color-border, rgba(128,128,128,.35)); background: transparent; color: inherit; border-radius: 7px; padding: 7px 10px; font-size: 13px; margin-top: 8px; }
.dsh-codex-plus-device { margin: 4px 0; }
.dsh-codex-plus-devicecode { font-size: 22px; font-weight: 700; letter-spacing: 3px; font-variant-numeric: tabular-nums; }
.dsh-codex-plus-bar { display: flex; flex-direction: column; gap: 5px; }
.dsh-codex-plus-bar-head { display: flex; align-items: baseline; justify-content: space-between; font-size: 12px; }
.dsh-codex-plus-bar-label { font-weight: 600; }
.dsh-codex-plus-bar-track { height: 6px; border-radius: 3px; background: rgba(128,128,128,.22); overflow: hidden; }
.dsh-codex-plus-bar-fill { height: 100%; border-radius: 3px; background: #4f9d69; transition: width .3s ease; }
.dsh-codex-plus-warn .dsh-codex-plus-bar-fill { background: #d99a2b; }
.dsh-codex-plus-critical .dsh-codex-plus-bar-fill { background: #e5534b; }
.dsh-codex-plus-bar-foot { display: flex; justify-content: space-between; font-size: 11px; color: var(--dsh-color-text-secondary, #8b8f98); }
.dsh-codex-plus-chipwrap { position: relative; display: inline-flex; }
.dsh-codex-plus-chip { display: inline-flex; align-items: center; gap: 5px; border: 1px solid var(--dsh-color-border, rgba(128,128,128,.3)); background: transparent; color: inherit; border-radius: 999px; padding: 3px 9px; font-size: 11px; cursor: pointer; }
.dsh-codex-plus-dot { width: 7px; height: 7px; border-radius: 50%; background: #4f9d69; }
.dsh-codex-plus-warn .dsh-codex-plus-dot { background: #d99a2b; }
.dsh-codex-plus-critical .dsh-codex-plus-dot { background: #e5534b; }
.dsh-codex-plus-popover { position: absolute; right: 0; bottom: calc(100% + 8px); z-index: 60; width: 280px; display: flex; flex-direction: column; gap: 12px; padding: 14px; border-radius: 12px; border: 1px solid var(--dsh-color-border, rgba(128,128,128,.3)); background: var(--dsh-color-surface, #fff); box-shadow: 0 12px 32px rgba(0,0,0,.18); }
.dsh-codex-plus-popover-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 13px; }
.dsh-codex-plus-error { color: #e5534b; font-size: 12px; }
.dsh-codex-plus-notice { color: #4f9d69; font-size: 12px; }
`

/* ------------------------------------------------------------------ *
 * 插件入口
 * ------------------------------------------------------------------ */

function apply(ctx) {
  ctx.locale.register(NS, dict)
  const t = ctx.locale.bind(NS)

  // 样式只注入一次，挂在插件自己的 DOM 标记上，随插件 dispose 移除。
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.plugin = 'dsh-codex-plus'
    style.textContent = STYLE
    document.head.appendChild(style)
    return () => style.remove()
  }, 'codex-plus: styles')

  // RPC 客户端：只用 DSH 自己的连接通道，不额外开 HTTP 端点。
  //
  // DSH 的 RPC 契约：channel 只能是 "/api"（assertTarget 不允许 channel 里
  // 出现第二个斜杠），真正的端点是 channel 下的相对路径。宿主按
  // /api/codex-plus/<endpoint> 逐条注册精确路由，所以这里把命名空间并进
  // endpoint：call('/api', 'codex-plus/status')。
  const rpc = {
    call: (channel, endpoint, payload, signal) => {
      const connection = ctx.get('connection')
      if (connection === undefined) return Promise.resolve({ ok: false, error: { code: 'unsupported', message: 'no connection', details: {} } })
      return connection.rpc.call(channel, NAMESPACE + '/' + endpoint, payload, signal)
    },
  }

  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'codex-plus',
        order: 40,
        label: () => t('nav'),
        locale: NS,
        inject: () => ({ rpc }),
      },
      SettingsSection,
    ),
  )

  ctx.slots.inject('conversation.input.right', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.right',
        id: 'codex-plus-quota',
        order: 20,
        locale: NS,
        inject: () => ({ rpc }),
      },
      ComposerQuota,
    ),
  )
}

__exports["inject"] = inject
__exports["name"] = name
__exports["apply"] = apply
});
var __entry = __m("client/index")
Object.assign(module.exports, __entry)
    return module.exports;
  },
});
