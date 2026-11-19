"""照片檔共用的併發與中斷情境測試（src/media.js、migration 0008），只對本機跑。

用法：先在另一個終端機跑 `npx wrangler dev --test-scheduled`，再執行
    python3 scripts/photo-gc-test.py [BASE_URL] [PASSWORD] [ACCOUNT]
直接改本機 D1（blob_locks、blob_gc）與 R2 來模擬「鎖被別人占用」「上傳寫完檔就中斷」「鎖過期」等狀況，
用 /__scheduled 觸發排程回收。會建立並刪除一筆測試點評。
"""
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8787").rstrip("/")
PASSWORD = sys.argv[2] if len(sys.argv) > 2 else "dev-password"
ACCOUNT = sys.argv[3] if len(sys.argv) > 3 else "admin"
DB = "food-review-db"
BUCKET = "food-review-photos"
fails = []
cookies = {}  # 手動帶 cookie：cookiejar 不把 localhost 上的 Secure cookie 送回 http


def ok(name, cond, detail=""):
    print(("通過：" if cond else "失敗：") + name + ("" if cond else f"（{detail}）"))
    if not cond:
        fails.append(name)


def req(method, path, data=None, ctype=None):
    headers = {"Content-Type": ctype} if ctype else {}
    if isinstance(data, (dict, list)):
        data, headers = json.dumps(data).encode(), {"Content-Type": "application/json"}
    if cookies:
        headers["Cookie"] = "; ".join(f"{k}={v}" for k, v in cookies.items())
    r = urllib.request.Request(BASE + path, data=data, method=method, headers=headers)
    try:
        res = urllib.request.urlopen(r)
    except urllib.error.HTTPError as e:
        res = e
    for c in res.headers.get_all("Set-Cookie") or []:
        name, _, rest = c.partition("=")
        cookies[name.strip()] = rest.split(";", 1)[0]
    return res.status if hasattr(res, "status") else res.code, res.read()


def jbody(body):
    return json.loads(body or b"null")


def sql(command):
    out = subprocess.run(["npx", "wrangler", "d1", "execute", DB, "--local", "--json", "--command", command],
                         capture_output=True, text=True, check=True).stdout
    return json.loads(out)[0]["results"]


def r2_put(key, path):
    subprocess.run(["npx", "wrangler", "r2", "object", "put", f"{BUCKET}/{key}", "--local", "--file", path, "--content-type", "image/jpeg"],
                   capture_output=True, check=True)


def media_status(key):
    return req("GET", "/media/" + key)[0]


def scheduled():
    with urllib.request.urlopen(BASE + "/__scheduled?cron=17+*+*+*+*") as res:
        return res.status


def make_jpeg():
    # 每次執行都用不同內容，雜湊不會跟其他資料撞在一起
    data = bytes([0xFF, 0xD8, 0xFF, 0xE0]) + os.urandom(64) + bytes([0xFF, 0xD9])
    return data, hashlib.sha256(data).hexdigest()


def upload(rid, data):
    return req("POST", f"/api/reviews/{rid}/photos?w=10&h=10", data, "image/jpeg")


def future(ms):
    return int(time.time() * 1000) + ms


s, _ = req("POST", "/api/login", {"username": ACCOUNT, "password": PASSWORD})
ok("登入", s == 200, s)
s, b = req("POST", "/api/reviews", {"title": "照片回收情境測試", "price": 1, "lat": 25.03, "lng": 121.56, "address": ""})
rid = jbody(b)["review"]["id"]
tmp = tempfile.mkdtemp()

# 1. 鎖被別人占用：同一張照片的上傳要等，等不到回 503，不會寫紀錄
data, sha = make_jpeg()
key = f"blobs/{sha}.jpg"
sql(f"INSERT INTO blob_locks (key, owner, expires_at) VALUES ('{key}', 'other', {future(60_000)})")
t = time.time()
s, b = upload(rid, data)
ok("鎖被占用時上傳回 503", s == 503, (s, b))
ok("等候約 5 秒才放棄", 4 <= time.time() - t <= 10, time.time() - t)
ok("鎖被占用時沒有寫紀錄", not sql(f"SELECT 1 FROM photos WHERE r2_key = '{key}'"))
s, b = req("POST", f"/api/reviews/{rid}/photos?sha256={sha}")
ok("鎖被占用時只送雜湊也回 503", s == 503, (s, b))

# 2. 鎖過期就能接手
sql(f"UPDATE blob_locks SET expires_at = {future(-1000)} WHERE key = '{key}'")
s, b = upload(rid, data)
ok("鎖過期後可以接手上傳", s == 201 and jbody(b)["photo"]["key"] == key, (s, b))
pid = jbody(b)["photo"]["id"]
ok("上傳完成後釋放鎖、沒有留下待回收登記",
   not sql(f"SELECT 1 FROM blob_locks WHERE key = '{key}'") and not sql(f"SELECT 1 FROM blob_gc WHERE key = '{key}'"))

# 3. 刪除時鎖被占用：紀錄照刪、登記待回收、檔先留著；鎖釋放後排程才刪檔
sql(f"INSERT INTO blob_locks (key, owner, expires_at) VALUES ('{key}', 'other', {future(60_000)})")
s, _ = req("DELETE", f"/api/photos/{pid}")
ok("鎖被占用時刪除照片仍成功", s == 200, s)
ok("刪除紀錄時同時登記待回收", bool(sql(f"SELECT 1 FROM blob_gc WHERE key = '{key}'")))
ok("鎖被占用時不刪檔", media_status(key) == 200)
scheduled()
ok("鎖還在時排程也不刪檔", media_status(key) == 200 and bool(sql(f"SELECT 1 FROM blob_gc WHERE key = '{key}'")))
sql(f"DELETE FROM blob_locks WHERE key = '{key}'")
scheduled()
ok("鎖釋放後排程刪掉沒有引用的檔", media_status(key) == 404 and not sql(f"SELECT 1 FROM blob_gc WHERE key = '{key}'"))

# 4. 上傳寫完檔就中斷（有檔、有登記、沒有紀錄）：排程回收
data, sha = make_jpeg()
key = f"blobs/{sha}.jpg"
path = os.path.join(tmp, "orphan.jpg")
open(path, "wb").write(data)
r2_put(key, path)
sql(f"INSERT INTO blob_gc (key, queued_at) VALUES ('{key}', '2026-01-01T00:00:00.000Z')")
ok("模擬中斷留下孤兒檔", media_status(key) == 200)
scheduled()
ok("排程回收中斷留下的孤兒檔", media_status(key) == 404 and not sql(f"SELECT 1 FROM blob_gc WHERE key = '{key}'"))

# 5. 登記待回收後、排程前又被引用：排程不刪檔，只移除登記
data, sha = make_jpeg()
key = f"blobs/{sha}.jpg"
s, b = upload(rid, data)
pid = jbody(b)["photo"]["id"]
sql(f"INSERT INTO blob_locks (key, owner, expires_at) VALUES ('{key}', 'other', {future(60_000)})")
req("DELETE", f"/api/photos/{pid}")  # 鎖被占用，留下待回收登記
sql(f"DELETE FROM blob_locks WHERE key = '{key}'")
s, b = req("POST", f"/api/reviews/{rid}/photos?sha256={sha}")
ok("待回收的檔在回收前被重新引用", s == 201 and jbody(b)["reused"] is True, (s, b))
scheduled()
ok("排程看到有引用就不刪檔、移除登記", media_status(key) == 200 and not sql(f"SELECT 1 FROM blob_gc WHERE key = '{key}'"))

# 6. 真的同時送出：刪除最後一筆引用與用同一雜湊重新引用並行，每輪都要「有紀錄引用就讀得到檔」
from concurrent.futures import ThreadPoolExecutor

data6, sha6 = make_jpeg()
key6 = f"blobs/{sha6}.jpg"
broken = 0
with ThreadPoolExecutor(max_workers=2) as pool:
    for _ in range(20):
        s, b = upload(rid, data6)
        pid = jbody(b)["photo"]["id"]
        f1 = pool.submit(req, "DELETE", f"/api/photos/{pid}")
        f2 = pool.submit(lambda: upload(rid, data6) if req("POST", f"/api/reviews/{rid}/photos?sha256={sha6}")[0] != 201 else None)
        f1.result(), f2.result()
        refs = sql(f"SELECT id FROM photos WHERE r2_key = '{key6}'")
        if refs and media_status(key6) != 200:
            broken += 1
        for r in refs:
            req("DELETE", f"/api/photos/{r['id']}")
ok("並行刪除與重新引用 20 輪沒有破圖", broken == 0, broken)
scheduled()
ok("並行測試後沒有引用的檔被回收", media_status(key6) == 404 and not sql(f"SELECT 1 FROM blob_gc WHERE key = '{key6}'"))

# 7. 刪除點評：紀錄與登記同一個交易，回收後檔與登記都清掉
s, _ = req("DELETE", f"/api/reviews/{rid}")
ok("刪除測試點評", s == 200, s)
ok("刪除點評後沒有引用的檔被回收", media_status(key) == 404 and not sql(f"SELECT 1 FROM blob_gc WHERE key = '{key}'"))
ok("沒有殘留的鎖", not sql("SELECT 1 FROM blob_locks WHERE expires_at > %d" % int(time.time() * 1000)))

sys.exit(1 if fails else 0)
