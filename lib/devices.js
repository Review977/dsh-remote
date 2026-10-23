/**
 * 配对码与设备会话。
 *
 * 设计取舍（借别人的经验、按自己的需求精简）：
 * - 配对码是 6 位数字 + 5 分钟有效 + 一次性 + 每 IP 尝试次数上限。
 *   手机上手输 6 位数字最省事，代价是必须限制爆破窗口，所以三件事都要有。
 * - 设备凭证是 `<deviceId>.<secret>`，只存本地文件（0600），不存 hash
 *   库；这是单机自用工具，威胁模型是「公网扫描 + 手输配对码爆破」，
 *   不是「本机文件被读」。
 * - 设备列表落盘，进程重启后配对不失效——否则每次重启都要重新配对。
 */

import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

const CODE_ATTEMPT_LIMIT = 8

/** dsh 主目录。 */
export function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** 设备库默认落盘位置。 */
export function defaultDevicesFile(home = dshHome()) {
  return join(home, 'remote-gate', 'devices.json')
}

/** 定长比较，避免计时侧信道。 */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a))
  const bufB = Buffer.from(String(b))
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

export class DeviceStore {
  /**
   * @param options.file - 设备库文件路径。
   * @param options.pairTtlMs - 配对码有效期。
   * @param options.deviceTtlMs - 设备会话有效期。
   * @param options.log - 日志函数。
   */
  constructor({ file, pairTtlMs, deviceTtlMs, log = () => {} }) {
    this.file = file
    this.pairTtlMs = pairTtlMs
    this.deviceTtlMs = deviceTtlMs
    this.log = log
    /** @type {Map<string, {code: string, expiresAt: number, attempts: Map<string, number>}>} */
    this.pending = new Map()
    this.devices = []
    this.load()
  }

  load() {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8'))
      if (Array.isArray(raw?.devices)) this.devices = raw.devices
    } catch {
      this.devices = []
    }
  }

  save() {
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
      writeFileSync(this.file, `${JSON.stringify({ devices: this.devices }, null, 2)}\n`, { mode: 0o600 })
    } catch (error) {
      this.log(`保存设备库失败：${String(error)}`)
    }
  }

  /** 设备列表（已过滤过期项）。 */
  list() {
    const now = Date.now()
    const alive = this.devices.filter((device) => device.expiresAt > now)
    if (alive.length !== this.devices.length) {
      this.devices = alive
      this.save()
    }
    return [...this.devices].sort((a, b) => b.createdAt - a.createdAt)
  }

  /** 作废所有未使用的配对码。 */
  clearCodes() {
    this.pending.clear()
  }

  /** 发一个新的一次性配对码。 */
  issueCode() {
    const now = Date.now()
    for (const [code, entry] of this.pending) if (entry.expiresAt <= now) this.pending.delete(code)
    let code
    do {
      code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    } while (this.pending.has(code))
    this.pending.set(code, { code, expiresAt: now + this.pairTtlMs, attempts: new Map() })
    return { code, expiresAt: now + this.pairTtlMs }
  }

  /** 当前仍然有效的配对码（用于本机状态页展示）。 */
  activeCode() {
    const now = Date.now()
    for (const entry of this.pending.values()) {
      if (entry.expiresAt > now) return { code: entry.code, expiresAt: entry.expiresAt }
    }
    return undefined
  }

  /**
   * 用配对码换一个设备会话。
   * @returns {{ok: true, device: object, secret: string} | {ok: false, error: string}}
   */
  redeem(code, meta = {}) {
    const now = Date.now()
    const normalized = String(code ?? '').trim()
    const entry = this.pending.get(normalized)
    if (entry === undefined || entry.expiresAt <= now) {
      this.pending.delete(normalized)
      return { ok: false, error: '配对码不存在或已过期' }
    }
    const ip = String(meta.ip ?? 'unknown')
    const attempts = (entry.attempts.get(ip) ?? 0) + 1
    entry.attempts.set(ip, attempts)
    if (attempts > CODE_ATTEMPT_LIMIT) {
      this.pending.delete(normalized)
      this.log(`配对码因尝试次数过多被作废（来源 ${ip}）`)
      return { ok: false, error: '尝试次数过多，请重新生成配对码' }
    }
    // 一次性：换成功即销毁。
    this.pending.delete(normalized)
    const device = {
      id: randomBytes(8).toString('hex'),
      secret: randomBytes(24).toString('hex'),
      name: String(meta.name ?? '').trim() || guessDeviceName(meta.userAgent),
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + this.deviceTtlMs,
      ip,
      userAgent: String(meta.userAgent ?? '').slice(0, 200),
    }
    this.devices.push(device)
    this.save()
    this.log(`新设备已配对：${device.name}（${device.id}，来自 ${ip}）`)
    return { ok: true, device, secret: device.secret }
  }

  /** 校验设备 Cookie 值 `<id>.<secret>`。 */
  verify(value) {
    if (typeof value !== 'string') return undefined
    const dot = value.indexOf('.')
    if (dot <= 0) return undefined
    const id = value.slice(0, dot)
    const secret = value.slice(dot + 1)
    const now = Date.now()
    const device = this.devices.find((item) => item.id === id)
    if (device === undefined) return undefined
    if (device.expiresAt <= now) return undefined
    if (!safeEqual(device.secret, secret)) return undefined
    return device
  }

  /** 刷新 lastSeen（节流到 60 秒，避免每次请求都写盘）。 */
  touch(device) {
    const now = Date.now()
    if (now - device.lastSeenAt < 60_000) return
    device.lastSeenAt = now
    this.save()
  }

  /** 吊销一个设备。 */
  revoke(id) {
    const before = this.devices.length
    this.devices = this.devices.filter((device) => device.id !== id)
    if (this.devices.length !== before) {
      this.save()
      this.log(`设备已吊销：${id}`)
      return true
    }
    return false
  }

  /** 吊销全部设备。 */
  revokeAll() {
    const count = this.devices.length
    this.devices = []
    this.save()
    this.log(`已吊销全部设备（${count} 台）`)
    return count
  }
}

/** 从 UA 猜一个设备名，只是给人看的。 */
function guessDeviceName(userAgent) {
  const ua = String(userAgent ?? '')
  if (/iPhone/i.test(ua)) return 'iPhone'
  if (/iPad/i.test(ua)) return 'iPad'
  if (/Android/i.test(ua)) return 'Android 设备'
  if (/Macintosh/i.test(ua)) return 'Mac 浏览器'
  if (/Windows/i.test(ua)) return 'Windows 浏览器'
  return '未知设备'
}
