/**
 * 门控安全判定的单元测试（零依赖，node:test）。
 *
 * 这些函数决定「谁算本机、什么算跨站、哪些 cookie 能下发」，
 * 改一行就可能把公网请求放进来或者把手机挡在门外。之前全靠手工 curl 验证，
 * README 里两次「实测才发现的 bug」本来都该是这里的一条断言。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  crossSiteReason,
  forwardedSetCookies,
  shouldRetryWithFreshCredential,
} from '../lib/gate.js'
import { isLocalRequest, readCookie, escapeHtml } from '../lib/net.js'

/** 造一个最小的 request 形状。 */
function req({ method = 'GET', headers = {}, remoteAddress = '127.0.0.1' } = {}) {
  return { method, headers, socket: { remoteAddress } }
}

test('crossSiteReason：写请求跨站一律拒，读请求只放行顶级导航', () => {
  // 无浏览器信号（curl / 本机脚本）：放行。
  assert.equal(crossSiteReason(req()), undefined)

  // 同源页面里的 fetch / 表单：放行。
  assert.equal(
    crossSiteReason(req({ method: 'POST', headers: { origin: 'http://127.0.0.1:8790', host: '127.0.0.1:8790' } })),
    undefined,
  )

  // 顶级导航（从微信 / 飞书 / Slack 点开链接）：浏览器带 cross-site + navigate，
  // 必须放行，否则手机看到的是 403 JSON，连配对页都进不去。
  assert.equal(
    crossSiteReason(req({ headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' } })),
    undefined,
  )

  // 跨站子资源读（img / script / no-cors fetch）：仍然拒。
  assert.equal(
    crossSiteReason(req({ headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors' } })),
    'cross-site:subresource',
  )
  assert.equal(
    crossSiteReason(req({ headers: { 'sec-fetch-site': 'cross-site' } })),
    'cross-site:subresource',
  )

  // 跨站写：拒。
  assert.equal(
    crossSiteReason(req({ method: 'POST', headers: { 'sec-fetch-site': 'cross-site' } })),
    'cross-site',
  )

  // 跨站 WebSocket 握手（GET + mode=websocket）：拒，防 CSWSH。
  assert.equal(
    crossSiteReason(req({ headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'websocket' } })),
    'cross-site:subresource',
  )

  // Origin 与 Host 不一致 / 不透明 Origin。
  assert.equal(
    crossSiteReason(req({ method: 'POST', headers: { origin: 'http://evil.example', host: '127.0.0.1:8790' } })),
    'origin-mismatch:evil.example',
  )
  assert.equal(crossSiteReason(req({ method: 'POST', headers: { origin: 'null' } })), 'origin-malformed')
  assert.equal(crossSiteReason(req({ method: 'POST', headers: { origin: 'http://x.example' } })), 'origin-without-host')
})

test('forwardedSetCookies：官方凭据 cookie 不下发，其余照常透传', () => {
  const kept = forwardedSetCookies([
    'dsh-auth-abc=secret; Path=/; HttpOnly',
    'dsh-theme=dark; Path=/',
    'theme=dark; Path=/',
  ])
  assert.deepEqual(kept, ['theme=dark; Path=/'])
  assert.deepEqual(forwardedSetCookies(undefined), [])
  assert.deepEqual(forwardedSetCookies('dsh-auth-abc=1; Path=/'), [])
})

test('shouldRetryWithFreshCredential：只在带凭据的幂等请求上重试一次', () => {
  const base = { status: 401, method: 'GET', sentCookie: 'dsh-auth-x=1', retried: false }
  assert.equal(shouldRetryWithFreshCredential(base), true)
  assert.equal(shouldRetryWithFreshCredential({ ...base, method: 'HEAD' }), true)
  // 带请求体的方法不能重发（body 已经流给上游了）。
  assert.equal(shouldRetryWithFreshCredential({ ...base, method: 'POST' }), false)
  // 已经重试过 / 没带凭据 / 不是 401 都不重试。
  assert.equal(shouldRetryWithFreshCredential({ ...base, retried: true }), false)
  assert.equal(shouldRetryWithFreshCredential({ ...base, sentCookie: '' }), false)
  assert.equal(shouldRetryWithFreshCredential({ ...base, status: 502 }), false)
})

test('isLocalRequest：回环 + 回环 Host 才算本机，带转发头一律不算', () => {
  assert.equal(isLocalRequest(req({ headers: { host: '127.0.0.1:8790' } })), true)
  assert.equal(isLocalRequest(req({ headers: { host: 'localhost:8790' } })), true)
  assert.equal(isLocalRequest(req({ headers: { host: '[::1]:8790' }, remoteAddress: '::1' })), true)

  // 反代 / 隧道从本机拨进来：socket 是回环，但转发头说明这是公网流量。
  for (const header of ['cf-connecting-ip', 'x-forwarded-for', 'x-forwarded-host', 'x-real-ip', 'forwarded']) {
    assert.equal(
      isLocalRequest(req({ headers: { host: '127.0.0.1:8790', [header]: '203.0.113.7' } })),
      false,
      header,
    )
  }

  // Host 指向外部域名：不是本机。
  assert.equal(isLocalRequest(req({ headers: { host: 'dsh.example.com' } })), false)
  // 源地址不是本机：不是本机。
  assert.equal(isLocalRequest(req({ headers: { host: '127.0.0.1:8790' }, remoteAddress: '203.0.113.7' })), false)
})

test('readCookie / escapeHtml 的小契约', () => {
  assert.equal(readCookie('a=1; dsh_remote=xyz.abc; b=2', 'dsh_remote'), 'xyz.abc')
  assert.equal(readCookie('a=1', 'dsh_remote'), undefined)
  assert.equal(readCookie(undefined, 'x'), undefined)
  assert.equal(escapeHtml('<b>"x"&\'</b>'), '&lt;b&gt;&quot;x&quot;&amp;&#39;&lt;/b&gt;')
})
