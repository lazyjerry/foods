#!/usr/bin/env bash
# 重拍 README 的網站截圖與操作影片。
# 用法：bash scripts/readme-media.sh [--seed N] [--port 8790] [--share-only]
#   在一次性的本機 D1／R2（暫存目錄，不碰 .wrangler/ 與正式環境）起 wrangler dev，
#   寫入 scripts/readme-media-reviews.json 的虛構點評，從 public/img/illustrations/ 隨機挑插畫上傳，
#   再用 Playwright 拍 docs/readme-media/screenshots/*.png、錄 docs/readme-media/demo.gif 與 share.gif（分享操作）。
#   --share-only：只重錄 share.gif，截圖與 demo.gif 不動。
#   需要：.dev.vars（APP_PASSWORD）、Python 3 + Playwright + Pillow、ffmpeg；地圖圖磚要連網。
set -euo pipefail
cd "$(dirname "$0")/.."

PORT=8790
PY_ARGS=()
SHARE_ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT=$2; shift 2 ;;
    --seed) PY_ARGS+=(--seed "$2"); shift 2 ;;
    --share-only) PY_ARGS+=(--share-only); SHARE_ONLY=1; shift ;;
    *) echo "用法：bash scripts/readme-media.sh [--seed N] [--port 8790] [--share-only]" >&2; exit 2 ;;
  esac
done

[ -f .dev.vars ] || { echo "缺 .dev.vars，先照 README「本機開發」建立" >&2; exit 1; }
PASS=$(grep -E '^APP_PASSWORD=' .dev.vars | head -1 | cut -d= -f2-)
[ -n "$PASS" ] || { echo ".dev.vars 沒有 APP_PASSWORD" >&2; exit 1; }
command -v ffmpeg > /dev/null || { echo "缺 ffmpeg" >&2; exit 1; }
ls public/img/illustrations/*.jpg > /dev/null 2>&1 || { echo "public/img/illustrations/ 沒有 .jpg 插畫" >&2; exit 1; }
if curl -s -o /dev/null "http://localhost:$PORT/"; then echo "port $PORT 已被佔用，用 --port 換一個" >&2; exit 1; fi

STATE=$(mktemp -d)
DEV_PID=""
cleanup() {
  # 只 kill npx 會留下 workerd 子行程繼續佔 port，所以整個行程群組一起停
  if [ -n "$DEV_PID" ]; then kill -- "-$DEV_PID" 2> /dev/null || true; wait "$DEV_PID" 2> /dev/null || true; fi
  rm -rf "$STATE"
}
trap cleanup EXIT

echo "套用 migration 到暫存 D1"
npx wrangler d1 migrations apply food-review-db --local --persist-to "$STATE" > "$STATE/migrate.log" 2>&1 \
  || { cat "$STATE/migrate.log" >&2; exit 1; }

echo "啟動 wrangler dev（port ${PORT}）"
set -m  # 背景工作自成行程群組，cleanup 才能整組停掉
npx wrangler dev --port "$PORT" --persist-to "$STATE" > "$STATE/dev.log" 2>&1 < /dev/null &
DEV_PID=$!
set +m
for _ in $(seq 1 60); do
  if curl -s -o /dev/null "http://localhost:$PORT/login"; then break; fi
  if ! kill -0 "$DEV_PID" 2> /dev/null; then cat "$STATE/dev.log" >&2; exit 1; fi
  sleep 1
done
curl -s -o /dev/null "http://localhost:$PORT/login" || { echo "wrangler dev 60 秒內沒起來" >&2; tail -20 "$STATE/dev.log" >&2; exit 1; }

python3 scripts/readme_media.py "http://localhost:$PORT" "$PASS" --out docs/readme-media --video-dir "$STATE/video" "${PY_ARGS[@]+"${PY_ARGS[@]}"}"

echo "轉檔影片"
GIF_VF="fps=10,scale=720:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=4"
if [ -z "$SHARE_ONLY" ]; then
  WEBM=$(ls "$STATE"/video/*.webm | head -1)
  ffmpeg -loglevel error -y -i "$WEBM" -vf "$GIF_VF" docs/readme-media/demo.gif
fi
WEBM=$(ls "$STATE"/video/share/*.webm | head -1)
ffmpeg -loglevel error -y -i "$WEBM" -vf "$GIF_VF" docs/readme-media/share.gif
ls -l docs/readme-media/*.gif docs/readme-media/screenshots/
