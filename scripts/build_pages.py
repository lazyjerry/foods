#!/usr/bin/env python3
"""產生 public/*.html：元件一律由 jerry-ui.py snippet 產生，這裡只組版與填欄位。

用法：python3 scripts/build_pages.py
環境變數 JERRY_UI 可指定 jerry-ui.py 位置（預設 ~/.ai-global/skills/build-jerry-cloudflare-page/scripts/jerry-ui.py）。

元件庫沒有的區塊（地圖、心形評比、照片格、清單容器、隱藏的檔案輸入）以 app-* class 直接寫，
外觀放在 public/app.css。產生後補上的屬性只有 min／max／step／maxlength／autocomplete 這類輸入限制，
不改結構與 class。
"""
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public"
JERRY = Path(os.environ.get("JERRY_UI", Path.home() / ".ai-global/skills/build-jerry-cloudflare-page/scripts/jerry-ui.py"))

NAV = [("/", "點評", "index"), ("/edit", "新增", "edit"), ("/photos", "照片集", "photos"),
       ("/share", "分享", "share"), ("/settings", "設定", "settings")]

SHARE_FIELDS = [("title", "標題"), ("price", "價格"), ("date", "用餐日期"), ("address", "地址"),
                ("ratings", "評比"), ("body", "點評內容"), ("nickname", "稱呼")]

# 編輯頁「選擇插畫」可選的圖（public/img/illustrations/），檔名與顯示名稱
ILLUSTRATIONS = [("food-01.jpg", "牛肉麵"), ("food-02.jpg", "滷肉飯"), ("food-03.jpg", "小籠包"),
                 ("food-04.jpg", "珍珠奶茶"), ("food-05.jpg", "鹽酥雞"), ("meal-01.jpg", "火鍋"),
                 ("meal-02.jpg", "便當"), ("meal-03.jpg", "早餐"), ("meal-04.jpg", "刈包"), ("meal-05.jpg", "豆花")]


def sn(code, **fields):
    """呼叫 jerry-ui.py snippet，回傳 HTML。"""
    args = [sys.executable, str(JERRY), "snippet", code]
    if fields:
        args += ["--json", json.dumps(fields, ensure_ascii=False)]
    res = subprocess.run(args, capture_output=True, text=True)
    if res.returncode != 0:
        sys.exit(f"snippet {code} 失敗：{res.stderr.strip()}")
    return res.stdout.strip()


def attr(html, needle, extra):
    """在第一個符合 needle 的開頭標籤後補屬性（只用於輸入限制）。"""
    if needle not in html:
        sys.exit(f"找不到要補屬性的位置：{needle}")
    return html.replace(needle, needle + " " + extra, 1)


def header(current):
    if current == "login":
        end = sn("L2:pill", text="PRIVATE · PASSKEY")
    elif current == "public":
        # 分享鈕載入成功才由 js/shared.js 顯示（開 share_card_dialog()）
        share_btn = sn("A1", variant="is-sm", id="share-open", text="分享").replace("<button ", "<button hidden ", 1)
        end = sn("L2:pill", text="SHARED · READ ONLY") + share_btn
    elif current == "offline":
        end = sn("L2:pill", text="OFFLINE")
    else:
        end = sn("A1", variant="is-sm secondary", id="logout-btn", text="登出")
    return sn("L2", mark="食", name="吃過筆記", end=end)


def page_nav(current):
    # 頁面導覽放 main 開頭（A4），不放頁首：L2:nav 在手機會換行，首屏超過 1/3 高（ADR 011）
    if current in ("login", "public", "offline"):
        return ""
    links = [{"href": h, "text": t, **({"current": "page"} if k == current else {})} for h, t, k in NAV]
    return sn("A4", label="頁面", links=links)


REPO_URL = "https://github.com/lazyjerry/foods"


def footer():
    # 版權連到 repo（ADR 027）：L3:mono 會跳脫 text，作者先放佔位字再換成 <a>；check.sh 放行這一條 E24
    html = sn("L3:mono", text="吃過筆記 · 吃過的店，記一筆就不會忘 · © 2026 @@AUTHOR@@")
    return html.replace("@@AUTHOR@@", f'<a href="{REPO_URL}" target="_blank" rel="noopener">lazyjerry</a>', 1)


def card(index, cid, title, desc, content, accent="accent-coral", variant="is-roomy"):
    heading = sn("C2", index=index, id=cid, title=title, desc=desc)
    return sn("C1", id=cid, accent=accent, variant=variant, content=heading + "\n" + content)


def stack(*parts):
    return sn("L5", content="\n".join(parts))


def privacy_note():
    return sn("C5", icon="⌁", title="照片在你的裝置上壓縮後才上傳",
              text="原始照片不會離開裝置，上傳的是壓縮後的 JPEG，拍攝位置等 EXIF 資料一併移除。地址查詢經由 OpenStreetMap Nominatim。")


def page(name, title, desc, mast, main, scripts, current, form=None):
    # main 內的區塊（頁籤、卡片格線、提示框）一律放進 L5，間距由 .stack 決定，不手寫 margin
    inner = stack(*[b for b in (page_nav(current), main) if b])
    if form:
        inner = f'<form class="app-form" id="{form}" novalidate>\n{inner}\n</form>'
    head_scripts = "\n".join(f'<script src="{s}" defer></script>' if not s.startswith("module:")
                             else f'<script type="module" src="{s[7:]}"></script>' for s in scripts)
    # PWA：manifest、icon 與 service worker 註冊；公開分享頁不加，匿名訪客不該被引導安裝（會被導去登入）
    pwa_head = "" if current == "public" else """
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#f5f3ed">
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
<meta name="apple-mobile-web-app-title" content="吃過筆記">
<script type="module" src="js/pwa.js"></script>"""
    html = f"""<!doctype html>
<html lang="zh-Hant-TW">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
{'<base href="/">' if current == "public" else ""}
<title>{title}</title>
<meta name="description" content="{desc}">
<meta name="robots" content="noindex">
<script>if (typeof HTMLDialogElement === "function") document.documentElement.classList.add("has-dialog");</script>
<link rel="stylesheet" href="jerry-ui.css">
<link rel="stylesheet" href="app.css">
<script src="jerry-ui.js" defer></script>
{head_scripts}{pwa_head}
</head>
<body>
{sn("B2:skip")}
<div class="wrap is-wide">
{header(current)}
{sn("H1", **mast)}
<main id="main">
{inner}
</main>
{footer()}
</div>
{sn("M1")}
</body>
</html>
"""
    (OUT / name).write_text(html, encoding="utf-8")
    print(f"已產生：public/{name}")


def search_control(placeholder, label):
    f3 = sn("F3", id="q", placeholder=placeholder, button="搜尋", button_label=label)
    f3 = f3.replace('<button type="button"', '<button type="submit" id="search-btn"', 1)
    return sn("F2:control", id="q", label="關鍵字", control=f3, hint="以空白分隔多個關鍵字，全部符合才列出")


def build_index():
    content = "\n".join([
        sn("F1", id="search-form", content=search_control("例如：牛肉麵 大安", "搜尋點評")),
        sn("F10", id="list-status", role="status"),
        '<div class="app-review-list" id="review-list"></div>',
        sn("A1", variant="secondary", id="more-btn", text="載入更多").replace("<button", "<button hidden", 1),
    ])
    # 新增點評獨立成第一張卡片，進首頁第一眼就看到（ADR 016）
    add = sn("A2", buttons=sn("A1:link", href="/edit", text="新增點評"))
    cards = "\n".join([
        card("01", "add-title", "記下一筆", "標題、價格、點評與位置必填，照片和評比可以之後再補", add, variant="is-roomy is-wide"),
        card("02", "list-title", "搜尋點評", "依店名、地址、點評內容或分類篩選", content, accent="accent-blue", variant="is-roomy is-wide"),
    ])
    main = sn("L4", cards=cards) + "\n" + privacy_note()
    page("index.html", "食物點評｜記錄店家、價格、位置與照片", "瀏覽與搜尋自己記錄的食物點評",
         {"eyebrow": "FOOD REVIEW LOG", "solid": "食物點評", "outline": "列表",
          "lede": "想不起上次那家好不好吃，搜一下就知道。"},
         main, ["module:js/list.js"], "index")


def build_edit():
    title = attr(sn("F2", id="title", label="標題", required=True, placeholder="例如：老張牛肉麵"), 'id="title"', 'maxlength="100" autocomplete="off"')
    price = attr(sn("F2", id="price", label="價格", type="number", inputmode="numeric", num="num", required=True, hint="新台幣，整數"),
                 'id="price"', 'min="0" max="1000000" step="1"')
    visited = sn("F2", id="visited-on", label="用餐日期", type="date", num="num")
    body = sn("F2:textarea", id="body", label="點評", maxlength="2000", placeholder="味道、份量、推薦的品項…", hint="0／2000 字")
    basic = stack(title, sn("F2:row", fields=price + visited), body, tags_block())

    lat = attr(sn("F2", id="lat", label="緯度", type="number", num="num", required=True), 'id="lat"', 'min="-90" max="90" step="any"')
    lng = attr(sn("F2", id="lng", label="經度", type="number", num="num", required=True), 'id="lng"', 'min="-180" max="180" step="any"')
    addr_f3 = sn("F3", id="address", placeholder="例如：台北市大安區忠孝東路四段 1 號", button="查座標", button_label="以地址查座標")
    addr_f3 = attr(addr_f3.replace('<button type="button"', '<button type="button" id="geocode-btn"', 1), 'id="address"', 'required maxlength="300"')
    location = stack(
        '<div class="app-map" id="map" role="application" aria-label="地圖：點選或拖曳標記設定位置"></div>',
        sn("F2:row", fields=lat + lng),
        sn("F2:control", id="address", label="地址", control=addr_f3, hint="按「查座標」依地址移動標記；移動標記會自動帶入地址"),
        '<div class="app-geo-results" id="geo-results" aria-live="polite"></div>',
        sn("A2", buttons=sn("A1", variant="secondary", id="locate-btn", text="使用目前位置") + sn("A1", variant="secondary", id="reverse-btn", text="用座標查地址")),
        sn("F10", id="geo-status", role="status"),
    )

    ratings = stack(
        sn("F4", id="ratings-on", label="加入評比", hint="關閉時不儲存評比"),
        '<div class="app-ratings" id="ratings" hidden></div>',
    )

    illust_btn = sn("A1:link", variant="secondary", href="#illust-sheet", text="選擇插畫").replace("<a ", "<a data-dialog-open ", 1)
    photos = stack(
        sn("A2", buttons=sn("A1", id="camera-btn", text="拍照") + sn("A1", variant="secondary", id="pick-btn", text="從相簿選擇") + illust_btn),
        '<input class="app-file" id="camera-input" type="file" accept="image/*" capture="environment" aria-label="拍照" hidden>',
        '<input class="app-file" id="pick-input" type="file" accept="image/*" multiple aria-label="從相簿選擇照片" hidden>',
        '<div class="app-photo-grid" id="photo-grid"></div>',
        sn("F10", id="photo-status", role="status"),
    ) + "\n" + illustration_sheet()

    save = stack(
        sn("A1", variant="is-block", type="submit", id="save-btn", text="儲存點評", arrow=True),
        sn("F10", id="save-status", role="status"),
        sn("A2", buttons=sn("A1:link", variant="secondary", href="/share", text="做成分享圖").replace("<a ", '<a id="share-link" hidden ', 1)
           + sn("A1", variant="is-link", id="delete-btn", text="刪除這筆點評").replace("<button", "<button hidden", 1)),
    )

    cards = "\n".join([
        card("01", "basic-title", "基本資料", "標題、價格與點評內容", basic),
        card("02", "location-title", "位置", "點選地圖或拖曳標記，地址與座標互轉", location, accent="accent-blue"),
        card("03", "ratings-title", "評比（選用）", "每項 1–5 顆心，也可略過", ratings, accent="accent-violet"),
        card("04", "photos-title", "照片", "上傳前在裝置上壓縮，不保留原檔", photos, accent="accent-green"),
        card("05", "save-title", "儲存", "照片在儲存時一併上傳", save, variant="is-roomy is-wide"),
    ])
    main = sn("L4", cards=cards) + "\n" + privacy_note()
    page("edit.html", "新增點評｜記錄標題、價格、位置、評比與照片", "新增或編輯一筆食物點評",
         {"eyebrow": "NEW REVIEW", "solid": "店家點評", "outline": "記下這一餐",
          "lede": "剛吃完趁印象還在，記下價格、味道和位置。"},
         main, ["vendor/leaflet/leaflet.js", "module:js/edit.js"], "edit", form="review-form")


def illustration_sheet():
    # 「選擇插畫」對話框（D1）：點一張就加進照片，跟相簿照片走同一條壓縮與上傳流程（js/edit.js）
    for name, _ in ILLUSTRATIONS:
        if not (OUT / "img/illustrations" / name).is_file():
            sys.exit(f"找不到插畫：public/img/illustrations/{name}")
    items = "\n".join(
        f'<button class="app-illust" type="button" data-illust="/img/illustrations/{name}">'
        f'<img src="/img/illustrations/{name}" alt="" width="1200" height="1200" loading="lazy"><span>{label}</span></button>'
        for name, label in ILLUSTRATIONS)
    content = f'<p>點一張加進這筆點評的照片，儲存時一併上傳。</p>\n<div class="app-illust-grid">\n{items}\n</div>'
    return sn("D1", id="illust-sheet", accent="accent-green", title="選擇插畫", content=content, close="取消")


def tags_block():
    # 分類標籤（ADR 019）：輸入後按「加入」或 Enter，已加的分類以 chip 列出，點一下移除
    f3 = sn("F3", id="tag-input", placeholder="例如：拉麵", button="加入", button_label="加入分類")
    f3 = f3.replace('<button type="button"', '<button type="button" id="tag-add-btn"', 1)
    f3 = attr(f3, 'id="tag-input"', 'maxlength="60" list="tag-options" enterkeyhint="enter"')
    return stack(
        sn("F2:control", id="tag-input", label="分類（選用）", control=f3, hint="最多 10 個，每個 20 字內、不含空白；點已加的分類可移除"),
        '<datalist id="tag-options"></datalist>',
        '<div class="app-tag-list" id="tag-list" role="group" aria-label="已加的分類"></div>',
    )


def build_photos():
    content = "\n".join([
        sn("F1", id="search-form", content=search_control("例如：拉麵 信義", "搜尋照片")),
        sn("F10", id="gallery-status", role="status"),
        '<div class="app-gallery" id="gallery"></div>',
        sn("A1", variant="secondary", id="more-btn", text="載入更多").replace("<button", "<button hidden", 1),
    ])
    main = sn("L4", cards=card("01", "gallery-title", "照片集", "依店名、地址、點評、分類或照片說明搜尋", content, accent="accent-green", variant="is-roomy is-wide")) + "\n" + privacy_note()
    page("photos.html", "照片集｜瀏覽、搜尋與下載壓縮後的點評照片", "瀏覽、搜尋與下載點評照片",
         {"eyebrow": "PHOTO GALLERY", "solid": "照片集", "outline": "瀏覽下載",
          "lede": "翻翻吃過的每一餐，想要的照片存回手機。"},
         main, ["module:js/photos.js"], "photos")


def share_switches(prefix):
    return sn("F4:list", switches="".join(sn("F4", id=f"{prefix}-{k}", label=t) for k, t in SHARE_FIELDS))


def position_segment(name):
    return sn("A5", legend="浮水印位置", name=name, options=[{"value": "bottom", "text": "下方", "checked": True}, {"value": "top", "text": "上方"}])


def build_share():
    pick = stack(
        sn("F2:select", id="review-select", label="點評", options=[{"value": "0", "text": "載入中…"}]),
        share_switches("share"),
    )
    source = stack(
        sn("A5", legend="圖片來源", name="source", options=[
            {"value": "review", "text": "點評照片", "checked": True}, {"value": "album", "text": "相簿"},
            {"value": "camera", "text": "拍照"}, {"value": "none", "text": "純文字"}]),
        '<div class="app-photo-pick" id="review-photos"></div>',
        '<input class="app-file" id="album-input" type="file" accept="image/*" aria-label="從相簿選擇照片" hidden>',
        '<input class="app-file" id="camera-input" type="file" accept="image/*" capture="environment" aria-label="拍照" hidden>',
        position_segment("position"),
        sn("F5", id="opacity", label="底色不透明度（%）", min="40", max="95", step="5", value="80"),
        sn("F10", id="source-status", role="status"),
    )
    output = stack(
        '<canvas class="app-canvas" id="canvas" role="img" aria-label="分享圖預覽"></canvas>',
        sn("A2", buttons=sn("A1", id="download-btn", text="下載圖片") + sn("A1", variant="secondary", id="share-btn", text="分享圖片")),
        sn("F10", id="out-status", role="status"),
    )
    cards = "\n".join([
        card("01", "pick-title", "選擇點評與欄位", "勾選要放進浮水印的內容", pick),
        card("02", "source-title", "圖片來源", "點評照片、相簿或現場拍照", source, accent="accent-blue"),
        card("03", "output-title", "預覽與輸出", "合成後下載或用系統分享", output, accent="accent-violet", variant="is-roomy is-wide"),
    ])
    image_panel = stack(sn("L4", cards=cards), sn("C5", icon="⌁", title="分享圖在瀏覽器裡合成",
                                                   text="相簿或現場拍的照片只用來合成，不會上傳。"))
    # 分享圖與分享網頁以 A4:tabs 切換，?tab=web 由 share.js 開第二個頁籤（ADR 023）
    main = sn("A4:tabs", label="分享方式", tabs=[
        {"key": "image", "text": "分享圖", "pressed": "true", "panel": image_panel},
        {"key": "web", "text": "分享網頁", "pressed": "false", "hidden": True, "panel": share_web_panel()},
    ])
    page("share.html", "分享圖｜把點評做成浮水印合成在照片上", "勾選點評欄位，做成浮水印合成在照片上",
         {"eyebrow": "SHARE CARD", "solid": "點評", "outline": "做成分享圖",
          "lede": "把這一餐的心得壓在照片上，傳給朋友看。"},
         main, ["module:js/share.js"], "share")


def share_web_panel():
    # 分享網頁（ADR 020）：分類或單一點評建立免登入的公開連結
    target = stack(
        sn("A5", legend="分享內容", name="web-kind", options=[
            {"value": "tag", "text": "整個分類", "checked": True}, {"value": "review", "text": "單一點評"}]),
        sn("F2:select", id="web-tag", label="分類", options=[{"value": "0", "text": "載入中…"}], hint="列出已用在點評上的分類"),
        attr(sn("F2:select", id="web-review", label="點評", options=[{"value": "0", "text": "載入中…"}]), '<div class="field"', "hidden"),
        sn("A1", variant="is-block", id="web-create-btn", text="建立分享連結", arrow=True),
        sn("F10", id="web-status", role="status"),
    )
    links = stack(
        sn("F10", id="share-list-status", role="status"),
        '<ul class="app-key-list" id="share-list" aria-label="已分享的連結"></ul>',
    )
    cards = "\n".join([
        card("01", "web-title", "建立分享連結", "拿到連結的人不用登入就能看", target),
        card("02", "links-title", "已分享的連結", "複製、開啟，或停止分享讓連結失效", links, accent="accent-blue"),
    ])
    note = sn("C5", icon="!", title="分享網頁不需要登入就能看", warn="is-warn",
              text="連結是隨機產生、猜不到的網址，但轉傳出去任何人都能開。公開頁不顯示座標，照片以內嵌資料顯示、不露出照片網址；停止分享後連結立即失效。")
    return stack(sn("L4", cards=cards), note, share_card_dialog())


def share_card_dialog():
    # 分享卡片對話框：公開分享頁與「已分享的連結」共用，開關、卡片繪製與按鈕由 js/share-card.js 處理
    url = attr(sn("F2", id="share-card-url", label="網址（不用登入就能看）"), "<input", "readonly")
    hide = lambda html: html.replace("<button ", "<button hidden ", 1).replace("<a ", "<a hidden ", 1)
    save = sn("A1:link", href="#", text="儲存圖片").replace("<a ", '<a id="share-card-save" download ', 1)
    content = stack(
        url,
        sn("A2", buttons=sn("A1", id="share-card-copy", text="複製網址")
           + hide(sn("A1", variant="secondary", id="share-card-link", text="用其他 App 分享網址"))),
        '<div class="app-card-preview" id="share-card-preview" aria-live="polite"></div>',
        sn("A2", buttons=hide(save) + hide(sn("A1", variant="secondary", id="share-card-image", text="分享圖片"))),
        sn("F10", id="share-card-status", role="status"),
    )
    return sn("D1", id="share-card", title="分享連結", content=content, close="關閉")


def photo_box():
    # 公開分享頁的大圖檢視：D1 對話框限寬 560px 放不下大圖，另做 app-lightbox；開關與切換由 js/shared.js 的 bindPhotoBox() 處理
    return """<dialog class="app-lightbox" id="photo-box" aria-label="照片大圖">
  <div class="app-lightbox-body">
    <div class="app-lightbox-head"><span class="app-slider-count" id="photo-box-count"></span><button class="sheet-x" type="button" id="photo-box-close" aria-label="關閉">×</button></div>
    <img class="app-lightbox-img" id="photo-box-img" alt="">
    <p class="app-lightbox-caption" id="photo-box-caption"></p>
    <div class="app-slider-bar" id="photo-box-bar"><button class="btn secondary" type="button" data-box="-1">‹ 上一張</button><button class="btn secondary" type="button" data-box="1">下一張 ›</button></div>
  </div>
</dialog>"""


def build_shared():
    # 公開分享頁（/s/<token>）：免登入、唯讀，內容由 js/shared.js 依 token 載入（ADR 020–022）
    content = "\n".join([
        sn("F10", id="shared-status", role="status"),
        '<div class="app-review-list" id="shared-list"></div>',
        photo_box(),
        share_card_dialog(),
    ])
    main = sn("L4", cards=card("01", "shared-title", "分享的點評", "載入中…", content, variant="is-roomy is-wide"))
    page("shared.html", "吃過筆記｜分享的點評", "朋友分享的食物點評",
         {"eyebrow": "SHARED FOOD NOTES", "solid": "吃過筆記", "outline": "分享",
          "lede": "朋友吃過、覺得值得一提的店，整理在這裡。"},
         main, ["module:js/shared.js"], "public")


def build_settings():
    people = stack(
        sn("F2", id="nickname", label="稱呼", placeholder="例如：小林", hint="顯示在分享圖上").replace('id="nickname"', 'id="nickname" maxlength="30" autocomplete="nickname"', 1),
        sn("F2:select", id="default-hearts", label="預設心數", options=[{"value": str(n), "text": f"{n} 顆心", **({"selected": True} if n == 3 else {})} for n in range(1, 6)],
           hint="新增點評時每項評比的起始值"),
        sn("F4:list", switches=sn("F4", id="ratings-default-on", label="新增時開啟評比", hint="關閉時評比區預設收起")),
    )
    share = stack(share_switches("def-share"), position_segment("def-position"))
    photo = stack(
        sn("F2:select", id="max-edge", label="照片長邊", options=[{"value": "1280", "text": "1280 px"},
                                                               {"value": "1600", "text": "1600 px", "selected": True},
                                                               {"value": "2048", "text": "2048 px"}], hint="超過才縮小，不放大"),
        sn("F5", id="quality", label="JPEG 品質（%）", min="60", max="95", step="5", value="80"),
        # 稱呼浮水印：分享圖、公開分享頁與分享卡片的照片都照這個開關，不改上傳的照片；預設開啟（settings.js 依 D1 設定勾選）
        sn("F4:list", switches=sn("F4", id="watermark", label="分享的照片壓上稱呼浮水印", hint="分享圖照片角落、公開分享頁與分享卡片的照片壓上「稱呼」（公開頁沒設稱呼時用「吃過筆記」）；不改上傳的照片")),
    )
    # 儲存狀態列：放在卡片格線上方，不另佔一張卡；儲存按鈕是右下角的浮動圓鈕（.app-fab）
    save = "\n".join([
        '<div class="app-autosave">',
        '<p class="hint">改完按右下角「儲存」才會存到 D1，各裝置共用</p>',
        sn("F10", id="settings-status", role="status"),
        sn("A1", variant="is-link", id="reset-btn", text="恢復預設"),
        "</div>",
    ])
    cards = "\n".join([
        card("01", "people-title", "稱呼與評比", "新增點評時套用的預設值", people),
        card("02", "photo-title", "照片壓縮", "上傳前的長邊尺寸、JPEG 品質與分享圖浮水印", photo, accent="accent-blue"),
        card("03", "share-title", "分享預設", "分享頁一開始勾選的欄位", share, accent="accent-green"),
        card("04", "passkey-title", "通行金鑰", "用指紋、臉部或裝置密碼登入；變更立即生效，不用按儲存", passkey_block(), accent="accent-violet"),
        card("05", "account-title", "帳號與密碼", "密碼以雜湊存在 D1；修改後其他裝置要重新登入", account_block(), accent="accent-blue"),
        card("06", "usage-title", "用量", "已用空間與今日（UTC）讀寫次數，每小時更新", usage_block(), accent="accent-green"),
        card("07", "ga-title", "流量統計", "公開分享頁的 Google Analytics 4；改完按儲存", ga_block(), accent="accent-violet"),
    ])
    main = save + "\n" + sn("L4", cards=cards)
    # 浮動儲存鈕：固定在右下角，捲到哪都按得到；沒有未存變更時 disabled（settings.js 控制）
    main += '\n<button class="app-fab" type="button" id="save-btn" aria-label="儲存設定" disabled>儲存</button>'
    page("settings.html", "設定｜分享欄位、稱呼、預設心數與照片壓縮", "設定點評與分享的預設值",
         {"eyebrow": "SETTINGS", "solid": "預設值", "outline": "設定",
          "lede": "常用的評比與分享方式先設好，之後不用每次調。"},
         main, ["vendor/simplewebauthn/browser.umd.min.js", "module:js/settings.js"], "settings", form="settings-form")


def ga_block():
    # GA4（ADR 028）：只有公開分享頁載入 gtag；留空就完全不載入。和 01–03 一樣按儲存才寫入，由 settings.js 驗格式
    field = attr(sn("F2", id="ga-id", label="GA4 評估 ID", placeholder="G-XXXXXXXXXX",
                    hint="GA4 管理 → 資料串流 → 網頁串流裡的「評估 ID」；留空就不追蹤"),
                 'id="ga-id"', 'maxlength="22" autocomplete="off" autocapitalize="characters" spellcheck="false"')
    note = sn("C5", icon="i", title="只追蹤公開分享頁",
              text="登入後的頁面不載入 GA。GA 報表的網址會含分享連結的代碼，能看報表的人都能開那些分享頁。")
    return stack(field, note)


def usage_block():
    # 用量卡（src/storage.js）：一項一列的清單（X6），數值由 settings.js 依 dd 順序填入，順序要和這裡一致
    rows = [("D1 已用空間", "點評、設定等文字資料"),
            ("R2 已用空間", "壓縮後的照片"),
            ("D1 今日讀取", "帳號合計；免費方案每日 500 萬列"),
            ("D1 今日寫入", "帳號合計；免費方案每日 10 萬列"),
            ("Worker 今日請求", "帳號合計；免費方案每日 10 萬次")]
    items = [{"term": t, "sub": s, "text": "—"} for t, s in rows]
    stats = sn("X6", items=items).replace('<dl class="def-list"', '<dl class="def-list app-usage" id="usage-stats"', 1)
    return stack(stats, sn("F10", id="usage-status", role="status"))


def passkey_block():
    # 設定頁的通行金鑰卡：在 settings-form 裡，但按鈕都是 type=button，名稱欄按 Enter 由 settings.js 攔下改成新增
    f3 = sn("F3", id="passkey-name", placeholder="例如：iPhone、MacBook", button="新增", button_label="新增通行金鑰")
    f3 = f3.replace('<button type="button"', '<button type="button" id="add-passkey-btn"', 1)
    f3 = attr(f3, 'id="passkey-name"', 'maxlength="40"')
    return stack(
        sn("F2:control", id="passkey-name", label="新增通行金鑰", control=f3, hint="名稱用來辨認是哪台裝置；新增後會跳出系統的驗證視窗"),
        sn("F10", id="passkey-status", role="status"),
        '<ul class="app-key-list" id="passkey-list" aria-label="已註冊的通行金鑰"></ul>',
        sn("F4:list", switches=sn("F4", id="password-login", label="允許密碼登入",
                                  hint="至少有一把通行金鑰才能關閉；關閉後登入頁只剩通行金鑰")),
        sn("F10", id="password-login-status", role="status"),
    )


def account_block():
    # 設定頁的帳號卡：在 settings-form 裡，按鈕是 type=button，密碼欄按 Enter 由 settings.js 攔下改成修改密碼
    def pw(fid, label, autocomplete, hint=None):
        html = sn("F2", id=fid, label=label, type="password", **({"hint": hint} if hint else {}))
        return attr(html, f'id="{fid}"', f'autocomplete="{autocomplete}" maxlength="128"')
    return stack(
        attr(sn("F2", id="account-username", label="帳號"), 'id="account-username"', 'readonly autocomplete="username"'),
        pw("current-password", "目前的密碼", "current-password"),
        pw("new-password", "新密碼", "new-password", hint="8–128 個字，開頭與結尾不能是空白"),
        pw("confirm-password", "再輸入一次新密碼", "new-password"),
        sn("A1", variant="is-block", id="change-pw-btn", text="修改密碼", arrow=True),
        sn("F10", id="account-status", role="status"),
    )


def build_login():
    username = attr(sn("F2", id="username", label="帳號", placeholder="輸入帳號"), 'id="username"', 'autocomplete="username" maxlength="64"')
    f3 = sn("F3", id="password", type="password", placeholder="輸入密碼", button="顯示", button_label="顯示密碼")
    f3 = f3.replace('<button type="button"', '<button type="button" id="toggle-pw"', 1).replace('autocomplete="off"', 'autocomplete="current-password"', 1)
    form = sn("F1", id="login-form", content="\n".join([
        username,
        sn("F2:control", id="password", label="密碼", control=f3, hint="忘記密碼請看 README 的救援步驟"),
        sn("A1", variant="is-block", type="submit", text="登入", arrow=True),
        sn("F10", id="login-status", role="alert"),
    ]))
    passkey = stack(
        attr(sn("A1", variant="is-block", id="passkey-btn", text="用通行金鑰登入", arrow=True), 'id="passkey-btn"', "hidden"),
        sn("F10", id="passkey-status", role="alert"),
    )
    form = attr(form, 'id="login-form"', "hidden")
    main = sn("L4", cards=card("01", "login-title", "登入", "這是私人點評，需要通行金鑰或密碼才能使用", stack(passkey, form)))
    page("login.html", "登入｜食物點評", "登入食物點評",
         {"eyebrow": "FOOD REVIEW LOG", "solid": "食物點評", "outline": "登入",
          "lede": "打開只屬於你的美食紀錄，接著記下一餐。"},
         main, ["vendor/simplewebauthn/browser.umd.min.js", "module:js/login.js"], "login")


def build_offline():
    # service worker 在連不上網路時顯示這頁（public/sw.js 預先快取）；只用預先快取過的檔案，不呼叫 API
    content = stack(
        sn("C5", icon="⌁", title="目前沒有網路",
           text="點評與照片存在雲端，連上網路後才看得到。"),
        sn("A1:link", href="/", text="重新連線"),
    )
    main = sn("L4", cards=card("01", "offline-title", "離線中", "恢復連線後重新整理即可", content))
    page("offline.html", "離線中｜吃過筆記", "目前沒有網路連線",
         {"eyebrow": "FOOD REVIEW LOG", "solid": "吃過筆記", "outline": "離線",
          "lede": "網路恢復後，從上次停下的地方繼續記。"},
         main, [], "offline")


if __name__ == "__main__":
    if not JERRY.exists():
        sys.exit(f"找不到 jerry-ui.py：{JERRY}")
    build_index()
    build_edit()
    build_photos()
    build_share()
    build_shared()
    build_settings()
    build_login()
    build_offline()
