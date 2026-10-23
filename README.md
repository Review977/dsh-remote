# dsh-remote —— 自己的 DSH 远程控制插件

用手机（或另一台电脑）安全地接管这台 Mac 上的 DeepSeek Harness 会话。

不是另做一套界面：手机打开的就是**同一份官方 Web GUI**，只是入口换成了我们自己的
「门控」——非本机请求必须先配对，配对通过后由门控以回环形状 + 进程自己的官方凭据
把请求转发给 `127.0.0.1` 上的官方服务。本机直连完全不受影响。

```
手机 / 另一台电脑
   │  http://<局域网IP>:8790/          （同一 Wi-Fi，直接连）
   │  https://xxx.trycloudflare.com/   （在外网，cloudflared 快速隧道）
   ▼
┌─────────────────────────────┐
│ dsh-remote 门控监听          │  ← 配对码 / 设备 cookie / 吊销都在这里
│  · 本机请求 → 直接放行        │
│  · 非本机 + 无 cookie → 配对页 │
│  · 已配对 → 加上官方凭据转发   │
└─────────────┬───────────────┘
              │  Host: 127.0.0.1:<port> + 进程自己的 dsh-auth cookie
              ▼
      官方 dsh web server（127.0.0.1:3999）
              └─ 官方 Web GUI + /api + WebSocket mux
```

## 它和 `@linxin666/dsh-remote-web-ui` 有什么不一样

借鉴了它的关键经验（内层官方凭据兑换、转发头一律视为远程、一次性配对码、
`Secure` cookie 只在 TLS 下加、uuid polyfill），但按自己的需求砍成了一个
**约 1400 行、零依赖、无构建步骤**的宿主插件：

| | 第三方插件 | 本插件 |
|---|---|---|
| 门控位置 | 官方 web server 上的 `/remote` 前缀 | 自己另起一个监听（默认 `127.0.0.1:8790`） |
| 客户端改写 | 需要往浏览器注入 boot 脚本重写 `fetch`/`WebSocket`/`src` | **不需要**——手机从门控加载界面，相对路径天然指向门控 |
| 浏览器半侧 | React 客户端插件（~5.5k 行） | 无（管理页是门控自己渲染的 HTML） |
| 代码量 | ~13.9k 行 TS | ~1400 行 JS，零依赖 |
| 构建 | tsc + tsdown | 无，直接是 ESM |
| 局域网绑定 | 改写 profile 的受管块 + 防火墙规则 | 门控自己绑 `bind: lan`，官方服务不动 |
| 隧道 | quick / named / 自建中继 | quick（够用就好） |
| 设备管理 | 客户端面板 | 本机 `http://127.0.0.1:8790/__remote/` |

## 安装

一条命令，`desktop` profile 也可以：

```sh
./scripts/install.sh            # 默认装进 desktop
./scripts/install.sh remotedev  # 装进别的 profile
```

装完**当场就生效**：正在运行的 App 会随 profile 变更热重组，插件立刻挂载
（实测：`plugin add` 之后 8790 端口立刻开始监听，不需要重启）。不放心就重启一次
App，行为一样。

脚本替你填了两个坑：

- App 自带的 pnpm 在 App 内部，而 dsh CLI 只从 PATH 找 pnpm → 脚本生成
  `scripts/bin/pnpm` 这个 shim 转过去（不需要你另外装 pnpm）。
- npm 版的 `dsh` CLI 拒绝管理 `desktop` profile（`profile "desktop" is managed
  exclusively by the Electron application`）→ 脚本改用 App 内置的
  `dsh-desktop-host` CLI，那个才管得了 desktop。

### 也可以从图形界面装

DSH 桌面端 → **设置 → 插件 → 添加插件 → 安装第三方插件 → 本地绝对路径**，填：

```
<本插件目录的绝对路径>
```

装完在插件页**启用**这一行。等价于上面那条命令。

### 卸载

```sh
APP="/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"
DCLI="/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js"
PATH="$PWD/scripts/bin:$PATH" ELECTRON_RUN_AS_NODE=1 "$APP" --expose-internals "$DCLI" \
  plugin --profile desktop remove @local/dsh-remote
```

## 使用

1. 在 Mac 上打开门控状态页（只有本机能开）：

   ```
   http://127.0.0.1:8790/__remote/          # 默认（bind: 127.0.0.1）
   http://192.168.0.239:8790/__remote/      # 配了 bind: lan 时改用局域网地址
   ```

   注意 `bind: lan` 之后门控只监听那个局域网地址，`127.0.0.1` 是不通的 ——
   在 Mac 上访问自己的局域网地址仍会被当作「本机」，所以状态页照样能开。

2. 页面上会显示**访问地址**和**6 位配对码**（5 分钟有效、只能用一次）。
3. 手机上打开访问地址 → 输入配对码 → 直接进入官方界面。
4. 状态页就是控制台，可以：
   - 看/吊销已配对设备（单个或全部）
   - **改隧道与域名**：模式（off / quick / named）、固定域名、cloudflared 配置路径、隧道 token、门控端口、监听地址、是否强制配对。保存后写进 profile 的受管块，App 自动重组，几秒就生效（实测：把端口从 8790 改成 8791，门控和隧道当场换过去了）
   - 这个表单**只有本机能提交**，公网访问者拿不到

### 连法：反向穿透优先

门控只听回环，公网入口靠 `cloudflared` **从里往外**拨——不需要公网 IP、
不用改路由器、不往局域网开任何口子。

| 模式 | 入口 | 代价 |
|---|---|---|
| `tunnel: quick` | `https://xxx.trycloudflare.com`（随机） | 零配置；**域名随重启变**，旧链接失效、已配对设备要重配（cookie 绑主机名） |
| `tunnel: named` | 你自己域名下的一条固定 hostname | 需要 Cloudflare 账号 + 一个域名；重启不换链接 |
| `bind: lan` | `http://<Mac的局域网IP>:8790/` | 只在同一 Wi-Fi 下有用，不算穿透 |

```
手机 ──https──> Cloudflare 边缘 ──反向隧道（Mac 主动外连）──> 门控 127.0.0.1:8790 ──> 官方 GUI
```

`named` 模式在 Cloudflare 后台建一条 tunnel，把 hostname 指到
`http://127.0.0.1:8790`，然后填两行配置：

```yaml
- id: dsh-remote
  config:
    tunnel: named
    tunnelToken: <eyJ... 后台给的 token>   # 也可以放环境变量 CLOUDFLARED_TUNNEL_TOKEN
    publicHostname: dsh.example.com        # 只用于状态页展示 URL
```

token 不进命令行参数（走 `TUNNEL_TOKEN` 环境变量），避免被其他进程从
`/proc/<pid>/cmdline` 读到。

### 用自己域名（固定入口，已跑通）

接上自己的域名之后是这样（下面用 `dsh.example.com` 举例）：

```
https://dsh.example.com/  →  门控 127.0.0.1:8790  →  官方 GUI
```

一条命令搞定（先 `cloudflared tunnel login` 一次，在浏览器里选域名授权）：

```sh
./scripts/own-domain.sh dsh.你的域名
```

它做四件事：建隧道（存在就复用）→ 给 hostname 挂 CNAME 指到隧道 →
写 `~/.cloudflared/dsh-remote.yml`（`ingress` 只放行这一条 hostname，其余
`http_status:404`，不让隧道变成通用出口）→ 把 desktop profile 切成
`tunnel: named` + `tunnelConfig`。

产物（都别外传）：

- `~/.cloudflared/cert.pem`（授权证书，600）
- `~/.cloudflared/<隧道uuid>.json`（隧道凭据，600）

### 插件页里也能进

「设置 → 插件 → 本插件」的详情页底下会多一块**远程门控**，直接显示门控页地址，点开就是状态页。
地址是宿主注入的（`window.__DSH_REMOTE_GATE__`），换端口也跟着变。

> **注入方式有讲究**：门控地址用 `webserver/index-inject` 的**结构化行**注入，不是
> `tapIndex`。因为 `tapIndex` 是 HTML 字符串改写，只有「HTTP 发 index」的载体（SPA
> dist 回退）会跑；桌面 App 的窗口走 `dsh://host` 自定义协议、index 由外壳自己渲染，
> 只认结构化行。用 `tapIndex` 时桌面窗口里 `__DSH_REMOTE_GATE__` 是 undefined，
> 这块就整个不渲染——而用 HTTP 访问却是好的，很难查。
>
> 两层缓存要注意：
> 1. 客户端插件的**包元数据缓存到重启**——第一次加上这个能力，要重启一次 App；
> 2. 之后每次改动 bundle、或者重新挂载插件，**已经打开的页面不会自动换模块图**，按 `⌘R` 刷新一下才看得到。
>
>
> **怎么确认它在你当前这个窗口里真的渲染了**：门控状态页有一行「插件页入口：已被窗口
> 渲染 N 次」。客户端半侧每次成功渲染都会回一条 `POST /__dsh-remote/seen`；N 一直是 0
> 就说明那个窗口的模块图里没有它（该刷新了），别再靠肉眼猜。

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖（**整行替换 config，要写全**）：

```yaml
- id: dsh-remote
  config:
    enabled: true
    bind: lan
    port: 8790
    tunnel: quick
    cloudflaredPath: /opt/homebrew/bin/cloudflared
    requirePairing: true
    deviceTtlDays: 30
    pairTtlSeconds: 300
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关；关掉后门控监听不启动 |
| `bind` | `127.0.0.1` | `127.0.0.1` / `lan`（自动选第一个非回环 IPv4）/ 具体 IPv4、IPv6 字面量 |
| `port` | `8790` | 门控监听端口；`0` 表示让系统分配 |
| `tunnel` | `off` | `off` / `quick`（随机域名）/ `named`（固定域名） |
| `tunnelToken` | `''` | `named` 模式的隧道 token；留空则读环境变量 `CLOUDFLARED_TUNNEL_TOKEN` |
| `publicHostname` | `''` | `named` 模式的固定域名，只用于在状态页显示入口 URL |
| `cloudflaredPath` | `''` | 留空则依次找 `CLOUDFLARED_BIN`、PATH、`~/.local/bin`、`~/bin`、`node_modules/cloudflared` |
| `requirePairing` | `true` | 非本机请求是否必须持配对 cookie。**只在完全可信的网络里才关** |
| `deviceTtlDays` | `30` | 设备会话有效期 |
| `pairTtlSeconds` | `300` | 配对码有效期 |

设备库落在 `~/.dsh/remote-gate/devices.json`（0600）。

### 卸载与进程生命周期

- **卸载插件即时停隧道**：`plugin remove` 之后门控和 cloudflared 都会在几秒内退出（实测：移除后 `pgrep cloudflared` 为空、8790 释放）。不然门控都下线了、公网入口还开着，等于留了个幽灵入口。
- **启动前清孤儿**：万一 App 被强杀，上一次的 cloudflared 可能还活着占着隧道。插件每次启动会先按「命令行逐字匹配自己那条」清掉（`--config <我们的配置>` 或 `--url http://<门控>`），**只碰自己起的进程**。
- **隧道断了自动重连**：cloudflared 退出后按 3s→10s→30s→60s 退避重连，成功后退避归零。
- 注意：每次重组/重启后，cloudflared 注册到边缘大约要 10–20 秒，这段时间公网是打不通的。

## 安全模型

**威胁模型**：公网扫描、暴力猜配对码、拿到链接的陌生人、反代带来的"看起来像本机"的请求。

已经做到的：

- **非本机一律先配对**。本机（回环 socket + 回环 Host + 无转发头）才免配对。
- **反代陷阱已处理**：cloudflared / nginx 是从 `127.0.0.1` 拨进来的，请求长得跟桌面
  一模一样；所以只要带 `CF-Connecting-IP` / `X-Forwarded-For` / `X-Real-IP` /
  `Forwarded` 中任意一个，就一律按远程处理。（这条不写，隧道就是一个无门的大门。）
- **配对码 6 位、5 分钟、一次性**，单个码每 IP 最多 8 次尝试，另有每 IP 12 次/5 分钟
  的失败节流。
- **设备 cookie 是 `HttpOnly` + `SameSite=Lax`**，`Secure` 只在请求经 TLS 到达时加
  （纯 HTTP 局域网下加 `Secure` 会被浏览器直接丢掉，静默失去会话）。
- **内层官方凭据绝不下发**：门控自己兑换进程的启动令牌，附在转发请求上；上游响应的
  `Set-Cookie` 被剥掉，客户端拿到的只有我们自己的设备 cookie。
- **Origin / 调用方 Cookie / Sec-Fetch-* 一律不转发**，只转发白名单请求头，并合成
  `sec-fetch-site: same-origin` 与 `Host: 127.0.0.1:<port>`。
- **吊销即时生效，含已经建好的长连接**：手机的整段界面跑在一条 WebSocket 上，只拉黑「新请求」等于没踢。门控记着每条连接属于哪台设备，吊销/全部吊销时会先发 `1001 going away` 再销毁 socket（实测：吊销后那条连接当秒断开）。
- 设备列表显示**在线/离线**（在线 = 这台设备此刻有活着的长连接）。
- 配对码默认 **120 秒**、一次性。
- 门控管理面（`/__remote/`）**只有本机能访问**，非本机得到 403。

已知的边界（自用可接受，发行前要补）：

- 配对码是 6 位数字，靠 TTL + 一次性 + 节流兜住爆破；要更硬就换成长随机串。
- WebSocket 握手只能靠 cookie（浏览器不让我们加头），没有单独的短时票据。
- 门控没有做 TLS，公网路径的 TLS 由 Cloudflare 终结；纯局域网是明文 HTTP。
- 只有 `quick` 隧道；没有 named tunnel / 自建中继，域名每次重启会变。
- 设备 secret 明文存在本地 JSON（0600）里，威胁模型不含"本机文件被读"。

## 开发与验证回路

不需要 DSH 源码 checkout，也不需要装 pnpm。App 自带 node 与 pnpm，
用 `ELECTRON_RUN_AS_NODE=1` 就能跑官方 CLI：

```sh
APP="/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"
CLI="/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"

# 造一个独立测试 profile（不影响 desktop）
ELECTRON_RUN_AS_NODE=1 "$APP" "$CLI" --profile remotedev --from-default-profile web --dump-config

# 装上本插件（脚本里带 pnpm shim）
./scripts/install.sh remotedev

# 起独立实例（另一个端口，另一个门控端口）
PATH="$(pwd)/scripts/bin:$PATH" ELECTRON_RUN_AS_NODE=1 "$APP" "$CLI" --profile remotedev --port 3999 --no-open
```

`scripts/install.sh` 会自动生成 `scripts/bin/pnpm` 这个 shim（把
`pnpm` 转发到 App 内置的 pnpm），因为官方 CLI 只会从 PATH 找 pnpm。

### 实测验证（全部跑通，含真机）

**在正在运行的桌面 App 上**（不是模拟环境）逐项实测：

| 项 | 结果 |
|---|---|
| 本机直连 `GET /` | 200，40988 字节，真实桌面 GUI |
| 远程未配对 `GET /` | 配对页 |
| 远程未配对 `GET /api/*` | 401 |
| 配对（6 位码） | 303 + `Set-Cookie`，`Max-Age=2592000` |
| 已配对 `GET /` | 200，真实 GUI，`dsh-remote-mobile` / `dsh-remote-polyfill` / `viewport-fit=cover` 均已注入 |
| 已配对 `/api/remote.mux` 升级 | `101 Switching Protocols` |
| 吊销设备后 | 401 |
| 门控绑定 | `127.0.0.1:8790`（回环），非 `*:8790` |

**公网链路**：真的下载 cloudflared 起了一条快速隧道
（`https://pants-projects-jerry-registry.trycloudflare.com`），在上面走完
配对 → 加载完整官方界面 → WebSocket 升级，公网 cookie 自动带 `Secure`。

**`bind: lan`**：绑到 `192.168.0.239:8791`（真实网卡，不是 `utun` 那个
`198.18.0.1`）；从 Mac 走局域网地址能打开状态页并拿到配对码；带转发头的请求
仍被拦在配对页。

### 验证过程中查出并修掉的两个真 bug

1. **门控绑到了所有网卡**。`normalizeConfig()` 只产出 `bind`，而门控读的是
   `config.bindAddress` —— 传进去是 `undefined`，`server.listen(port, undefined)`
   于是绑了 `0.0.0.0/::`。配置写的是 `127.0.0.1`，实际却在局域网上开了口子，
   状态页还显示「127.0.0.1」（谎报）。修法：把解析后的字面量放进配置，并在
   `gate.start()` 里加防呆——没有监听地址就直接拒绝启动，绝不退化成绑所有网卡。
   实测确认修复后是 `IPv4 127.0.0.1:8790`。
2. **`bind: lan` 时状态页打不开**（配对码就在那页上）。原来的「本机」判定要求
   socket 是回环，而绑到局域网地址后，Mac 自己访问也得走局域网地址。修法：
   「本机」= 源地址与 Host 都是本机自己的网卡地址（远程机器的源地址不可能是
   本机地址），且**没有转发头**——转发头那条是硬约束，反代就是从本机拨进来的。

## 换电脑 / 多台机器

插件本体（`index.js` + `lib/` + `cordis.patch.yml` + `package.json`）**零依赖、零写死路径**，
整目录拷过去就能跑：

```sh
# 旧机打包
tar czf dsn-remote.tgz --exclude scripts/bin -C "$(dirname "$PWD")" "$(basename "$PWD")"

# 新机解开并安装
tar xzf dsn-remote.tgz -C ~/Desktop
cd ~/Desktop/dsn-remote && ./scripts/install.sh
```

新机另外需要 cloudflared：`brew install cloudflared`，或直接把
`~/.local/bin/cloudflared` 拷过去。

### 域名怎么处理（这是唯一要想清楚的）

| 目标 | 做法 | 坑 |
|---|---|---|
| **新机取代旧机**（同一个域名） | 把 `~/.cloudflared/` 整个拷过去（`cert.pem`、`<uuid>.json`、`dsh-remote.yml`），**旧机必须停掉隧道**（退出 App，或从旧机 profile 里去掉 `tunnel`） | 同一条隧道同时连两台，Cloudflare 会在两条连接间轮询，你会看到「一会儿这台机的会话、一会儿那台」，非常难排查 |
| **两台并存** | 新机跑 `./scripts/own-domain.sh dsh2.你的域名`，会自动建**新**隧道 + 新 CNAME | 无冲突，两台各用一个 hostname |
| **新机重新授权** | 新机 `BROWSER=true ~/.local/bin/cloudflared tunnel login`，再 `./scripts/own-domain.sh dsh.你的域名` | 会复用同名隧道 → 回到第一种的冲突，除非旧机已停 |

**已配对设备**：拷 `~/.dsh/remote-gate/devices.json` 可保留（设备 cookie 绑的是
hostname，域名不变就不用重配）；不拷就在手机上重配一次。

**会话与工作区数据**在 `~/.dsh/`（`sessions/`、`storages/workspace.json` 等），
跟插件无关；要一起搬再拷，体积可能不小。

**跨平台**：插件是纯 Node ESM，没有平台相关代码；但 `scripts/*.sh` 假设 App 在
`/Applications/DeepSeek Harness.app`，换平台要改这两行。

## 借鉴对照（`Misaka10091/dsh-remote-control`）

那个仓库是同类实现里更成熟的一份，架构选的是同一条路（自建监听 + 只做鉴权的反代，
官方端口始终留回环）。已经吸收的：

| 借鉴点 | 落成什么 |
|---|---|
| 吊销要关闭活着的 socket | 门控维护 `设备 → socket` 表，吊销/全部吊销/卸载时发 `1001` 再销毁 |
| 内层凭据不能假设 cookie 名字 | `pickCredentialCookie()`：先认 `dsh-auth-`，再认 `dsh-` + 长值，最后取任意长值 cookie；兑换失败进 5 秒冷却，不再按请求重试 |
| 配对码要短命 | 300 秒 → **120 秒** |
| 设备在线状态 | 用 socket 表直接算，列表里标「在线/离线」 |

还没吸收、但值得考虑的（按性价比排）：

- **扫码配对**。他们把密钥放在 URL 的 **fragment** 里（`#...`），fragment 不会进
  服务器日志，这点比我手输 6 位码更干净。代价是要一个 QR 编码器（自带约 250 行，
  或引入一个依赖，破坏零依赖）。
- **本地审计**（`audit-YYYY-MM-DD.jsonl`，保留 30 天，只删自己命名的文件，**从不
  记录正文**，还会按「够长的 token 形状」把值判定为敏感而丢弃）。远程入口有审计
  确实更有底，约 150 行。
- **cloudflared 自动下载**（sha256 取自 GitHub release API、有字节上限与超时、
  原子改名、只在显式点击时触发）。我现在是「找不到就报错并提示 brew 装」。

明确不打算照抄的：

- **`dsh.plugin.json`**：那个文件是作者自己的打包元数据，DSH 官方代码里
  （`dsh-package-manifest` / `dsh-plugin-manager`）**一次都没引用**，加了没用。
- **JWT 设备令牌**：不透明随机串已经够用，JWT 只多出一套密钥轮换面。

另外一条**反过来**的经验：他们 README 写「`desktop` profile 由桌面应用托管，会拒绝
CLI 插件命令」——这点我这边绕过去了：App 内置的 `dsh-desktop-host` CLI 能管 desktop
profile（`scripts/install.sh` 用的就是它），所以装机不用走图形界面。

## 文件

| 文件 | 作用 |
|---|---|
| `index.js` | 插件入口：配置归一化、启动门控与隧道、往官方 index 注入手机适配与 uuid polyfill |
| `lib/gate.js` | 门控监听：准入判定、配对接口、HTTP/WebSocket 反向代理 |
| `lib/devices.js` | 配对码（一次性 + 节流）与设备会话（落盘、吊销） |
| `lib/inner-auth.js` | 兑换进程自己的官方浏览器凭据 |
| `lib/tunnel.js` | cloudflared 快速隧道的查找、拉起与地址解析 |
| `lib/pages.js` | 状态页（含隧道/域名配置表单）与配对页（纯 HTML） |
| `lib/profile-config.js` | 找 profile、读写受管配置块 |
| `lib/client.js` | 客户端半侧：插件页里的「远程门控」入口（手写 bundle，零构建） |
| `lib/net.js` | 「本机请求」判定（含反代陷阱与 `bind: lan` 情形）、局域网地址挑选、Cookie、HTML 转义 |
| `cordis.patch.yml` | 插件自己的 patch 层（含默认配置） |
| `scripts/install.sh` | 装进指定 profile（desktop 也支持） |
| `scripts/own-domain.sh` | 一次性接上自己的域名（建隧道 / 绑 DNS / 写配置 / 切 profile） |

## 下一步可以做的

- 配对页出二维码（现在要手输 6 位码；加个纯 JS 的 QR 编码器即可，不用依赖）
- named tunnel（固定域名，重启不换链接）
- 只读模式 / 按会话授权（官方 `remoteAccess` 那套 role/policy 已经在 base 里）
- 门控自己上 TLS（`ctx.webServer` 的 `tls` 只服务官方监听，门控要自己读证书）
