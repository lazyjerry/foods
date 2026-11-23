#!/usr/bin/env python3
"""瀏覽器端到端測試（Playwright）：登入 → 新增點評（定位、評比、壓縮上傳）→ 列表搜尋 → 照片集下載 → 分享合成 → 設定 → 刪除。

用法：python3 scripts/e2e.py [BASE_URL] [PASSWORD] [--shots 目錄]
預設 http://localhost:8787（通行金鑰不接受 IP 當 RP ID）、dev-password。地址查詢的兩個 API 會被攔截改回假資料，不打 Nominatim。
"""
import argparse
import io
import json
import sys
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

ap = argparse.ArgumentParser()
ap.add_argument("base", nargs="?", default="http://localhost:8787")  # 通行金鑰的 RP ID 不能是 IP
ap.add_argument("password", nargs="?", default="dev-password")
ap.add_argument("--account", default="admin")
ap.add_argument("--shots")
args = ap.parse_args()
BASE = args.base.rstrip("/")
fails = []


def ok(name, cond, detail=""):
    print(("通過：" if cond else "失敗：") + name + ("" if cond else f"（{detail}）"))
    if not cond:
        fails.append(name)


def make_jpeg(path, w=3000, h=2000):
    # 用瀏覽器以外的方式產生大圖：寫一張未壓縮 BMP，交給瀏覽器 decode 測壓縮
    import struct
    row = (w * 3 + 3) & ~3
    data = bytearray()
    for y in range(h):
        line = bytearray()
        for x in range(w):
            line += bytes(((x * 255) // w, (y * 255) // h, 128))
        line += b"\x00" * (row - w * 3)
        data += line
    header = b"BM" + struct.pack("<IHHI", 54 + len(data), 0, 0, 54) + struct.pack("<IiiHHIIiiII", 40, w, h, 1, 24, 0, len(data), 2835, 2835, 0, 0)
    path.write_bytes(header + data)


def shot(page, name):
    if args.shots:
        Path(args.shots).mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(Path(args.shots) / f"{name}.png"), full_page=True)


tmp = Path(tempfile.mkdtemp())
big = tmp / "big.bmp"
make_jpeg(big)

with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(geolocation={"latitude": 25.0339, "longitude": 121.5645}, permissions=["geolocation"], locale="zh-TW", accept_downloads=True)
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    # 地圖圖磚與地址服務都不打外部
    page.route("https://tile.openstreetmap.org/**", lambda r: r.fulfill(status=204, body=""))
    page.route("**/api/geo/reverse**", lambda r: r.fulfill(status=200, content_type="application/json", body=json.dumps({"address": "台北市信義區信義路五段7號", "label": "台北 101"})))
    page.route("**/api/geo/search**", lambda r: r.fulfill(status=200, content_type="application/json", body=json.dumps({"results": [
        {"lat": 25.0418, "lng": 121.5654, "address": "台北市信義區市府路1號", "label": "臺北市政府, 市府路, 信義區"},
        {"lat": 25.0478, "lng": 121.517, "address": "台北市中正區北平西路3號", "label": "臺北車站, 北平西路, 中正區"}]})))

    page.goto(BASE + "/edit")
    ok("未登入導向登入頁", "/login" in page.url, page.url)
    page.fill("#username", args.account)
    page.fill("#password", "wrong")
    page.click("#login-form button[type=submit]")
    page.wait_for_function("document.querySelector('#login-status').textContent.includes('密碼不正確')")
    ok("錯誤密碼顯示訊息", True)
    page.fill("#password", args.password)
    page.click("#login-form button[type=submit]")
    page.wait_for_url("**/edit")
    ok("登入後回到原頁", page.url.endswith("/edit"), page.url)

    # 新增點評
    page.wait_for_function("document.querySelector('#address').value.length > 0", timeout=15000)
    ok("預設目前位置並帶入地址", abs(float(page.input_value("#lat")) - 25.0339) < 1e-4 and "信義路" in page.input_value("#address"))
    ok("地圖載入（Leaflet CSS 動態插入）", page.locator(".leaflet-container").count() == 1 and page.locator("link[data-leaflet]").count() == 1)

    page.click("#save-btn")
    ok("必填驗證：餐廳", "請輸入餐廳" in page.text_content("#save-status"))
    page.fill("#title", "E2E 測試拉麵")
    page.fill("#meal", "E2E叉燒拉麵")
    page.fill("#price", "260")
    page.fill("#body", "叉燒很厚，湯偏鹹。")
    ok("字數計數", page.text_content("#body-hint") == "9／2000 字", page.text_content("#body-hint"))
    ok("餐廳、餐點限 256 字並顯示計數",
       page.get_attribute("#title", "maxlength") == "256" and page.text_content("#title-hint") == "8／256 字"
       and page.get_attribute("#meal", "maxlength") == "256" and page.text_content("#meal-hint") == "7／256 字",
       [page.text_content("#title-hint"), page.text_content("#meal-hint")])

    page.fill("#address", "市府路")
    page.click("#geocode-btn")
    page.wait_for_selector(".app-geo-option")
    page.locator(".app-geo-option").first.click()
    ok("地址查座標並套用", abs(float(page.input_value("#lat")) - 25.0418) < 1e-4 and page.input_value("#address") == "台北市信義區市府路1號")
    addr_hint = page.text_content('.field:has(#address) .hint')
    ok("地址限 256 字，帶入後更新計數", page.get_attribute("#address", "maxlength") == "256" and addr_hint.startswith("11／256 字 · "), addr_hint)

    ok("評比預設關閉", page.is_hidden("#ratings"))
    page.click("label.switch:has(#ratings-on)")
    ok("開啟評比後顯示", page.is_visible("#ratings"))
    checked = page.eval_on_selector_all(".app-hearts input:checked", "els => els.map(e => e.value)")
    ok("每項預設 3 顆心", checked == ["3"] * 6, checked)
    page.click('.app-hearts[data-key="taste"] .app-heart:nth-of-type(5)')
    page.click('.app-hearts[data-key="portion"] .app-heart-skip')
    ok("點心形會塗色", page.locator('.app-hearts[data-key="taste"] .app-heart.app-is-on').count() == 5)

    page.set_input_files("#pick-input", str(big))
    page.wait_for_function("document.querySelector('#photo-status').textContent.includes('已壓縮')", timeout=20000)
    meta = page.text_content(".app-photo-tile .meta")
    ok("照片壓縮到長邊 1600", "1600×1067" in meta, meta)
    page.fill(".app-photo-tile input", "招牌叉燒")
    ok("照片說明限 256 字並顯示計數",
       page.get_attribute(".app-photo-tile input", "maxlength") == "256" and page.text_content(".app-photo-tile .hint") == "4／256 字",
       page.text_content(".app-photo-tile .hint"))
    shot(page, "edit")
    page.click("#save-btn")
    page.wait_for_function("document.querySelector('#save-status').textContent === '已儲存'", timeout=20000)
    ok("儲存點評與上傳照片", "已上傳" in page.text_content(".app-photo-tile .meta") and "id=" in page.url, page.text_content("#save-status"))
    page.wait_for_selector(".app-toast.is-bottom.is-shown")
    ok("儲存後底部跳出返回列表 toast",
       page.text_content(".app-toast.is-bottom .app-toast-text") == "已儲存點評"
       and page.get_attribute(".app-toast.is-bottom a", "href") == "/"
       and page.evaluate("(() => { const r = document.querySelector('.app-toast.is-bottom').getBoundingClientRect(); return innerHeight - r.bottom < 40; })()"))
    shot(page, "edit-saved-toast")
    page.click(".app-toast.is-bottom button")
    page.wait_for_function("getComputedStyle(document.querySelector('.app-toast.is-bottom')).visibility === 'hidden'")
    ok("按關閉收起 toast", True)
    rid = page.url.split("id=")[1]

    data = page.evaluate(f"fetch('/api/reviews/{rid}').then(r => r.json())")["review"]
    ok("評比存入（份量略過）", data["ratings"] == {"taste": 5, "price": 3, "experience": 3, "ambience": 3, "service": 3}, data["ratings"])
    ok("照片只存壓縮檔", data["photos"][0]["bytes"] < big.stat().st_size / 10 and data["photos"][0]["width"] == 1600, data["photos"][0])

    # 選擇插畫：開對話框、點一張就加進照片並關閉；測完移除這張，不影響後面的測試
    page.click('a[href="#illust-sheet"]')
    ok("插畫對話框開啟", page.evaluate("document.querySelector('#illust-sheet').open"))
    page.click('.app-illust:has-text("滷肉飯")')
    page.wait_for_function("document.querySelectorAll('.app-photo-tile').length === 2", timeout=20000)
    ok("選插畫後加入一張待上傳照片並關閉對話框",
       "待上傳" in page.text_content(".app-photo-tile:last-child .meta") and not page.evaluate("document.querySelector('#illust-sheet').open"))
    page.click(".app-photo-tile:last-child [data-remove]")

    # 自動插畫：沒有照片、分類、餐點或餐廳含插畫名稱時，儲存前自動加入那張插畫（分類 → 餐點 → 餐廳）；測完刪掉這筆
    page.goto(BASE + "/edit")
    page.wait_for_function("document.querySelector('#address').value.length > 0", timeout=15000)
    page.fill("#title", "E2E 自動插畫拉麵")
    page.fill("#price", "120")
    page.fill("#meal", "滷肉飯")
    ok("餐點優先於餐廳比對插畫", "「滷肉飯」插畫" in page.text_content("#photo-status"), page.text_content("#photo-status"))
    page.fill("#tag-input", "大腸包小腸")
    page.press("#tag-input", "Enter")
    ok("沒有照片時提示會自動加入插畫（分類優先於餐點）", "「大腸包小腸」插畫" in page.text_content("#photo-status"), page.text_content("#photo-status"))
    page.click("#save-btn")
    page.wait_for_function("document.querySelector('#save-status').textContent === '已儲存'", timeout=20000)
    ok("儲存後自動加入一張插畫並上傳",
       page.locator(".app-photo-tile").count() == 1 and "已上傳" in page.text_content(".app-photo-tile .meta")
       and "已自動加入「大腸包小腸」" in page.text_content("#photo-status"), page.text_content("#photo-status"))
    auto_id = page.url.split("id=")[1]
    auto_key = page.evaluate(f"fetch('/api/reviews/{auto_id}').then(r => r.json())")["review"]["photos"][0]["key"]
    ok("插畫引用站內原檔、不另存 R2", auto_key.startswith("illust/"), auto_key)
    page.once("dialog", lambda dlg: dlg.accept())
    page.click("#delete-btn")
    page.wait_for_url(BASE + "/")

    # 列表與搜尋
    page.goto(BASE + "/")
    page.wait_for_selector(".app-review")
    page.fill("#q", "叉燒 拉麵")
    page.click("#search-btn")
    page.wait_for_function("document.querySelector('#list-status').textContent.includes('結果')")
    ok("列表搜尋", page.locator(".app-review").count() >= 1 and "E2E 測試拉麵" in page.text_content(".app-review"))
    ok("列表在店名下方顯示餐點", "E2E叉燒拉麵" in page.text_content(".app-review .meta"), page.text_content(".app-review .meta"))
    page.fill("#q", "E2E叉燒拉麵")
    page.click("#search-btn")
    page.wait_for_function("document.querySelector('#list-status').textContent.includes('結果')")
    ok("可用餐點搜尋", page.locator(".app-review").count() == 1 and "E2E 測試拉麵" in page.text_content(".app-review"))
    shot(page, "list")

    # 照片集
    page.goto(BASE + "/photos?q=招牌叉燒")
    page.wait_for_selector(".app-shot")
    with page.expect_download() as dl:
        page.click(".app-shot a[download]")
    d = dl.value
    path = d.path()
    ok("下載壓縮照片", Path(path).read_bytes()[:3] == b"\xff\xd8\xff" and d.suggested_filename.endswith(".jpg"), d.suggested_filename)
    shot(page, "photos")
    page.click(".app-shot .app-photo-open")
    ok("照片集點照片開大圖", page.evaluate("document.querySelector('#photo-box').open") and page.url.startswith(BASE + "/photos"), page.url)
    page.keyboard.press("Escape")
    ok("照片集大圖可關閉", not page.evaluate("document.querySelector('#photo-box').open"))

    # 設定
    page.goto(BASE + "/settings")
    page.wait_for_function("!document.querySelector('#settings-form').inert")
    puts = []
    def on_put(r):
        if r.method == "PUT" and r.url.endswith("/api/settings"):
            puts.append(r.url)
    page.on("request", on_put)
    ok("沒有變更時儲存鈕不可按", page.is_disabled("#save-btn"))
    ok("稱呼浮水印預設開啟", page.is_checked("#watermark"))
    ok("儲存鈕浮動在右下角", page.evaluate("(() => { const r = document.querySelector('#save-btn').getBoundingClientRect(); return getComputedStyle(document.querySelector('#save-btn')).position === 'fixed' && innerWidth - r.right < 60 && innerHeight - r.bottom < 60 && Math.abs(r.width - r.height) < 1; })()"))
    page.fill("#nickname", "小林")
    page.select_option("#default-hearts", "4")
    page.click("label.switch:has(#def-share-body)")
    page.wait_for_timeout(2000)
    ok("變更後不自動儲存", len(puts) == 0 and page.is_enabled("#save-btn")
       and "未儲存" in page.text_content("#settings-status"), (len(puts), page.text_content("#settings-status")))
    shot(page, "settings-unsaved")
    page.click("#save-btn")
    page.wait_for_function("document.querySelector('#settings-status').textContent.includes('已儲存')")
    ok("按儲存鈕寫入一次", len(puts) == 1 and page.is_disabled("#save-btn"), len(puts))
    page.wait_for_function("document.querySelector('.app-toast.is-shown')?.textContent === '已儲存設定'")
    ok("儲存成功跳右上角 toast", page.evaluate("(() => { const r = document.querySelector('.app-toast').getBoundingClientRect(); return r.top < 40 && innerWidth - r.right < 40; })()"))
    shot(page, "settings-toast")
    page.reload()
    page.wait_for_function("document.querySelector('#nickname').value === '小林'")
    ok("設定儲存並重新載入", page.input_value("#default-hearts") == "4" and not page.is_checked("#def-share-body"))
    shot(page, "settings")
    puts.clear()
    page.click("label.switch:has(#def-share-price)")
    page.click("label.switch:has(#def-share-price)")
    page.fill("#nickname", "小林林")
    page.fill("#nickname", "小林")
    ok("來回切換、改回原值時儲存鈕不可按", page.is_disabled("#save-btn") and len(puts) == 0, len(puts))
    page.select_option("#default-hearts", "5")
    page.select_option("#default-hearts", "2")
    page.press("#nickname", "Enter")
    page.wait_for_function("document.querySelector('#settings-status').textContent.includes('已儲存')")
    ok("稱呼欄按 Enter 儲存，多次變動只寫一次", len(puts) == 1, len(puts))
    page.select_option("#default-hearts", "4")
    page.click("#save-btn")
    page.wait_for_function("document.querySelector('#settings-status').textContent.includes('已儲存')")
    page.remove_listener("request", on_put)

    # 分享
    page.goto(BASE + f"/share?id={rid}")
    page.wait_for_function("document.querySelector('#source-status').textContent.includes('已使用')", timeout=15000)
    ok("分享頁套用設定（點評內容預設不勾）", not page.is_checked("#share-body") and page.is_checked("#share-nickname"))
    size = page.evaluate("[canvas.width, canvas.height]")
    ok("合成照片尺寸", size == [1600, 1067], size)
    ok("照片分享圖壓上稱呼浮水印", page.evaluate("canvas.dataset.watermark") == "小林", page.evaluate("canvas.dataset.watermark"))
    shot(page, "share-watermark")
    page.click("label:has(input[name=source][value=none])")
    page.wait_for_function("document.querySelector('#source-status').textContent.includes('純文字')")
    ok("純文字分享圖", page.evaluate("canvas.width") == 1080)
    ok("純文字分享圖不壓浮水印", page.evaluate("canvas.dataset.watermark") == "")
    page.set_input_files("#album-input", str(big))
    page.wait_for_function("document.querySelector('#source-status').textContent.includes('相簿照片')", timeout=15000)
    ok("相簿照片合成", page.evaluate("canvas.width") == 2048)
    with page.expect_download() as dl:
        page.click("#download-btn")
    ok("下載分享圖", dl.value.suggested_filename.endswith("-分享.jpg"), dl.value.suggested_filename)
    shot(page, "share")

    # 分享卡片：建一個單一點評的分享連結，從「已分享的連結」與公開頁都能開分享卡片
    ctx.grant_permissions(["clipboard-read", "clipboard-write"], origin=BASE)
    tok = page.evaluate("fetch('/api/shares', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({kind: 'review', review_id: Number(%s)})}).then(r => r.json())" % json.dumps(rid))["share"]["token"]
    card_ready = "document.querySelector('#share-card-preview img')?.naturalWidth > 0"
    page.goto(BASE + "/share?tab=web")
    page.click(f'#share-list [data-card="{tok}"]')
    page.wait_for_function(card_ready, timeout=15000)
    ok("已分享的連結開分享卡片", page.evaluate("document.querySelector('#share-card').open")
       and page.input_value("#share-card-url") == f"{BASE}/s/{tok}"
       and page.evaluate("document.querySelector('#share-card-preview img').naturalWidth") == 1080, page.input_value("#share-card-url"))
    page.click("#share-card-copy")
    page.wait_for_function("document.querySelector('#share-card-status').textContent.includes('已複製')")
    ok("分享卡片複製網址", page.evaluate("navigator.clipboard.readText()") == f"{BASE}/s/{tok}")
    shot(page, "share-card")
    page.goto(BASE + f"/s/{tok}")
    page.wait_for_selector("#share-open:not([hidden])")
    page.click("#share-open")
    page.wait_for_function(card_ready, timeout=15000)
    with page.expect_download() as dl:
        page.click("#share-card-save")
    ok("公開頁分享卡片可儲存", dl.value.suggested_filename.endswith("-分享卡片.jpg")
       and Path(dl.value.path()).read_bytes()[:3] == b"\xff\xd8\xff", dl.value.suggested_filename)
    shot(page, "shared-card")
    page.set_viewport_size({"width": 375, "height": 667})
    page.goto(BASE + f"/s/{tok}")
    page.wait_for_selector("#share-open:not([hidden])")
    over = page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
    ok("手機無水平捲動 /s/<token>", over <= 0, over)
    page.click("#share-open")
    page.wait_for_function(card_ready, timeout=15000)
    shot(page, "m_shared-card")
    page.set_viewport_size({"width": 1280, "height": 900})
    # 稱呼浮水印關掉時，公開頁照片不壓浮水印（img 直接用 API 給的 data URI）
    cur = page.evaluate("fetch('/api/settings').then(r => r.json())")["settings"]
    put_settings = "s => fetch('/api/settings', {method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(s)})"
    page.evaluate(put_settings, {**cur, "watermark": False})
    page.goto(BASE + f"/s/{tok}")
    page.wait_for_function("document.querySelector('#shared-list img')?.src.startsWith('data:')", timeout=15000)
    pid = page.evaluate(f"fetch('/api/public/shares/{tok}').then(r => r.json())")["reviews"][0]["photos"][0]["id"]
    raw = page.evaluate(f"fetch('/api/public/shares/{tok}/photos/{pid}').then(r => r.json())")["src"]
    ok("關掉稱呼浮水印時公開頁照片不壓浮水印", page.evaluate("document.querySelector('#shared-list img').src") == raw)
    page.evaluate(put_settings, cur)
    # 公開頁用到的模組都要免登入拿得到：沒登入的訪客也能開分享卡片
    anon = browser.new_context(locale="zh-TW")
    apage = anon.new_page()
    apage.goto(BASE + f"/s/{tok}")
    apage.wait_for_selector("#share-open:not([hidden])", timeout=15000)
    apage.click("#share-open")
    apage.wait_for_function(card_ready, timeout=15000)
    ok("未登入訪客可開分享卡片", apage.evaluate("document.querySelector('#share-card-preview img').naturalWidth") == 1080)
    anon.close()
    page.goto(BASE + f"/s/{tok}")
    page.wait_for_function("document.querySelector('#shared-list img')?.src.startsWith('data:')", timeout=15000)
    ok("開著稱呼浮水印時公開頁照片壓浮水印", page.evaluate("document.querySelector('#shared-list img').src") != raw)
    page.evaluate("fetch('/api/shares/%s', {method: 'DELETE'})" % tok)

    # 新增時套用預設心數 4
    page.goto(BASE + "/edit")
    page.wait_for_function("!document.querySelector('#review-form').inert")
    page.click("label.switch:has(#ratings-on)")
    checked = page.eval_on_selector_all(".app-hearts input:checked", "els => els.map(e => e.value)")
    ok("新增點評套用預設 4 顆心", checked == ["4"] * 6, checked)

    # 分類建議清單：打新字第一項是「新增」，Enter 加入；聚焦時列出舊分類，點一下加入
    page.fill("#tag-input", "E2E新分類")
    ok("分類輸入出現新增項", page.text_content(".app-combo-option.is-active") == "新增「E2E新分類」", page.text_content(".app-combo-pop"))
    page.press("#tag-input", "Enter")
    ok("分類 Enter 新增", page.text_content("#tag-list") == "#E2E新分類 ×" and page.input_value("#tag-input") == "", page.text_content("#tag-list"))
    old = page.locator(".app-combo-option", has_text="#")
    if old.count():
        name = old.first.text_content()
        old.first.click()
        ok("分類從清單選舊的", (name + " ×") in page.text_content("#tag-list") and page.evaluate("document.activeElement.id") == "tag-input", page.text_content("#tag-list"))
    page.keyboard.press("Escape")
    ok("分類清單 Esc 關閉", page.is_hidden(".app-combo-pop"))

    # 帳號與密碼卡：顯示帳號、確認不一致、目前密碼錯誤（回 400，不跳登入頁）；實際改密碼由 smoke-api.sh 測
    page.goto(BASE + "/settings")
    page.wait_for_function("document.querySelector('#account-username').value !== ''")
    ok("設定頁顯示帳號", page.input_value("#account-username") == args.account, page.input_value("#account-username"))
    page.fill("#current-password", args.password)
    page.fill("#new-password", "e2e-new-password")
    page.fill("#confirm-password", "e2e-different")
    page.press("#confirm-password", "Enter")
    page.wait_for_function("document.querySelector('#account-status').textContent.includes('不一樣')")
    ok("確認密碼不一致，按 Enter 不送出設定", "已儲存設定" not in page.text_content("#settings-status"))
    page.fill("#current-password", "wrong-password")
    page.fill("#confirm-password", "e2e-new-password")
    page.click("#change-pw-btn")
    page.wait_for_function("document.querySelector('#account-status').textContent.includes('目前的密碼不正確')")
    ok("目前密碼錯誤顯示訊息、不跳登入頁", page.url.endswith("/settings"), page.url)

    # 通行金鑰：Chromium 虛擬驗證器（CDP），註冊 → 停用密碼 → 登出 → 通行金鑰登入 → 恢復
    cdp = ctx.new_cdp_session(page)
    cdp.send("WebAuthn.enable")
    auth_id = cdp.send("WebAuthn.addVirtualAuthenticator", {"options": {
        "protocol": "ctap2", "transport": "internal", "hasResidentKey": True,
        "hasUserVerification": True, "isUserVerified": True, "automaticPresenceSimulation": True}})["authenticatorId"]
    page.goto(BASE + "/settings")
    page.wait_for_function("!document.querySelector('#settings-form').inert")
    page.wait_for_function("document.querySelector('#passkey-status').textContent.includes('還沒有通行金鑰')")
    ok("沒有金鑰時不能關閉密碼登入", page.is_checked("#password-login") and page.is_disabled("#password-login"))
    page.fill("#passkey-name", "E2E 金鑰")
    page.press("#passkey-name", "Enter")
    page.wait_for_function("document.querySelector('#passkey-status').textContent.includes('已新增')", timeout=15000)
    ok("名稱欄按 Enter 新增通行金鑰，不送出設定", page.locator("#passkey-list .app-key").count() == 1
       and "已儲存設定" not in page.text_content("#settings-status"), page.text_content("#passkey-status"))
    page.once("dialog", lambda dlg: dlg.accept())
    page.click("label.switch:has(#password-login)")
    page.wait_for_function("document.querySelector('#password-login-status').textContent.includes('已停用')")
    ok("停用密碼登入", not page.is_checked("#password-login"))
    page.once("dialog", lambda dlg: dlg.accept())
    page.click("#passkey-list button[data-del]")
    page.wait_for_function("document.querySelector('#passkey-status').textContent.includes('不能刪除最後')")
    ok("密碼停用時不能刪最後一把金鑰", page.locator("#passkey-list .app-key").count() == 1)
    shot(page, "settings-passkey")

    page.once("dialog", lambda dlg: dlg.accept())
    page.click("#logout-btn")
    page.wait_for_url("**/login")
    page.wait_for_selector("#passkey-btn:not([hidden])")
    ok("登入頁只剩通行金鑰", page.is_hidden("#login-form") and page.is_visible("#passkey-btn"))
    st = page.evaluate("fetch('/api/login', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({username: %s, password: %s})}).then(r => r.status)" % (json.dumps(args.account), json.dumps(args.password)))
    ok("停用後密碼 API 回 403", st == 403, st)
    shot(page, "login-passkey")
    page.click("#passkey-btn")
    page.wait_for_url(BASE + "/", timeout=15000)
    keys = page.evaluate("fetch('/api/passkeys').then(r => r.json())")["passkeys"]
    ok("通行金鑰登入並記錄使用時間", len(keys) == 1 and keys[0]["lastUsedAt"], keys)

    page.goto(BASE + "/settings")
    page.wait_for_function("!document.querySelector('#settings-form').inert")
    page.wait_for_selector("#passkey-list .app-key")
    page.click("label.switch:has(#password-login)")
    page.wait_for_function("document.querySelector('#password-login-status').textContent.includes('已允許')")
    page.once("dialog", lambda dlg: dlg.accept())
    page.click("#passkey-list button[data-del]")
    page.wait_for_function("document.querySelector('#passkey-status').textContent.includes('已刪除')")
    ok("恢復密碼登入並刪除金鑰", page.locator("#passkey-list .app-key").count() == 0 and page.is_checked("#password-login"))
    cdp.send("WebAuthn.removeVirtualAuthenticator", {"authenticatorId": auth_id})

    # 統計頁：載入後各卡都有內容，「修改」連到編輯頁，日期顛倒時擋下
    page.goto(BASE + "/stats")
    page.wait_for_function("document.querySelector('#stats-status').textContent.includes('筆點評')")
    ok("統計頁前五名有「修改」連結", page.locator('#best-list a.btn[href^="/edit?id="]').count() >= 1)
    ok("統計頁每張統計都有情境句", page.locator(".card .app-scenario").count() == 5)
    page.check('input[name="trend-metric"][value="spend"]', force=True)
    ok("統計頁切換花費趨勢", "NT$" in page.text_content("#trend-status"), page.text_content("#trend-status"))
    page.fill("#stats-from", "2026-12-01")
    page.fill("#stats-to", "2026-11-01")
    page.click("#range-btn")
    ok("統計頁擋下開始晚於結束", "不能晚於" in page.text_content("#stats-status"))

    # 手機寬度：有資料時不可水平捲動
    page.set_viewport_size({"width": 375, "height": 667})
    for path in ["/", f"/edit?id={rid}", "/photos", f"/share?id={rid}", "/settings", "/stats"]:
        page.goto(BASE + path)
        page.wait_for_load_state("networkidle")
        over = page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
        ok(f"手機無水平捲動 {path}", over <= 0, over)
        shot(page, "m" + path.replace("/", "_").replace("?", "_"))
    page.set_viewport_size({"width": 1280, "height": 900})

    # 清理
    page.evaluate("fetch('/api/settings', {method: 'PUT', headers: {'Content-Type': 'application/json'}, body: '{}'})")
    page.goto(BASE + f"/edit?id={rid}")
    page.wait_for_selector("#delete-btn:not([hidden])")
    page.once("dialog", lambda dlg: dlg.accept())
    page.click("#delete-btn")
    page.wait_for_url(BASE + "/")
    ok("刪除點評", True)
    ok("沒有 JavaScript 錯誤", not errors, errors)
    browser.close()

sys.exit(1 if fails else 0)
