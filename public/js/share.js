// 分享圖：勾選欄位，把點評畫成浮水印合成在照片上（點評照片、相簿、現場拍照或純文字）。
// 全部在瀏覽器的 canvas 完成；相簿與拍照的圖不上傳。
import { $, NO_ADDRESS, RATING_DEFS, SHARE_FIELDS, api, autoLoadMore, bindLogout, esc, formatPrice, loadSettings, mediaUrl, reviewShareText, setStatus, tagShareText } from "./common.js";
import { loadImage } from "./photo.js";
import { openShareCard } from "./share-card.js";
import { combo } from "./combo.js";

const params = new URLSearchParams(location.search);
const select = $("#review-select");
const picks = $("#review-photos");
const canvas = $("#canvas");
const ctx = canvas.getContext("2d");
const opacity = $("#opacity");
const srcStatus = $("#source-status");
const outStatus = $("#out-status");

let settings;
let review = null;
let base = null; // 底圖 canvas；null 代表純文字
let wantPhoto = Number(params.get("photo")) || null;
let listItems = []; // 分享圖與分享網頁共用的點評清單
let listComplete = false; // 清單是否已含全部點評；分享分類時才能寫出總筆數

const token = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const source = () => document.querySelector('input[name="source"]:checked')?.value || "review";
const position = () => document.querySelector('input[name="position"]:checked')?.value || "bottom";
const fields = () => Object.fromEntries(SHARE_FIELDS.map(([k]) => [k, $(`#share-${k}`).checked]));

// ---------- 文字排版 ----------
// 不放在行首的標點：遇到時讓它掛在上一行尾（會略超出 maxW，落在面板內距裡）
const NO_LINE_START = /[，。、；：！？）」』》〉,.;:!?)\]]/;
function wrap(text, font, maxW, maxLines) {
  ctx.font = font;
  const lines = [];
  for (const para of String(text).split("\n")) {
    let line = "";
    for (const ch of para) {
      if (ctx.measureText(line + ch).width > maxW && line && !NO_LINE_START.test(ch)) {
        lines.push(line);
        line = ch.trim() ? ch : "";
      } else {
        line += ch;
      }
    }
    lines.push(line);
  }
  const trimmed = lines.length && !lines[lines.length - 1] ? lines.slice(0, -1) : lines;
  if (trimmed.length <= maxLines) return trimmed;
  const out = trimmed.slice(0, maxLines);
  let last = out[maxLines - 1];
  while (last && ctx.measureText(last + "…").width > maxW) last = last.slice(0, -1);
  out[maxLines - 1] = last + "…";
  return out;
}

// 點評內容的字級依「剩下的高度」決定：上下面板總高不超過照片一半、左右面板是整張高，扣掉其他欄位後才是內容可用的高度。
// 字級由大到小試，取第一個排得進去的；原文排不進時，把換行併成全形空格再試（短句一句一行會佔很多行）。
// 仍排不進就回傳 fits: false，由 render() 把整個面板縮小重排；縮到底還是不行，才以最小字級截斷加「…」。
const BODY_MAX = 32;
const BODY_MIN = 22; // 再小就跟店名差太多，改由 render() 整個面板一起縮
const bodyLh = (size, u) => Math.round(size * 1.45) * u;
function bodyRow(text, font, maxW, u, budget) {
  const color = token("--card");
  const joined = text.split(/\n+/).map((s) => s.trim()).filter(Boolean).join("　");
  for (const t of joined === text ? [text] : [text, joined]) {
    // 先看最小字級排不排得進，排不進就不必逐級試（面板縮放時每一輪都會跑到這裡）
    if (wrap(t, font(BODY_MIN), maxW, Infinity).length * bodyLh(BODY_MIN, u) > budget) continue;
    for (let size = BODY_MAX; size >= BODY_MIN; size -= 2) {
      const lines = wrap(t, font(size), maxW, Infinity);
      if (lines.length * bodyLh(size, u) <= budget) return { lines, font: font(size), lh: bodyLh(size, u), color, fits: true };
    }
  }
  const lh = bodyLh(BODY_MIN, u);
  return { lines: wrap(joined, font(BODY_MIN), maxW, Math.max(1, Math.floor(budget / lh))), font: font(BODY_MIN), lh, color, fits: false };
}

// 評比：放得進一行就放一行；橫圖的上下面板高度吃緊（不超過照片一半），差一點放不下時縮小字級擠成一行
// （最多縮到 RATING_MIN_K 倍），差太多或其他排法才換行
const RATING_MIN_K = 0.6;
function ratingsRow(items, font, maxW, u, squeeze) {
  const measure = (f) => {
    ctx.font = f;
    return items.map((it) => ctx.measureText(`${it.label} ♥♥♥♥♥`).width);
  };
  const widths = measure(font(30, 700));
  const total = widths.reduce((a, b) => a + b, 0) + 28 * u * (items.length - 1);
  const k = Math.min(1, (maxW / total) * 0.98);
  if (k === 1 || (squeeze && k >= RATING_MIN_K)) return { ratings: [items], font: font(30 * k, 700), lh: 46 * u * k, gapW: 28 * u * k };
  const lines = [[]];
  let x = 0;
  items.forEach((it, i) => {
    if (x && x + widths[i] > maxW) {
      lines.push([]);
      x = 0;
    }
    lines[lines.length - 1].push(it);
    x += widths[i] + 28 * u;
  });
  return { ratings: lines, font: font(30, 700), lh: 46 * u, gapW: 28 * u };
}

// W 是文字面板的寬；ref 是字級基準寬（上下面板 1080、左右半寬面板 600，字才不會太小）；
// limitH 是面板高度上限，點評內容只能用扣掉其他欄位後剩下的高度；純文字分享圖沒有上限，內容最多約 8 行大字的高度；
// squeeze 為 true（橫圖的上下面板）時評比縮字擠成一行
function layout(W, scale, { ref = 1080, limitH = null, squeeze = false } = {}) {
  const u = (W / ref) * scale;
  const pad = Math.round(48 * u);
  const family = getComputedStyle(document.body).fontFamily;
  const font = (size, weight = 400) => `${weight} ${Math.round(size * u)}px ${family}`;
  const maxW = W - pad * 2;
  const sel = fields();
  const rows = []; // {lines, font, lh, color} 或 {ratings, font, lh, gapW}
  const ink2 = token("--on-ink-2");

  if (sel.title) rows.push({ lines: wrap(review.title, font(60, 800), maxW, 2), font: font(60, 800), lh: 72 * u, color: token("--card") });
  if (sel.meal && review.meal) rows.push({ lines: wrap(review.meal, font(36, 700), maxW, 2), font: font(36, 700), lh: 48 * u, color: token("--card") });
  const meta = [sel.price ? formatPrice(review.price) : "", sel.date && review.visited_on ? review.visited_on : "", sel.nickname && settings.nickname ? `${settings.nickname} 的點評` : ""].filter(Boolean).join(" · ");
  if (meta) rows.push({ lines: wrap(meta, font(32, 700), maxW, 2), font: font(32, 700), lh: 44 * u, color: token("--coral") });
  if (sel.address) rows.push({ lines: wrap(review.address || NO_ADDRESS, font(28), maxW, 2), font: font(28), lh: 40 * u, color: ink2 });
  if (sel.ratings) {
    const items = RATING_DEFS.filter(([k]) => review.ratings?.[k]).map(([k, label]) => ({ label, n: review.ratings[k] }));
    if (items.length) rows.push(ratingsRow(items, font, maxW, u, squeeze));
  }
  const brand = { lines: ["吃過筆記"], font: font(22, 800), lh: 34 * u, color: ink2, brand: true };
  rows.push(brand);

  const gap = 14 * u;
  const rowH = (r) => (r.ratings ? r.ratings.length : r.lines.length) * r.lh;
  const body = sel.body ? review.body.trim() : "";
  let fits = true;
  if (body) {
    const others = pad * 2 + rows.reduce((s, r) => s + rowH(r), 0) + gap * rows.length; // 加上內容那列後共 rows.length 個間距
    const row = bodyRow(body, font, maxW, u, limitH ? limitH - others : 8 * 46 * u);
    fits = row.fits;
    rows.splice(rows.length - 1, 0, row);
  }
  const height = pad * 2 + rows.reduce((s, r) => s + rowH(r), 0) + gap * (rows.length - 1);
  return { rows, pad, gap, height: Math.ceil(height), u, fits };
}

function render() {
  if (!review) {
    canvas.width = 1080;
    canvas.height = 300;
    ctx.fillStyle = token("--paper");
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    return;
  }
  const W = base ? base.width : 1080;
  const pos = position();
  // 左方／右方：面板占照片一半寬、整張高，文字垂直置中；純文字分享圖沒有照片，一律照上下排
  const side = Boolean(base) && (pos === "left" || pos === "right");
  const PW = side ? Math.round(W / 2) : W;
  // 面板高度上限：上下不蓋過照片一半，左右是整張高；排不進就整個面板縮小重排，最多縮到 0.4 倍
  const limit = base ? (side ? base.height : Math.floor(base.height * 0.5)) : null;
  const squeeze = Boolean(base) && !side && base.width > base.height;
  const fit = (s) => (side ? layout(PW, s, { ref: 600, limitH: limit }) : layout(W, s, { limitH: limit, squeeze }));
  let L = fit(1);
  for (let s = 0.95; base && !(L.fits && L.height <= limit) && s >= 0.4; s -= 0.05) L = fit(s);
  const H = base ? base.height : L.height;
  canvas.width = W;
  canvas.height = H;
  if (base) ctx.drawImage(base, 0, 0);
  const left = side && pos === "right" ? W - PW : 0;
  const top = side ? 0 : base && pos === "bottom" ? H - L.height : 0;

  ctx.globalAlpha = base ? Number(opacity.value) / 100 : 1;
  ctx.fillStyle = token("--ink");
  ctx.fillRect(left, top, PW, side ? H : L.height);
  ctx.globalAlpha = 1;
  ctx.fillStyle = token("--coral");
  const bar = Math.max(4, Math.round(10 * L.u));
  if (side) ctx.fillRect(pos === "left" ? PW - bar : left, 0, bar, H); // 色條畫在面板朝照片的那一側
  else ctx.fillRect(0, pos === "bottom" || !base ? top : top + L.height - bar, W, bar);

  ctx.textBaseline = "top";
  let y = (side ? Math.max(0, Math.round((H - L.height) / 2)) : top) + L.pad;
  for (const row of L.rows) {
    ctx.font = row.font;
    if (row.ratings) {
      for (const line of row.ratings) {
        let x = left + L.pad;
        for (const it of line) {
          const parts = [[`${it.label} `, token("--card")], ["♥︎".repeat(it.n), token("--coral")], ["♡︎".repeat(5 - it.n), token("--on-ink-2")]]; // FE0E：強制文字字形，才吃得到 fillStyle
          for (const [t, c] of parts) {
            ctx.fillStyle = c;
            ctx.fillText(t, x, y);
            x += ctx.measureText(t).width;
          }
          x += row.gapW;
        }
        y += row.lh;
      }
    } else {
      ctx.fillStyle = row.color;
      for (const line of row.lines) {
        ctx.fillText(line, left + L.pad, y + (row.lh - parseInt(row.font.split(" ")[1], 10)) / 2);
        y += row.lh;
      }
    }
    y += L.gap;
  }
  drawWatermark(W, H);
}

// 稱呼浮水印（設定頁 02 照片壓縮卡的開關，預設開啟）：只壓在照片上、避開文字面板的角落
// （面板在下／左 → 右上角；在上 → 右下角；在右 → 左上角）；
// 純文字分享圖沒有照片、稱呼留空時都不壓。dataset.watermark 記下壓了什麼，給 e2e 檢查。
function drawWatermark(W, H) {
  const text = base && settings.watermark ? settings.nickname.trim() : "";
  canvas.dataset.watermark = text;
  if (!text) return;
  const u = Math.min(W, H) / 1080;
  const pad = Math.round(40 * u);
  ctx.save();
  ctx.font = `800 ${Math.max(16, Math.round(40 * u))}px ${getComputedStyle(document.body).fontFamily}`;
  const atTop = position() !== "top";
  const atLeft = position() === "right";
  ctx.textAlign = atLeft ? "left" : "right";
  ctx.textBaseline = atTop ? "top" : "bottom";
  ctx.shadowColor = "rgba(0, 0, 0, 0.55)";
  ctx.shadowBlur = Math.round(8 * u);
  ctx.shadowOffsetY = Math.round(2 * u);
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = token("--white") || "#fff";
  ctx.fillText(text, atLeft ? pad : W - pad, atTop ? pad : H - pad);
  ctx.restore();
}

// ---------- 底圖 ----------
async function useBlob(blob, label) {
  setStatus(srcStatus, "讀取圖片中…");
  try {
    base = await loadImage(blob, 2048);
    render();
    setStatus(srcStatus, `已使用${label}`, "ok");
  } catch (err) {
    setStatus(srcStatus, err.message, "error");
  }
}

async function usePhoto(photo) {
  picks.querySelectorAll(".app-pick").forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.id) === photo.id)));
  try {
    const res = await fetch(mediaUrl(photo.key), { credentials: "same-origin" });
    if (!res.ok) throw new Error("照片讀取失敗，請重新整理後再試");
    await useBlob(await res.blob(), "點評照片");
  } catch (err) {
    setStatus(srcStatus, err.message, "error");
  }
}

function renderPicks() {
  const list = review?.photos || [];
  picks.innerHTML = list
    .map((p) => `<button class="app-pick" type="button" data-id="${p.id}" aria-pressed="false" aria-label="使用照片 ${p.id}"><img src="${mediaUrl(p.key)}" alt="" loading="lazy"></button>`)
    .join("");
  picks.querySelectorAll(".app-pick").forEach((b) => b.addEventListener("click", () => usePhoto(list.find((p) => p.id === Number(b.dataset.id)))));
}

async function applySource({ open = true } = {}) {
  const s = source();
  picks.hidden = s !== "review";
  if (s === "none") {
    base = null;
    render();
    setStatus(srcStatus, "純文字分享圖", "ok");
  } else if (s === "review") {
    const list = review?.photos || [];
    if (!list.length) {
      base = null;
      render();
      setStatus(srcStatus, "這筆點評沒有照片，改選「相簿」「拍照」或「純文字」", "error");
      return;
    }
    const chosen = list.find((p) => p.id === wantPhoto) || list[0];
    wantPhoto = null;
    await usePhoto(chosen);
  } else if (open) {
    $(s === "album" ? "#album-input" : "#camera-input").click();
    setStatus(srcStatus, s === "album" ? "請從相簿選一張照片" : "請拍一張照片");
  }
}

document.querySelectorAll('input[name="source"]').forEach((r) => {
  // click 事件在重複點同一個選項時也會觸發，方便重新挑照片
  r.addEventListener("click", () => applySource());
});
for (const id of ["#album-input", "#camera-input"]) {
  $(id).addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    const value = id === "#album-input" ? "album" : "camera";
    document.querySelector(`input[name="source"][value="${value}"]`).checked = true;
    picks.hidden = true;
    await useBlob(file, value === "album" ? "相簿照片" : "拍攝的照片");
  });
}

// ---------- 點評 ----------
async function loadReview(id) {
  setStatus(outStatus, "載入點評中…");
  try {
    review = (await api(`/api/reviews/${id}`)).review;
    history.replaceState(null, "", `/share?id=${id}${new URLSearchParams(location.search).get("tab") === "web" ? "&tab=web" : ""}`);
    renderPicks();
    await applySource({ open: false });
    setStatus(outStatus, "預覽已更新", "ok");
  } catch (err) {
    setStatus(outStatus, err.message, "error");
  }
}

async function loadList() {
  const data = await api("/api/reviews?limit=100");
  const items = data.items;
  listItems = items;
  listComplete = !data.hasMore;
  const want = Number(params.get("id"));
  if (want && !items.some((r) => r.id === want)) {
    try {
      items.unshift((await api(`/api/reviews/${want}`)).review);
    } catch {
      // 找不到就用清單第一筆
    }
  }
  if (!items.length) {
    select.innerHTML = '<option value="0">還沒有點評</option>';
    select.disabled = true;
    $("#download-btn").disabled = true; // 沒有點評可合成，按鈕不能按
    $("#share-btn").disabled = true;
    setStatus(outStatus, "還沒有點評，先到「新增」記下一筆", "error");
    return null;
  }
  select.innerHTML = items.map((r) => `<option value="${r.id}">${r.title.replace(/</g, "&lt;")}${r.visited_on ? `（${r.visited_on}）` : ""}</option>`).join("");
  const id = items.some((r) => r.id === want) ? want : items[0].id;
  select.value = String(id);
  return id;
}

select.addEventListener("change", () => loadReview(Number(select.value)));
for (const [k] of SHARE_FIELDS) $(`#share-${k}`).addEventListener("change", render);
document.querySelectorAll('input[name="position"]').forEach((r) => r.addEventListener("change", render));
opacity.addEventListener("input", render);

// ---------- 輸出 ----------
function toBlob() {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("無法產生圖片"))), "image/jpeg", 0.92));
}
const outName = () => `${(review?.title || "food").replace(/[\\/:*?"<>|]/g, "").slice(0, 40)}-分享.jpg`;

$("#download-btn").addEventListener("click", async () => {
  if (!review) return setStatus(outStatus, "請先選一筆點評", "error");
  try {
    const url = URL.createObjectURL(await toBlob());
    const a = document.createElement("a");
    a.href = url;
    a.download = outName();
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    setStatus(outStatus, "已下載分享圖", "ok");
  } catch (err) {
    setStatus(outStatus, err.message, "error");
  }
});

$("#share-btn").addEventListener("click", async () => {
  if (!review) return setStatus(outStatus, "請先選一筆點評", "error");
  try {
    const file = new File([await toBlob()], outName(), { type: "image/jpeg" });
    if (!navigator.canShare?.({ files: [file] })) {
      setStatus(outStatus, "這個瀏覽器不支援直接分享圖片，請按「下載圖片」後再分享", "error");
      return;
    }
    // 文字沿用分享圖的欄位開關，圖上關掉的欄位文字也不帶
    const sel = fields();
    const by = sel.nickname && settings.nickname ? `${settings.nickname} 的點評` : "";
    await navigator.share({ files: [file], title: review.title, text: reviewShareText(review, { by, show: sel }) });
    setStatus(outStatus, "已開啟分享", "ok");
  } catch (err) {
    if (err.name !== "AbortError") setStatus(outStatus, err.message, "error");
  }
});

// ---------- 分享網頁（ADR 020、023） ----------
const webKind = () => document.querySelector('input[name="web-kind"]:checked')?.value || "tag";
const webTag = $("#web-tag");
const webReview = $("#web-review");
const webStatus = $("#web-status");
const shareList = $("#share-list");
const listStatus = $("#share-list-status");

const shareUrl = (token) => `${location.origin}/s/${token}`;

function applyWebKind() {
  const tag = webKind() === "tag";
  webTag.closest(".field").hidden = !tag;
  webReview.closest(".field").hidden = tag;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// 分享網頁時附上的文字：用已載入的點評清單組成，不另外打 API（系統分享要在點擊後盡快呼叫）。
// 內容比照公開頁，固定放全部欄位；清單不完整時分類只列店名、不寫總筆數。
function webShareText(json) {
  const by = settings.nickname ? `${settings.nickname} 分享的` : "";
  if (json.kind === "tag") {
    const rs = listItems.filter((r) => r.tags?.includes(json.tag));
    return tagShareText(json.tag, rs, { by: by && `${by}分類`, total: listComplete ? rs.length : 0 });
  }
  const r = listItems.find((x) => x.id === json.review_id);
  return r ? reviewShareText(r, { by: by && `${by}點評` }) : "";
}

function shareItem(s) {
  return `<li class="app-key">
  <div class="app-key-body"><strong>${esc(s.title || "（已刪除的點評）")}</strong><span class="app-key-meta">${s.kind === "tag" ? "整個分類" : "單一點評"} · ${esc(shareUrl(s.token))}</span></div>
  <div class="actions"><button class="btn is-sm" type="button" data-copy="${s.token}">複製連結</button><button class="btn is-sm secondary" type="button" data-card="${s.token}">分享</button><a class="btn is-sm secondary" href="/s/${s.token}" target="_blank" rel="noopener">開啟</a><button class="btn is-sm secondary" type="button" data-revoke="${s.token}">停止分享</button></div>
</li>`;
}

// 後端 cursor 分頁＋關鍵字（做法同 list.js）：清單在卡片內捲動，捲到底自動載入下一頁，按鈕留著手動重試；
// shareSeq 在重設時加一，丟棄還沒回來的舊請求，避免舊結果插進新清單。
const SHARE_PAGE = 10;
const shareMore = $("#share-more-btn");
const shareInput = $("#share-q");
let shareQuery = "";
let shareCursor = null;
let shareShown = 0;
let shareSeq = 0;

async function loadShares(reset = true) {
  if (reset) {
    shareSeq += 1;
    shareCursor = null;
    shareShown = 0;
    shareList.innerHTML = "";
    shareMore.hidden = true;
  } else if (shareMore.disabled) return;
  const mine = shareSeq;
  setStatus(listStatus, "載入中…");
  shareMore.disabled = true;
  try {
    const qs = new URLSearchParams({ limit: SHARE_PAGE });
    if (shareCursor) qs.set("cursor", shareCursor);
    if (shareQuery) qs.set("q", shareQuery);
    const data = await api("/api/shares?" + qs);
    if (mine !== shareSeq) return;
    shareList.insertAdjacentHTML("beforeend", data.shares.map(shareItem).join(""));
    shareShown += data.shares.length;
    shareCursor = data.nextCursor;
    shareMore.hidden = !data.hasMore;
    if (!shareShown) setStatus(listStatus, shareQuery ? `找不到符合「${shareQuery}」的連結，換個關鍵字試試` : "還沒有分享的連結");
    else setStatus(listStatus, `${shareQuery ? `「${shareQuery}」的結果：` : ""}已顯示 ${shareShown} 個連結${data.hasMore ? "，捲動看更多" : ""}`, "ok");
    shareRecheck();
  } catch (err) {
    if (mine === shareSeq) setStatus(listStatus, err.message, "error");
  } finally {
    if (mine === shareSeq) shareMore.disabled = false;
  }
}

const shareRecheck = autoLoadMore(shareMore, () => loadShares(false));
shareMore.addEventListener("click", () => loadShares(false));
$("#share-search-form").addEventListener("submit", (e) => {
  e.preventDefault();
  shareQuery = shareInput.value.trim();
  loadShares(true);
});

async function loadWebOptions(reviews) {
  webReview.innerHTML = reviews.length
    ? reviews.map((r) => `<option value="${r.id}">${esc(r.title)}${r.visited_on ? `（${r.visited_on}）` : ""}</option>`).join("")
    : '<option value="0">還沒有點評</option>';
  const want = Number(params.get("id"));
  if (want && reviews.some((r) => r.id === want)) webReview.value = String(want);
  try {
    const { tags } = await api("/api/tags");
    webTag.innerHTML = tags.length
      ? tags.map((t) => `<option value="${esc(t.tag)}">#${esc(t.tag)}（${t.count} 筆）</option>`).join("")
      : '<option value="0">還沒有分類，先在點評加上分類</option>';
    webTag.disabled = !tags.length;
    const wantTag = params.get("tag");
    if (wantTag && tags.some((t) => t.tag === wantTag)) {
      webTag.value = wantTag;
      document.querySelector('input[name="web-kind"][value="tag"]').checked = true;
    } else if (want && !wantTag && params.get("tab") === "web") {
      document.querySelector('input[name="web-kind"][value="review"]').checked = true;
    }
  } catch (err) {
    setStatus(webStatus, err.message, "error");
  }
  applyWebKind();
}

document.querySelectorAll('input[name="web-kind"]').forEach((r) => r.addEventListener("change", applyWebKind));

$("#web-create-btn").addEventListener("click", async () => {
  const kind = webKind();
  const json = kind === "tag" ? { kind, tag: webTag.value } : { kind, review_id: Number(webReview.value) };
  if ((kind === "tag" && (webTag.disabled || !webTag.value)) || (kind === "review" && !json.review_id)) {
    setStatus(webStatus, kind === "tag" ? "請先選一個分類" : "請先選一筆點評", "error");
    return;
  }
  setStatus(webStatus, "建立中…");
  try {
    const { share } = await api("/api/shares", { method: "POST", json });
    const url = shareUrl(share.token);
    const copied = await copyText(url);
    setStatus(webStatus, `${copied ? "已複製連結" : "已建立連結"}：${url}`, "ok");
    await loadShares();
    if (navigator.share && matchMedia("(pointer: coarse)").matches) {
      navigator.share({ title: share.title, text: webShareText(json), url }).catch(() => {});
    }
  } catch (err) {
    setStatus(webStatus, err.message, "error");
  }
});

shareList.addEventListener("click", async (e) => {
  const copy = e.target.closest("[data-copy]");
  const revoke = e.target.closest("[data-revoke]");
  const shareCard = e.target.closest("[data-card]");
  if (shareCard) openShareCard(shareCard.dataset.card);
  else if (copy) {
    const url = shareUrl(copy.dataset.copy);
    setStatus(listStatus, (await copyText(url)) ? `已複製：${url}` : `請手動複製：${url}`, "ok");
  } else if (revoke) {
    if (!confirm("停止分享後，這個連結會立即失效。確定停止？")) return;
    try {
      await api(`/api/shares/${encodeURIComponent(revoke.dataset.revoke)}`, { method: "DELETE" });
      await loadShares();
      setStatus(listStatus, "已停止分享", "ok");
    } catch (err) {
      setStatus(listStatus, err.message, "error");
    }
  }
});

function openWebTabIfAsked() {
  if (params.get("tab") !== "web") return;
  // jerry-ui.js 以 defer 載入，模組執行時可能還沒綁好事件；直接切換 aria-pressed 與 hidden
  document.querySelectorAll("[data-tabs] [data-tab]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.tab === "web")));
  document.querySelectorAll("[data-tabs] [data-tab-panel]").forEach((p) => { p.hidden = p.dataset.tabPanel !== "web"; });
}

async function init() {
  bindLogout();
  for (const el of [select, webTag, webReview]) combo(el); // 可搜尋的下拉選單，值與 change 事件仍走原生 select
  openWebTabIfAsked();
  loadShares();
  const main = $("#main");
  main.inert = true; // 預設勾選載入前鎖住，避免先勾的欄位被設定蓋掉
  settings = await loadSettings();
  for (const [k] of SHARE_FIELDS) $(`#share-${k}`).checked = Boolean(settings.shareFields[k]);
  const pos = document.querySelector(`input[name="position"][value="${settings.sharePosition}"]`);
  if (pos) pos.checked = true;
  main.inert = false;
  render();
  try {
    const id = await loadList();
    loadWebOptions(listItems);
    if (id) await loadReview(id);
  } catch (err) {
    setStatus(outStatus, err.message, "error");
  }
}

init();
