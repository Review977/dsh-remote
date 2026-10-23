/**
 * dsh-remote —— 自己的 DSH 远程控制插件（宿主半侧）。
 *
 * 一句话：在官方 web server 前面另起一个「门控」监听，本机直连照旧，
 * 非本机请求必须先配对；配对通过后由门控以回环形状 + 进程自己的官方
 * 凭据把请求转发给 127.0.0.1 上的官方界面，于是手机拿到的是同一份
 * 官方 Web GUI，而门口站着我们自己的人。
 *
 * 借鉴的两份经验：
 * - agents-anywhere 连接器协议：一次性凭据 + 长期隧道 + 心跳保活，
 *   以及「在线 ≠ 能用」——能力要如实上报。
 * - @linxin666/dsh-remote-web-ui：配对码/设备会话/吊销的形态、
 *   内层官方凭据兑换（inner-auth）、转发头一律视为远程（反代陷阱）、
 *   以及「手机端不是第二套界面，就是官方 GUI + 适配层」。
 * 砍掉的：客户端插件（React bundle）、受管绑定块、防火墙、中继注册、
 * 姿态探测、自绘设置卡片——这些是为「发行给别人用」服务的，自用不需要。
 */

import { DeviceStore, defaultDevicesFile } from './lib/devices.js'
import { createGate } from './lib/gate.js'
import { createInnerAuth } from './lib/inner-auth.js'
import { firstLanIPv4 } from './lib/net.js'
import { resolveCloudflared, startTunnel } from './lib/tunnel.js'

/** 稳定 cordis 插件名。 */
export const name = 'dsh-remote'

/** 依赖注入边：webServer 就绪后才跑 apply，所以能直接读端口。 */
export const inject = ['webServer']

/** 归一化配置。故意不导出 schemastery 的 Config：少一个依赖，配置在下面自己收口。 */
function normalizeConfig(raw) {
  const config = raw ?? {}
  const port = Number(config.port)
  const deviceTtlDays = Number(config.deviceTtlDays)
  const pairTtlSeconds = Number(config.pairTtlSeconds)
  return {
    enabled: config.enabled !== false,
    bind: typeof config.bind === 'string' && config.bind.length > 0 ? config.bind : '127.0.0.1',
    port: Number.isInteger(port) && port >= 0 && port <= 65535 ? port : 8790,
    tunnel: config.tunnel === 'quick' || config.tunnel === 'named' ? config.tunnel : 'off',
    // named 模式的 token 与固定域名；token 也接受环境变量，免得写进 profile。
    tunnelToken: typeof config.tunnelToken === 'string' && config.tunnelToken.trim().length > 0
      ? config.tunnelToken.trim()
      : String(process.env.CLOUDFLARED_TUNNEL_TOKEN ?? '').trim(),
    publicHostname: typeof config.publicHostname === 'string' ? config.publicHostname.trim() : '',
    // named 的本地管理方式：直接喂 cloudflared config.yml。
    tunnelConfig: typeof config.tunnelConfig === 'string' ? config.tunnelConfig.trim() : '',
    requirePairing: config.requirePairing !== false,
    deviceTtlDays: Number.isFinite(deviceTtlDays) && deviceTtlDays > 0 ? deviceTtlDays : 30,
    deviceTtlMs: (Number.isFinite(deviceTtlDays) && deviceTtlDays > 0 ? deviceTtlDays : 30) * 24 * 60 * 60 * 1000,
    pairTtlSeconds: Number.isFinite(pairTtlSeconds) && pairTtlSeconds > 0 ? pairTtlSeconds : 120,
    cloudflaredPath: typeof config.cloudflaredPath === 'string' ? config.cloudflaredPath : '',
    // 注意：这里必须把解析后的字面量也放进来。门控用的是 config.bindAddress；
    // 少了它 server.listen(port, undefined) 会绑到所有网卡（0.0.0.0/::），
    // 与配置里写的 127.0.0.1 不符 —— 实测踩过这个坑。
    bindAddress: undefined,
  }
}

/** 解析监听地址：支持 'lan' 关键字。 */
function resolveBindAddress(bind) {
  if (bind === 'lan') return firstLanIPv4()
  return bind
}

/**
 * 纯 HTTP 局域网下 crypto.randomUUID 不存在（非安全上下文），
 * SDK 造 RPC id 会直接崩、界面白屏。所以必须补一个。
 */
const UUID_POLYFILL = `(function(){try{
if(typeof crypto!=='undefined'&&typeof crypto.randomUUID==='function')return;
var g=typeof crypto!=='undefined'&&crypto.getRandomValues?crypto:null;
var f=function(){var b=new Uint8Array(16);
if(g){g.getRandomValues(b);}else{for(var i=0;i<16;i++)b[i]=Math.floor(Math.random()*256);}
b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;
var h=[];for(var j=0;j<16;j++)h.push((b[j]+256).toString(16).slice(1));
return h.slice(0,4).join('')+'-'+h.slice(4,6).join('')+'-'+h.slice(6,8).join('')+'-'+h.slice(8,10).join('')+'-'+h.slice(10,16).join('');};
try{Object.defineProperty(crypto,'randomUUID',{value:f,writable:true,configurable:true});}catch(e){}
}catch(e){}})();`

/**
 * 手机适配：只作用于窄屏竖屏，桌面完全不受影响。
 * 选择器按官方 CSS Modules 的语义后缀取（`[class$="_composerSeat"]` 这类），
 * 官方重构换 hash 时仍然有效。
 */
const MOBILE_CSS = `
@media (max-width: 820px) and (orientation: portrait) {
  html { -webkit-text-size-adjust: 100%; }
  input, textarea, select, [contenteditable="true"] { font-size: 16px !important; }
  button, [role="button"] { min-height: 36px; }
  [class$="_detailsCol"] { display: none !important; }
  [class$="_scroll"] { padding-left: 10px !important; padding-right: 10px !important; }
  [class$="_composerSeat"] { padding-bottom: calc(8px + env(safe-area-inset-bottom)) !important; }
  [class$="_sidebarCol"] { max-width: 84vw !important; }
  [class$="_frame"] {
    padding-left: env(safe-area-inset-left);
    padding-right: env(safe-area-inset-right);
  }
}
`

/**
 * 把手机适配当脚本注入：运行时创建 <style>，幂等。
 * 之所以不直接推一个 style 行——结构化行里 script 是各载体都保证支持的形态。
 */
const MOBILE_SCRIPT = `(function(){try{
if(document.getElementById('dsh-remote-mobile'))return;
var m=document.querySelector('meta[name=viewport]');
if(m){if(String(m.getAttribute('content')||'').indexOf('viewport-fit')<0)m.setAttribute('content',(m.getAttribute('content')||'')+', viewport-fit=cover');}
else{m=document.createElement('meta');m.setAttribute('name','viewport');m.setAttribute('content','width=device-width, initial-scale=1, viewport-fit=cover');document.head.appendChild(m);}
var s=document.createElement('style');s.id='dsh-remote-mobile';s.textContent=${JSON.stringify(MOBILE_CSS)};document.head.appendChild(s);
}catch(e){}})();`

/** 安全取一个可选服务。 */
function optionalService(ctx, key) {
  try {
    return typeof ctx.get === 'function' ? ctx.get(key) : undefined
  } catch {
    return undefined
  }
}

/**
 * 插件入口。
 * @param ctx - cordis 上下文。
 * @param rawConfig - patch 行里的 config。
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const log = (message) => console.log(`[dsh-remote] ${message}`)

  if (!config.enabled) {
    log('已在配置里关闭（enabled: false），门控不启动')
    return
  }

  const upstreamPort = ctx.webServer.port
  if (upstreamPort === undefined) {
    log('官方 web server 还没有绑定端口，门控不启动')
    return
  }

  const bindAddress = resolveBindAddress(config.bind)
  if (bindAddress === undefined) {
    log('配置 bind: lan 但本机没有非回环 IPv4 地址，门控不启动')
    return
  }
  config.bindAddress = bindAddress

  /**
   * 当前 profile 名：优先问 profileContext（官方给的口径），拿不到就留空。
   * 用途有两个——配置写回哪个 profile、设备库归属哪个实例。
   */
  const profileName = (() => {
    const context = optionalService(ctx, 'profileContext')
    const name = context?.name
    return typeof name === 'string' && name.length > 0 ? name : ''
  })()

  const devices = new DeviceStore({
    // 注意：设备库是**共用**的（不按 profile 分）。分库会让「谁先启动谁认领旧库」，
    // 实测把线上 profile 的配对搞丢过。代价是开发 profile 里配对会出现在正式
    // profile 的列表里——用完记得吊销。
    file: defaultDevicesFile(),
    pairTtlMs: config.pairTtlSeconds * 1000,
    deviceTtlMs: config.deviceTtlDays * 24 * 60 * 60 * 1000,
    log,
  })

  /**
   * 上游的真实 origin：官方可能绑在别的地址、也可能开了 TLS。
   * getOrigin() 给的就是「协议 + 实际绑定地址 + 端口」，比自己拼靠谱。
   */
  const upstream = (() => {
    const fallback = { protocol: 'http:', hostname: '127.0.0.1', port: upstreamPort }
    try {
      const origin = ctx.webServer.getOrigin()
      const parsed = new URL(origin)
      return {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: Number(parsed.port) || upstreamPort,
      }
    } catch {
      return fallback
    }
  })()

  const connection = optionalService(ctx, 'connection')
  const innerAuth = createInnerAuth(() => {
    const service = connection ?? optionalService(ctx, 'connection')
    const make = service?.authenticatedUrl
    if (typeof make !== 'function') return undefined
    try {
      const base = `${upstream.protocol}//${upstream.hostname.includes(':') ? `[${upstream.hostname}]` : upstream.hostname}:${String(upstream.port)}/`
      return make.call(service, base)
    } catch {
      return undefined
    }
  })

  /** 门控对外地址（给客户端半侧渲染入口用），启动后才有值。 */
  let gateOrigin = ''

  /**
   * 客户端半侧回报：哪个窗口真的把「远程门控」这块渲染出来了。
   * 桌面外壳（dsh://host）里我没法从外面看 DOM，这个计数就是唯一的眼见为实。
   */
  const clientSeen = { count: 0, lastAt: 0, lastSurface: '' }

  /** 隧道句柄与状态。 */
  let tunnel
  let tunnelInfo = { status: 'off', detail: '未开启（配置 tunnel: quick 或 tunnel: named 可开）', url: undefined }
  const warnings = []

  const cloudflaredBin = config.tunnel === 'off' ? undefined : resolveCloudflared(config.cloudflaredPath)
  if (config.tunnel !== 'off' && cloudflaredBin === undefined) {
    warnings.push('配置要求开隧道，但找不到 cloudflared。装一个（brew install cloudflared）或写 cloudflaredPath。')
  }
  if (config.tunnel === 'named') {
    if (config.tunnelConfig.length === 0 && config.tunnelToken.length === 0) {
      warnings.push('named 隧道既没有 tunnelConfig 也没有 tunnelToken，隧道起不来。')
    }
    if (config.publicHostname.length === 0) warnings.push('named 隧道没写 publicHostname，状态页只能显示「请看 Cloudflare 后台」。')
  }
  if (!config.requirePairing) warnings.push('requirePairing 已关闭：任何能访问到门控端口的人都能直接操作 agent。')
  if (config.bind === 'lan') warnings.push('门控绑在局域网地址上：同一网络内的设备都能看到配对页。')
  if (config.tunnel === 'quick') warnings.push('快速隧道的域名每次重启都会变：旧链接失效，已配对设备也要重新配对（cookie 绑定主机名）。要固定入口用 tunnel: named。')

  /** 状态页数据。 */
  const buildState = () => {
    const addresses = []
    if (bindAddress !== '127.0.0.1' && bindAddress !== '::1') {
      const host = bindAddress.includes(':') ? `[${bindAddress}]` : bindAddress
      addresses.push(`http://${host}:${String(gate.port ?? config.port)}/`)
    }
    if (tunnelInfo.url !== undefined) addresses.push(tunnelInfo.url)
    return {
      listen: `${bindAddress}:${String(gate.port ?? config.port)}`,
      upstream: `${upstream.protocol}//${upstream.hostname}:${String(upstream.port)}`,
      tunnel: tunnelInfo,
      code: devices.activeCode(),
      devices: devices.list().map((device) => ({ ...device, online: gate.isDeviceOnline(device.id) })),
      addresses,
      warnings,
      config,
      clientSeen,
      profileName,
    }
  }

  const gate = createGate({
    config,
    devices,
    innerAuth,
    log,
    getState: async () => buildState(),
    upstreamPort,
    upstream,
    gateName: 'DSH 远程门控',
    profileName,
  })

  ctx.effect(() => {
    let stopped = false
    gate
      .start()
      .then((port) => {
        if (stopped) return
        devices.issueCode()
        const shownHost = bindAddress.includes(':') ? `[${bindAddress}]` : bindAddress
        gateOrigin = `http://${shownHost}:${String(port)}/__remote/`
        log(`门控已监听 ${bindAddress}:${String(port)} → 上游 ${upstream.protocol}//${upstream.hostname}:${String(upstream.port)}`)
        log(`状态页（仅本机）：http://127.0.0.1:${String(port)}/__remote/`)
        if (config.tunnel !== 'off' && cloudflaredBin !== undefined) {
          tunnel = startTunnel({
            mode: config.tunnel,
            port,
            host: bindAddress,
            token: config.tunnelToken,
            publicHostname: config.publicHostname,
            tunnelConfig: config.tunnelConfig,
            binPath: cloudflaredBin,
            log,
            onChange: (info) => {
              tunnelInfo = info
            },
          })
        }
      })
      .catch((error) => {
        log(`门控监听失败：${String(error)}`)
        warnings.push(`门控监听失败：${String(error)}`)
      })
    return () => {
      stopped = true
      tunnel?.stop()
      void gate.stop()
    }
  }, 'dsh-remote: gate listener')

  // 手机适配 + uuid polyfill + 门控地址：用 `webserver/index-inject` 的结构化行注入。
  //
  // 为什么不用 tapIndex：那是 HTML 字符串改写，只有「HTTP 发 index」的载体（SPA dist
  // 回退）会跑它；桌面 App 的窗口走 `dsh://host` 自定义协议，index 由外壳自己渲染，
  // 只认结构化行、不跑 tapIndex。之前用 tapIndex，结果门控地址在桌面窗口里是
  // undefined，插件页那块就直接不渲染了（HTTP 访问却是好的）。
  ctx.effect(() => ctx.on('webserver/index-inject', (table) => {
    if (gateOrigin.length > 0) {
      table.push({ kind: 'script', placement: 'head', text: `try{window.__DSH_REMOTE_GATE__=${JSON.stringify(gateOrigin)}}catch(e){}` })
    }
    table.push({ kind: 'script', placement: 'head', text: MOBILE_SCRIPT })
    table.push({ kind: 'script', placement: 'head', text: UUID_POLYFILL })
  }), 'dsh-remote: index rows')

  // 客户端半侧的兜底取址：万一窗口在门控起来之前就渲染完了（拿不到上面的全局），
  // 它还能问这个接口。相对路径 fetch 在两种载体里都通（外壳走 IPC 桥）。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/__dsh-remote/gate',
    handler: (request, response) => {
      const body = Buffer.from(JSON.stringify({ url: gateOrigin, upstreamPort }), 'utf8')
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(body.length),
        'cache-control': 'no-store',
      })
      response.end(body)
    },
  }), 'dsh-remote: gate url route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/__dsh-remote/seen',
    handler: (request, response) => {
      clientSeen.count += 1
      clientSeen.lastAt = Date.now()
      clientSeen.lastSurface = String(request.headers['x-dsh-remote-surface'] ?? 'web').slice(0, 40)
      response.writeHead(204, { 'cache-control': 'no-store' })
      response.end()
      request.resume()
    },
  }), 'dsh-remote: client seen route')
}
