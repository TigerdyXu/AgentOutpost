#!/bin/sh
# 前哨 (Outpost) installer: puts the latest release into DeepSeek Harness desktop (macOS).
#   curl -fsSL https://raw.githubusercontent.com/TigerdyXu/AgentOutpost/master/install.sh | sh
# Run it again to update. Settings you changed in 前哨 are kept.
# Env: OUTPOST_HOME (default ~/.outpost: data/, packages/, backup/), OUTPOST_DATA (data dir, default $OUTPOST_HOME/data).
set -eu

REPO=TigerdyXu/AgentOutpost
ASSET=dsh-outpost.tgz
APP="/Applications/DeepSeek Harness.app"
DSH="$APP/Contents/Resources/runtime/cli/bin/dsh"
PROFILE="$HOME/.dsh/profiles/desktop"
OUTPOST_HOME="${OUTPOST_HOME:-$HOME/.outpost}"
DATA_DIR="${OUTPOST_DATA:-$OUTPOST_HOME/data}"
BROWSER_PKGS="@deepseek-ai/dsh-browser-use@0.2.3-alpha.2 @deepseek-ai/dsh-experimental-browser-use-playwright-mcp@0.2.3-alpha.2"

say() { printf '%s\n' "$*"; }
die() { printf '✗ %s\n' "$*" >&2; exit 1; }

[ -x "$DSH" ] || die "没找到 DeepSeek Harness 桌面版（$APP）。先装好桌面版（0.2.3-alpha.2 系列）再来。"
if pgrep -x "DeepSeek Harness" >/dev/null 2>&1; then
  die "DeepSeek Harness 正在运行。等手上的会话跑完，⌘Q 退出后再运行这条命令。"
fi

# 1. Download the latest release into a folder that stays (the profile remembers this path).
mkdir -p "$OUTPOST_HOME/packages"
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  TAG=$(gh release view --repo "$REPO" --json tagName -q .tagName)
  PKG="$OUTPOST_HOME/packages/dsh-outpost-$TAG.tgz"
  gh release download "$TAG" --repo "$REPO" --pattern "$ASSET" --output "$PKG" --clobber
else
  TAG=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest" | sed 's#.*/tag/##')
  [ -n "$TAG" ] && [ "$TAG" != "latest" ] || die "拿不到最新版本，检查一下网络（需要能访问 github.com）。"
  PKG="$OUTPOST_HOME/packages/dsh-outpost-$TAG.tgz"
  curl -fsSL "https://github.com/$REPO/releases/download/$TAG/$ASSET" -o "$PKG"
fi
say "✓ 下载 前哨 $TAG"

# 2. Back up the profile files the install rewrites.
BACKUP="$OUTPOST_HOME/backup/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP"
for f in package.json cordis.patch.yml pnpm-lock.yaml; do
  [ -f "$PROFILE/$f" ] && cp -p "$PROFILE/$f" "$BACKUP/"
done
say "✓ 备份配置到 $BACKUP"

# 3. Install (remove first: the version number stays 0.1.0, so a plain add would keep the old files).
INSTALLED=$("$DSH" plugin --profile desktop list 2>/dev/null || true)
case "$INSTALLED" in *dsh-outpost@*) "$DSH" plugin --profile desktop remove dsh-outpost >/dev/null ;; esac
MISSING=""
for p in $BROWSER_PKGS; do
  case "$INSTALLED" in *"$p"*) ;; *) MISSING="$MISSING $p" ;; esac
done
# shellcheck disable=SC2086 # MISSING is a space-separated package list
"$DSH" plugin --profile desktop add "$PKG" $MISSING >/dev/null
say "✓ 装进桌面版"

# 4. Tell 前哨 where to keep its data, once (an existing outpost entry, with your settings, is left as it is).
PATCH="$PROFILE/cordis.patch.yml"
if ! grep -q '^- id: outpost$' "$PATCH" 2>/dev/null; then
  mkdir -p "$DATA_DIR"
  [ -s "$PATCH" ] && [ -n "$(tail -c1 "$PATCH")" ] && printf '\n' >> "$PATCH"
  printf -- '- id: outpost\n  config:\n    dataDir: %s\n' "$DATA_DIR" >> "$PATCH"
  say "✓ 数据放在 $DATA_DIR"
fi

[ -d "/Applications/Google Chrome.app" ] || say "! 没找到 Google Chrome：公众号、知乎这类要验证的网页打不开，相关动态会标「待确认」。"

open -a "DeepSeek Harness"
say "装好了。在侧栏点「前哨」，从「＋ 新赛道」开始。"
