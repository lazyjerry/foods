// 公開分享連結（ADR 020–022）：分類或單一點評建一個隨機 token，/s/<token> 免登入可看。
// 公開 API 不回座標、R2 key；照片逐張轉成 base64 data URI 回傳，畫面上不出現圖片網址。
import { HttpError, json, parseId, readJson } from "./http.js";
import { getSettings, normalizeTag, parseTags, searchTerms } from "./db.js";

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
      price: r.price,
      body: r.body,
      address: r.address,
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
  const obj = await env.PHOTOS.get(photo.r2_key);
  if (!obj) throw new HttpError(404, "找不到這張照片");
  const type = obj.httpMetadata?.contentType || "image/jpeg";
  return json({ src: `data:${type};base64,${toBase64(await obj.arrayBuffer())}` }, 200, { "X-Robots-Tag": "noindex" });
}
