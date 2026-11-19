// 食物點評 Worker：靜態頁面（public/）＋ /api/* ＋ /media/*（R2 照片）。
// 所有請求先經過這裡（assets.run_worker_first），未登入只放行登入頁需要的檔案。
import { account, changePassword, currentUser, isAuthed, login, logout } from "./auth.js";
import { HttpError, errorResponse, json, parseId, readJson } from "./http.js";
import { geoReverse, geoSearch } from "./geo.js";
import * as db from "./db.js";
import * as media from "./media.js";
import * as passkey from "./passkey.js";
import * as shares from "./shares.js";
import { storageUsage } from "./storage.js";

const MAX_PHOTO_BYTES = 3 * 1024 * 1024;
const PUBLIC_PATHS = new Set(["/login", "/login.html", "/jerry-ui.css", "/jerry-ui.js", "/app.css", "/jerry.png", "/js/login.js", "/js/common.js", "/js/shared.js", "/js/share-card.js", "/favicon.ico", "/vendor/simplewebauthn/browser.umd.min.js",
  // PWA：manifest 預設不帶 cookie 抓取；sw.js、離線頁與 icon 在登入頁就要拿得到
  "/manifest.webmanifest", "/sw.js", "/js/pwa.js", "/offline", "/offline.html",
  "/icons/icon-192.png", "/icons/icon-512.png", "/icons/icon-maskable-512.png", "/icons/apple-touch-icon.png"]);

function pageParams(url, max) {
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 20, 1), max);
  const cursor = db.parseCursor(url.searchParams.get("cursor"));
  return { q: url.searchParams.get("q") || "", limit, cursor };
}

function withSecurityHeaders(res) {
  const out = new Response(res.body, res);
  out.headers.set("X-Content-Type-Options", "nosniff");
  out.headers.set("Referrer-Policy", "same-origin");
  out.headers.set("X-Frame-Options", "DENY");
  return out;
}

function safeFilename(title, id) {
  const base = String(title || "photo").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "").trim().slice(0, 60) || "photo";
  return `${base}-${id}.jpg`;
}

async function serveMedia(request, env, key, url) {
  const file = await media.readPhoto(env, key);
  if (!file) throw new HttpError(404, "找不到這張照片");
  const headers = new Headers({ "Content-Type": file.type });
  if (file.etag) headers.set("ETag", file.etag);
  headers.set("Cache-Control", "private, max-age=31536000, immutable");
  if (url.searchParams.has("download")) {
    const row = await db.photoByKey(env.DB, key);
    const name = safeFilename(row?.title, row?.id || "x");
    headers.set("Content-Disposition", `attachment; filename="photo-${row?.id || "x"}.jpg"; filename*=UTF-8''${encodeURIComponent(name)}`);
  }
  return new Response(file.body, { headers });
}

// 新增照片的三種請求（照片檔共用，見 src/media.js）：
// - ?illust=<檔名>：引用站內插畫，不傳檔、不進 R2
// - ?sha256=<雜湊>、不帶 body：問 R2 有沒有同一張；有就直接引用，沒有回 { needUpload: true }，前端再帶檔案重送
// - body 是 JPEG：後端自己算雜湊當 key，R2 已有同一張就不再寫入
async function uploadPhoto(request, env, reviewId, url) {
  if (!(await db.reviewExists(env.DB, reviewId))) throw new HttpError(404, "找不到這筆點評，請先儲存點評再上傳照片");
  const width = Number(url.searchParams.get("w")) || null;
  const height = Number(url.searchParams.get("h")) || null;
  const caption = [...(url.searchParams.get("caption") || "").trim()].slice(0, 100).join("");
  const illust = url.searchParams.get("illust");
  const sha = url.searchParams.get("sha256");
  let key;
  let bytes;
  let created = false; // 這次請求才寫進 R2 的檔，寫紀錄失敗時要收掉
  if (illust) {
    const info = await media.illustInfo(env, illust);
    if (!info) throw new HttpError(404, "找不到這張插畫");
    ({ key, bytes } = info);
  } else if (sha) {
    if (!/^[0-9a-f]{64}$/.test(sha)) throw new HttpError(400, "照片雜湊格式不正確");
    key = media.blobKey(sha);
    const head = await env.PHOTOS.head(key);
    if (!head) return json({ needUpload: true });
    bytes = head.size;
  } else {
    if ((request.headers.get("Content-Type") || "") !== "image/jpeg") throw new HttpError(415, "只接受壓縮後的 JPEG 照片");
    const buf = await request.arrayBuffer();
    if (buf.byteLength === 0) throw new HttpError(400, "照片是空的");
    if (buf.byteLength > MAX_PHOTO_BYTES) throw new HttpError(413, "照片超過 3 MB，請調低設定頁的照片長邊或品質");
    const head = new Uint8Array(buf, 0, 3);
    if (head[0] !== 0xff || head[1] !== 0xd8 || head[2] !== 0xff) throw new HttpError(415, "檔案不是 JPEG");
    key = media.blobKey(await media.sha256Hex(buf));
    bytes = buf.byteLength;
    if (!(await env.PHOTOS.head(key))) {
      await env.PHOTOS.put(key, buf, { httpMetadata: { contentType: "image/jpeg" } });
      created = true;
    }
  }
  try {
    const photo = await db.insertPhoto(env.DB, { review_id: reviewId, key, caption, width, height, bytes });
    return json({ photo, reused: !created }, 201);
  } catch (err) {
    if (created) await media.deleteUnreferenced(env, [key]); // 中繼資料寫不進去就不要留孤兒檔
    throw err;
  }
}

async function api(request, env, ctx, url) {
  const { pathname } = url;
  const method = request.method;
  let m;

  if (pathname === "/api/login" && method === "POST") return login(request, env, await readJson(request));
  if (pathname === "/api/logout" && method === "POST") return logout();
  if (pathname === "/api/auth/status" && method === "GET") return passkey.authStatus(env);
  if (pathname === "/api/passkeys/login/options" && method === "POST") return passkey.loginOptions(env, url);
  if (pathname === "/api/passkeys/login/verify" && method === "POST") return passkey.loginVerify(request, env, url);
  // 公開分享（ADR 020）：只憑 token，不需登入
  if ((m = pathname.match(/^\/api\/public\/shares\/([^/]+)$/)) && method === "GET") return shares.publicShare(env, m[1]);
  if ((m = pathname.match(/^\/api\/public\/shares\/([^/]+)\/photos\/(\d+)$/)) && method === "GET") return shares.publicPhoto(env, m[1], parseId(m[2]));

  const user = await currentUser(request, env);
  if (!user) throw new HttpError(401, "請先登入");

  if (pathname === "/api/account" && method === "GET") return account(user);
  if (pathname === "/api/account/password" && method === "PUT") return changePassword(request, env, user);
  if (pathname === "/api/passkeys" && method === "GET") return passkey.listPasskeys(env, user);
  if (pathname === "/api/passkeys/register/options" && method === "POST") return passkey.registerOptions(env, url, user);
  if (pathname === "/api/passkeys/register/verify" && method === "POST") return passkey.registerVerify(request, env, url, user);
  if ((m = pathname.match(/^\/api\/passkeys\/([A-Za-z0-9_-]{1,1024})$/)) && method === "DELETE") return passkey.deletePasskey(env, m[1], user);
  if (pathname === "/api/auth/password-login" && method === "PUT") return passkey.setPasswordLogin(request, env);

  if (pathname === "/api/reviews") {
    if (method === "GET") return json(await db.listReviews(env.DB, pageParams(url, 100)));
    if (method === "POST") return json({ review: await db.createReview(env.DB, db.validateReview(await readJson(request))) }, 201);
  }
  if (pathname === "/api/reviews/map" && method === "GET") return json(await db.listReviewPoints(env.DB, { q: url.searchParams.get("q") || "" }));
  if ((m = pathname.match(/^\/api\/reviews\/(\d+)$/))) {
    const id = parseId(m[1]);
    if (method === "GET") return json({ review: await db.getReview(env.DB, id) });
    if (method === "PUT") return json({ review: await db.updateReview(env.DB, id, db.validateReview(await readJson(request))) });
    if (method === "DELETE") {
      const keys = await db.deleteReview(env.DB, id);
      await media.deleteUnreferenced(env, keys); // 其他點評還引用的照片檔留著
      return json({ ok: true, deletedPhotos: keys.length });
    }
  }
  if ((m = pathname.match(/^\/api\/reviews\/(\d+)\/photos$/)) && method === "POST") return uploadPhoto(request, env, parseId(m[1]), url);
  if (pathname === "/api/photos" && method === "GET") return json(await db.listPhotos(env.DB, pageParams(url, 60)));
  if ((m = pathname.match(/^\/api\/photos\/(\d+)$/))) {
    const id = parseId(m[1]);
    if (method === "PATCH") {
      const body = await readJson(request);
      const caption = [...String(body?.caption ?? "").trim()].slice(0, 100).join("");
      return json({ photo: await db.updatePhotoCaption(env.DB, id, caption) });
    }
    if (method === "DELETE") {
      const key = await db.deletePhoto(env.DB, id);
      await media.deleteUnreferenced(env, [key]); // 其他照片還引用同一個檔就留著
      return json({ ok: true });
    }
  }
  if (pathname === "/api/tags" && method === "GET") return json({ tags: await db.listTags(env.DB) });
  if (pathname === "/api/stats" && method === "GET") return json(await db.listStatsRows(env.DB, db.parseStatsRange(url.searchParams)));
  if (pathname === "/api/shares") {
    if (method === "GET") return shares.listShares(env, url);
    if (method === "POST") return shares.createShare(request, env);
  }
  if ((m = pathname.match(/^\/api\/shares\/([^/]+)$/)) && method === "DELETE") return shares.deleteShare(env, m[1]);
  if (pathname === "/api/settings") {
    if (method === "GET") return json({ settings: await db.getSettings(env.DB) });
    if (method === "PUT") return json({ settings: await db.saveSettings(env.DB, await readJson(request)) });
  }
  if (pathname === "/api/storage" && method === "GET") return storageUsage(env, ctx);
  if (pathname === "/api/geo/search" && method === "GET") return geoSearch(url, ctx);
  if (pathname === "/api/geo/reverse" && method === "GET") return geoReverse(url, ctx);

  throw new HttpError(404, "找不到這個 API");
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/api/")) return withSecurityHeaders(await api(request, env, ctx, url));

      // 公開分享頁：/s/<token> 免登入，回傳同一個頁面殼，內容由 js/shared.js 依 token 載入（token 無效時由頁面顯示錯誤）
      const shareMatch = url.pathname.match(/^\/s\/([^/]+)$/);
      if (shareMatch && request.method === "GET") {
        const res = withSecurityHeaders(await env.ASSETS.fetch(new Request(new URL("/shared", url), request)));
        res.headers.set("Cache-Control", "no-store");
        res.headers.set("X-Robots-Tag", "noindex");
        return res;
      }

      const authed = PUBLIC_PATHS.has(url.pathname) || (await isAuthed(request, env));
      if (!authed) {
        const accept = request.headers.get("Accept") || "";
        if (request.method === "GET" && (accept.includes("text/html") || !/\.[a-z0-9]+$/i.test(url.pathname))) {
          const next = url.pathname + url.search;
          return Response.redirect(`${url.origin}/login?next=${encodeURIComponent(next)}`, 302);
        }
        return new Response("請先登入", { status: 401 });
      }

      if (url.pathname.startsWith("/media/") && request.method === "GET") {
        const key = decodeURIComponent(url.pathname.slice("/media/".length));
        media.assertValidKey(key);
        return withSecurityHeaders(await serveMedia(request, env, key, url));
      }
      const res = await env.ASSETS.fetch(request);
      const out = withSecurityHeaders(res);
      if ((out.headers.get("Content-Type") || "").includes("text/html")) out.headers.set("Cache-Control", "no-store");
      return out;
    } catch (err) {
      return withSecurityHeaders(errorResponse(err));
    }
  },
};
