/**
 * 出网隧道：把门控反向打穿到公网，Mac 只往外连，不需要公网 IP、不用改路由器。
 *
 * 两种模式：
 * - quick：`cloudflared tunnel --url <门控>`，零配置，但域名是随机的
 *   `https://xxx.trycloudflare.com`，**每次重启都会变**（旧链接失效、已配对
 *   设备也要重新配对，因为 cookie 绑定了主机名）。
 * - named：自己 Cloudflare 域名下固定的一条 hostname，重启不变——这才是
 *   「固定入口」的穿透。两种跑法：
 *   a) 本地管理：`cloudflared tunnel --config <config.yml> run`（推荐，配置全在本地）
 *   b) 远程管理：`cloudflared tunnel run` + `TUNNEL_TOKEN` 环境变量（后台下发配置）
 *
 * 两种都是 Mac 主动外连、公网入口由边缘节点转发，也就是反向隧道；
 * 门控照旧只听回环，不再往局域网上开任何口子。
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** 从 cloudflared 输出里抓 trycloudflare 地址。 */
const QUICK_URL_RE = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/
/** named 隧道注册成功的标志。 */
const REGISTERED_RE = /Registered tunnel connection|Connection .* registered|INF Registered/
/** 重启退避（毫秒）。 */
const RESTART_BACKOFF = [3_000, 10_000, 30_000, 60_000]

/**
 * 找一个可用的 cloudflared 可执行文件。
 * @param configured - 配置里显式给的路径。
 * @returns 路径，或 undefined。
 */
export function resolveCloudflared(configured) {
  const candidates = []
  if (typeof configured === 'string' && configured.trim().length > 0) candidates.push(configured.trim())
  if (typeof process.env.CLOUDFLARED_BIN === 'string' && process.env.CLOUDFLARED_BIN.length > 0) {
    candidates.push(process.env.CLOUDFLARED_BIN)
  }
  for (const candidate of candidates) if (existsSync(candidate)) return candidate

  const which = spawnSync('which', ['cloudflared'], { encoding: 'utf8' })
  if (which.status === 0) {
    const found = which.stdout.trim()
    if (found.length > 0 && existsSync(found)) return found
  }

  for (const relative of [
    join(process.env.HOME ?? '', '.local', 'bin', 'cloudflared'),
    join(process.env.HOME ?? '', 'bin', 'cloudflared'),
    join(process.cwd(), 'node_modules', 'cloudflared', 'bin', 'cloudflared'),
  ]) {
    if (existsSync(relative)) return relative
  }

  return undefined
}

/**
 * 清掉上一次留下的孤儿 cloudflared。
 *
 * 插件被卸载、或者 App 被强杀时，子进程可能还活着并继续占着隧道——那等于
 * 门控都下线了、公网入口还开着。启动前先按「命令行逐字匹配自己那条」清一遍，
 * 绝不碰任何不是我们起的进程。
 * @param options.configPath - named 模式用的 config.yml 路径。
 * @param options.gateUrl - quick 模式用的 `http://host:port` 目标。
 * @param options.log - 日志函数。
 * @returns 被清掉的进程数。
 */
export function killOrphans({ configPath = '', gateUrl = '', log = () => {} }) {
  const ps = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
  if (ps.status !== 0 || typeof ps.stdout !== 'string') return 0
  let killed = 0
  for (const line of ps.stdout.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    const space = trimmed.indexOf(' ')
    if (space <= 0) continue
    const pid = Number(trimmed.slice(0, space))
    const command = trimmed.slice(space + 1)
    if (!command.includes('cloudflared')) continue
    const mine = (configPath.length > 0 && command.includes(`--config ${configPath}`))
      || (gateUrl.length > 0 && command.includes(`--url ${gateUrl}`))
    if (!mine || !Number.isInteger(pid) || pid <= 0) continue
    try {
      process.kill(pid, 'SIGTERM')
      killed += 1
      log(`清掉残留的 cloudflared（pid ${pid}）`)
    } catch {
      /* 已经不在了 */
    }
  }
  return killed
}

/**
 * 拉起隧道（quick 或 named），并在意外退出时自动重启。
 * @param options.mode - 'quick' | 'named'。
 * @param options.port - 门控端口。
 * @param options.host - 门控监听地址（默认 127.0.0.1）。
 * @param options.tunnelConfig - named 模式的 cloudflared config.yml 路径（本地管理）。
 * @param options.token - named 模式的隧道 token（远程管理，与 config 二选一）。
 * @param options.publicHostname - named 模式的固定域名（只用于展示 URL）。
 * @param options.binPath - cloudflared 路径。
 * @param options.log - 日志函数。
 * @param options.onChange - 状态变化回调。
 */
export function startTunnel(options) {
  const { mode, port, host = '127.0.0.1', token = '', publicHostname = '', tunnelConfig = '', binPath, log, onChange = () => {} } = options

  let status = 'starting'
  let url = mode === 'named' && publicHostname.length > 0 ? `https://${publicHostname}/` : undefined
  let detail = mode === 'named' ? '正在连接固定域名隧道…' : '正在拉起 cloudflared…'
  let child
  let stopped = false
  let attempt = 0
  let restartTimer
  let readyTimer

  const publish = () => onChange({ status, url, detail })

  const spawnOnce = () => {
    killOrphans({
      configPath: tunnelConfig,
      gateUrl: host.includes(':') ? `http://[${host}]:${String(port)}` : `http://${host}:${String(port)}`,
      log,
    })
    // named 也要显式走 http2：默认的 quic 在不少家用宽带上会被限速/丢包，
    // 表现就是「隧道显示已连接，但公网请求一半超时」。
    const common = ['--no-autoupdate', '--protocol', 'http2']
    const args = mode !== 'named'
      ? ['tunnel', ...common, '--url', host.includes(':') ? `http://[${host}]:${String(port)}` : `http://${host}:${String(port)}`]
      : tunnelConfig.length > 0
        ? ['tunnel', '--config', tunnelConfig, ...common, 'run']
        : ['tunnel', ...common, 'run']
    const env = { ...process.env, NO_COLOR: '1' }
    // token 绝不进 argv：任何能读 /proc/<pid>/cmdline 的进程都看得到。
    if (mode === 'named' && tunnelConfig.length === 0) env.TUNNEL_TOKEN = token

    try {
      child = spawn(binPath, args, { stdio: ['ignore', 'pipe', 'pipe'], env })
    } catch (error) {
      status = 'failed'
      detail = `无法启动 cloudflared：${String(error)}`
      publish()
      return
    }

    let buffer = ''
    const consume = (chunk) => {
      buffer += chunk.toString('utf8')
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) handleLine(line)
    }
    child.stdout.on('data', consume)
    child.stderr.on('data', consume)

    child.on('error', (error) => {
      status = 'failed'
      detail = `cloudflared 启动失败：${String(error)}`
      publish()
    })

    child.on('exit', (code) => {
      clearTimeout(readyTimer)
      if (stopped) return
      status = 'failed'
      detail = `cloudflared 退出（code ${String(code)}），${String(Math.round(RESTART_BACKOFF[Math.min(attempt, RESTART_BACKOFF.length - 1)] / 1000))} 秒后重试`
      if (mode === 'quick') url = undefined
      publish()
      scheduleRestart()
    })

    readyTimer = setTimeout(() => {
      if (status === 'starting') {
        status = 'failed'
        detail = mode === 'quick'
          ? 'cloudflared 15 秒内没有给出隧道地址（可能是网络到不了 Cloudflare）'
          : 'cloudflared 15 秒内没有注册上固定域名（检查 token 与 Cloudflare 后台的 hostname 路由）'
        publish()
      }
    }, 15_000)
    readyTimer.unref?.()
  }

  const scheduleRestart = () => {
    if (stopped) return
    const delay = RESTART_BACKOFF[Math.min(attempt, RESTART_BACKOFF.length - 1)]
    attempt += 1
    clearTimeout(restartTimer)
    restartTimer = setTimeout(() => {
      if (stopped) return
      status = 'starting'
      detail = `重连中（第 ${String(attempt)} 次）…`
      publish()
      spawnOnce()
    }, delay)
    restartTimer.unref?.()
  }

  const handleLine = (line) => {
    if (mode === 'quick') {
      const match = QUICK_URL_RE.exec(line)
      if (match !== null && url === undefined) {
        url = match[0]
        status = 'running'
        detail = '快速隧道已连接'
        attempt = 0
        log(`隧道已就绪：${url}`)
        publish()
        return
      }
    } else if (REGISTERED_RE.test(line)) {
      status = 'running'
      detail = '固定域名隧道已连接'
      attempt = 0
      log(`隧道已就绪：${url ?? '（未配置 publicHostname，请看 Cloudflare 后台）'}`)
      publish()
      return
    }
    if (/failed to|ERR |error/i.test(line) && status !== 'running') {
      detail = line.trim().slice(0, 200)
      log(`cloudflared: ${detail}`)
    }
  }

  spawnOnce()
  publish()

  return {
    get status() {
      return status
    },
    get url() {
      return url
    },
    get detail() {
      return detail
    },
    stop() {
      stopped = true
      clearTimeout(restartTimer)
      clearTimeout(readyTimer)
      try {
        child?.kill('SIGTERM')
      } catch {
        /* 已经退出了 */
      }
    },
  }
}
