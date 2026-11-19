// 照片檔的三種 key（photos.r2_key）與讀取、刪除：
// - photos/<點評 id>/<uuid>.jpg：舊格式，每張照片一個 R2 檔
// - blobs/<sha256>.jpg：內容雜湊，同一張壓縮後的照片只存一份 R2 檔，可被多筆照片引用
// - illust/<檔名>：站內插畫（public/img/illustrations/），不進 R2，直接讀靜態檔
// 刪除照片時只有在沒有任何照片再引用同一個 key 時，才刪 R2 檔。
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

// 照片紀錄刪掉之後呼叫：keys 裡已經沒有照片引用的 R2 檔才刪；插畫不在 R2，略過
export async function deleteUnreferenced(env, keys) {
  const r2Keys = [...new Set(keys)].filter(isR2Key);
  if (!r2Keys.length) return 0;
  const { results } = await env.DB
    .prepare(`SELECT DISTINCT r2_key FROM photos WHERE r2_key IN (${r2Keys.map(() => "?").join(",")})`)
    .bind(...r2Keys)
    .all();
  const stillUsed = new Set(results.map((r) => r.r2_key));
  const orphans = r2Keys.filter((k) => !stillUsed.has(k));
  if (orphans.length) await env.PHOTOS.delete(orphans);
  return orphans.length;
}

export function assertValidKey(key) {
  if (!isValidKey(key)) throw new HttpError(404, "找不到這張照片");
}
