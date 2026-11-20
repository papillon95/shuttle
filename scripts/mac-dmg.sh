#!/bin/bash
# 打 macOS 安装包（dmg）的备用办法：electron-builder 先打出 .app，再用 hdiutil create 直接从文件夹生成 dmg。
# 不需要把临时磁盘挂载上去再卸载，避开「hdiutil detach 资源忙（16）」的问题（Spotlight / Finder 占着临时磁盘时会出现）。
# 用法：scripts/mac-dmg.sh 0.3.15   → dist/Shuttle-<版本>-mac-arm64.dmg、dist/Shuttle-<版本>-mac-x64.dmg
set -euo pipefail
VERSION="$1"
cd "$(dirname "$0")/.."
npx electron-builder --mac dir --arm64 --x64
for pair in "arm64:dist/mac-arm64" "x64:dist/mac"; do
  arch="${pair%%:*}"
  dir="${pair#*:}"
  app="$dir/Shuttle.app"
  [ -d "$app" ] || { echo "找不到 $app"; exit 1; }
  stage="$(mktemp -d)"
  cp -R "$app" "$stage/"
  ln -s /Applications "$stage/Applications"
  out="dist/Shuttle-$VERSION-mac-$arch.dmg"
  rm -f "$out" "$out.blockmap"
  hdiutil create -volname "Shuttle $VERSION" -srcfolder "$stage" -fs HFS+ -format UDZO -imagekey zlib-level=9 -ov "$out"
  rm -rf "$stage"
  echo "✓ $out"
done
