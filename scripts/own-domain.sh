#!/bin/sh
# 把自己的域名接成固定入口（Cloudflare Tunnel，本地管理）。
#
#   ./scripts/own-domain.sh dsh.example.com
#
# 前提：域名已经托管在 Cloudflare（NS 指向 CF），并且你已经跑过
#   cloudflared tunnel login
# 一次（浏览器里选那个域名授权）。
#
# 这个脚本做四件事：建隧道 → 把 hostname 的 CNAME 指到隧道 → 写
# cloudflared config.yml → 把 desktop profile 切到 tunnel: named。
# 全程不需要 Cloudflare 的 API token，也不需要把任何密钥贴进聊天框。

set -eu

HOSTNAME_ARG="${1:-}"
if [ -z "$HOSTNAME_ARG" ]; then
  echo "用法: ./scripts/own-domain.sh <完整域名>   例如 ./scripts/own-domain.sh dsh.example.com" >&2
  exit 1
fi

TUNNEL_NAME="${DSH_TUNNEL_NAME:-dsh-remote}"
GATE_PORT="${DSH_GATE_PORT:-8790}"
CF="$HOME/.local/bin/cloudflared"
CF_DIR="$HOME/.cloudflared"
CONFIG="$CF_DIR/$TUNNEL_NAME.yml"
PROFILE_PATCH="$HOME/.dsh/profiles/desktop/cordis.patch.yml"

[ -x "$CF" ] || { echo "找不到 $CF（先装 cloudflared）" >&2; exit 1; }
[ -f "$CF_DIR/cert.pem" ] || {
  echo "还没有登录态。先跑：BROWSER=true $CF tunnel login" >&2
  echo "然后在浏览器里选你的域名授权。" >&2
  exit 1
}

echo "→ 1/4 建隧道 ${TUNNEL_NAME}（已存在就复用）"
if ! "$CF" tunnel list 2>/dev/null | awk '{print $2}' | grep -qx "$TUNNEL_NAME"; then
  "$CF" tunnel create "$TUNNEL_NAME"
fi
TUNNEL_ID=$("$CF" tunnel list 2>/dev/null | awk -v n="$TUNNEL_NAME" '$2==n{print $1; exit}')
[ -n "$TUNNEL_ID" ] || { echo "拿不到隧道 ID，先看 cloudflared tunnel list" >&2; exit 1; }
echo "   隧道 ID: $TUNNEL_ID"

echo "→ 2/4 把 ${HOSTNAME_ARG} 指向这条隧道"
"$CF" tunnel route dns "$TUNNEL_NAME" "$HOSTNAME_ARG"

echo "→ 3/4 写本地 config: $CONFIG"
cat > "$CONFIG" <<YAML
# dsh-remote 的固定入口（本地管理的隧道）。改 hostname 后重启插件即可。
tunnel: $TUNNEL_ID
credentials-file: $CF_DIR/$TUNNEL_ID.json

ingress:
  - hostname: $HOSTNAME_ARG
    service: http://127.0.0.1:$GATE_PORT
  # 其它 hostname 一律 404，别让这条隧道变成通用出口。
  - service: http_status:404
YAML
chmod 600 "$CONFIG"

echo "→ 4/4 把 desktop profile 切到 named 模式"
python3 - "$PROFILE_PATCH" "$CONFIG" "$HOSTNAME_ARG" <<'PY'
import pathlib, re, sys

patch, config_path, hostname = sys.argv[1], sys.argv[2], sys.argv[3]
p = pathlib.Path(patch)
text = p.read_text(encoding='utf-8')

block = f"""# dsh-remote：门控 + 固定域名反向穿透。
- id: dsh-remote
  name: '@local/dsh-remote'
  config:
    enabled: true
    bind: 127.0.0.1
    port: 8790
    tunnel: named
    tunnelConfig: {config_path}
    publicHostname: {hostname}
    requirePairing: true
    deviceTtlDays: 30
"""

# 已有 dsh-remote 块就整块替换（含注释行），没有就追加。
pattern = re.compile(r"(?:^# dsh-remote[^\n]*\n)?^- id: dsh-remote\n(?:^[ \t].*\n|^-\s*$\n?)*", re.M)
if 'id: dsh-remote' in text:
    # 从 "- id: dsh-remote" 一直吃到下一个顶层条目之前
    lines = text.splitlines(keepends=True)
    out, i = [], 0
    while i < len(lines):
        line = lines[i]
        if line.startswith('- id: dsh-remote'):
            i += 1
            while i < len(lines) and not lines[i].startswith('- '):
                i += 1
            out.append(block)
            continue
        out.append(line)
        i += 1
    text = ''.join(out)
    # 去掉可能重复的注释头
    text = re.sub(r"# dsh-remote[^\n]*\n(?=# dsh-remote)", "", text)
else:
    text = text.rstrip('\n') + '\n\n' + block

p.write_text(text, encoding='utf-8')
print(f"   已写入 {patch}")
PY

echo
echo "完成。App 会热重组，quick 隧道会被停掉、固定域名隧道接管。"
echo "  入口: https://${HOSTNAME_ARG}/"
echo "  配对码: 打开 http://127.0.0.1:${GATE_PORT}/__remote/ 看"
echo
echo "偶尔要看隧道日志: $CF tunnel --config $CONFIG run"
