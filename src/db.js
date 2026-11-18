// D1 存取：點評、照片中繼資料、設定。所有值都用 binding。
// 搜尋用 instr() 而非 LIKE：D1 的 LIKE pattern 只有 50 bytes，中文十幾字就會失敗。
import { HttpError } from "./http.js";

export const RATING_KEYS = ["taste", "price", "experience", "ambience", "service", "portion"];
export const SHARE_FIELD_KEYS = ["title", "price", "date", "address", "ratings", "body", "nickname"];

export const DEFAULT_SETTINGS = {
  nickname: "",
  defaultHearts: 3,
  ratingsDefaultOn: false,
  shareFields: Object.fromEntries(SHARE_FIELD_KEYS.map((k) => [k, true])),
  sharePosition: "bottom",
  maxEdge: 1600,
  quality: 80,
};

const now = () => new Date().toISOString();
const chars = (s) => [...s].length;

function num(value) {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") return Number(value);
  return NaN;
}

export function validateReview(input) {
  const errors = {};
  const title = typeof input?.title === "string" ? input.title.trim() : "";
  if (!title) errors.title = "請輸入標題";
  else if (chars(title) > 100) errors.title = "標題最多 100 字";

  const price = num(input?.price);
  if (!Number.isInteger(price) || price < 0 || price > 1_000_000) errors.price = "請輸入 0 到 1,000,000 的整數價格";

  const body = typeof input?.body === "string" ? input.body.replace(/\r\n/g, "\n") : "";
  if (chars(body) > 2000) errors.body = `點評最多 2000 字（目前 ${chars(body)} 字）`;

  const lat = num(input?.lat);
  const lng = num(input?.lng);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) errors.lat = "緯度要在 -90 到 90 之間";
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) errors.lng = "經度要在 -180 到 180 之間";

  const address = typeof input?.address === "string" ? input.address.trim() : "";
  if (!address) errors.address = "請輸入地址，或在地圖上選位置後按「用座標查地址」";
  else if (chars(address) > 300) errors.address = "地址最多 300 字";

  let visitedOn = null;
  if (input?.visited_on) {
    const v = String(input.visited_on);
    if (/^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v + "T00:00:00Z"))) visitedOn = v;
    else errors.visited_on = "用餐日期格式要是 YYYY-MM-DD";
  }

  const ratings = {};
  if (input?.ratings && typeof input.ratings === "object") {
    for (const key of RATING_KEYS) {
      const n = Number(input.ratings[key]);
      if (Number.isInteger(n) && n >= 1 && n <= 5) ratings[key] = n;
    }
  }

  const tags = normalizeTags(input?.tags);
  if (tags.error) errors.tags = tags.error;

  if (Object.keys(errors).length) {
    const err = new HttpError(422, Object.values(errors)[0]);
    err.fields = errors;
    throw err;
  }
  return { title, price, body, lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6, address, visited_on: visitedOn, ratings, tags: tags.list };
}

// 分類標籤（ADR 019）：去掉開頭的 #、NFKC 正規化、合併重複；不含空白（搜尋以空白分隔關鍵字）。
export const MAX_TAGS = 10;
export const MAX_TAG_CHARS = 20;

export function normalizeTag(value) {
  return String(value ?? "").normalize("NFKC").trim().replace(/^#+/, "").trim();
}

export function normalizeTags(input) {
  if (input === undefined || input === null) return { list: [] };
  if (!Array.isArray(input)) return { list: [], error: "分類格式錯誤" };
  const list = [];
  for (const raw of input) {
    const tag = normalizeTag(raw);
    if (!tag) continue;
    if (/\s/.test(tag)) return { list, error: `分類「${tag}」不能含空白` };
    if (chars(tag) > MAX_TAG_CHARS) return { list, error: `分類「${tag}」超過 ${MAX_TAG_CHARS} 字` };
    if (!list.includes(tag)) list.push(tag);
  }
  if (list.length > MAX_TAGS) return { list, error: `分類最多 ${MAX_TAGS} 個` };
  return { list };
}

export function parseTags(text) {
  try {
    const v = JSON.parse(text || "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function searchTerms(q) {
  if (!q) return [];
  return String(q).normalize("NFKC").trim().slice(0, 50).toLowerCase().split(/\s+/).filter(Boolean).slice(0, 5);
}

function rowToReview(row) {
  return {
    id: row.id,
    title: row.title,
    price: row.price,
    body: row.body,
    lat: row.lat,
    lng: row.lng,
    address: row.address,
    ratings: JSON.parse(row.ratings || "{}"),
    tags: parseTags(row.tags),
    visited_on: row.visited_on,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(row.cover_key !== undefined ? { cover_key: row.cover_key, photo_count: row.photo_count } : {}),
  };
}

function rowToPhoto(row) {
  return { id: row.id, review_id: row.review_id, key: row.r2_key, caption: row.caption, width: row.width, height: row.height, bytes: row.bytes, created_at: row.created_at };
}

// keyset 分頁游標：上一頁最後一筆的 `<created_at>~<id>`，搭配 (created_at DESC, id DESC) 索引，
// 每頁讀取量固定、翻頁期間有新增也不重複（ADR 024）。
export function parseCursor(value) {
  if (!value) return null;
  const m = /^([^~]{1,40})~(\d{1,15})$/.exec(String(value));
  if (!m) throw new HttpError(400, "分頁位置格式不正確，請重新整理頁面");
  return { createdAt: m[1], id: Number(m[2]) };
}

function keysetPage(rows, limit) {
  const items = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const last = items[items.length - 1];
  return { items, hasMore, nextCursor: hasMore ? `${last.created_at}~${last.id}` : null };
}

export async function listReviews(db, { q, limit, cursor }) {
  const terms = searchTerms(q);
  const conds = terms.map(() => "instr(lower(r.title || ' ' || r.address || ' ' || r.body || ' ' || r.tags), ?) > 0");
  if (cursor) conds.push("(r.created_at, r.id) < (?, ?)");
  const sql = `SELECT r.*,
      (SELECT p.r2_key FROM photos p WHERE p.review_id = r.id ORDER BY p.id LIMIT 1) AS cover_key,
      (SELECT COUNT(*) FROM photos p WHERE p.review_id = r.id) AS photo_count
    FROM reviews r ${conds.length ? "WHERE " + conds.join(" AND ") : ""}
    ORDER BY r.created_at DESC, r.id DESC LIMIT ?`;
  const after = cursor ? [cursor.createdAt, cursor.id] : [];
  const { results } = await db.prepare(sql).bind(...terms, ...after, limit + 1).all();
  const page = keysetPage(results, limit);
  return { ...page, items: page.items.map(rowToReview) };
}

export async function getReview(db, id) {
  const row = await db.prepare("SELECT * FROM reviews WHERE id = ?").bind(id).first();
  if (!row) throw new HttpError(404, "找不到這筆點評，可能已被刪除");
  const { results } = await db.prepare("SELECT * FROM photos WHERE review_id = ? ORDER BY id").bind(id).all();
  return { ...rowToReview(row), photos: results.map(rowToPhoto) };
}

export async function createReview(db, v) {
  const t = now();
  const row = await db
    .prepare("INSERT INTO reviews (title, price, body, lat, lng, address, ratings, tags, visited_on, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id")
    .bind(v.title, v.price, v.body, v.lat, v.lng, v.address, JSON.stringify(v.ratings), JSON.stringify(v.tags), v.visited_on, t, t)
    .first();
  return getReview(db, row.id);
}

export async function updateReview(db, id, v) {
  const res = await db
    .prepare("UPDATE reviews SET title = ?, price = ?, body = ?, lat = ?, lng = ?, address = ?, ratings = ?, tags = ?, visited_on = ?, updated_at = ? WHERE id = ?")
    .bind(v.title, v.price, v.body, v.lat, v.lng, v.address, JSON.stringify(v.ratings), JSON.stringify(v.tags), v.visited_on, now(), id)
    .run();
  if (!res.meta.changes) throw new HttpError(404, "找不到這筆點評，可能已被刪除");
  return getReview(db, id);
}

export async function deleteReview(db, id) {
  const { results } = await db.prepare("SELECT r2_key FROM photos WHERE review_id = ?").bind(id).all();
  const [, , res] = await db.batch([
    db.prepare("DELETE FROM shares WHERE review_id = ?").bind(id),
    db.prepare("DELETE FROM photos WHERE review_id = ?").bind(id),
    db.prepare("DELETE FROM reviews WHERE id = ?").bind(id),
  ]);
  if (!res.meta.changes) throw new HttpError(404, "找不到這筆點評，可能已被刪除");
  return results.map((r) => r.r2_key);
}

export async function reviewExists(db, id) {
  return Boolean(await db.prepare("SELECT 1 FROM reviews WHERE id = ?").bind(id).first());
}

export async function insertPhoto(db, p) {
  const row = await db
    .prepare("INSERT INTO photos (review_id, r2_key, caption, width, height, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *")
    .bind(p.review_id, p.key, p.caption, p.width, p.height, p.bytes, now())
    .first();
  return rowToPhoto(row);
}

export async function getPhoto(db, id) {
  const row = await db.prepare("SELECT * FROM photos WHERE id = ?").bind(id).first();
  if (!row) throw new HttpError(404, "找不到這張照片，可能已被刪除");
  return rowToPhoto(row);
}

export async function updatePhotoCaption(db, id, caption) {
  const res = await db.prepare("UPDATE photos SET caption = ? WHERE id = ?").bind(caption, id).run();
  if (!res.meta.changes) throw new HttpError(404, "找不到這張照片，可能已被刪除");
  return getPhoto(db, id);
}

export async function deletePhoto(db, id) {
  const photo = await getPhoto(db, id);
  await db.prepare("DELETE FROM photos WHERE id = ?").bind(id).run();
  return photo.key;
}

export async function photoByKey(db, key) {
  return db.prepare("SELECT p.*, r.title FROM photos p JOIN reviews r ON r.id = p.review_id WHERE p.r2_key = ?").bind(key).first();
}

export async function listPhotos(db, { q, limit, cursor }) {
  const terms = searchTerms(q);
  const conds = terms.map(() => "instr(lower(r.title || ' ' || r.address || ' ' || r.body || ' ' || r.tags || ' ' || p.caption), ?) > 0");
  if (cursor) conds.push("(p.created_at, p.id) < (?, ?)");
  const sql = `SELECT p.*, r.title, r.address, r.visited_on, r.tags FROM photos p JOIN reviews r ON r.id = p.review_id
    ${conds.length ? "WHERE " + conds.join(" AND ") : ""} ORDER BY p.created_at DESC, p.id DESC LIMIT ?`;
  const after = cursor ? [cursor.createdAt, cursor.id] : [];
  const { results } = await db.prepare(sql).bind(...terms, ...after, limit + 1).all();
  const page = keysetPage(results, limit);
  const items = page.items.map((r) => ({ ...rowToPhoto(r), title: r.title, address: r.address, visited_on: r.visited_on, tags: parseTags(r.tags) }));
  return { ...page, items };
}

// 既有分類與筆數，給編輯頁建議與分享頁選單用。
export async function listTags(db) {
  const { results } = await db
    .prepare("SELECT j.value AS tag, COUNT(*) AS count FROM reviews r, json_each(r.tags) j GROUP BY j.value ORDER BY count DESC, j.value")
    .all();
  return results.map((r) => ({ tag: r.tag, count: r.count }));
}

export function sanitizeSettings(input) {
  const s = structuredClone(DEFAULT_SETTINGS);
  if (!input || typeof input !== "object") return s;
  if (typeof input.nickname === "string") s.nickname = [...input.nickname.trim()].slice(0, 30).join("");
  const hearts = Number(input.defaultHearts);
  if (Number.isInteger(hearts) && hearts >= 1 && hearts <= 5) s.defaultHearts = hearts;
  if (typeof input.ratingsDefaultOn === "boolean") s.ratingsDefaultOn = input.ratingsDefaultOn;
  if (input.shareFields && typeof input.shareFields === "object") {
    for (const k of SHARE_FIELD_KEYS) if (typeof input.shareFields[k] === "boolean") s.shareFields[k] = input.shareFields[k];
  }
  if (["top", "bottom"].includes(input.sharePosition)) s.sharePosition = input.sharePosition;
  if ([1280, 1600, 2048].includes(Number(input.maxEdge))) s.maxEdge = Number(input.maxEdge);
  const q = Number(input.quality);
  if (Number.isInteger(q) && q >= 60 && q <= 95) s.quality = q;
  return s;
}

export async function getSettings(db) {
  const row = await db.prepare("SELECT data FROM settings WHERE id = 1").first();
  return sanitizeSettings(row ? JSON.parse(row.data) : null);
}

export async function saveSettings(db, input) {
  const s = sanitizeSettings(input);
  await db
    .prepare("INSERT INTO settings (id, data, updated_at) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at")
    .bind(JSON.stringify(s), now())
    .run();
  return s;
}
