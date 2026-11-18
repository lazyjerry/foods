// 帳號密碼登入（ADR 018）：帳號與密碼雜湊存在 D1 users（雜湊見 password.js），登入後發 HMAC 簽章的 HttpOnly cookie。
// 簽章金鑰是 Worker secret APP_PASSWORD；cookie 帶帳號編號與 session_version，改密碼後其他裝置的登入失效。
import { HttpError, json, readJson } from "./http.js";
import { burnPasswordCheck, hashPassword, validateNewPassword, verifyPassword } from "./password.js";

const COOKIE = "fr_session";
const MAX_AGE = 60 * 60 * 24 * 30;
const enc = new TextEncoder();

// .dev.vars.example 的佔位值。一鍵部署時沒改掉，任何人都能用它簽出有效的登入 cookie，所以視同未設定。
const PLACEHOLDER_PASSWORD = "change-me";

function appPassword(env) {
  return env.APP_PASSWORD && env.APP_PASSWORD !== PLACEHOLDER_PASSWORD ? env.APP_PASSWORD : "";
}

function requirePassword(env) {
  if (!appPassword(env)) throw new HttpError(500, "尚未設定 APP_PASSWORD，或仍是預設值 change-me，請用 wrangler secret put APP_PASSWORD 設定");
  return env.APP_PASSWORD;
}

function b64url(buf) {
  let s = "";
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sign(secret, message) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

async function sameText(a, b) {
  // 先雜湊成等長，再做常數時間比較。
  const [ha, hb] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

function readCookie(request, name = COOKIE) {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return "";
}

function now() {
  return new Date().toISOString();
}

async function failSlowly(status, message) {
  await new Promise((r) => setTimeout(r, 800)); // 放慢暴力嘗試
  throw new HttpError(status, message);
}

// 目前登入的帳號；cookie 無效、過期或 session_version 已變（改過密碼）時回 null。
export async function currentUser(request, env) {
  if (!appPassword(env)) return null;
  const [ver, uid, sv, exp, sig] = readCookie(request).split(".");
  if (ver !== "v2" || !uid || !sv || !exp || !sig) return null;
  if (Number(exp) < Math.floor(Date.now() / 1000)) return null;
  if (!(await sameText(sig, await sign(env.APP_PASSWORD, `v2.${uid}.${sv}.${exp}`)))) return null;
  const user = await env.DB.prepare("SELECT id, username, session_version, password_changed_at FROM users WHERE id = ?").bind(Number(uid)).first();
  return user && String(user.session_version) === sv ? user : null;
}

export async function isAuthed(request, env) {
  return Boolean(await currentUser(request, env));
}

// 驗證帳號目前的密碼；還沒有雜湊（NULL）時比對 APP_PASSWORD（舊站平移與救援，ADR 018）。
async function checkPassword(env, user, given) {
  if (user.password_hash) return verifyPassword(given, user.password_hash);
  return sameText(given, requirePassword(env));
}

export async function login(request, env, body) {
  requirePassword(env);
  if (!(await passwordLoginEnabled(env.DB))) throw new HttpError(403, "已停用密碼登入，請改用通行金鑰登入");
  const username = typeof body?.username === "string" ? body.username.trim() : "";
  const given = typeof body?.password === "string" ? body.password : "";
  if (!username || !given) throw new HttpError(400, "請輸入帳號與密碼");
  const user = await env.DB.prepare("SELECT * FROM users WHERE username = ?").bind(username).first();
  if (!user) {
    await burnPasswordCheck(given);
    return failSlowly(401, "帳號或密碼不正確，請再試一次");
  }
  if (!(await checkPassword(env, user, given))) return failSlowly(401, "帳號或密碼不正確，請再試一次");
  if (!user.password_hash) {
    // 第一次用 APP_PASSWORD 登入：立刻存成雜湊，之後改密碼只動 D1
    await env.DB.prepare("UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ? AND password_hash IS NULL").bind(await hashPassword(given), now(), user.id).run();
  }
  return json({ ok: true }, 200, { "Set-Cookie": await sessionCookie(env, user) });
}

// 登入成功後發的 session cookie；密碼與通行金鑰共用。user 需要 id 與 session_version。
export async function sessionCookie(env, user) {
  const exp = Math.floor(Date.now() / 1000) + MAX_AGE;
  const payload = `v2.${user.id}.${user.session_version}.${exp}`;
  return `${COOKIE}=${payload}.${await sign(requirePassword(env), payload)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${MAX_AGE}`;
}

export function account(user) {
  return json({ username: user.username, passwordChangedAt: user.password_changed_at });
}

// 修改密碼：要先驗目前的密碼；成功後 session_version 加一，其他裝置要重新登入，這台換發新 cookie。
// 失敗回 400 而不是 401，前端 api() 遇到 401 會直接跳登入頁。
export async function changePassword(request, env, user) {
  const body = await readJson(request);
  const current = typeof body?.currentPassword === "string" ? body.currentPassword : "";
  if (!current) throw new HttpError(400, "請輸入目前的密碼");
  const next = validateNewPassword(body?.newPassword);
  const row = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(user.id).first();
  if (!row || !(await checkPassword(env, row, current))) return failSlowly(400, "目前的密碼不正確");
  if (next === current) throw new HttpError(422, "新密碼不能和目前的密碼相同");
  // 以舊雜湊當條件，兩台裝置同時改密碼時只有一台成功
  const updated = await env.DB.prepare(
    "UPDATE users SET password_hash = ?, session_version = session_version + 1, password_changed_at = ? WHERE id = ? AND password_hash IS ? RETURNING id, session_version, password_changed_at",
  )
    .bind(await hashPassword(next), now(), row.id, row.password_hash)
    .first();
  if (!updated) throw new HttpError(409, "密碼剛在其他裝置變更過，請重新整理後再試");
  return json({ ok: true, passwordChangedAt: updated.password_changed_at }, 200, { "Set-Cookie": await sessionCookie(env, updated) });
}

export async function passwordLoginEnabled(db) {
  const row = await db.prepare("SELECT password_login FROM auth_config WHERE id = 1").first();
  return row?.password_login !== 0;
}

// WebAuthn challenge 放在短效簽章 cookie（ADR 014）：綁用途、5 分鐘到期、驗證時一併清除。
const CHAL_COOKIE = "fr_chal";
const CHAL_MAX_AGE = 300;
const CHAL_ATTRS = "Path=/api/passkeys; HttpOnly; Secure; SameSite=Strict";

export async function challengeCookie(env, purpose, challenge) {
  const exp = Math.floor(Date.now() / 1000) + CHAL_MAX_AGE;
  const payload = `c1.${purpose}.${exp}.${challenge}`;
  return `${CHAL_COOKIE}=${payload}.${await sign(requirePassword(env), payload)}; ${CHAL_ATTRS}; Max-Age=${CHAL_MAX_AGE}`;
}

export const clearChallengeCookie = `${CHAL_COOKIE}=; ${CHAL_ATTRS}; Max-Age=0`;

export async function takeChallenge(request, env, purpose) {
  const [ver, p, exp, challenge, sig] = readCookie(request, CHAL_COOKIE).split(".");
  const payload = `${ver}.${p}.${exp}.${challenge}`;
  const valid = ver === "c1" && p === purpose && challenge && sig && Number(exp) >= Math.floor(Date.now() / 1000) && (await sameText(sig, await sign(requirePassword(env), payload)));
  if (!valid) throw new HttpError(400, "通行金鑰的驗證已逾時，請再試一次");
  return challenge;
}

export function logout() {
  return json({ ok: true }, 200, { "Set-Cookie": `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` });
}
