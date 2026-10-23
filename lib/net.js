/**
 * 小工具：回环判定、Cookie 读写、HTML 转义、IPv4 枚举。
 * 只依赖 node 内置模块，保持插件零运行时依赖。
 */

import { networkInterfaces } from 'node:os'

/** 读一个 Cookie 值。 */
export function readCookie(header, name) {
  if (typeof header !== 'string') return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return undefined
}

/** 判断 socket 对端地址是否为回环。 */
export function isLoopbackAddress(address) {
  if (typeof address !== 'string' || address.length === 0) return false
  const value = address.startsWith('::ffff:') ? address.slice(7) : address
  if (value === '::1') return true
  const parts = value.split('.')
  return parts.length === 4 && parts[0] === '127'
}

/** 判断 Host 头里的主机名是否为回环字面量。 */
export function isLoopbackHostname(hostname) {
  if (typeof hostname !== 'string' || hostname.length === 0) return false
  const value = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (value === 'localhost' || value === '::1') return true
  const parts = value.split('.')
  return parts.length === 4 && parts[0] === '127'
}

/** 解析请求的 Host 主机名。 */
export function hostnameOf(request) {
  const host = request.headers.host
  if (typeof host !== 'string') return undefined
  try {
    return new URL(`http://${host}`).hostname
  } catch {
    return undefined
  }
}

/** 归一化地址字面量：去掉 IPv4-mapped 前缀与 IPv6 方括号。 */
function normalizeAddress(address) {
  if (typeof address !== 'string') return ''
  return address.replace(/^\[|\]$/g, '').replace(/^::ffff:/i, '').toLowerCase()
}

/** 本机所有网卡地址（含回环），用来识别「从本机访问自己的局域网地址」。 */
export function ownAddresses() {
  const set = new Set(['127.0.0.1', '::1', 'localhost'])
  for (const list of Object.values(networkInterfaces())) {
    for (const item of list ?? []) set.add(normalizeAddress(item.address))
  }
  return set
}

/**
 * 是否为「本机自己」的请求。
 *
 * 两种情况：
 * 1. socket 回环 + Host 回环 —— 本机通过 127.0.0.1 访问。
 * 2. socket 源地址是本机某个网卡地址 + Host 也是本机地址 —— `bind: lan` 时
 *    在 Mac 上打开 http://<局域网IP>:<端口>/__remote/ 就属于这种。远程机器的
 *    源地址不可能是本机地址，所以这一条不会把外人放进来。
 *
 * 两种都必须没有转发头：cloudflared/nginx 是从本机拨进来的，只看地址会把
 * 公网请求误判成本机（第三方插件 issue #1906 踩过）。
 */
export function isLocalRequest(request) {
  const socket = request.socket
  if (socket === undefined) return false
  for (const name of ['cf-connecting-ip', 'x-forwarded-for', 'x-forwarded-host', 'x-real-ip', 'forwarded']) {
    if (request.headers[name] !== undefined) return false
  }
  const source = normalizeAddress(socket.remoteAddress)
  const host = normalizeAddress(hostnameOf(request))
  if (source.length === 0 || host.length === 0) return false
  if (isLoopbackAddress(source) && isLoopbackHostname(host)) return true
  const own = ownAddresses()
  return own.has(source) && own.has(host)
}

/**
 * 客户端真实来源 IP。
 *
 * 隧道/反代是从本机拨进来的，socket 地址永远是 127.0.0.1——直接记这个值，
 * 设备列表里每台设备都显示「来自 127.0.0.1」，等于没记。所以优先取转发头。
 * @returns 可读的来源 IP（最多保留前两跳）。
 */
export function clientIpOf(request) {
  const forwarded = request.headers['cf-connecting-ip']
  if (typeof forwarded === 'string' && forwarded.trim().length > 0) return forwarded.trim()
  const chain = request.headers['x-forwarded-for']
  if (typeof chain === 'string' && chain.trim().length > 0) {
    return chain.split(',').slice(0, 2).map((part) => part.trim()).filter(Boolean).join(', ')
  }
  const socket = request.socket?.remoteAddress
  if (typeof socket === 'string') return socket.replace(/^::ffff:/, '')
  return 'unknown'
}

/** 请求是否经 TLS 终结的代理进来（隧道场景）。 */
export function isSecureRequest(request) {
  const proto = request.headers['x-forwarded-proto']
  return typeof proto === 'string' && proto.split(',')[0].trim() === 'https'
}

/** HTML 文本转义。 */
export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[ch])
}

/** 虚拟/隧道网卡名字前缀：这些地址手机到不了，不能拿来当「局域网地址」广告。 */
const VIRTUAL_INTERFACE_PREFIXES = [
  'utun', 'tun', 'tap', 'ppp', 'ipsec', 'gif', 'stf', 'bridge',
  'awdl', 'llw', 'anpi', 'ap', 'vmnet', 'vboxnet', 'docker', 'lo',
]

/** 保留/虚拟网段前缀：198.18.0.0/15 常被 Clash 这类工具当 fake-IP 用。 */
const VIRTUAL_ADDRESS_PREFIXES = ['198.18.', '198.19.', '169.254.']

/**
 * 选一个手机真能连上的局域网 IPv4 地址。
 *
 * 不能只看「第一个非回环地址」：这台机器上 `utun4 -> 198.18.0.1` 就是隧道网卡，
 * 把它广告给手机，链接一定打不开。所以按网卡名与网段打分，优先 en*。
 * @returns 地址字面量，没有可用地址时 undefined。
 */
export function firstLanIPv4() {
  const candidates = []
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const item of list ?? []) {
      if (item.family !== 'IPv4' || item.internal) continue
      const virtualName = VIRTUAL_INTERFACE_PREFIXES.some((prefix) => name.startsWith(prefix))
      const virtualAddress = VIRTUAL_ADDRESS_PREFIXES.some((prefix) => item.address.startsWith(prefix))
      if (virtualName || virtualAddress) continue
      // en* 是真实的以太网/Wi-Fi 接口，排最前。
      candidates.push({ address: item.address, score: name.startsWith('en') ? 0 : 1 })
    }
  }
  candidates.sort((a, b) => a.score - b.score)
  return candidates[0]?.address
}

/** 读请求体（上限 64 KiB，配对接口足够）。 */
export function readBody(request, limit = 65536) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

/** 解析 application/x-www-form-urlencoded 或 JSON 请求体。 */
export function parseForm(body, contentType) {
  const text = body.trim()
  if (text.length === 0) return {}
  if (typeof contentType === 'string' && contentType.includes('application/json')) {
    try {
      const value = JSON.parse(text)
      return typeof value === 'object' && value !== null ? value : {}
    } catch {
      return {}
    }
  }
  const out = {}
  for (const [key, value] of new URLSearchParams(text)) out[key] = value
  return out
}
