/**
 * 门控的端到端测试：假上游 + 真门控（零依赖，node:test）。
 *
 * 借的是 dsh-remote-mobile 那套「假核心 + 真代理」的骨架：不碰真的 DSH，
 * 一条条断言把「未配对 → 配对页 / 已配对 → 转发 / 吊销 → 401 / 跨站写 → 403」
 * 这些只有上线后才会发现的行为锁住。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createGate } from '../lib/gate.js'
import { DeviceStore } from '../lib/devices.js'

const TOKEN = 'testtoken123'

/** 发一个请求，返回 { status, headers, body }。 */
function request(port, { path = '/', method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

/** 伪装成「从公网经隧道进来的请求」：带转发头，门控就会按远程处理。 */
const REMOTE = { 'x-forwarded-for': '203.0.113.7', 'user-agent': 'Mozilla/5.0 (iPhone)' }

test('门控端到端：配对、转发、跨站导航、令牌、吊销', async (t) => {
  // 1. 假上游。
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(`upstream:${req.url}`)
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const upstreamPort = upstream.address().port

  // 2. 真门控（临时设备库，不碰 ~/.dsh）。
  const dir = mkdtempSync(join(tmpdir(), 'dsh-remote-test-'))
  t.after(() => {
    rmSync(dir, { recursive: true, force: true })
    upstream.close()
  })

  const devices = new DeviceStore({
    file: join(dir, 'devices.json'),
    pairTtlMs: 120_000,
    deviceTtlMs: 3_600_000,
  })
  const config = {
    requirePairing: true,
    bindAddress: '127.0.0.1',
    port: 0,
    deviceTtlMs: 3_600_000,
  }
  const gate = createGate({
    config,
    devices,
    innerAuth: undefined,
    log: () => {},
    getState: async () => ({
      listen: '127.0.0.1',
      upstream: `http://127.0.0.1:${upstreamPort}`,
      tunnel: { status: 'off' },
      code: devices.activeCode(),
      devices: devices.list(),
      addresses: [],
      warnings: [],
      config,
      clientSeen: { count: 0, lastAt: 0, lastSurface: '' },
      profileName: 'test',
      version: 'test',
    }),
    upstreamPort,
    upstream: { protocol: 'http:', hostname: '127.0.0.1', port: upstreamPort },
    gateName: '测试门控',
    adminToken: TOKEN,
    rejectLogFile: join(dir, 'reject.log'),
  })
  const port = await gate.start()
  t.after(() => gate.stop())
  const localHost = { host: `127.0.0.1:${port}` }

  // 3. 远程未配对：HTML 给配对页，/api/* 给 401。
  const unpaired = await request(port, { path: '/', headers: { ...REMOTE, accept: 'text/html' } })
  assert.equal(unpaired.status, 200)
  assert.match(unpaired.body, /配对/)
  assert.match(unpaired.body, new RegExp(`action="/__remote/join\\?t=${TOKEN}"`))

  const unpairedApi = await request(port, { path: '/api/session', headers: REMOTE })
  assert.equal(unpairedApi.status, 401)
  assert.equal(JSON.parse(unpairedApi.body).error.code, 'unpaired')

  // 4. 用配对码换设备 cookie（带令牌，模拟真实配对页）。
  const code = devices.issueCode().code
  const joined = await request(port, {
    path: `/__remote/join?t=${TOKEN}`,
    method: 'POST',
    headers: { ...REMOTE, 'content-type': 'application/x-www-form-urlencoded' },
    body: `code=${code}`,
  })
  assert.equal(joined.status, 303)
  const setCookie = String(joined.headers['set-cookie'])
  assert.match(setCookie, /^dsh_remote=/)
  assert.match(setCookie, /HttpOnly/)
  assert.match(setCookie, /SameSite=Lax/)
  assert.equal(/Secure/.test(setCookie), false)
  const cookie = setCookie.split(';')[0]

  // 5. 已配对：真的转到了上游。
  const proxied = await request(port, { path: '/workspace', headers: { ...REMOTE, cookie } })
  assert.equal(proxied.status, 200)
  assert.equal(proxied.body, 'upstream:/workspace')
  assert.equal(proxied.headers['set-cookie'], undefined)

  // 6. 从微信 / 飞书点开链接：顶级导航带 cross-site，必须能进。
  const navigation = await request(port, {
    path: '/',
    headers: {
      ...REMOTE,
      cookie,
      accept: 'text/html',
      'sec-fetch-site': 'cross-site',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-dest': 'document',
    },
  })
  assert.equal(navigation.status, 200)
  assert.equal(navigation.body, 'upstream:/')

  // 7. 跨站子资源读 / 跨站写仍然拒，并留下可诊断的拒绝日志。
  const subresource = await request(port, {
    path: '/',
    headers: { ...REMOTE, cookie, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors' },
  })
  assert.equal(subresource.status, 403)
  assert.equal(JSON.parse(subresource.body).error.code, 'cross-site')

  const crossSiteWrite = await request(port, {
    path: '/api/session',
    method: 'POST',
    headers: { ...REMOTE, cookie, origin: 'http://evil.example', host: `127.0.0.1:${port}` },
  })
  assert.equal(crossSiteWrite.status, 403)

  const rejectEntry = JSON.parse(readFileSync(join(dir, 'reject.log'), 'utf8').trim().split('\n').pop())
  assert.equal(rejectEntry.reason, 'origin-mismatch:evil.example')
  assert.equal(rejectEntry.path, '/api/session')
  assert.equal(rejectEntry.local, false)

  // 8. 管理面：本地 + 令牌，即使来源不透明（Origin: null）也要放行。
  const opaqueAdmin = await request(port, {
    path: `/__remote/pair?t=${TOKEN}`,
    method: 'POST',
    headers: { ...localHost, origin: 'null', 'content-type': 'application/x-www-form-urlencoded' },
    body: '',
  })
  assert.equal(opaqueAdmin.status, 303)

  const noToken = await request(port, {
    path: '/__remote/pair',
    method: 'POST',
    headers: { ...localHost, origin: 'null', 'content-type': 'application/x-www-form-urlencoded' },
    body: '',
  })
  assert.equal(noToken.status, 403)

  // 远程设备带令牌配对（模拟手机浏览器来源不透明的情形）：能过门，只是码错。
  devices.issueCode()
  const remoteJoin = await request(port, {
    path: `/__remote/join?t=${TOKEN}`,
    method: 'POST',
    headers: { ...REMOTE, origin: 'null', 'content-type': 'application/x-www-form-urlencoded' },
    body: 'code=000000',
  })
  assert.equal(remoteJoin.status, 400)

  // 8.5 主屏幕图标 / manifest：公开、无需配对、内容是真的。
  const icon = await request(port, { path: '/__dsh-remote-assets/icon-180.png', headers: REMOTE })
  assert.equal(icon.status, 200)
  assert.equal(icon.headers['content-type'], 'image/png')
  assert.equal(icon.body.slice(1, 4), 'PNG')
  const manifest = await request(port, { path: '/__dsh-remote-assets/manifest.webmanifest', headers: REMOTE })
  assert.equal(manifest.status, 200)
  const parsed = JSON.parse(manifest.body)
  assert.equal(parsed.scope, '/')
  assert.ok(parsed.icons.some((item) => item.sizes === '512x512'))

  // 9. 本机状态页：每个表单都带令牌。
  const statusPageHtml = await request(port, { path: '/__remote/', headers: localHost })
  assert.equal(statusPageHtml.status, 200)
  for (const action of ['pair', 'config', 'revoke-all']) {
    assert.match(statusPageHtml.body, new RegExp(`action="/__remote/${action}\\?t=${TOKEN}"`))
  }

  // 10. 本机不受配对约束（门控的管理面只在这里开着）。
  const local = await request(port, { path: '/', headers: localHost })
  assert.equal(local.status, 200)
  assert.equal(local.body, 'upstream:/')

  // 11. 吊销后：接口回到 401。
  const deviceId = devices.list()[0].id
  assert.equal(devices.revoke(deviceId), true)
  const revokedApi = await request(port, { path: '/api/session', headers: { ...REMOTE, cookie } })
  assert.equal(revokedApi.status, 401)
})
