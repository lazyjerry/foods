#!/usr/bin/env bash
# 把 node_modules 內的 Leaflet 複製到 public/vendor/leaflet（自行託管，不走 CDN）。
set -euo pipefail
cd "$(dirname "$0")/.."
src=node_modules/leaflet/dist
[ -f "$src/leaflet.js" ] || { echo "找不到 $src，請先執行 npm install" >&2; exit 1; }
dest=public/vendor/leaflet
rm -rf "$dest"
mkdir -p "$dest/images"
cp "$src/leaflet.js" "$src/leaflet.css" "$dest/"
cp "$src/images/"*.png "$dest/images/"
cp node_modules/leaflet/LICENSE "$dest/LICENSE.txt"
echo "已複製 Leaflet 到 $dest"

# SimpleWebAuthn 前端（通行金鑰），UMD 版，全域變數 SimpleWebAuthnBrowser
wa=public/vendor/simplewebauthn
rm -rf "$wa"
mkdir -p "$wa"
cp node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js "$wa/browser.umd.min.js"
cp node_modules/@simplewebauthn/browser/LICENSE.md "$wa/LICENSE.md"
echo "已複製 SimpleWebAuthn 到 $wa"
