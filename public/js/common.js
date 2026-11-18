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
  gaMeasurementId: "",
  watermark: true,
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

// 頁首右上角：重新整理與登出（登出先 confirm）
export function bindLogout() {
  $("#refresh-btn")?.addEventListener("click", () => location.reload());
  const btn = $("#logout-btn");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    if (!confirm("確定要登出嗎？")) return;
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

// 右上角 toast（樣式見 app.css 的 .app-toast）：同一時間只留一個，連續呼叫會換文字並重新計時。
// 設 aria-hidden，因為呼叫端都另有 role=status 的狀態列負責朗讀，避免報讀兩次。
let toastEl = null;
let toastTimer = 0;
export function toast(text, ms = 2500) {
  if (!toastEl) {
    toastEl = document.createElement("p");
    toastEl.className = "app-toast";
    toastEl.setAttribute("aria-hidden", "true");
    document.body.append(toastEl);
  }
  toastEl.textContent = text;
  clearTimeout(toastTimer);
  requestAnimationFrame(() => toastEl.classList.add("is-shown"));
  toastTimer = setTimeout(() => toastEl.classList.remove("is-shown"), ms);
}

// 照片燒進稱呼的半透明斜向浮水印：直接畫進圖片，另存或截圖都帶著浮水印。沒設稱呼時用品牌名。
export function watermark(src, text) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const size = Math.max(16, Math.round(Math.min(canvas.width, canvas.height) / 14));
      ctx.font = `800 ${size}px ${getComputedStyle(document.body).fontFamily}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.lineWidth = Math.max(1, size / 14);
      ctx.fillStyle = "rgba(255, 255, 255, 0.32)";
      ctx.strokeStyle = "rgba(0, 0, 0, 0.18)";
      const stepX = ctx.measureText(text).width + size * 3;
      const stepY = size * 4;
      const diag = Math.hypot(canvas.width, canvas.height);
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate(-Math.PI / 6);
      for (let y = -diag / 2, row = 0; y < diag / 2; y += stepY, row++) {
        for (let x = -diag / 2 + (row % 2) * (stepX / 2); x < diag / 2; x += stepX) {
          ctx.strokeText(text, x, y);
          ctx.fillText(text, x, y);
        }
      }
      resolve(canvas.toDataURL("image/jpeg", 0.9));
    };
    img.onerror = () => reject(new Error("照片解碼失敗"));
    img.src = src;
  });
}

// 地址選填；分享圖與公開分享頁遇到空地址時顯示這句。
export const NO_ADDRESS = "我不知道地址";

// 導航：以座標開地圖 App。Google 地圖各平台都能開；iOS／iPadOS／macOS 另給 Apple 地圖，
// Android 另給 geo: 交由系統選地圖 App；Windows／Linux 沒有通用的裝置地圖連結，只給 Google。
// 上次選的 App 記在 localStorage（只是排序偏好，讀寫失敗就用預設順序）。
const NAV_KEY = "foods.navApp";

function devicePlatform() {
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return "android";
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return "ios"; // iPadOS 的 UA 偽裝成 Mac
  if (/Macintosh/.test(ua)) return "mac";
  return "";
}

function navApps(lat, lng, label) {
  const at = `${Number(lat)},${Number(lng)}`;
  const apps = [{ id: "google", name: "Google 地圖", href: `https://www.google.com/maps/dir/?api=1&destination=${at}`, blank: true }];
  const platform = devicePlatform();
  if (platform === "android") apps.push({ id: "device", name: "裝置地圖", href: `geo:${at}?q=${at}(${encodeURIComponent(label || "")})` });
  else if (platform) apps.push({ id: "device", name: "Apple 地圖", href: `https://maps.apple.com/?daddr=${at}`, blank: platform === "mac" });
  let last = "";
  try {
    last = localStorage.getItem(NAV_KEY) || "";
  } catch {}
  return last === "device" ? apps.reverse() : apps;
}

const navLink = (a, text, aria = "") =>
  `<a class="btn is-sm secondary" href="${esc(a.href)}" data-nav="${a.id}"${a.blank ? ' target="_blank" rel="noopener"' : ""}${aria ? ` aria-label="${esc(aria)}"` : ""}>${esc(text)}</a>`;

// 回傳「導航」按鈕的 HTML：只有一個 App 時直接連 Google 地圖，否則是可選 App 的下拉選單。頁面要呼叫一次 bindNavMenus()。
export function navMenu(lat, lng, label) {
  if (lat == null || lng == null || !Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) return "";
  const apps = navApps(lat, lng, label);
  if (apps.length === 1) return navLink(apps[0], "導航", "用 Google 地圖導航");
  return `<details class="app-nav"><summary class="btn is-sm secondary">導航</summary><div class="app-nav-menu">${apps.map((a) => navLink(a, a.name)).join("")}</div></details>`;
}

// 記住選的 App、點選單外或按 Esc 收起選單。用 capture：Leaflet popup 會擋住 click 冒泡。
export function bindNavMenus() {
  const closeAll = (except) => {
    for (const d of document.querySelectorAll("details.app-nav[open]")) if (d !== except) d.open = false;
  };
  document.addEventListener("click", (e) => {
    const pick = e.target.closest?.("[data-nav]");
    if (pick) {
      try {
        localStorage.setItem(NAV_KEY, pick.dataset.nav);
      } catch {}
      setTimeout(() => closeAll(null)); // 等連結的預設動作送出後再收
      return;
    }
    closeAll(e.target.closest?.("details.app-nav"));
  }, true);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeAll(null);
  });
}
