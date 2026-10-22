import { readFileSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

const REPO = 'ZhaoZiyangShaanxi/dsh-codex-plus'
const root = process.cwd()
const VERSION = 'v0.1.1'

const raw = execFileSync('git', ['credential', 'fill'], {
  input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8',
})
const token = raw.split('\n').find(l => l.startsWith('password=')).slice('password='.length)
const headers = { authorization: 'Bearer ' + token, 'user-agent': 'dsh-codex-plus', accept: 'application/vnd.github+json' }
const api = async (url, init = {}) => {
  const res = await fetch(url, { ...init, headers: { ...headers, ...(init.headers ?? {}) } })
  const text = await res.text()
  let body; try { body = JSON.parse(text) } catch { body = text }
  return { ok: res.ok, status: res.status, body }
}

// 1) 先提交版本号
execFileSync('git', ['add', '-A'], { cwd: root })
try {
  execFileSync('git', ['-c', 'user.name=ZhaoZiyangShaanxi', '-c', 'user.email=ZhaoZiyangShaanxi@users.noreply.github.com',
    'commit', '-m', 'chore: release v0.1.1 (RPC channel fix)'], { cwd: root })
  console.log('version commit created')
} catch { console.log('nothing to commit') }
execFileSync('git', ['push', 'origin', 'main'], { cwd: root })
console.log('pushed')

// 2) release
let release
const existing = await api('https://api.github.com/repos/' + REPO + '/releases/tags/' + VERSION)
if (existing.ok) { release = existing.body; console.log('release exists:', release.html_url) }
else {
  const body = [
    'Fixes a blocking bug: the settings page could not load any data.',
    '',
    '### What was wrong',
    "DSH's connection RPC validates the channel with `^/[A-Za-z0-9._~-]+$`, so a channel containing a second slash is rejected outright. The client called `rpc.call('/api/codex-plus', '<endpoint>')`, which surfaced in the renderer as:",
    '',
    '```',
    'Error: connection: invalid RPC target "/api/codex-plus/status"',
    '```',
    '',
    '### What changed',
    "- client: channel is now `/api`; the plugin namespace moves into the endpoint (`codex-plus/<endpoint>`)",
    '- host: one exact route per endpoint (`/api/codex-plus/<endpoint>`) instead of a single route on the bare prefix',
    '- host: reject a request whose envelope method disagrees with the routed endpoint',
    '- adds `tests/rpc-contract.test.mjs` pinning both ends against DSH\'s assertTarget rules',
    '',
    '### Install',
    '```sh',
    'dsh plugin --profile desktop add https://github.com/' + REPO,
    '```',
    '',
    '31 tests pass, zero build dependencies. MIT.',
  ].join('\n')
  const created = await api('https://api.github.com/repos/' + REPO + '/releases', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tag_name: VERSION, target_commitish: 'main', name: VERSION, body }),
  })
  if (!created.ok) { console.log('release failed:', created.status, JSON.stringify(created.body).slice(0, 300)); process.exit(1) }
  release = created.body
  console.log('release created:', release.html_url)
}

// 3) 上传 tarball
const tgz = readdirSync(root).find(f => f.endsWith('.tgz'))
const assets = await api(release.assets_url)
const already = Array.isArray(assets.body) ? assets.body.find(a => a.name === tgz) : undefined
if (already) console.log('asset exists:', already.browser_download_url)
else {
  const bytes = readFileSync(path.join(root, tgz))
  const up = await fetch('https://uploads.github.com/repos/' + REPO + '/releases/' + release.id + '/assets?name=' + encodeURIComponent(tgz),
    { method: 'POST', headers: { ...headers, 'content-type': 'application/gzip' }, body: bytes })
  const text = await up.text()
  let asset; try { asset = JSON.parse(text) } catch {}
  if (asset?.browser_download_url) console.log('asset uploaded:', asset.browser_download_url)
  else { console.log('upload failed:', up.status, text.slice(0, 200)); process.exit(1) }
}
