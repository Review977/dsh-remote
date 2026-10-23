/**
 * 内层官方凭据。
 *
 * 官方 web server 的 /api 要求「浏览器认证 cookie」，那份 cookie 是跟
 * authority 绑定的（为访问过的确切 host:port 签发），而且没有回环豁免，
 * 所以配对设备自己的 cookie 永远过不了内层检查。
 *
 * 办法：进程自己兑换一次自己的启动令牌——和浏览器首次访问执行的是同一次
 * 交换——把拿到的 cookie 附到转发给 127.0.0.1 的请求上。这份凭据只在配对门
 * 之后使用，绝不交给任何客户端。
 *
 * 两处加固（借鉴 @misaka10091/dsh-remote-control 的 inner-auth）：
 * - **不假设 cookie 名字**。官方现在叫 `dsh-auth-*`，但那是实现细节；只认死
 *   前缀的话，一旦改名就变成「静默 401」——转发永远带空凭据，且查不出原因。
 *   所以先按前缀找，找不到按「dsh- 前缀 + 长不透明值」找，再不济取第一个够长的。
 * - **失败后冷却**。兑换失败不能每个请求都重试一次（一个页面加载几十个请求，
 *   等于对着本机打一串无意义的请求）。冷却期内直接返回空，让上游照常回 401。
 */

/** 官方当前使用的 cookie 名前缀。 */
const BROWSER_AUTH_COOKIE_PREFIX = 'dsh-auth-'
/** 失败后多久再试。 */
const DEFAULT_RETRY_INTERVAL_MS = 5_000

/**
 * 从 Set-Cookie 里挑出最像会话凭据的一条，返回 `name=value`。
 * @param raw - 原始的 set-cookie 头（可能有多条，逗号分隔）。
 * @returns `name=value`，或 undefined。
 */
export function pickCredentialCookie(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return undefined
  // cookie 值都是 base64url，不含逗号，所以按逗号切是安全的。
  const pairs = raw
    .split(',')
    .map((part) => part.split(';')[0]?.trim() ?? '')
    .filter((pair) => pair.includes('='))

  const byPrefix = pairs.find((pair) => pair.startsWith(BROWSER_AUTH_COOKIE_PREFIX))
  if (byPrefix !== undefined) return byPrefix

  // 改名兜底一：dsh- 开头且值够长（排除 feature flag 那种短值）。
  const byShape = pairs.find((pair) => {
    const eq = pair.indexOf('=')
    return pair.startsWith('dsh-') && eq > 0 && pair.length - eq - 1 >= 16
  })
  if (byShape !== undefined) return byShape

  // 兜底二：不猜名字就永远修不好 401，取第一个值足够长的。
  return pairs.find((pair) => {
    const eq = pair.indexOf('=')
    return eq > 0 && pair.length - eq - 1 >= 32
  })
}

/**
 * @param launchUrl - 返回带启动令牌的回环 URL（官方 connection 服务的 authenticatedUrl）。
 * @param fetchImpl - 可注入的 fetch（测试用）。
 * @param options.retryIntervalMs - 兑换失败后的冷却时间。
 */
export function createInnerAuth(launchUrl, fetchImpl = fetch, options = {}) {
  const retryIntervalMs = Number.isFinite(options.retryIntervalMs) && options.retryIntervalMs > 0
    ? options.retryIntervalMs
    : DEFAULT_RETRY_INTERVAL_MS
  let cached
  let inflight
  let cooldownUntil = 0

  const redeem = async () => {
    const url = launchUrl()
    if (url === undefined) return undefined
    try {
      // redirect: 'manual' 才能读到 303 上的 set-cookie，而不是被自动跟随。
      const response = await fetchImpl(url, { redirect: 'manual' })
      const cookie = pickCredentialCookie(response.headers.get('set-cookie') ?? '')
      if (cookie === undefined) cooldownUntil = Date.now() + retryIntervalMs
      return cookie
    } catch {
      cooldownUntil = Date.now() + retryIntervalMs
      return undefined
    }
  }

  return {
    /** 拿到 `name=value`，失败返回 undefined。 */
    ready() {
      if (cached !== undefined) return Promise.resolve(cached)
      if (Date.now() < cooldownUntil) return Promise.resolve(undefined)
      inflight ??= redeem().then(
        (value) => {
          if (value !== undefined) cached = value
          inflight = undefined
          return value
        },
        () => {
          inflight = undefined
          cooldownUntil = Date.now() + retryIntervalMs
          return undefined
        },
      )
      return inflight
    },
    /** 丢弃缓存，下次重新兑换（上游回 401 时调用）。 */
    invalidate() {
      cached = undefined
      // 上游刚拒过，立刻再换大概率还是被拒，先冷静一下。
      cooldownUntil = Date.now() + Math.min(retryIntervalMs, 1_000)
    },
  }
}
