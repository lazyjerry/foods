#!/usr/bin/env python3
"""README 截圖與操作影片（Playwright）。由 scripts/readme-media.sh 呼叫，對一次性的本機 wrangler dev 執行。

用法：python3 scripts/readme_media.py BASE_URL PASSWORD --out docs/readme-media --video-dir 暫存目錄 [--seed N]
- 寫入 scripts/readme-media-reviews.json 的虛構點評；照片從 public/img/illustrations/*.jpg 隨機挑（--seed 固定結果）。
- 截圖存 <out>/screenshots/，影片（webm）存 --video-dir，轉檔交給外層 shell。
"""
import argparse
import json
import random
import sys
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
ap = argparse.ArgumentParser()
ap.add_argument("base")
ap.add_argument("password")
ap.add_argument("--account", default="admin")
ap.add_argument("--out", required=True)
ap.add_argument("--video-dir", required=True)
ap.add_argument("--seed", type=int)
args = ap.parse_args()
BASE = args.base.rstrip("/")
OUT = Path(args.out)
SHOTS = OUT / "screenshots"
SHOTS.mkdir(parents=True, exist_ok=True)

fixture = json.loads((ROOT / "scripts/readme-media-reviews.json").read_text(encoding="utf-8"))
photos = sorted((ROOT / "public/img/illustrations").glob("*.jpg"))
seed = args.seed if args.seed is not None else random.randrange(1_000_000)
rng = random.Random(seed)
print(f"照片隨機種子：{seed}（重現同一組照片用 --seed {seed}）")


def must(resp, what):
    if not resp.ok:
        sys.exit(f"{what} 失敗：HTTP {resp.status} {resp.text()[:200]}")
    return resp.json()


def seed_data(req):
    must(req.post(BASE + "/api/login", data={"username": args.account, "password": args.password}), "登入")
    must(req.put(BASE + "/api/settings", data={"nickname": fixture["nickname"]}), "設定稱呼")
    ids = {}
    deck = []
    for r in reversed(fixture["reviews"]):  # 列表新的在上，倒序建立讓 JSON 順序等於畫面順序
        body = {k: v for k, v in r.items() if k != "photos"}
        review = must(req.post(BASE + "/api/reviews", data=body), f"建立點評 {r['title']}")["review"]
        ids[r["title"]] = review["id"]
        for _ in range(r["photos"]):
            if not deck:  # 洗牌後依序發，照片用完才重洗，避免同一張重複出現
                deck.extend(rng.sample(photos, len(photos)))
            path = deck.pop()
            w, h = Image.open(path).size
            must(req.post(f"{BASE}/api/reviews/{review['id']}/photos?w={w}&h={h}&caption=示範插畫",
                          headers={"Content-Type": "image/jpeg"}, data=path.read_bytes()), f"上傳 {path.name}")
            print(f"  {r['title']} ← {path.name}")
    share = must(req.post(BASE + "/api/shares", data={"kind": "tag", "tag": "小吃"}), "建立分享連結")["share"]
    return ids, share


def settle(page, ms=600):
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(ms)


def scroll_to(page, selector, offset=24):
    page.evaluate("([s, o]) => window.scrollTo({ top: document.querySelector(s).getBoundingClientRect().top + scrollY - o, behavior: 'smooth' })", [selector, offset])
    page.wait_for_timeout(900)


# 公開的截圖與影片不露出實際位置：地圖圖磚模糊、緯度經度欄看不清楚（標記與操作照常）
MASK_CSS = """
.app-map .leaflet-tile-pane { filter: blur(14px) grayscale(0.4); }
#lat, #lng { color: transparent; text-shadow: 0 0 9px var(--ink); }
"""


def masked_context(browser, **kw):
    ctx = browser.new_context(**kw)
    ctx.add_init_script("document.addEventListener('DOMContentLoaded', () => {"
                        f" const s = document.createElement('style'); s.textContent = {json.dumps(MASK_CSS)}; document.head.append(s); }});")
    return ctx


def shot(page, name, url, selector=None, height=900, wait=1000, offset=24):
    """開 url、捲到 selector、以目前視窗寬 × height 截圖（視窗先調高，lazy 圖片才會載入）。"""
    page.set_viewport_size({"width": page.viewport_size["width"], "height": height})
    page.goto(url)
    settle(page, wait)
    if selector:
        scroll_to(page, selector, offset)
        settle(page, 600)
    page.screenshot(path=str(SHOTS / f"{name}.png"))


def screenshots(browser, ids, share):
    login = {"username": args.account, "password": args.password}
    desktop = masked_context(browser, viewport={"width": 1280, "height": 900}, locale="zh-TW")
    must(desktop.request.post(BASE + "/api/login", data=login), "截圖登入")
    page = desktop.new_page()
    shot(page, "list", BASE + "/", "#list-title", height=1180)
    shot(page, "edit", f"{BASE}/edit?id={ids['巷口老王牛肉麵']}", "#location-title", wait=1500)
    shot(page, "photos", BASE + "/photos", "#gallery-title", height=1000)
    desktop.close()

    public = masked_context(browser, viewport={"width": 1280, "height": 900}, locale="zh-TW")
    shot(public.new_page(), "shared", f"{BASE}/s/{share['token']}", "#shared-title", height=1000)
    public.close()

    mobile = masked_context(browser, viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True, locale="zh-TW")
    must(mobile.request.post(BASE + "/api/login", data=login), "手機截圖登入")
    page = mobile.new_page()
    shot(page, "list-mobile", BASE + "/", "#list-title", height=844, offset=12)
    shot(page, "share-mobile", f"{BASE}/share?id={ids['雙人鍋物所']}", "#output-title", height=844, wait=1500, offset=12)
    mobile.close()


def video(browser, ids):
    size = {"width": 1280, "height": 800}
    ctx = masked_context(browser, viewport=size, record_video_dir=args.video_dir, record_video_size=size, locale="zh-TW")
    page = ctx.new_page()
    page.goto(BASE + "/login")
    settle(page, 800)
    page.type("#username", args.account, delay=90)
    page.type("#password", args.password, delay=60)
    page.click("#login-form button[type=submit]")
    page.wait_for_url(BASE + "/")
    settle(page, 1200)
    scroll_to(page, "#list-title")
    page.wait_for_timeout(1200)
    page.evaluate("window.scrollBy({ top: 700, behavior: 'smooth' })")
    page.wait_for_timeout(1500)
    scroll_to(page, "#list-title")
    page.type("#q", "小吃", delay=180)
    page.click("#search-btn")
    settle(page, 1800)

    page.click(f'.app-review h3 a[href="/edit?id={ids["夜貓鹽酥雞"]}"]')
    settle(page, 1500)
    scroll_to(page, "#location-title")
    settle(page, 2000)
    page.evaluate("window.scrollBy({ top: 600, behavior: 'smooth' })")
    page.wait_for_timeout(1800)

    page.goto(f"{BASE}/share?id={ids['夜貓鹽酥雞']}")
    settle(page, 1500)
    page.click("label.switch:has(#share-body)")
    page.wait_for_timeout(800)
    scroll_to(page, "#output-title")
    page.wait_for_timeout(2500)

    page.goto(BASE + "/photos")
    settle(page, 1500)
    page.evaluate("window.scrollBy({ top: 500, behavior: 'smooth' })")
    page.wait_for_timeout(2000)
    ctx.close()  # 關閉 context 才會寫出 webm


with sync_playwright() as p:
    browser = p.chromium.launch()
    req_ctx = browser.new_context()
    ids, share = seed_data(req_ctx.request)
    req_ctx.close()
    screenshots(browser, ids, share)
    video(browser, ids)
    browser.close()
print("截圖：" + "、".join(sorted(x.name for x in SHOTS.glob("*.png"))))
