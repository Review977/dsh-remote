/**
 * 门控自己渲染的两张页面：本机状态页与手机配对页。
 * 刻意不用客户端插件（React bundle），纯 HTML —— 少一半工程量，
 * 也少一个构建步骤。
 */

import { escapeHtml } from './net.js'

const BASE_CSS = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  margin: 0; padding: 20px 16px 48px;
  font: 15px/1.6 -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
  background: #f6f7f9; color: #1b1f24;
}
@media (prefers-color-scheme: dark) {
  body { background: #16181c; color: #e8eaed; }
  .card { background: #212429 !important; border-color: #32363d !important; }
  .muted { color: #9aa0a6 !important; }
  code, .url { background: #2b2f36 !important; }
  input, button { background: #2b2f36; color: #e8eaed; border-color: #3c4149; }
  .primary { background: #3b6cf6 !important; color: #fff !important; border-color: #3b6cf6 !important; }
  .danger { color: #ff8a80 !important; border-color: #5a3a3a !important; }
}
.wrap { max-width: 640px; margin: 0 auto; }
h1 { font-size: 20px; margin: 0 0 4px; }
h2 { font-size: 15px; margin: 0 0 10px; color: #5f6368; font-weight: 600; }
.card { background: #fff; border: 1px solid #e3e6ea; border-radius: 12px; padding: 16px; margin: 0 0 14px; }
.muted { color: #5f6368; font-size: 13px; }
.row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.between { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
code, .url {
  font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
  background: #f1f3f5; padding: 3px 6px; border-radius: 6px; word-break: break-all;
}
.code {
  font: 700 34px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace;
  letter-spacing: 6px; padding: 10px 0;
}
input, select, button {
  font: inherit; padding: 9px 12px; border-radius: 8px;
  border: 1px solid #d5d9de; background: #fff; color: inherit;
}
select { width: 100%; }
label.check { display: flex; align-items: center; gap: 8px; font-size: 14px; }
label.check input { width: auto; }
input { width: 100%; font-size: 16px; }
button { cursor: pointer; }
.primary { background: #1b1f24; color: #fff; border-color: #1b1f24; font-weight: 600; }
.danger { color: #c5221f; border-color: #e8c4c2; background: transparent; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { text-align: left; padding: 7px 6px; border-bottom: 1px solid #eceef1; vertical-align: top; }
th { color: #5f6368; font-weight: 600; }
.pill { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; border: 1px solid #d5d9de; }
.ok { color: #137333; border-color: #b7dfc2; }
.warn { color: #b06000; border-color: #f0d7a8; }
.err { color: #c5221f; border-color: #e8c4c2; }
form { margin: 0; }
.stack > * + * { margin-top: 10px; }
`

function page(title, body) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>${BASE_CSS}</style>
</head>
<body><div class="wrap">${body}</div></body>
</html>
`
}

/** 手机端：输入配对码。 */
export function pairPage({ message, gateName } = {}) {
  const alert = message === undefined ? '' : `<p class="pill err">${escapeHtml(message)}</p>`
  return page('配对这台设备', `
<h1>配对这台设备</h1>
<p class="muted">${escapeHtml(gateName ?? 'DSH 远程门控')} · 在 Mac 上打开门控状态页，把 6 位配对码填进来。</p>
<div class="card stack">
  ${alert}
  <form method="POST" action="/__remote/join">
    <label class="muted" for="code">配对码</label>
    <input id="code" name="code" inputmode="numeric" autocomplete="one-time-code"
           pattern="[0-9]{6}" maxlength="6" placeholder="000000" autofocus required>
    <div style="height:10px"></div>
    <button class="primary" type="submit" style="width:100%">配对</button>
  </form>
  <p class="muted">配对码 2 分钟内有效，只能用一次。配对成功后这台设备在有效期内可直接打开完整界面。</p>
</div>
`)
}

/** 手机端：配对失败。 */
export function pairFailedPage(reason) {
  return page('配对失败', `
<h1>配对失败</h1>
<div class="card stack">
  <p class="pill err">${escapeHtml(reason)}</p>
  <p class="muted">回到 Mac 的状态页重新生成一个配对码，再试一次。</p>
  <a href="/"><button class="primary" type="button" style="width:100%">返回</button></a>
</div>
`)
}

/** 本机状态页。 */
export function statusPage(state) {
  const { listen, upstream, tunnel, code, devices, gateName, requirePairing, warnings, config, clientSeen } = state
  const codeBlock = code === undefined
    ? `<p class="muted">当前没有有效配对码。</p>`
    : `<div class="code">${escapeHtml(code.code)}</div>
       <p class="muted">有效至 ${escapeHtml(new Date(code.expiresAt).toLocaleTimeString('zh-CN'))}</p>`

  const deviceRows = devices.length === 0
    ? `<tr><td colspan="4" class="muted">还没有配对过任何设备。</td></tr>`
    : devices.map((device) => `
      <tr>
        <td>${escapeHtml(device.name)} ${device.online ? '<span class="pill ok">在线</span>' : '<span class="pill">离线</span>'}</td>
        <td class="muted">${escapeHtml(device.ip ?? '-')}</td>
        <td class="muted">${escapeHtml(new Date(device.lastSeenAt).toLocaleString('zh-CN'))}</td>
        <td><form method="POST" action="/__remote/revoke">
          <input type="hidden" name="id" value="${escapeHtml(device.id)}">
          <button class="danger" type="submit">吊销</button>
        </form></td>
      </tr>`).join('')

  const tunnelPill = tunnel.status === 'running'
    ? `<span class="pill ok">已连接</span>`
    : tunnel.status === 'failed'
      ? `<span class="pill err">失败</span>`
      : `<span class="pill">${escapeHtml(tunnel.status)}</span>`

  const addresses = state.addresses.length === 0
    ? `<p class="muted">没有可用的访问地址（门控只监听回环，且隧道未开启）。</p>`
    : state.addresses.map((item) => `<div class="url">${escapeHtml(item)}</div>`).join('<div style="height:6px"></div>')

  const warnBlock = warnings.length === 0 ? '' : `
<div class="card">
  <h2>提醒</h2>
  ${warnings.map((text) => `<p class="muted">· ${escapeHtml(text)}</p>`).join('')}
</div>`

  return page('DSH 远程门控', `
<h1>${escapeHtml(gateName)}</h1>
<p class="muted">本页只在本机可见。手机连上下面任一地址后输入配对码即可接管界面。</p>

<div class="card">
  <h2>访问地址</h2>
  ${addresses}
  <p class="muted" style="margin-top:10px">门控监听 <code>${escapeHtml(listen)}</code> → 上游 <code>${escapeHtml(upstream)}</code></p>
  <p class="muted">插件页入口：${clientSeen !== undefined && clientSeen.count > 0
    ? `已被窗口渲染 <b>${String(clientSeen.count)}</b> 次（最近 ${escapeHtml(new Date(clientSeen.lastAt).toLocaleTimeString('zh-CN'))}）`
    : '还没有任何窗口渲染过 —— 插件页里那块「远程门控」没出现时，看这里就能判断是客户端半侧没跑，还是你没刷新'}</p>
</div>

<div class="card">
  <h2>配对码</h2>
  ${codeBlock}
  <div style="height:12px"></div>
  <form method="POST" action="/__remote/pair">
    <button class="primary" type="submit">生成新的配对码</button>
  </form>
  <p class="muted" style="margin-top:10px">要求配对：${requirePairing ? '是（非本机请求必须配对）' : '<b>否（任何人都能进，请谨慎）</b>'}</p>
</div>

<div class="card">
  <h2>出网隧道</h2>
  <div class="between">
    <div>${tunnelPill}</div>
    <div class="muted">${escapeHtml(tunnel.detail)}</div>
  </div>
  ${tunnel.url === undefined ? '' : `<div style="height:10px"></div><div class="url">${escapeHtml(tunnel.url)}</div>`}
</div>

<div class="card">
  <h2>隧道与域名</h2>
  <form method="POST" action="/__remote/config" class="stack">
    <div>
      <label class="muted" for="tunnel">模式</label>
      <select id="tunnel" name="tunnel">
        <option value="off"${config.tunnel === 'off' ? ' selected' : ''}>off —— 只在本机 / 局域网</option>
        <option value="quick"${config.tunnel === 'quick' ? ' selected' : ''}>quick —— 随机域名（重启会变）</option>
        <option value="named"${config.tunnel === 'named' ? ' selected' : ''}>named —— 固定域名</option>
      </select>
    </div>
    <div>
      <label class="muted" for="publicHostname">固定域名（named）</label>
      <input id="publicHostname" name="publicHostname" placeholder="dsh.example.com"
             value="${escapeHtml(config.publicHostname ?? '')}">
    </div>
    <div>
      <label class="muted" for="tunnelConfig">cloudflared 配置路径（named，推荐）</label>
      <input id="tunnelConfig" name="tunnelConfig" placeholder="~/.cloudflared/dsh-remote.yml"
             value="${escapeHtml(config.tunnelConfig ?? '')}">
    </div>
    <div>
      <label class="muted" for="tunnelToken">隧道 token（named，且不想用配置文件时）</label>
      <input id="tunnelToken" name="tunnelToken" type="password" autocomplete="off"
             placeholder="${config.tunnelToken ? '已设置，留空则保持不变' : '留空表示不用'}">
    </div>
    <div>
      <label class="muted" for="port">门控端口</label>
      <input id="port" name="port" type="number" min="1" max="65535" value="${String(config.port)}">
    </div>
    <div>
      <label class="muted" for="bind">监听</label>
      <select id="bind" name="bind">
        <option value="127.0.0.1"${config.bind === '127.0.0.1' ? ' selected' : ''}>127.0.0.1 —— 只回环（配隧道时用这个）</option>
        <option value="lan"${config.bind !== '127.0.0.1' ? ' selected' : ''}>lan —— 局域网地址直连</option>
      </select>
    </div>
    <label class="check"><input type="checkbox" name="requirePairing"${requirePairing ? ' checked' : ''}> 非本机请求必须配对</label>
    <button class="primary" type="submit">保存并重启门控</button>
    <p class="muted">保存会写进 profile 的 <code>cordis.patch.yml</code>（受管块），App 会自动重组，几秒后本页刷新即可。</p>
  </form>
</div>

<div class="card">
  <h2>已配对设备（${devices.length}）</h2>
  <table>
    <thead><tr><th>设备</th><th>来源</th><th>最近活跃</th><th></th></tr></thead>
    <tbody>${deviceRows}</tbody>
  </table>
  ${devices.length === 0 ? '' : `
  <div style="height:12px"></div>
  <form method="POST" action="/__remote/revoke-all">
    <button class="danger" type="submit">吊销全部设备</button>
  </form>`}
</div>
${warnBlock}
`)
}

/** 服务端错误页。 */
export function errorPage(status, message) {
  return page('出错了', `
<h1>${status}</h1>
<div class="card"><p class="muted">${escapeHtml(message)}</p></div>
`)
}
