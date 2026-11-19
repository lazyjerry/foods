// 照片檔的三種 key（photos.r2_key）與讀取、刪除：
// - photos/<點評 id>/<uuid>.jpg：舊格式，每張照片一個 R2 檔
// - blobs/<sha256>.jpg：內容雜湊，同一張壓縮後的照片只存一份 R2 檔，可被多筆照片引用
// - illust/<檔名>：站內插畫（public/img/illustrations/），不進 R2，直接讀靜態檔
// 刪除照片時只有在沒有任何照片再引用同一個 key 時，才刪 R2 檔；併發與中斷的處理見下方「併發與中斷保護」。
import { HttpError } from "./http.js";

const LEGACY_KEY = /^photos\/\d+\/[0-9a-f-]{36}\.jpg$/;
const BLOB_KEY = /^blobs\/[0-9a-f]{64}\.jpg$/;
const ILLUST_KEY = /^illust\/((?:food|meal)-\d{2}\.jpg)$/;
const ASSET_ORIGIN = "https://assets.invalid"; // ASSETS binding 只看路徑，主機名稱隨意

export const isValidKey = (key) => LEGACY_KEY.test(key) || BLOB_KEY.test(key) || ILLUST_KEY.test(key);
export const isR2Key = (key) => LEGACY_KEY.test(key) || BLOB_KEY.test(key);
export const blobKey = (sha256) => `blobs/${sha256}.jpg`;

export async function sha256Hex(buf) {
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// 插畫檔名 → key 與檔案大小；檔名不合格或站內沒有這張插畫回 null
export async function illustInfo(env, name) {
  const key = `illust/${name}`;
  if (!ILLUST_KEY.test(key)) return null;
  const res = await env.ASSETS.fetch(new Request(`${ASSET_ORIGIN}/img/illustrations/${name}`));
  if (!res.ok) return null;
  const bytes = (await res.arrayBuffer()).byteLength;
  return { key, bytes };
}

// 讀照片內容：回傳 { body, type, etag }，找不到回 null
export async function readPhoto(env, key) {
  const illust = key.match(ILLUST_KEY);
  if (illust) {
    const res = await env.ASSETS.fetch(new Request(`${ASSET_ORIGIN}/img/illustrations/${illust[1]}`));
    if (!res.ok) return null;
    return { body: res.body, type: res.headers.get("Content-Type") || "image/jpeg", etag: res.headers.get("ETag") };
  }
  if (!isR2Key(key)) return null;
  const obj = await env.PHOTOS.get(key);
  if (!obj) return null;
  return { body: obj.body, type: obj.httpMetadata?.contentType || "image/jpeg", etag: obj.httpEtag };
}

// ---------- 併發與中斷保護（migration 0008） ----------
// 共用的 R2 檔可能同時被「上傳去重（新增引用）」與「回收（沒有引用就刪檔）」碰到，兩者都要先拿同一個 key 的租約鎖。
// 寫照片紀錄用條件式 INSERT 確認自己還持有鎖（db.insertPhoto 的 lock 參數），刪 R2 檔前確認租約還剩 SAFE_MS 以上，
// 所以就算持有者執行太久、鎖被別人接手，也不會一邊新增引用、一邊刪檔。
// 中斷保護：刪照片紀錄與登記待回收（blob_gc）在同一個交易；上傳在寫 R2 之前先登記。中途失敗的登記由排程（scheduled）重試。
const LOCK_MS = 30_000;
const SAFE_MS = 5_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 拿 key 的鎖後執行 fn({ key, owner })，結束一定釋放；waitMs 內拿不到回 503
export async function withLock(env, key, fn, { waitMs = 5_000 } = {}) {
  const owner = crypto.randomUUID();
  const deadline = Date.now() + waitMs;
  for (let delay = 50; ; delay = Math.min(delay * 2, 500)) {
    const t = Date.now();
    const res = await env.DB
      .prepare(`INSERT INTO blob_locks (key, owner, expires_at) VALUES (?1, ?2, ?3)
        ON CONFLICT (key) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at WHERE blob_locks.expires_at <= ?4`)
      .bind(key, owner, t + LOCK_MS, t)
      .run();
    if (res.meta.changes) break;
    if (Date.now() + delay > deadline) throw new HttpError(503, "這張照片正在處理中，請稍後再試一次");
    await sleep(delay);
  }
  try {
    return await fn({ key, owner });
  } finally {
    await env.DB.prepare("DELETE FROM blob_locks WHERE key = ? AND owner = ?").bind(key, owner).run().catch(() => {}); // 釋放失敗就等租約到期
  }
}

export async function queueGc(env, key) {
  await env.DB.prepare("INSERT OR IGNORE INTO blob_gc (key, queued_at) VALUES (?, ?)").bind(key, new Date().toISOString()).run();
}

// 持有 key 的鎖時呼叫：沒有照片引用就刪 R2 檔，最後移除待回收登記。回傳是否刪了檔
export async function collect(env, lock) {
  const { key, owner } = lock;
  const ref = await env.DB.prepare("SELECT 1 FROM photos WHERE r2_key = ? LIMIT 1").bind(key).first();
  if (!ref) {
    const held = await env.DB
      .prepare("SELECT 1 FROM blob_locks WHERE key = ? AND owner = ? AND expires_at > ?")
      .bind(key, owner, Date.now() + SAFE_MS)
      .first();
    if (!held) return false; // 租約快到期或已被接手：這次不刪，登記留給排程
    await env.PHOTOS.delete(key);
  }
  await env.DB.prepare("DELETE FROM blob_gc WHERE key = ?").bind(key).run();
  return !ref;
}

// 照片紀錄刪掉之後呼叫（紀錄與待回收登記已在同一個交易寫入）：立刻試著回收；鎖被占用或出錯就留給排程
export async function collectKeys(env, keys) {
  let deleted = 0;
  for (const key of new Set(keys.filter(isR2Key))) {
    try {
      if (await withLock(env, key, (lock) => collect(env, lock), { waitMs: 0 })) deleted++;
    } catch (err) {
      if (!(err instanceof HttpError)) console.error("回收照片檔失敗，留給排程重試", key, err);
    }
  }
  return deleted;
}

// 排程：重試待回收登記，並清掉早已過期的鎖
export async function sweep(env, limit = 100) {
  const { results } = await env.DB.prepare("SELECT key FROM blob_gc ORDER BY queued_at LIMIT ?").bind(limit).all();
  const deleted = await collectKeys(env, results.map((r) => r.key));
  await env.DB.prepare("DELETE FROM blob_locks WHERE expires_at < ?").bind(Date.now() - 3_600_000).run();
  return { queued: results.length, deleted };
}

export function assertValidKey(key) {
  if (!isValidKey(key)) throw new HttpError(404, "找不到這張照片");
}
