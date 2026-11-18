// 各頁共用：API 呼叫、登入導向、評比與分享欄位定義、設定預設值、小工具。
// 評比類別要和 src/db.js 的 RATING_KEYS 一致。

export const RATING_DEFS = [
  ["taste", "口味"],
  ["price", "價位"],
  ["experience", "用餐體驗"],
  ["ambience", "環境"],
  ["service", "服務態度"],
  ["portion", "份量"],
];

export const SHARE_FIELDS = [
  ["title", "標題"],
  ["price", "價格"],
  ["date", "用餐日期"],
  ["address", "地址"],
  ["ratings", "評比"],
  ["body", "點評內容"],
  ["nickname", "稱呼"],
];

export const DEFAULT_SETTINGS = {
  nickname: "",
  defaultHearts: 3,
  ratingsDefaultOn: false,
  shareFields: Object.fromEntries(SHARE_FIELDS.map(([k]) => [k, true])),
  sharePosition: "bottom",
  maxEdge: 1600,
  quality: 80,
};

export const $ = (sel, root = document) => root.querySelector(sel);

export async function api(path, { method = "GET", json, body, headers = {}, keepalive = false } = {}) {
  const opts = { method, headers: { ...headers }, credentials: "same-origin", keepalive };
  if (json !== undefined) {
    opts.body = JSON.stringify(json);
    opts.headers["Content-Type"] = "application/json";
  } else if (body !== undefined) {
    opts.body = body;
  }
  let res;
  try {
    res = await fetch(path, opts);
  } catch {
    throw new Error("連不上伺服器，請確認網路後再試一次");
  }
  if (res.status === 401 && path !== "/api/login" && !path.startsWith("/api/passkeys/login/")) {
    location.href = "/login?next=" + encodeURIComponent(location.pathname + location.search);
    throw new Error("請先登入");
  }
  const data = (res.headers.get("Content-Type") || "").includes("json") ? await res.json().catch(() => null) : null;
  if (!res.ok) {
    const err = new Error(data?.error || `伺服器錯誤（${res.status}），請稍後再試`);
    err.fields = data?.fields;
    throw err;
  }
  return data;
}

export function mergeSettings(s) {
  const out = structuredClone(DEFAULT_SETTINGS);
  if (!s) return out;
  return { ...out, ...s, shareFields: { ...out.shareFields, ...(s.shareFields || {}) } };
}

export async function loadSettings() {
  try {
    const data = await api("/api/settings");
    return mergeSettings(data.settings);
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

export const hearts = (n) => "♥".repeat(n) + "♡".repeat(5 - n);
export const formatPrice = (n) => "NT$ " + Number(n).toLocaleString("zh-TW");
export const charCount = (s) => [...(s || "")].length;

export function ratingSummary(ratings) {
  return RATING_DEFS.filter(([k]) => ratings?.[k]).map(([k, label]) => `${label} ${hearts(ratings[k])}`);
}

export function mediaUrl(key, download = false) {
  return "/media/" + key.split("/").map(encodeURIComponent).join("/") + (download ? "?download=1" : "");
}

export function setStatus(el, text, state = "") {
  if (!el) return;
  if (window.JerryUI) window.JerryUI.setStatus(el, text, state);
  else el.textContent = text;
}

export function formatBytes(n) {
  if (n >= 1024 * 1024 * 1024) return `${+(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
}

export function bindLogout() {
  const btn = $("#logout-btn");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    try {
      await api("/api/logout", { method: "POST" });
    } finally {
      location.href = "/login";
    }
  });
}

export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// 分類標籤（ADR 019）以徽章列呈現；link 給定時每個標籤連到該頁的搜尋（例如 "/" 或 "/photos"）。
export function tagBadges(tags, link = "") {
  if (!tags?.length) return "";
  const items = tags.map((t) => `<li class="badge">${link ? `<a class="app-tag-link" href="${link}?q=${encodeURIComponent(t)}">#${esc(t)}</a>` : `#${esc(t)}`}</li>`);
  return `<ul class="badges" aria-label="分類">${items.join("")}</ul>`;
}

// 「載入更多」按鈕接近可視範圍時自動觸發（ADR 025）。按鈕隱藏代表沒有下一頁、disabled 代表載入中。
// 回傳 recheck：一頁載入成功後呼叫，按鈕仍在範圍內（例如螢幕很高）就再載一頁；失敗時不呼叫，避免無限重試。
export function autoLoadMore(button, onReach) {
  if (!("IntersectionObserver" in window)) return () => {};
  const io = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting) && !button.hidden && !button.disabled) onReach();
  }, { rootMargin: "400px 0px" });
  io.observe(button);
  return () => {
    io.unobserve(button);
    io.observe(button);
  };
}
