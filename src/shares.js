// 公開分享連結（ADR 020–022）：分類或單一點評建一個隨機 token，/s/<token> 免登入可看。
// 公開 API 不回座標、R2 key；照片逐張轉成 base64 data URI 回傳，畫面上不出現圖片網址。
import { HttpError, json, parseId, readJson } from "./http.js";
import { getSettings, normalizeTag, parseTags, searchTerms } from "./db.js";
import { readPhoto } from "./media.js";
import { ogImage, readOg } from "./og.js";

const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;
const MAX_REVIEWS = 100;

function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function checkToken(token) {
  if (!TOKEN_RE.test(token)) throw new HttpError(404, "這個分享連結不存在或已停止分享");
  return token;
}

function rowToShare(row) {
  return {
    token: row.token,
    kind: row.kind,
    tag: row.tag,
    review_id: row.review_id,
    title: row.kind === "tag" ? `#${row.tag}` : row.title,
    created_at: row.created_at,
  };
}

const SHARE_SELECT = "SELECT s.*, r.title FROM shares s LEFT JOIN reviews r ON r.id = s.review_id";

// ---------- 管理（需登入） ----------
// 分頁比照點評列表（ADR 024）的 keyset cursor；shares 沒有數字 id，游標改用 `<created_at>~<token>`。
function parseShareCursor(value) {
  if (!value) return null;
  const m = /^([^~]{1,40})~([A-Za-z0-9_-]{22})$/.exec(String(value));
  if (!m) throw new HttpError(400, "分頁位置格式不正確，請重新整理頁面");
  return { createdAt: m[1], token: m[2] };
}

// 關鍵字比對分類名稱或點評標題；多個關鍵字全部符合才列出，拆詞規則跟點評搜尋相同。
export async function listShares(env, url) {
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 10, 1), 50);
  const cursor = parseShareCursor(url.searchParams.get("cursor"));
  const terms = searchTerms(url.searchParams.get("q"));
  const conds = terms.map(() => "instr(lower(coalesce(s.tag, '') || ' ' || coalesce(r.title, '')), ?) > 0");
  if (cursor) conds.push("(s.created_at, s.token) < (?, ?)");
  const after = cursor ? [cursor.createdAt, cursor.token] : [];
  const { results } = await env.DB
    .prepare(`${SHARE_SELECT} ${conds.length ? "WHERE " + conds.join(" AND ") : ""} ORDER BY s.created_at DESC, s.token DESC LIMIT ?`)
    .bind(...terms, ...after, limit + 1)
    .all();
  const rows = results.slice(0, limit);
  const hasMore = results.length > limit;
  const last = rows[rows.length - 1];
  return json({ shares: rows.map(rowToShare), hasMore, nextCursor: hasMore ? `${last.created_at}~${last.token}` : null });
}

export async function createShare(request, env) {
  const body = await readJson(request);
  const db = env.DB;
  let row;
  if (body?.kind === "tag") {
    const tag = normalizeTag(body.tag);
    if (!tag) throw new HttpError(422, "請選擇要分享的分類");
    const used = await db.prepare("SELECT 1 FROM reviews r, json_each(r.tags) j WHERE j.value = ? LIMIT 1").bind(tag).first();
    if (!used) throw new HttpError(404, `沒有點評屬於分類「${tag}」`);
    row = await db.prepare(`${SHARE_SELECT} WHERE s.kind = 'tag' AND s.tag = ?`).bind(tag).first();
    if (!row) {
      await db.prepare("INSERT OR IGNORE INTO shares (token, kind, tag, created_at) VALUES (?, 'tag', ?, ?)").bind(newToken(), tag, new Date().toISOString()).run();
      row = await db.prepare(`${SHARE_SELECT} WHERE s.kind = 'tag' AND s.tag = ?`).bind(tag).first();
    }
  } else if (body?.kind === "review") {
    const id = parseId(body.review_id);
    if (!(await db.prepare("SELECT 1 FROM reviews WHERE id = ?").bind(id).first())) throw new HttpError(404, "找不到這筆點評，可能已被刪除");
    row = await db.prepare(`${SHARE_SELECT} WHERE s.kind = 'review' AND s.review_id = ?`).bind(id).first();
    if (!row) {
      await db.prepare("INSERT OR IGNORE INTO shares (token, kind, review_id, created_at) VALUES (?, 'review', ?, ?)").bind(newToken(), id, new Date().toISOString()).run();
      row = await db.prepare(`${SHARE_SELECT} WHERE s.kind = 'review' AND s.review_id = ?`).bind(id).first();
    }
  } else {
    throw new HttpError(422, "分享類型要是分類或單一點評");
  }
  return json({ share: rowToShare(row) }, 201);
}

export async function deleteShare(env, token) {
  checkToken(token);
  const res = await env.DB.prepare("DELETE FROM shares WHERE token = ?").bind(token).run();
  if (!res.meta.changes) throw new HttpError(404, "這個分享連結已經停止分享");
  return json({ ok: true });
}

// ---------- 公開（免登入） ----------
async function findShare(db, token) {
  checkToken(token);
  const row = await db.prepare("SELECT * FROM shares WHERE token = ?").bind(token).first();
  if (!row) throw new HttpError(404, "這個分享連結不存在或已停止分享");
  return row;
}

async function scopeReviews(db, share) {
  if (share.kind === "review") {
    const { results } = await db.prepare("SELECT * FROM reviews WHERE id = ?").bind(share.review_id).all();
    return results;
  }
  const { results } = await db
    .prepare("SELECT r.* FROM reviews r WHERE EXISTS (SELECT 1 FROM json_each(r.tags) j WHERE j.value = ?) ORDER BY r.created_at DESC, r.id DESC LIMIT ?")
    .bind(share.tag, MAX_REVIEWS)
    .all();
  return results;
}

export async function publicShare(env, token) {
  const db = env.DB;
  const share = await findShare(db, token);
  const rows = await scopeReviews(db, share);
  const ids = rows.map((r) => r.id);
  const photosBy = new Map(ids.map((id) => [id, []]));
  if (ids.length) {
    const { results } = await db
      .prepare(`SELECT id, review_id, caption, width, height FROM photos WHERE review_id IN (${ids.map(() => "?").join(",")}) ORDER BY review_id, id`)
      .bind(...ids)
      .all();
    for (const p of results) photosBy.get(p.review_id).push({ id: p.id, caption: p.caption, width: p.width, height: p.height });
  }
  const settings = await getSettings(db);
  const reviews = rows.map((r) => {
    const photos = photosBy.get(r.id) || [];
    return {
      title: r.title,
      meal: r.meal,
      price: r.price,
      body: r.body,
      address: r.address,
      lat: r.lat,
      lng: r.lng,
      ratings: JSON.parse(r.ratings || "{}"),
      tags: parseTags(r.tags),
      visited_on: r.visited_on,
      photo_count: photos.length,
      photos: share.kind === "tag" ? photos.slice(0, 1) : photos, // 分類頁只帶封面（ADR 021）
    };
  });
  return json({ share: { kind: share.kind, tag: share.tag }, nickname: settings.nickname, watermark: settings.watermark, gaMeasurementId: settings.gaMeasurementId, reviews }, 200, { "X-Robots-Tag": "noindex" });
}

export async function publicPhoto(env, token, photoId) {
  const db = env.DB;
  const share = await findShare(db, token);
  const photo = await db
    .prepare(
      share.kind === "review"
        ? "SELECT p.r2_key FROM photos p WHERE p.id = ? AND p.review_id = ?"
        : "SELECT p.r2_key FROM photos p JOIN reviews r ON r.id = p.review_id WHERE p.id = ? AND EXISTS (SELECT 1 FROM json_each(r.tags) j WHERE j.value = ?)",
    )
    .bind(photoId, share.kind === "review" ? share.review_id : share.tag)
    .first();
  if (!photo) throw new HttpError(404, "找不到這張照片");
  const file = await readPhoto(env, photo.r2_key); // R2 照片或站內插畫
  if (!file) throw new HttpError(404, "找不到這張照片");
  const buf = await new Response(file.body).arrayBuffer();
  return json({ src: `data:${file.type};base64,${toBase64(buf)}` }, 200, { "X-Robots-Tag": "noindex" });
}

// ---------- 公開分享頁的 head：社群預覽（Open Graph、Twitter Card）與 JSON-LD ----------
// 社群平台抓預覽不跑 JS，所以由 Worker 在回傳頁面殼時依 token 把標題、摘要、預覽圖寫進 head。
// 公開頁仍維持 noindex（ADR 020），JSON-LD 只讓支援的平台預覽多一點資訊，不為搜尋收錄。
const SITE_NAME = "吃過筆記";
const oneLine = (s) => String(s || "").replace(/\s+/g, " ").trim();
const cut = (s, n) => ([...s].length > n ? [...s].slice(0, n - 1).join("") + "…" : s);
const attr = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// 範圍內第一筆有照片的點評的第一張照片（分類頁依頁面上的順序）
async function scopeCover(db, rows) {
  const ids = rows.map((r) => r.id);
  if (!ids.length) return null;
  const { results } = await db
    .prepare(`SELECT review_id, r2_key, width, height FROM photos WHERE id IN (SELECT MIN(id) FROM photos WHERE review_id IN (${ids.map(() => "?").join(",")}) GROUP BY review_id)`)
    .bind(...ids)
    .all();
  const byReview = new Map(results.map((p) => [p.review_id, p]));
  return rows.map((r) => byReview.get(r.id)).find(Boolean) || null;
}

function reviewJsonLd(r, { nickname, pageUrl, imageUrl }) {
  const scores = Object.values(JSON.parse(r.ratings || "{}")).filter((n) => Number.isInteger(n));
  const avg = scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : null;
  return {
    "@context": "https://schema.org",
    "@type": "Review",
    name: r.meal ? `${r.title}｜${r.meal}` : r.title,
    url: pageUrl,
    itemReviewed: {
      "@type": "Restaurant",
      name: r.title,
      ...(r.address ? { address: r.address } : {}),
      ...(Number.isFinite(r.lat) && Number.isFinite(r.lng) ? { geo: { "@type": "GeoCoordinates", latitude: r.lat, longitude: r.lng } } : {}),
      ...(imageUrl ? { image: imageUrl } : {}),
    },
    ...(r.body ? { reviewBody: r.body } : {}),
    ...(avg ? { reviewRating: { "@type": "Rating", ratingValue: avg, bestRating: 5, worstRating: 1 } } : {}), // 各項評比（1–5 顆心）的平均
    ...(nickname ? { author: { "@type": "Person", name: nickname } } : {}),
    datePublished: String(r.created_at).slice(0, 10),
  };
}

function tagJsonLd(tag, rows, { pageUrl }) {
  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: `#${tag}`,
    url: pageUrl,
    numberOfItems: rows.length,
    itemListElement: rows.slice(0, 20).map((r, i) => ({
      "@type": "ListItem",
      position: i + 1,
      item: { "@type": "Restaurant", name: r.title, ...(r.address ? { address: r.address } : {}) },
    })),
  };
}

// token 有效時回傳 head 要用的內容；token 無效回 null（頁面照常由 js/shared.js 顯示錯誤）
export async function shareHead(env, token, origin) {
  let share;
  try {
    share = await findShare(env.DB, token);
  } catch (err) {
    if (err instanceof HttpError) return null;
    throw err;
  }
  const rows = await scopeReviews(env.DB, share);
  const { nickname } = await getSettings(env.DB);
  const pageUrl = `${origin}/s/${token}`;
  const image = await ogImage(env, await scopeCover(env.DB, rows));
  const imageUrl = image ? `${pageUrl}/og.jpg?v=${encodeURIComponent(image.version)}` : "";
  let title;
  let description;
  let jsonLd;
  if (share.kind === "review" && rows[0]) {
    const r = rows[0];
    title = r.meal ? `${r.title}｜${r.meal}` : r.title;
    const facts = [`NT$ ${Number(r.price).toLocaleString("en-US")}`, r.address].filter(Boolean).join(" · ");
    description = (nickname ? `${nickname} 的點評：` : "") + cut(oneLine(r.body) || facts, 120);
    jsonLd = reviewJsonLd(r, { nickname, pageUrl, imageUrl });
  } else {
    title = `#${share.tag ?? ""}`;
    const names = rows.slice(0, 8).map((r) => r.title).join("、") + (rows.length > 8 ? "…" : "");
    description = rows.length ? `${nickname ? `${nickname} 分享的` : ""} ${rows.length} 筆點評：${names}`.trim() : "這個分類目前沒有點評";
    jsonLd = tagJsonLd(share.tag ?? "", rows, { pageUrl });
  }
  return { title, description, pageUrl, image, imageUrl, jsonLd };
}

// 把 shareHead() 的內容寫進頁面殼的 head
export function injectHead(res, h) {
  const tags = [
    ["og:type", "article"], ["og:site_name", SITE_NAME], ["og:locale", "zh_TW"], ["og:title", h.title], ["og:description", h.description], ["og:url", h.pageUrl],
    ...(h.image ? [["og:image", h.imageUrl], ["og:image:type", "image/jpeg"], ["og:image:alt", h.title],
      ...(h.image.width && h.image.height ? [["og:image:width", h.image.width], ["og:image:height", h.image.height]] : [])] : []),
  ].map(([p, c]) => `<meta property="${p}" content="${attr(c)}">`);
  tags.push(
    `<meta name="twitter:card" content="${h.image ? "summary_large_image" : "summary"}">`,
    `<meta name="twitter:title" content="${attr(h.title)}">`,
    `<meta name="twitter:description" content="${attr(h.description)}">`,
    ...(h.image ? [`<meta name="twitter:image" content="${attr(h.imageUrl)}">`] : []),
    `<script type="application/ld+json">${JSON.stringify(h.jsonLd).replace(/</g, "\\u003c")}</script>`,
  );
  return new HTMLRewriter()
    .on("title", { element: (el) => el.setInnerContent(`${h.title}｜${SITE_NAME}`) })
    .on('meta[name="description"]', { element: (el) => el.setAttribute("content", h.description) })
    .on("head", { element: (el) => el.append(tags.join("\n"), { html: true }) })
    .transform(res);
}

// /s/<token>/og.jpg：分享預覽圖，停止分享後就 404
export async function shareOg(env, token) {
  const share = await findShare(env.DB, token);
  const rows = await scopeReviews(env.DB, share);
  const image = await ogImage(env, await scopeCover(env.DB, rows));
  const file = image && (await readOg(env, image));
  if (!file) throw new HttpError(404, "這個分享連結沒有預覽圖");
  return new Response(file.body, { headers: { "Content-Type": file.type, "Cache-Control": "public, max-age=3600", "X-Robots-Tag": "noindex" } });
}
