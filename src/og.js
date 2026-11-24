// 分享預覽小圖（公開分享連結的 og:image）：每筆點評第一張照片做一張壓上稱呼浮水印的 JPEG，存 R2 `og/og-<點評 id>.jpg`。
// - 小圖由編輯頁儲存點評時在瀏覽器產生（浮水印跟分享圖同一支 watermark()），後端只收檔、驗大小與格式。
//   改稱呼不重做；重新儲存該點評才會用當下的稱呼重做。
// - customMetadata.source 記下是用哪張照片（photos.r2_key）做的；第一張照片換了、小圖還沒重做時，不拿舊小圖出去。
// - 第一張是站內插畫時不做小圖，直接用插畫原檔。
// - 點評刪除時一起刪；小圖只在公開分享頁的 head 出現（/s/<token>/og.jpg），畫面上仍不出現圖片網址（ADR 021）。
import { HttpError, json } from "./http.js";
import { isIllustKey, isR2Key, readPhoto } from "./media.js";

export const OG_MAX_BYTES = 800 * 1024;

export const ogKey = (reviewId) => `og/og-${reviewId}.jpg`;

// 點評的第一張照片（跟列表封面同一個排序）；沒有照片回 null
export async function coverPhoto(db, reviewId) {
  return db.prepare("SELECT review_id, r2_key, width, height FROM photos WHERE review_id = ? ORDER BY id LIMIT 1").bind(reviewId).first();
}

export async function putOg(request, env, reviewId, url) {
  if ((request.headers.get("Content-Type") || "") !== "image/jpeg") throw new HttpError(415, "分享預覽圖只接受 JPEG");
  const buf = await request.arrayBuffer();
  if (buf.byteLength === 0) throw new HttpError(400, "分享預覽圖是空的");
  if (buf.byteLength > OG_MAX_BYTES) throw new HttpError(413, "分享預覽圖超過 800 KB");
  const head = new Uint8Array(buf, 0, 3);
  if (head[0] !== 0xff || head[1] !== 0xd8 || head[2] !== 0xff) throw new HttpError(415, "檔案不是 JPEG");
  const cover = await coverPhoto(env.DB, reviewId);
  const source = url.searchParams.get("source") || "";
  if (!cover || cover.r2_key !== source || !isR2Key(source)) throw new HttpError(409, "第一張照片已經變更，請重新儲存點評");
  const width = String(Math.max(0, Number(url.searchParams.get("w")) || 0));
  const height = String(Math.max(0, Number(url.searchParams.get("h")) || 0));
  await env.PHOTOS.put(ogKey(reviewId), buf, { httpMetadata: { contentType: "image/jpeg" }, customMetadata: { source, width, height } });
  return json({ ok: true, bytes: buf.byteLength });
}

export async function deleteOg(env, reviewId) {
  await env.PHOTOS.delete(ogKey(reviewId));
}

// 第一張照片 → 分享預覽圖：{ key, width, height, version }；沒有可用的圖回 null
// version 放進 og:image 網址，圖換了網址就換，社群平台才不會一直用舊快取
export async function ogImage(env, cover) {
  if (!cover) return null;
  if (isIllustKey(cover.r2_key)) return { key: cover.r2_key, width: cover.width, height: cover.height, version: cover.r2_key.slice("illust/".length, -".jpg".length) };
  if (!isR2Key(cover.r2_key)) return null;
  const head = await env.PHOTOS.head(ogKey(cover.review_id));
  if (!head || head.customMetadata?.source !== cover.r2_key) return null;
  return { key: ogKey(cover.review_id), width: Number(head.customMetadata.width) || null, height: Number(head.customMetadata.height) || null, version: head.etag.slice(0, 12) };
}

// 讀 ogImage() 回傳的圖：{ body, type }，找不到回 null
export async function readOg(env, image) {
  if (isIllustKey(image.key)) return readPhoto(env, image.key);
  const obj = await env.PHOTOS.get(image.key);
  return obj ? { body: obj.body, type: "image/jpeg" } : null;
}
