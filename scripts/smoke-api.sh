#!/usr/bin/env bash
# API 冒煙測試：登入、驗證錯誤、建立點評、上傳照片、搜尋、設定、刪除。
# 用法：bash scripts/smoke-api.sh [BASE_URL] [PASSWORD] [ACCOUNT]
#   預設 http://127.0.0.1:8787、.dev.vars 的 dev-password 與帳號 admin。會建立並刪除一筆測試點評。
#   修改密碼的測試只對本機跑（改完會改回原密碼），不動正式環境的密碼。
set -euo pipefail
BASE=${1:-http://127.0.0.1:8787}
PASS=${2:-dev-password}
ACCOUNT=${3:-admin}
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
JAR="$TMP/cookies"
fail=0

check() { # 名稱 期望狀態碼 實際狀態碼 回應
  if [ "$2" = "$3" ]; then echo "通過：$1"; else echo "失敗：$1（期望 $2，實際 $3）${4:-}"; fail=1; fi
}
req() { # method path [curl 參數...] → 印出 "狀態碼<TAB>本文"
  local method=$1 path=$2; shift 2
  curl -s -b "$JAR" -c "$JAR" -X "$method" -o "$TMP/body" -w "%{http_code}" "$@" "$BASE$path" > "$TMP/code"
  printf '%s\t%s' "$(cat "$TMP/code")" "$(cat "$TMP/body")"
}
code() { printf '%s' "${1%%$'\t'*}"; }
body() { printf '%s' "${1#*$'\t'}"; }

r=$(req GET /api/reviews); check "未登入擋 API" 401 "$(code "$r")"
r=$(req POST /api/login -H "Content-Type: application/json" -d "{\"username\":\"$ACCOUNT\",\"password\":\"wrong\"}"); check "錯誤密碼" 401 "$(code "$r")"
r=$(req POST /api/login -H "Content-Type: application/json" -d "{\"username\":\"no-such-user\",\"password\":\"$PASS\"}"); check "不存在的帳號" 401 "$(code "$r")"
r=$(req POST /api/login -H "Content-Type: application/json" -d "{\"password\":\"$PASS\"}"); check "缺帳號回 400" 400 "$(code "$r")"
r=$(req POST /api/login -H "Content-Type: application/json" -d "{\"username\":\"$ACCOUNT\",\"password\":\"$PASS\"}"); check "正確帳號密碼登入" 200 "$(code "$r")"
r=$(req GET /api/account); check "讀取帳號" 200 "$(code "$r")"
[ "$(body "$r" | python3 -c 'import json,sys; print(json.load(sys.stdin)["username"])')" = "$ACCOUNT" ] && echo "通過：帳號名稱" || { echo "失敗：帳號名稱 $(body "$r")"; fail=1; }

r=$(req POST /api/reviews -H "Content-Type: application/json" -d '{"title":"","price":-1,"lat":200,"lng":0,"address":""}')
check "欄位驗證回 422" 422 "$(code "$r")" "$(body "$r")"

long=$(python3 -c 'print("好"*2001)')
r=$(req POST /api/reviews -H "Content-Type: application/json" -d "{\"title\":\"t\",\"price\":1,\"body\":\"$long\",\"lat\":1,\"lng\":1,\"address\":\"a\"}")
check "點評超過 2000 字回 422" 422 "$(code "$r")"

r=$(req POST /api/reviews -H "Content-Type: application/json" -d '{"title":"冒煙測試牛肉麵","price":180,"body":"湯頭濃郁，麵條Q彈。","lat":25.033,"lng":121.5654,"address":"台北市信義區信義路五段7號","visited_on":"2026-11-18","ratings":{"taste":5,"price":4,"bogus":3,"service":9},"meal":"  冒煙紅燒牛肉麵  "}')
check "建立點評" 201 "$(code "$r")" "$(body "$r")"
id=$(body "$r" | python3 -c 'import json,sys; print(json.load(sys.stdin)["review"]["id"])')
ratings=$(body "$r" | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)["review"]["ratings"], sort_keys=True))')
[ "$ratings" = '{"price": 4, "taste": 5}' ] && echo "通過：評比白名單過濾" || { echo "失敗：評比白名單 $ratings"; fail=1; }
# 餐點（選填，256 字內，去前後空白，可搜尋）
m=$(body "$r" | python3 -c 'import json,sys; print(json.load(sys.stdin)["review"]["meal"])')
[ "$m" = "冒煙紅燒牛肉麵" ] && echo "通過：餐點去前後空白後存入" || { echo "失敗：餐點（$m）"; fail=1; }
long_meal=$(python3 -c 'print("麵"*257)')
r=$(req POST /api/reviews -H "Content-Type: application/json" -d "{\"title\":\"t\",\"price\":1,\"lat\":1,\"lng\":1,\"address\":\"\",\"meal\":\"$long_meal\"}")
check "餐點超過 256 字回 422" 422 "$(code "$r")"
q=$(python3 -c 'import urllib.parse; print(urllib.parse.quote("冒煙紅燒"))')
r=$(req GET "/api/reviews?q=$q"); n=$(body "$r" | python3 -c 'import json,sys; print(sum(i["id"]=='"$id"' for i in json.load(sys.stdin)["items"]))')
[ "$n" = "1" ] && echo "通過：可用餐點搜尋" || { echo "失敗：餐點搜尋（$n）"; fail=1; }

# 統計頁：日期範圍以用餐日期為準，格式錯誤或開始晚於結束回 400
r=$(req GET "/api/stats?from=2026-11-18&to=2026-11-18"); check "統計日期範圍" 200 "$(code "$r")"
s=$(body "$r" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(sum(i["id"]=='"$id"' and i["date"]=="2026-11-18" for i in d["items"]), d["truncated"])')
[ "$s" = "1 False" ] && echo "通過：統計範圍包含測試點評" || { echo "失敗：統計範圍（$s）"; fail=1; }
r=$(req GET "/api/stats?to=2026-11-17"); s=$(body "$r" | python3 -c 'import json,sys; print(sum(i["id"]=='"$id"' for i in json.load(sys.stdin)["items"]))')
[ "$s" = "0" ] && echo "通過：統計範圍排除範圍外的點評" || { echo "失敗：統計範圍外仍列出（$s）"; fail=1; }
r=$(req GET "/api/stats?from=2026-13-01"); check "統計日期格式錯誤" 400 "$(code "$r")"
r=$(req GET "/api/stats?from=2026-11-19&to=2026-11-18"); check "統計開始晚於結束" 400 "$(code "$r")"

python3 - "$TMP/t.jpg" <<'PY'
import sys
# 最小合法 JPEG 檔頭即可通過伺服器檢查（FF D8 FF）
open(sys.argv[1], "wb").write(bytes([0xFF, 0xD8, 0xFF, 0xE0]) + b"\x00" * 200 + bytes([0xFF, 0xD9]))
PY
r=$(req POST "/api/reviews/$id/photos?w=80&h=50&caption=%E6%8B%9B%E7%89%8C" -H "Content-Type: image/jpeg" --data-binary @"$TMP/t.jpg")
check "上傳 JPEG" 201 "$(code "$r")" "$(body "$r")"
key=$(body "$r" | python3 -c 'import json,sys; print(json.load(sys.stdin)["photo"]["key"])')
pid=$(body "$r" | python3 -c 'import json,sys; print(json.load(sys.stdin)["photo"]["id"])')
r=$(req POST "/api/reviews/$id/photos" -H "Content-Type: image/png" --data-binary @"$TMP/t.jpg"); check "拒絕非 JPEG" 415 "$(code "$r")"
r=$(req GET "/media/$key"); check "讀取照片" 200 "$(code "$r")"
curl -s -b "$JAR" -D "$TMP/h" -o /dev/null "$BASE/media/$key?download=1"
grep -qi "content-disposition: attachment" "$TMP/h" && echo "通過：下載附檔名" || { echo "失敗：下載缺 Content-Disposition"; fail=1; }

q=$(python3 -c 'import urllib.parse; print(urllib.parse.quote("牛肉 信義"))')
r=$(req GET "/api/photos?q=$q"); n=$(body "$r" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["items"]))')
[ "$n" -ge 1 ] && echo "通過：照片集中文多詞搜尋" || { echo "失敗：照片集搜尋 $n 筆"; fail=1; }
q=$(python3 -c 'import urllib.parse; print(urllib.parse.quote("湯頭濃郁，麵條Q彈。湯頭濃郁"))')
r=$(req GET "/api/reviews?q=$q"); check "長中文搜尋不出錯（無 LIKE 上限）" 200 "$(code "$r")" "$(body "$r")"

r=$(req PATCH "/api/photos/$pid" -H "Content-Type: application/json" -d '{"caption":"新說明"}'); check "更新照片說明" 200 "$(code "$r")"
r=$(req PUT /api/settings -H "Content-Type: application/json" -d '{"nickname":"小林","defaultHearts":4,"quality":999,"shareFields":{"body":false}}')
check "儲存設定" 200 "$(code "$r")"
s=$(body "$r" | python3 -c 'import json,sys; s=json.load(sys.stdin)["settings"]; print(s["nickname"], s["defaultHearts"], s["quality"], s["shareFields"]["body"], s["shareFields"]["meal"])')
[ "$s" = "小林 4 80 False True" ] && echo "通過：設定白名單與範圍" || { echo "失敗：設定 $s"; fail=1; }
# GA4 評估 ID（ADR 028）：去空白轉大寫；格式不對存空字串
r=$(req PUT /api/settings -H "Content-Type: application/json" -d '{"gaMeasurementId":" g-ab12cd34ef "}')
s=$(body "$r" | python3 -c 'import json,sys; print(json.load(sys.stdin)["settings"]["gaMeasurementId"])')
[ "$s" = "G-AB12CD34EF" ] && echo "通過：GA4 評估 ID 正規化" || { echo "失敗：GA4 評估 ID $s"; fail=1; }
r=$(req PUT /api/settings -H "Content-Type: application/json" -d '{"gaMeasurementId":"G-1\"><script>"}')
s=$(body "$r" | python3 -c 'import json,sys; print(repr(json.load(sys.stdin)["settings"]["gaMeasurementId"]))')
[ "$s" = "''" ] && echo "通過：GA4 評估 ID 格式不對存空字串" || { echo "失敗：GA4 評估 ID $s"; fail=1; }
# 稱呼浮水印：預設開啟，只收布林值
r=$(req PUT /api/settings -H "Content-Type: application/json" -d '{"watermark":"no"}')
s=$(body "$r" | python3 -c 'import json,sys; print(json.load(sys.stdin)["settings"]["watermark"])')
[ "$s" = "True" ] && echo "通過：浮水印預設開啟、非布林值不收" || { echo "失敗：浮水印 $s"; fail=1; }
r=$(req PUT /api/settings -H "Content-Type: application/json" -d '{"watermark":false}')
s=$(body "$r" | python3 -c 'import json,sys; print(json.load(sys.stdin)["settings"]["watermark"])')
[ "$s" = "False" ] && echo "通過：浮水印可關閉" || { echo "失敗：浮水印 $s"; fail=1; }
req PUT /api/settings -H "Content-Type: application/json" -d '{}' >/dev/null

# 分類標籤與公開分享（ADR 019–021）
r=$(req PUT "/api/reviews/$id" -H "Content-Type: application/json" -d '{"title":"冒煙測試牛肉麵","price":180,"lat":25.033,"lng":121.5654,"address":"","tags":["#冒煙分類","冒煙分類","台式"]}')
check "儲存分類（地址選填，留空）" 200 "$(code "$r")" "$(body "$r")"
t=$(body "$r" | python3 -c 'import json,sys; print(",".join(json.load(sys.stdin)["review"]["tags"]))')
[ "$t" = "冒煙分類,台式" ] && echo "通過：分類去 # 與合併重複" || { echo "失敗：分類 $t"; fail=1; }
r=$(req PUT "/api/reviews/$id" -H "Content-Type: application/json" -d '{"title":"t","price":1,"lat":1,"lng":1,"address":"a","tags":["有 空白"]}'); check "分類含空白回 422" 422 "$(code "$r")"
q=$(python3 -c 'import urllib.parse; print(urllib.parse.quote("冒煙分類"))')
r=$(req GET "/api/reviews?q=$q"); n=$(body "$r" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["items"]))')
[ "$n" -ge 1 ] && echo "通過：首頁搜尋分類" || { echo "失敗：首頁搜尋分類 $n 筆"; fail=1; }
r=$(req GET "/api/photos?q=$q"); n=$(body "$r" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["items"]))')
[ "$n" -ge 1 ] && echo "通過：照片集搜尋分類" || { echo "失敗：照片集搜尋分類 $n 筆"; fail=1; }
r=$(req POST /api/shares -H "Content-Type: application/json" -d '{"kind":"tag","tag":"冒煙分類"}'); check "建立分類分享" 201 "$(code "$r")" "$(body "$r")"
tok=$(body "$r" | python3 -c 'import json,sys; print(json.load(sys.stdin)["share"]["token"])')
r=$(req GET "/api/shares?limit=1&q=$q"); n=$(body "$r" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(sum(s["token"]=="'"$tok"'" for s in d["shares"]), "nextCursor" in d)')
[ "$n" = "1 True" ] && echo "通過：已分享的連結搜尋與分頁欄位" || { echo "失敗：已分享的連結搜尋（$n）"; fail=1; }
r=$(req GET "/api/shares?cursor=bad"); check "已分享的連結壞游標" 400 "$(code "$r")"
c=$(curl -s -o "$TMP/pub" -w "%{http_code}" "$BASE/api/public/shares/$tok"); check "公開分享免登入" 200 "$c"
grep -q "r2_key\|photos/$id/\|blobs/" "$TMP/pub" && { echo "失敗：公開分享露出 key"; fail=1; } || echo "通過：公開分享不含 key"
python3 -c 'import json,sys; r=json.load(open(sys.argv[1]))["reviews"][0]; sys.exit(0 if (r["lat"], r["lng"], r["address"]) == (25.033, 121.5654, "") else 1)' "$TMP/pub" && echo "通過：公開分享帶座標供導航（ADR 022）" || { echo "失敗：公開分享座標或空地址 $(cat "$TMP/pub")"; fail=1; }
c=$(curl -s -o "$TMP/pub" -w "%{http_code}" "$BASE/api/public/shares/$tok/photos/$pid"); check "公開照片" 200 "$c"
grep -q '"src":"data:image/jpeg;base64,' "$TMP/pub" && echo "通過：公開照片為 base64" || { echo "失敗：公開照片格式"; fail=1; }
c=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/s/$tok"); check "公開分享頁免登入" 200 "$c"
r=$(req DELETE "/api/shares/$tok"); check "停止分享" 200 "$(code "$r")"
c=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/public/shares/$tok"); check "停止分享後連結失效" 404 "$c"
r=$(req POST /api/shares -H "Content-Type: application/json" -d "{\"kind\":\"review\",\"review_id\":$id}"); check "建立單一點評分享" 201 "$(code "$r")"
tok=$(body "$r" | python3 -c 'import json,sys; print(json.load(sys.stdin)["share"]["token"])')

# 照片檔共用（src/media.js）：同一張照片以雜湊引用、插畫引用站內原檔，沒有引用時才刪 R2 檔
case "$key" in blobs/*) echo "通過：照片 key 用內容雜湊";; *) echo "失敗：照片 key 不是 blobs/ 雜湊（$key）"; fail=1;; esac
r=$(req POST /api/reviews -H "Content-Type: application/json" -d '{"title":"冒煙測試共用照片","price":1,"lat":25.033,"lng":121.5654,"address":""}')
check "建立第二筆點評" 201 "$(code "$r")"
id2=$(body "$r" | python3 -c 'import json,sys; print(json.load(sys.stdin)["review"]["id"])')
sha=$(python3 -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$TMP/t.jpg")
r=$(req POST "/api/reviews/$id2/photos?w=80&h=50&sha256=$sha"); check "同一張照片只送雜湊" 201 "$(code "$r")" "$(body "$r")"
s=$(body "$r" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["photo"]["key"], d["reused"])')
[ "$s" = "$key True" ] && echo "通過：重複照片引用同一個檔" || { echo "失敗：重複照片（$s）"; fail=1; }
r=$(req POST "/api/reviews/$id2/photos?sha256=$(printf '0%.0s' $(seq 1 64))"); s=$(body "$r" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("needUpload"))')
[ "$s" = "True" ] && echo "通過：R2 沒有的雜湊要求上傳" || { echo "失敗：未知雜湊（$(body "$r")）"; fail=1; }
r=$(req POST "/api/reviews/$id2/photos?sha256=xyz"); check "雜湊格式錯誤" 400 "$(code "$r")"
r=$(req POST "/api/reviews/$id2/photos?w=1200&h=1200&illust=food-01.jpg"); check "引用插畫" 201 "$(code "$r")" "$(body "$r")"
ikey=$(body "$r" | python3 -c 'import json,sys; print(json.load(sys.stdin)["photo"]["key"])')
[ "$ikey" = "illust/food-01.jpg" ] && echo "通過：插畫 key 指向站內原檔" || { echo "失敗：插畫 key（$ikey）"; fail=1; }
r=$(req GET "/media/$ikey"); check "讀取插畫照片" 200 "$(code "$r")"
r=$(req POST "/api/reviews/$id2/photos?illust=..%2Fx.jpg"); check "插畫檔名不合格" 404 "$(code "$r")"
r=$(req POST "/api/reviews/$id2/photos?illust=food-99.jpg"); check "不存在的插畫" 404 "$(code "$r")"

r=$(req DELETE "/api/reviews/$id"); check "刪除點評" 200 "$(code "$r")"
r=$(req GET "/media/$key"); check "其他點評仍引用，照片檔保留" 200 "$(code "$r")"
r=$(req DELETE "/api/reviews/$id2"); check "刪除第二筆點評" 200 "$(code "$r")"
r=$(req GET "/media/$key"); check "沒有引用後照片檔才刪除" 404 "$(code "$r")"
r=$(req GET "/media/$ikey"); check "插畫原檔不受刪除影響" 200 "$(code "$r")"
r=$(req GET "/api/reviews/$id"); check "刪除後查無點評" 404 "$(code "$r")"
c=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/public/shares/$tok"); check "刪除點評後分享失效" 404 "$c"

# 通行金鑰：只測不需要真實驗證器的部分（完整流程在 e2e.py 用虛擬驗證器測）
c=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/passkeys"); check "未登入不能列通行金鑰" 401 "$c"
r=$(req GET /api/auth/status); check "登入方式狀態（公開）" 200 "$(code "$r")"
has=$(body "$r" | python3 -c 'import json,sys; print(json.load(sys.stdin)["hasPasskeys"])')
r=$(req GET /api/passkeys); check "列出通行金鑰" 200 "$(code "$r")"
r=$(req POST /api/passkeys/login/options -H "Content-Type: application/json" -d '{}'); check "登入 challenge" 200 "$(code "$r")"
grep -q "fr_chal" "$JAR" && echo "通過：challenge 存在簽章 cookie" || { echo "失敗：沒有 fr_chal cookie"; fail=1; }
r=$(req POST /api/passkeys/register/verify -H "Content-Type: application/json" -d '{"response":{}}'); check "challenge 用途不符（登入用的拿去註冊）" 400 "$(code "$r")"
r=$(req POST /api/passkeys/login/verify -H "Content-Type: application/json" -d '{"response":{"id":"bm90LWEta2V5"}}'); check "不存在的通行金鑰登入失敗" 401 "$(code "$r")"
r=$(req PUT /api/auth/password-login -H "Content-Type: application/json" -d '{"enabled":"no"}'); check "密碼登入開關格式錯誤" 400 "$(code "$r")"
if [ "$has" = "False" ]; then
  r=$(req PUT /api/auth/password-login -H "Content-Type: application/json" -d '{"enabled":false}'); check "沒有通行金鑰不能停用密碼" 409 "$(code "$r")"
fi

# 修改密碼（只對本機跑）：舊 cookie 失效、這台換發新 cookie、舊密碼不能登入，最後改回原密碼
case "$BASE" in http://127.0.0.1*|http://localhost*) local_base=1 ;; *) local_base=0 ;; esac
if [ "$local_base" = 1 ]; then
  NEW="$PASS-smoke-new"
  cp "$JAR" "$TMP/other" # 模擬另一台已登入的裝置
  r=$(req PUT /api/account/password -H "Content-Type: application/json" -d '{"currentPassword":"wrong","newPassword":"long-enough-pw"}'); check "目前密碼錯誤不能改" 400 "$(code "$r")"
  r=$(req PUT /api/account/password -H "Content-Type: application/json" -d "{\"currentPassword\":\"$PASS\",\"newPassword\":\"short\"}"); check "新密碼太短回 422" 422 "$(code "$r")"
  r=$(req PUT /api/account/password -H "Content-Type: application/json" -d "{\"currentPassword\":\"$PASS\",\"newPassword\":\"$PASS\"}"); check "新舊密碼相同回 422" 422 "$(code "$r")"
  r=$(req PUT /api/account/password -H "Content-Type: application/json" -d "{\"currentPassword\":\"$PASS\",\"newPassword\":\"$NEW\"}"); check "修改密碼" 200 "$(code "$r")" "$(body "$r")"
  c=$(curl -s -b "$TMP/other" -o /dev/null -w "%{http_code}" "$BASE/api/reviews"); check "其他裝置的登入失效" 401 "$c"
  r=$(req GET /api/reviews); check "這台換發新 cookie 仍登入" 200 "$(code "$r")"
  r=$(req POST /api/login -H "Content-Type: application/json" -d "{\"username\":\"$ACCOUNT\",\"password\":\"$PASS\"}"); check "舊密碼不能登入" 401 "$(code "$r")"
  r=$(req POST /api/login -H "Content-Type: application/json" -d "{\"username\":\"$ACCOUNT\",\"password\":\"$NEW\"}"); check "新密碼登入" 200 "$(code "$r")"
  r=$(req PUT /api/account/password -H "Content-Type: application/json" -d "{\"currentPassword\":\"$NEW\",\"newPassword\":\"$PASS\"}"); check "改回原密碼" 200 "$(code "$r")"
  [ "$(code "$r")" = 200 ] || echo "警告：密碼停在 $NEW，請手動改回"
fi

exit $fail
