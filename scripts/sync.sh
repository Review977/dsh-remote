#!/bin/sh
# 把当前目录的插件代码同步进某个 profile 的已安装副本。
#
#   ./scripts/sync.sh            # desktop
#   ./scripts/sync.sh remotedev
#
# 为什么需要这一步：GUI 里装的插件是 GitHub 快照（profile 的 package.json 里
# 写的是 github:Review977/dsh-remote），装完就成了一份独立的拷贝。改这个目录
# 里的代码**不会**进入那份拷贝 —— 端口还在跑旧代码，改了半天以为没生效。
#
# 宿主模块按 URL 缓存，同步完必须重启 App 才会换掉已加载的代码；
# 重启后拿 http://127.0.0.1:<port>/__remote/health 的 version 核对。

set -eu

PROFILE="${1:-desktop}"
HERE=$(cd "$(dirname "$0")/.." && pwd)
DST="$HOME/.dsh/profiles/$PROFILE/node_modules/@local/dsh-remote"

if [ ! -d "$DST" ]; then
  echo "没找到已安装的插件：$DST" >&2
  echo "先用 ./scripts/install.sh $PROFILE 装一次。" >&2
  exit 1
fi

VERSION=$(grep -m1 '"version"' "$HERE/package.json" | sed 's/.*: *"\(.*\)".*/\1/')

echo "→ 同步 ${HERE} → ${DST}（版本 ${VERSION}）"
cp "$HERE/index.js" "$DST/index.js"
cp "$HERE/package.json" "$DST/package.json"
[ -f "$HERE/cordis.patch.yml" ] && cp "$HERE/cordis.patch.yml" "$DST/cordis.patch.yml"
[ -f "$HERE/README.md" ] && cp "$HERE/README.md" "$DST/README.md"
mkdir -p "$DST/lib"
cp "$HERE"/lib/*.js "$DST/lib/"
# 图标 / manifest 是插件的一部分，也跟着走。
rm -rf "$DST/lib/icons"
cp -R "$HERE/lib/icons" "$DST/lib/icons"
mkdir -p "$DST/test"
cp "$HERE"/test/*.js "$DST/test/"

echo "同步好了。接下来："
echo "  1) 重启 App（宿主模块按 URL 缓存，不重启不换代码）"
echo "  2) 打开状态页后硬刷新一次（旧页面里没有表单令牌）"
echo "  3) 核对版本：curl -s http://127.0.0.1:8790/__remote/health"
echo "     期望 \"version\":\"$VERSION\"，不是就说明跑的还是旧代码"
