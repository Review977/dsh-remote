/**
 * 门控监听：整个远程控制唯一的入口。
 *
 * 为什么不用官方 /api 那条路：官方 /api 只有「Host/Origin 围栏 + 浏览器
 * 认证 cookie」，而那份 cookie 是跟 authority 绑定的、没有回环豁免。
 * 所以自己的入口拿到请求后，先用自己的设备 cookie 做准入，再以
 * 127.0.0.1 的形状 + 进程自己的官方凭据重新发起请求（见 inner-auth.js）。
 *
 * 与第三方插件（@linxin666/dsh-remote-web-ui）的差别：它把门控做成官方
 * web server 上的 /remote 前缀，再往浏览器注入 boot 脚本去重写 fetch/WS
 * 路径；我们直接另起一个监听，手机从门控加载整份界面，相对路径天然
 * 指向门控，不需要任何客户端改写。
 */

import { createServer, request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import {
  isSecureRequest,
  parseForm,
  readBody,
  readCookie,
  isLocalRequest,
  escapeHtml,
} from './net.js'
import { errorPage, pairFailedPage, pairPage, statusPage } from './pages.js'
import { findProfileDir, writeManagedBlock } from './profile-config.js'

/** 设备 cookie 名。 */
const COOKIE_NAME = 'dsh_remote'
/** 门控自己的路径前缀，永远不转发给上游。 */
const LOCAL_PREFIX = '/__remote'
/** 上游响应里不回抄给手机的响应头。 */
const FORWARD_RESPONSE_HEADERS = [
  'content-type',
  'content-length',
  'content-disposition',
  'cache-control',
  'etag',
  'last-modified',
  'content-encoding',
  'vary',
]
/** 转发给上游的请求头白名单（其余一律丢弃，尤其 Origin / Cookie / Sec-Fetch-*）。 */
const FORWARD_REQUEST_HEADERS = [
  'accept',
  'accept-language',
  'content-type',
  'content-length',
  'range',
  'if-none-match',
  'if-modified-since',
]
/** WebSocket 握手转发头。 */
const WS_FORWARD_HEADERS = [
  'sec-websocket-key',
  'sec-websocket-version',
  'sec-websocket-extensions',
  'sec-websocket-protocol',
]

/** 配对失败节流：每个来源 IP 的失败窗口。 */
class FailureThrottle {
  constructor({ limit = 12, windowMs = 5 * 60_000 } = {}) {
    this.limit = limit
    this.windowMs = windowMs
    this.hits = new Map()
  }

  blocked(ip) {
    const now = Date.now()
    const list = (this.hits.get(ip) ?? []).filter((at) => now - at < this.windowMs)
    this.hits.set(ip, list)
    return list.length >= this.limit
  }

  record(ip) {
    const list = this.hits.get(ip) ?? []
    list.push(Date.now())
    this.hits.set(ip, list)
  }

  clear(ip) {
    this.hits.delete(ip)
  }
}

/**
 * 建门控。
 * @param options.config - 归一化后的配置。
 * @param options.devices - DeviceStore。
 * @param options.innerAuth - 官方浏览器凭据兑换器（可缺省）。
 * @param options.log - 日志函数。
 * @param options.getState - 返回状态页所需数据的回调。
 * @param options.upstreamPort - 官方 web server 端口。
 * @param options.gateName - 展示名。
 */
export function createGate(options) {
  const { config, devices, innerAuth, log, getState, upstreamPort, gateName } = options
  const throttle = new FailureThrottle()
  let boundPort

  /**
   * 还开着的隧道级 socket，按设备分组。
   *
   * 为什么要这张表：吊销只影响「新请求」，而手机那台一旦把 mux 的 WebSocket
   * 建起来，后面整段界面都跑在这条长连接上——不主动关掉它，吊销等于没生效，
   * 对方要等下次刷新才发现被踢。所以吊销/全部吊销/插件卸载都要顺手把这些
   * socket 掐了。
   * @type {Map<string, Set<import('node:stream').Duplex>>}
   */
  const liveSockets = new Map()

  function trackSocket(deviceId, socket) {
    const set = liveSockets.get(deviceId) ?? new Set()
    set.add(socket)
    liveSockets.set(deviceId, set)
    socket.on('close', () => {
      set.delete(socket)
      if (set.size === 0) liveSockets.delete(deviceId)
    })
  }

  /** 关掉某台设备（或全部，传 undefined）活着的连接。返回关掉的数量。 */
  function closeSockets(deviceId) {
    let closed = 0
    const targets = deviceId === undefined ? [...liveSockets.keys()] : [deviceId]
    for (const key of targets) {
      const set = liveSockets.get(key)
      if (set === undefined) continue
      for (const socket of set) {
        closed += 1
        try {
          // 先礼后兵：写一个 1001（going away），对端能立刻知道是被踢的。
          if (typeof socket.write === 'function' && socket.writable !== false) {
            socket.write(Buffer.from([0x88, 0x02, 0x03, 0xe9]))
          }
        } catch {
          /* 已经不可写 */
        }
        socket.destroy()
      }
      liveSockets.delete(key)
    }
    return closed
  }

  /** 读设备身份：先 cookie。 */
  function deviceOf(request) {
    const value = readCookie(request.headers.cookie, COOKIE_NAME)
    if (value === undefined) return undefined
    return devices.verify(value)
  }

  /** 写设备 cookie。 */
  function setDeviceCookie(request, response, device, secret) {
    const maxAge = Math.max(1, Math.floor(config.deviceTtlMs / 1000))
    const parts = [
      `${COOKIE_NAME}=${device.id}.${secret}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${String(maxAge)}`,
    ]
    if (isSecureRequest(request)) parts.push('Secure')
    response.setHeader('set-cookie', parts.join('; '))
  }

  function sendHtml(response, status, html) {
    const body = Buffer.from(html, 'utf8')
    response.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': String(body.length),
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    })
    response.end(body)
  }

  function sendJson(response, status, value) {
    const body = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8')
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(body.length),
      'cache-control': 'no-store',
    })
    response.end(body)
  }

  function redirect(response, location) {
    response.writeHead(303, { location, 'cache-control': 'no-store' })
    response.end()
  }

  // ---- 本机管理面 ----

  async function handleLocal(request, response, url) {
    const path = url.pathname
    const local = isLocalRequest(request)

    if (path === `${LOCAL_PREFIX}/health`) {
      sendJson(response, 200, { ok: true, port: boundPort, upstreamPort })
      return true
    }

    if (path === `${LOCAL_PREFIX}/join` && request.method === 'POST') {
      const ip = request.socket.remoteAddress ?? 'unknown'
      if (throttle.blocked(ip)) {
        sendHtml(response, 429, pairFailedPage('尝试过于频繁，请稍后再试'))
        return true
      }
      const body = await readBody(request)
      const form = parseForm(body, request.headers['content-type'])
      const result = devices.redeem(form.code, {
        ip,
        userAgent: request.headers['user-agent'],
        name: form.name,
      })
      if (!result.ok) {
        throttle.record(ip)
        sendHtml(response, 400, pairFailedPage(result.error))
        return true
      }
      throttle.clear(ip)
      setDeviceCookie(request, response, result.device, result.secret)
      redirect(response, '/')
      return true
    }

    // 以下都只允许本机访问。
    if (!local) {
      if (path === `${LOCAL_PREFIX}/` || path === `${LOCAL_PREFIX}`) {
        sendHtml(response, 403, errorPage(403, '门控状态页只在本机可打开。请在 Mac 上访问。'))
        return true
      }
      return false
    }

    if (path === `${LOCAL_PREFIX}/pair` && request.method === 'POST') {
      devices.issueCode()
      redirect(response, `${LOCAL_PREFIX}/`)
      return true
    }

    if (path === `${LOCAL_PREFIX}/revoke` && request.method === 'POST') {
      const body = await readBody(request)
      const form = parseForm(body, request.headers['content-type'])
      const revoked = String(form.id ?? '')
      devices.revoke(revoked)
      const closed = closeSockets(revoked)
      if (closed > 0) log(`吊销时顺手断开了 ${closed} 条在线连接`)
      redirect(response, `${LOCAL_PREFIX}/`)
      return true
    }

    // 改隧道/端口配置：只允许本机。写完由 App 监听 patch 变化自动重组。
    if (path === `${LOCAL_PREFIX}/config` && request.method === 'POST') {
      const body = await readBody(request)
      const form = parseForm(body, request.headers['content-type'])
      const profileDir = findProfileDir()
      if (profileDir === undefined) {
        sendHtml(response, 500, errorPage(500, '找不到装这个插件的 profile 目录，配置改不了。'))
        return true
      }
      const tunnel = ['off', 'quick', 'named'].includes(String(form.tunnel)) ? String(form.tunnel) : 'off'
      const port = Number(form.port)
      const fields = {
        bind: String(form.bind) === 'lan' ? 'lan' : '127.0.0.1',
        port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : config.port,
        tunnel,
        publicHostname: String(form.publicHostname ?? '').trim(),
        tunnelConfig: String(form.tunnelConfig ?? '').trim(),
        // 留空表示「保持原样」，不然保存一次就把 token 抹了。
        tunnelToken: String(form.tunnelToken ?? '').trim() || config.tunnelToken,
        requirePairing: form.requirePairing === 'on' || form.requirePairing === 'true',
        deviceTtlDays: config.deviceTtlDays,
      }
      try {
        writeManagedBlock(profileDir, fields)
      } catch (error) {
        sendHtml(response, 500, errorPage(500, `写配置失败：${String(error)}`))
        return true
      }
      // 先把响应发出去：写文件会触发 App 重组，门控马上会被拆掉重建，
      // 慢一步的话浏览器就收不到响应了。
      sendHtml(response, 200, errorPage(200, '配置已保存，门控正在按新配置重启。3 秒后刷新本页。'))
      log(`配置已更新：tunnel=${fields.tunnel} bind=${fields.bind} port=${fields.port}`)
      return true
    }

    if (path === `${LOCAL_PREFIX}/revoke-all` && request.method === 'POST') {
      devices.revokeAll()
      const closed = closeSockets()
      if (closed > 0) log(`全部吊销时断开了 ${closed} 条在线连接`)
      redirect(response, `${LOCAL_PREFIX}/`)
      return true
    }

    if (path === `${LOCAL_PREFIX}/` || path === `${LOCAL_PREFIX}`) {
      // 打开状态页时若没有有效配对码（启动时那枚 5 分钟就过期了），
      // 顺手发一枚——否则页面显示「当前没有有效配对码」，还得再点一次按钮。
      if (devices.activeCode() === undefined) devices.issueCode()
      const state = await getState()
      sendHtml(response, 200, statusPage({ ...state, gateName, requirePairing: config.requirePairing }))
      return true
    }

    return false
  }

  // ---- 转发面 ----

  function proxyHttp(request, response) {
    void (async () => {
      const cookie = innerAuth === undefined ? undefined : await innerAuth.ready().catch(() => undefined)
      const headers = { host: `127.0.0.1:${String(upstreamPort)}`, 'sec-fetch-site': 'same-origin' }
      for (const name of FORWARD_REQUEST_HEADERS) {
        const value = request.headers[name]
        if (typeof value === 'string') headers[name] = value
      }
      if (typeof cookie === 'string') headers.cookie = cookie

      const upstream = httpRequest(
        {
          host: '127.0.0.1',
          port: upstreamPort,
          method: request.method,
          path: request.url ?? '/',
          headers,
        },
        (upstreamResponse) => {
          const status = upstreamResponse.statusCode ?? 502
          if (status === 401 && innerAuth !== undefined) innerAuth.invalidate()
          const out = {}
          for (const name of FORWARD_RESPONSE_HEADERS) {
            const value = upstreamResponse.headers[name]
            if (value !== undefined) out[name] = value
          }
          // 关键：绝不把上游的 Set-Cookie 交给手机——那是进程自己的官方凭据。
          response.writeHead(status, out)
          upstreamResponse.pipe(response)
          upstreamResponse.on('error', () => response.destroy())
        },
      )
      upstream.on('error', (error) => {
        log(`转发失败：${String(error)}`)
        if (!response.headersSent) sendHtml(response, 502, errorPage(502, '门控无法连上本机 DSH 服务。'))
        else response.destroy()
      })
      request.pipe(upstream)
      response.on('close', () => upstream.destroy())
    })()
  }

  function proxyUpgrade(request, socket, head) {
    void (async () => {
      const cookie = innerAuth === undefined ? undefined : await innerAuth.ready().catch(() => undefined)
      const lines = [
        `GET ${request.url ?? '/'} HTTP/1.1`,
        `Host: 127.0.0.1:${String(upstreamPort)}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
      ]
      if (typeof cookie === 'string') lines.push(`Cookie: ${cookie}`)
      for (const name of WS_FORWARD_HEADERS) {
        const value = request.headers[name]
        if (value === undefined) continue
        lines.push(`${name}: ${Array.isArray(value) ? value.join(', ') : value}`)
      }
      const upstream = connect(upstreamPort, '127.0.0.1')
      // 半开的隧道路径会让手机上的 mux socket 静默僵死好几分钟，
      // 用 keepalive 探到缺口就销毁两条腿，让客户端重连。
      socket.setKeepAlive(true, 20_000)
      upstream.setKeepAlive(true, 20_000)
      const tearDown = () => {
        upstream.destroy()
        socket.destroy()
      }
      upstream.on('error', tearDown)
      socket.on('error', tearDown)
      upstream.on('close', () => socket.destroy())
      socket.on('close', () => upstream.destroy())
      upstream.on('connect', () => {
        upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
        if (head.length > 0) upstream.write(head)
        socket.pipe(upstream)
        upstream.pipe(socket)
      })
    })()
  }

  /** 非本机、且未配对的请求怎么回答。 */
  function denyUnauthenticated(request, response) {
    const url = new URL(request.url ?? '/', 'http://gate.invalid')
    // /api/* 是程序接口，回 JSON；其余是人在导航，给配对页。
    const wantsHtml = !url.pathname.startsWith('/api/')
    if (wantsHtml) {
      sendHtml(response, 200, pairPage({ gateName }))
      return
    }
    sendJson(response, 401, { ok: false, error: { code: 'unpaired', message: '这台设备还没有配对' } })
  }

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://gate.invalid')

    if (url.pathname === LOCAL_PREFIX || url.pathname.startsWith(`${LOCAL_PREFIX}/`)) {
      handleLocal(request, response, url)
        .then((handled) => {
          if (!handled) sendHtml(response, 404, errorPage(404, '没有这个门控接口。'))
        })
        .catch((error) => {
          log(`门控接口出错：${String(error)}`)
          if (!response.headersSent) sendHtml(response, 500, errorPage(500, String(error)))
        })
      return
    }

    if (config.requirePairing && !isLocalRequest(request)) {
      const device = deviceOf(request)
      if (device === undefined) {
        denyUnauthenticated(request, response)
        return
      }
      devices.touch(device)
    }

    proxyHttp(request, response)
  })

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://gate.invalid')
    if (url.pathname === LOCAL_PREFIX || url.pathname.startsWith(`${LOCAL_PREFIX}/`)) {
      socket.destroy()
      return
    }
    let owner = 'local'
    if (config.requirePairing && !isLocalRequest(request)) {
      const device = deviceOf(request)
      if (device === undefined) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      devices.touch(device)
      owner = device.id
    }
    trackSocket(owner, socket)
    proxyUpgrade(request, socket, head)
  })

  return {
    /** 当前实际监听端口。 */
    get port() {
      return boundPort
    },
    /** 这台设备此刻有没有活着的长连接（用来在设备列表里标「在线」）。 */
    isDeviceOnline(deviceId) {
      const set = liveSockets.get(deviceId)
      return set !== undefined && set.size > 0
    },
    /** 监听并返回实际端口。 */
    start() {
      return new Promise((resolve, reject) => {
        // 防呆：没给监听地址时绝不肯退化成「绑所有网卡」。
        // server.listen(port, undefined) 会绑 0.0.0.0/::，等于把门控摆到
        // 局域网上；宁可启动失败也不要这种静默暴露（实测踩过）。
        if (typeof config.bindAddress !== 'string' || config.bindAddress.length === 0) {
          reject(new Error('门控缺少监听地址（config.bindAddress），拒绝绑到所有网卡'))
          return
        }
        server.once('error', reject)
        server.listen(config.port, config.bindAddress, () => {
          server.removeListener('error', reject)
          boundPort = server.address().port
          resolve(boundPort)
        })
      })
    },
    /** 关掉监听。 */
    stop() {
      closeSockets()
      return new Promise((resolve) => {
        if (server.listening !== true) {
          resolve()
          return
        }
        server.closeAllConnections?.()
        server.close(() => resolve())
      })
    },
  }
}
