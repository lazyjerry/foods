#!/usr/bin/env bash
# 靜態檢查：重產頁面、Jerry UI 規則、JS 語法。瀏覽器測試另跑 scripts/e2e.py 與 jerry-ui-visual.py。
set -euo pipefail
cd "$(dirname "$0")/.."
JERRY_DIR=${JERRY_DIR:-$HOME/.ai-global/skills/build-jerry-cloudflare-page/scripts}
python3 scripts/build_pages.py
# 插畫檔名只增不改不刪（AGENTS.md〈插畫檔案〉）；放在 Jerry UI 檢查之前，不受後面的檢查結果影響
python3 scripts/check_illustrations.py
# 頁尾作者連結（ADR 027）：L3:mono 規格不允許子元素，只放行這一條 E24；錯誤總數要等於放行數，其他錯誤照常失敗
FOOT_E24='<footer.site-foot.is-mono> 的結構不符合 L3:mono'
jerry_out=$(python3 "$JERRY_DIR/jerry-ui.py" check public 2>&1) || true
errors=$(printf '%s\n' "$jerry_out" | grep -o '檢查完成：錯誤 [0-9]*' | grep -o '[0-9]*$' || true)
exempt=$(printf '%s\n' "$jerry_out" | grep -cF "$FOOT_E24" || true)
if [ -z "$errors" ] || [ "$errors" -ne "$exempt" ]; then printf '%s\n' "$jerry_out" >&2; exit 1; fi
printf '%s\n' "$jerry_out" | grep -vF "$FOOT_E24"
[ "$exempt" -eq 0 ] || echo "（頁尾作者連結的 E24 已放行 $exempt 筆，見 ADR 027）"

# 預設圖與插畫要隨第一次部署一起上傳：檔案要在、不能被 .gitignore（一鍵部署從 repo clone）或 .assetsignore 排除
imgs=(public/img/no-photo-{1..5}.svg)
while IFS= read -r f; do imgs+=("$f"); done < <(python3 -c 'import re,sys; print("\n".join("public/img/illustrations/" + n for n in re.findall(r"\(\"([\w-]+\.jpg)\"", open("scripts/build_pages.py", encoding="utf-8").read())))')
for f in "${imgs[@]}"; do
  [ -f "$f" ] || { echo "缺圖片：$f" >&2; exit 1; }
  if git check-ignore -q "$f"; then echo "圖片被 .gitignore 排除，一鍵部署會缺：$f" >&2; exit 1; fi
  if grep -qxF -e "${f#public/}" -e "/${f#public/}" -e img -e img/ -e /img/ public/.assetsignore 2> /dev/null; then echo "圖片被 .assetsignore 排除：$f" >&2; exit 1; fi
done
echo "部署圖片檢查通過：${#imgs[@]} 張"
for f in public/js/*.js src/*.js; do node --check "$f"; done
echo "JS 語法檢查通過"
