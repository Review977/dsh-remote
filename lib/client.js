/**
 * 客户端半侧：在「设置 → 插件 → 本插件」的详情页里加一块「远程门控」，
 * 显示门控页面的地址，点一下就打开。
 *
 * 手写的 bundle，不打 JSX、不引入构建步骤：格式就是官方那套
 * `// 自检用：浏览器里执行过什么，一眼能看出来（排查「插件页没有这块」时很有用）。
window.__DSH_REMOTE_CLIENT__ = { loaded: true, applied: false, registered: false, renders: 0, lastSubject: null, error: null }

window.__ModuleLoader__.load({ id, factory })`，factory 里用
 * `require('react')` 拿宿主提供的 React。这样整个插件仍然零依赖、零构建。
 *
 * 门控地址由宿主侧注入到 `window.__DSH_REMOTE_GATE__`（端口可配，不能写死）。
 */

// 自检用：浏览器里执行过什么，一眼能看出来（排查「插件页没有这块」时很有用）。
window.__DSH_REMOTE_CLIENT__ = { loaded: true, applied: false, registered: false, renders: 0, lastSubject: null, error: null }

window.__ModuleLoader__.load({
  id: '@local/dsh-remote',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    try {
    var React = require('react')
    var h = React.createElement

    var PKG = '@local/dsh-remote'

    /** 从 subject 里认出是不是我们自己这一页。 */
    function ownSubject(subject) {
      try {
        var pkg = subject && subject.pkg
        if (!pkg) return false
        var name = pkg.name || pkg.packageName || pkg.id
        return name === PKG
      } catch (error) {
        return false
      }
    }

    /** 已取到的门控地址（全局注入 + 接口兜底都写这里）。 */
    var resolvedUrl = ''

    /** 门控页面地址：优先宿主注入，其次接口。 */
    function gateUrl() {
      if (resolvedUrl) return resolvedUrl
      try {
        var value = window.__DSH_REMOTE_GATE__
        if (typeof value === 'string' && value.length > 0) {
          resolvedUrl = value
          return value
        }
      } catch (error) { /* ignore */ }
      return ''
    }

    var fetching = false

    /**
     * 兜底取址：相对路径 fetch 在 HTTP 载体和桌面外壳（IPC 桥）里都通。
     * 为什么需要它——桌面窗口走 dsh://host，外壳自己渲染 index，可能比门控
     * 先渲染完，那时全局还没注入。取到之后 setState 触发重渲染。
     */
    function resolveFromHost(setUrl, setFailed) {
      if (fetching || resolvedUrl) return
      fetching = true
      try {
        Promise.resolve(fetch('/__dsh-remote/gate', { cache: 'no-store' }))
          .then(function (response) { return response.ok ? response.json() : null })
          .then(function (data) {
            var url = data && typeof data.url === 'string' ? data.url : ''
            if (url.length > 0) {
              resolvedUrl = url
              setUrl(url)
            }
          })
          .catch(function () { if (setFailed) setFailed(true) })
          .then(function () { fetching = false })
      } catch (error) {
        fetching = false
      }
    }

    /**
     * 插件页里的「远程门控」区块。
     * 不是我们这一页、或者没拿到地址时返回 null，不占位。
     */
    function GateSection(props) {
      var subject = props && props.subject
      // hooks 必须无条件调用，所以放在任何 return 之前。
      var state = React.useState(gateUrl())
      var url = state[0]
      var setUrl = state[1]
      var failedState = React.useState(false)
      var failed = failedState[0]
      var setFailed = failedState[1]
      React.useEffect(function () { resolveFromHost(setUrl, setFailed) }, [url])
      try {
        window.__DSH_REMOTE_CLIENT__.renders += 1
        window.__DSH_REMOTE_CLIENT__.lastSubject = subject ? {
          kind: subject.kind,
          name: subject.pkg && (subject.pkg.name || subject.pkg.packageName),
          keys: Object.keys(subject),
          pkgKeys: subject.pkg ? Object.keys(subject.pkg) : null,
        } : null
      } catch (error) { /* 自检失败不影响渲染 */ }
      if (!ownSubject(subject)) return null
      try {
        if (!window.__DSH_REMOTE_SEEN__) {
          window.__DSH_REMOTE_SEEN__ = true
          fetch('/__dsh-remote/seen', { method: 'POST', cache: 'no-store' }).catch(function () {})
        }
      } catch (error) { /* 回报失败不影响渲染 */ }
      if (url.length === 0) {
        // 地址还没到手：给占位，别让这一块凭空消失又突然出现；
        // 取址也失败了就说明白，不然会一直停在「正在读取」。
        return h('div', { style: { fontSize: 13, opacity: 0.7, marginTop: 12 } },
          failed ? '远程门控：地址没取到，重启一次 App 后再看' : '远程门控：正在读取门控地址…')
      }

      var card = {
        border: '1px solid rgba(127,127,127,0.28)',
        borderRadius: 10,
        padding: '12px 14px',
        marginTop: 12,
        fontSize: 13,
        lineHeight: 1.6,
      }
      var label = { fontWeight: 600, marginBottom: 6 }
      var link = {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 12,
        wordBreak: 'break-all',
        textDecoration: 'underline',
      }
      var hint = { opacity: 0.7, marginTop: 6 }

      return h('div', { style: card },
        h('div', { style: label }, '远程门控'),
        h('a', { href: url, target: '_blank', rel: 'noreferrer', style: link }, url),
        h('div', { style: hint }, '在这儿配对手机、看已连设备、改隧道与域名。只在本机可打开。'))
    }

    /** 客户端插件入口。 */
    function apply(ctx) {
      try {
        window.__DSH_REMOTE_CLIENT__.applied = true
        ctx.slots.inject('plugins.detail.section', function () {
          var dispose = ctx.slots.register(
            { name: 'plugins.detail.section', id: 'dsh-remote-gate', order: 5 },
            GateSection,
          )
          window.__DSH_REMOTE_CLIENT__.registered = true
          return dispose
        })
      } catch (error) {
        // 客户端出错不该影响整个界面。
        window.__DSH_REMOTE_CLIENT__.error = String(error && error.message ? error.message : error)
        console.warn('[dsh-remote] 注册插件页区块失败：', error)
      }
    }

    exports.apply = apply
    exports.inject = ['slots']
    } catch (error) {
      // 客户端半侧整体兜底：宁可这块不渲染，也不能让插件页/整个界面挂掉。
      try { window.__DSH_REMOTE_CLIENT__.error = String(error && error.message ? error.message : error) } catch (e) { /* ignore */ }
      console.warn('[dsh-remote] client bundle 初始化失败：', error)
    }
    return module.exports
  },
})
