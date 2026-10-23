#!/bin/sh
# 把 dsh-remote 装进一个 dsh profile（desktop 也可以）。
#
#   ./scripts/install.sh            # 默认 desktop
#   ./scripts/install.sh remotedev  # 别的 profile
#
# 两个坑，脚本都替你填了：
# 1. App 自带的 pnpm 在 App 内部，而 CLI 只从 PATH 找 pnpm —— 这里生成一个 shim。
# 2. npm 版的 dsh CLI 会拒绝管理 desktop profile（"managed exclusively by the
#    Electron application"）；能管它的是 App 内置的 dsh-desktop-host CLI。

set -eu

PROFILE="${1:-desktop}"
HERE=$(cd "$(dirname "$0")/.." && pwd)
APP="/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"
ASAR="/Applications/DeepSeek Harness.app/Contents/Resources/app.asar"
DESKTOP_CLI="$ASAR/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js"
NPM_CLI="$ASAR/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"
PNPM_MJS="$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.mjs"

if [ ! -x "$APP" ]; then
  echo "找不到 DeepSeek Harness：$APP" >&2
  exit 1
fi
# 注意：不能对 asar 里的路径用 test -f —— 只有 Electron 打过补丁的 fs 认得它。
if [ ! -f "$ASAR" ]; then
  echo "找不到 App 的 app.asar：$ASAR" >&2
  exit 1
fi
if [ ! -f "$PNPM_MJS" ]; then
  echo "找不到 App 自带的 pnpm：$PNPM_MJS" >&2
  exit 1
fi

# pnpm shim：官方 CLI 会 exec `pnpm`，这里把它转发到 App 内置的 pnpm。
SHIM_DIR="$HERE/scripts/bin"
mkdir -p "$SHIM_DIR"
cat > "$SHIM_DIR/pnpm" <<EOF
#!/bin/sh
export ELECTRON_RUN_AS_NODE=1
exec "$APP" --expose-internals "$PNPM_MJS" "\$@"
EOF
chmod +x "$SHIM_DIR/pnpm"

echo "→ 把 $HERE 装进 profile: $PROFILE"
if [ -f "$ASAR" ] && ELECTRON_RUN_AS_NODE=1 "$APP" --expose-internals "$DESKTOP_CLI" --version >/dev/null 2>&1; then
  # desktop profile 只有这个 CLI 能管；对普通 profile 也完全适用。
  PATH="$SHIM_DIR:$PATH" ELECTRON_RUN_AS_NODE=1 "$APP" --expose-internals "$DESKTOP_CLI" \
    plugin --profile "$PROFILE" add "link:$HERE"
else
  PATH="$SHIM_DIR:$PATH" ELECTRON_RUN_AS_NODE=1 "$APP" "$NPM_CLI" \
    plugin --profile "$PROFILE" add "link:$HERE"
fi

echo
echo "装好了。接下来："
echo "  1) profile 的 package.json 里 dsh.profile.bundles 应包含 @local/dsh-remote"
echo "  2) 正在运行的 App 会随 profile 变更热重组，插件当场挂载；不放心就重启一次"
echo "  3) 在 Mac 上打开门控状态页拿配对码：http://127.0.0.1:8790/__remote/"
echo "     （配置了 bind: lan 就改成 http://<局域网IP>:8790/__remote/）"
