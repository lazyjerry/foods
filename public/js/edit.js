// 新增／編輯點評：基本欄位、地圖與地址互轉、選用評比、照片壓縮上傳。
import { $, RATING_DEFS, actionToast, api, bindLogout, charCount, esc, formatBytes, hideActionToast, loadSettings, mediaUrl, setStatus, today } from "./common.js";
import { createMap } from "./map.js";
import { compressImage } from "./photo.js";
import { tagSuggest } from "./tag-suggest.js";

const FALLBACK = { lat: 25.0478, lng: 121.517 }; // 台北車站：拿不到目前位置時的起點
const MAX_PHOTOS = 20;
const form = $("#review-form");
const f = {
  title: $("#title"), meal: $("#meal"), price: $("#price"), visited: $("#visited-on"), body: $("#body"),
  lat: $("#lat"), lng: $("#lng"), address: $("#address"), tags: $("#tag-input"),
};
const geoStatus = $("#geo-status");
const photoStatus = $("#photo-status");
const saveStatus = $("#save-status");
// 單行文字欄位的字數上限取自 maxlength（build_pages.py 的 TEXT_MAX，與後端 src/db.js 相同）；
// 提示開頭的「n／256 字」跟著輸入更新，地址的提示後面還接著操作說明
const TEXT_MAX = f.title.maxLength;
const countText = (s) => `${charCount(s)}／${TEXT_MAX} 字`;
const clip = (s) => [...String(s || "")].slice(0, TEXT_MAX).join("");
const COUNTED = [[f.title, $("#title-hint")], [f.meal, $("#meal-hint")], [f.address, f.address.closest(".field").querySelector(".hint")]];
const ratingsOn = $("#ratings-on");
const ratingsBox = $("#ratings");
const grid = $("#photo-grid");
const results = $("#geo-results");

let settings;
let reviewId = Number(new URLSearchParams(location.search).get("id")) || null;
let photos = []; // {uid, kind: "existing"|"new", id?, key?, blob?, url?, width, height, bytes, caption, origCaption?, removed?}
let uid = 0;
let map;
let reverseTimer;
let reverseSeq = 0;
let saving = false;

// ---------- 鎖定畫面（ADR 026）：儲存、壓縮照片期間整頁 inert，遮罩顯示進度 ----------
// 遮罩放在 .wrap 之外，整頁 inert 時報讀器仍讀得到進度；重複呼叫 lockScreen() 只更新文字。
const page = document.querySelector(".wrap");
let busyBox;
let busyFocus;

function lockScreen(text) {
  if (!busyBox) {
    busyBox = document.createElement("div");
    busyBox.className = "app-busy";
    busyBox.hidden = true;
    busyBox.innerHTML = `<div class="app-busy-box"><span class="app-busy-spin" aria-hidden="true"></span><p class="app-busy-text" role="status"></p></div>`;
    document.body.append(busyBox);
  }
  if (busyBox.hidden) {
    busyFocus = document.activeElement;
    page.inert = true;
    busyBox.hidden = false;
  }
  busyBox.querySelector(".app-busy-text").textContent = text;
}

function unlockScreen() {
  if (!busyBox || busyBox.hidden) return;
  busyBox.hidden = true;
  page.inert = false;
  if (busyFocus?.isConnected) busyFocus.focus();
  busyFocus = null;
}

// ---------- 基本欄位 ----------
// 點評最多 4 行（src/db.js 同名常數）：分享圖照原文換行排版，行數多了字會縮得太小
const BODY_MAX_LINES = 4;
const lineCount = (s) => (s ? s.split("\n").length : 0);

function updateCount() {
  const n = charCount(f.body.value);
  const lines = lineCount(f.body.value);
  $("#body-hint").textContent = `${n}／2000 字・${lines}／${BODY_MAX_LINES} 行`;
  if (lines > BODY_MAX_LINES) markInvalid(f.body, true); // 舊點評可能超過，標出來讓使用者合併
  for (const [el, hint] of COUNTED) hint.textContent = hint.textContent.replace(/^\d+／\d+ 字/, countText(el.value));
}

function markInvalid(input, on) {
  input.closest(".field")?.classList.toggle("is-invalid", on);
  input.setAttribute("aria-invalid", on ? "true" : "false");
}

function clearInvalid() {
  Object.values(f).forEach((el) => markInvalid(el, false));
}

const FIELD_MAP = { title: "title", meal: "meal", price: "price", body: "body", lat: "lat", lng: "lng", address: "address", visited_on: "visited", tags: "tags" };

function showFieldErrors(fields) {
  let first;
  for (const [k, msg] of Object.entries(fields || {})) {
    const el = f[FIELD_MAP[k]];
    if (!el) continue;
    markInvalid(el, true);
    first ||= { el, msg };
  }
  if (first) first.el.focus();
  return first?.msg;
}

function validate() {
  const errors = {};
  if (!f.title.value.trim()) errors.title = "請輸入餐廳";
  else if (charCount(f.title.value.trim()) > TEXT_MAX) errors.title = `餐廳最多 ${TEXT_MAX} 字`;
  if (charCount(f.meal.value.trim()) > TEXT_MAX) errors.meal = `餐點最多 ${TEXT_MAX} 字`;
  if (charCount(f.address.value.trim()) > TEXT_MAX) errors.address = `地址最多 ${TEXT_MAX} 字`;
  const price = Number(f.price.value);
  if (f.price.value === "" || !Number.isInteger(price) || price < 0 || price > 1_000_000) errors.price = "請輸入 0 到 1,000,000 的整數價格";
  if (charCount(f.body.value) > 2000) errors.body = "點評最多 2000 字";
  const lat = Number(f.lat.value);
  const lng = Number(f.lng.value);
  if (f.lat.value === "" || !(lat >= -90 && lat <= 90)) errors.lat = "緯度要在 -90 到 90 之間";
  if (f.lng.value === "" || !(lng >= -180 && lng <= 180)) errors.lng = "經度要在 -180 到 180 之間";
  return errors;
}

// ---------- 分類（ADR 019） ----------
const MAX_TAGS = 10;
const tagInput = f.tags;
const TAG_HINT = "最多 10 個，每個 20 字內、不含空白；點已加的分類可移除";
const tagList = $("#tag-list");
let tags = [];

const cleanTag = (s) => String(s).normalize("NFKC").trim().replace(/^#+/, "").trim();

function renderTags() {
  tagList.innerHTML = tags
    .map((t, i) => `<button class="chip" type="button" data-i="${i}" aria-label="移除分類 ${esc(t)}">#${esc(t)} ×</button>`)
    .join("");
}

// 輸入框內容依空白、逗號、頓號拆成多個分類；回傳錯誤訊息，沒有錯誤回空字串
function addTags(text) {
  const parts = String(text).split(/[\s,，、]+/).map(cleanTag).filter(Boolean);
  for (const t of parts) {
    if ([...t].length > 20) return `分類「${t}」超過 20 字`;
    if (tags.includes(t)) continue;
    if (tags.length >= MAX_TAGS) return `分類最多 ${MAX_TAGS} 個`;
    tags.push(t);
  }
  renderTags();
  return "";
}

function commitTagInput() {
  const msg = addTags(tagInput.value);
  markInvalid(tagInput, Boolean(msg));
  tagInput.closest(".field").querySelector(".hint").textContent = msg || TAG_HINT;
  if (!msg) tagInput.value = "";
  return msg;
}

// 建議清單要比下面的 Enter 監聽先註冊：清單有選中項目時由它處理 Enter，不再走 commitTagInput
let tagOptions = [];
const suggest = tagSuggest(tagInput, {
  options: () => tagOptions,
  taken: () => tags,
  clean: cleanTag,
  onPick: (t) => {
    tagInput.value = t;
    commitTagInput();
  },
});

$("#tag-add-btn").addEventListener("click", () => {
  commitTagInput();
  tagInput.focus();
});
tagInput.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.isComposing) return; // 中文輸入法選字時的 Enter 不算
  e.preventDefault();
  commitTagInput();
});
tagList.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-i]");
  if (!btn) return;
  tags.splice(Number(btn.dataset.i), 1);
  renderTags();
  tagInput.focus();
});

async function loadTagOptions() {
  try {
    const data = await api("/api/tags");
    tagOptions = data.tags.map((t) => t.tag);
    suggest.refresh();
  } catch {
    // 建議清單拿不到不影響輸入
  }
}

// ---------- 評比 ----------
function paintHearts(fieldset) {
  const v = Number(fieldset.querySelector("input:checked")?.value || 0);
  fieldset.querySelectorAll(".app-heart").forEach((label, i) => label.classList.toggle("app-is-on", i < v));
}

function renderRatings(values) {
  ratingsBox.innerHTML = RATING_DEFS.map(([k, label]) => `<fieldset class="app-hearts" data-key="${k}">
  <legend>${label}</legend>
  <div class="app-hearts-row">${[1, 2, 3, 4, 5]
    .map((n) => `<label class="app-heart"><input type="radio" name="r-${k}" value="${n}"${values[k] === n ? " checked" : ""}><span aria-hidden="true">♥</span><span class="visually-hidden">${label} ${n} 顆心</span></label>`)
    .join("")}<label class="app-heart-skip"><input type="radio" name="r-${k}" value="0"${values[k] ? "" : " checked"}><span>不評</span></label></div>
</fieldset>`).join("");
  ratingsBox.querySelectorAll(".app-hearts").forEach(paintHearts);
}

function collectRatings() {
  if (!ratingsOn.checked) return {};
  const out = {};
  ratingsBox.querySelectorAll(".app-hearts").forEach((fs) => {
    const v = Number(fs.querySelector("input:checked")?.value || 0);
    if (v) out[fs.dataset.key] = v;
  });
  return out;
}

ratingsBox.addEventListener("change", (e) => {
  const fs = e.target.closest(".app-hearts");
  if (fs) paintHearts(fs);
});
ratingsOn.addEventListener("change", () => { ratingsBox.hidden = !ratingsOn.checked; });

// ---------- 位置 ----------
function setCoords(lat, lng, { moveMap = true, zoom } = {}) {
  f.lat.value = lat.toFixed(6);
  f.lng.value = lng.toFixed(6);
  markInvalid(f.lat, false);
  markInvalid(f.lng, false);
  if (moveMap && map) map.setPosition(lat, lng, zoom);
}

async function reverseLookup() {
  const lat = Number(f.lat.value);
  const lng = Number(f.lng.value);
  if (f.lat.value === "" || f.lng.value === "" || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    setStatus(geoStatus, "請先輸入緯度與經度，或在地圖上點選位置", "error");
    return;
  }
  const seq = ++reverseSeq;
  setStatus(geoStatus, "依座標查詢地址中…");
  try {
    const data = await api(`/api/geo/reverse?lat=${lat}&lng=${lng}`);
    if (seq !== reverseSeq) return;
    f.address.value = clip(data.address);
    markInvalid(f.address, false);
    updateCount();
    setStatus(geoStatus, "已依座標帶入地址，可再手動修改", "ok");
  } catch (err) {
    if (seq === reverseSeq) setStatus(geoStatus, err.message, "error");
  }
}

function scheduleReverse() {
  clearTimeout(reverseTimer);
  reverseTimer = setTimeout(reverseLookup, 1100); // Nominatim 每秒最多 1 次
}

function applyResult(r) {
  setCoords(r.lat, r.lng, { zoom: 17 });
  f.address.value = clip(r.address) || f.address.value;
  updateCount();
  results.innerHTML = "";
  setStatus(geoStatus, "已依地址移動標記，可再拖曳微調", "ok");
}

async function geocode() {
  const q = f.address.value.trim();
  results.innerHTML = "";
  if (!q) {
    markInvalid(f.address, true);
    setStatus(geoStatus, "請先輸入地址，再按「查座標」", "error");
    f.address.focus();
    return;
  }
  setStatus(geoStatus, "依地址查詢座標中…");
  try {
    const data = await api("/api/geo/search?q=" + encodeURIComponent(q));
    if (!data.results.length) {
      setStatus(geoStatus, "查不到這個地址，試著去掉樓層、巷弄，或直接在地圖上點選", "error");
      return;
    }
    if (data.results.length === 1) return applyResult(data.results[0]);
    results.innerHTML = data.results
      .map((r, i) => `<button class="btn is-sm secondary app-geo-option" type="button" data-i="${i}">${esc(r.label)}</button>`)
      .join("");
    results.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => applyResult(data.results[Number(b.dataset.i)])));
    setStatus(geoStatus, `找到 ${data.results.length} 個地點，請選一個`, "ok");
  } catch (err) {
    setStatus(geoStatus, err.message, "error");
  }
}

function locate({ fillAddress }) {
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      setStatus(geoStatus, "這個瀏覽器不支援定位，請在地圖上點選或輸入地址", "error");
      return resolve(false);
    }
    setStatus(geoStatus, "取得目前位置中…");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setCoords(pos.coords.latitude, pos.coords.longitude, { zoom: 17 });
        setStatus(geoStatus, "已定位到目前位置", "ok");
        if (fillAddress) reverseLookup();
        resolve(true);
      },
      (err) => {
        const msg = err.code === 1 ? "沒有定位權限，請在瀏覽器允許位置存取，或直接在地圖上點選" : "無法取得目前位置，請在地圖上點選或輸入地址";
        setStatus(geoStatus, msg, "error");
        resolve(false);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
    );
  });
}

async function initMap(lat, lng) {
  try {
    map = await createMap($("#map"), {
      lat, lng,
      onPick(la, ln) {
        setCoords(la, ln, { moveMap: false });
        scheduleReverse();
      },
    });
  } catch (err) {
    setStatus(geoStatus, err.message + "；仍可手動輸入座標與地址", "error");
  }
}

for (const el of [f.lat, f.lng]) {
  el.addEventListener("change", () => {
    const lat = Number(f.lat.value);
    const lng = Number(f.lng.value);
    if (f.lat.value !== "" && f.lng.value !== "" && Number.isFinite(lat) && Number.isFinite(lng) && map) map.setPosition(lat, lng);
  });
}
$("#geocode-btn").addEventListener("click", geocode);
f.address.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    geocode();
  }
});
$("#reverse-btn").addEventListener("click", reverseLookup);
$("#locate-btn").addEventListener("click", () => locate({ fillAddress: true }));

// ---------- 照片 ----------
function visiblePhotos() {
  return photos.filter((p) => !p.removed);
}

function renderPhotos() {
  grid.innerHTML = visiblePhotos()
    .map((p) => {
      const src = p.kind === "new" ? p.url : mediaUrl(p.key);
      const state = p.kind === "new" ? "待上傳" : "已上傳";
      return `<div class="app-photo-tile" data-uid="${p.uid}">
  <img src="${src}" alt="${esc(p.caption || "點評照片")}" width="${p.width || ""}" height="${p.height || ""}" loading="lazy">
  <div class="app-photo-meta">
    <div class="field"><label for="cap-${p.uid}">照片說明</label><input id="cap-${p.uid}" type="text" maxlength="${TEXT_MAX}" value="${esc(p.caption)}" data-caption="${p.uid}" aria-describedby="cap-${p.uid}-hint"><p class="hint" id="cap-${p.uid}-hint">${countText(p.caption)}</p></div>
    <p class="meta">${formatBytes(p.bytes)} · ${p.width}×${p.height} · ${state}</p>
    <button class="btn is-sm secondary" type="button" data-remove="${p.uid}">移除</button>
  </div>
</div>`;
    })
    .join("");
}

grid.addEventListener("input", (e) => {
  const id = e.target.dataset.caption;
  if (!id) return;
  const p = photos.find((x) => x.uid === Number(id));
  if (p) p.caption = e.target.value;
  $(`#cap-${id}-hint`).textContent = countText(e.target.value);
});
grid.addEventListener("click", (e) => {
  const id = e.target.dataset.remove;
  if (!id) return;
  const p = photos.find((x) => x.uid === Number(id));
  if (!p) return;
  if (p.kind === "new") {
    URL.revokeObjectURL(p.url);
    photos = photos.filter((x) => x !== p);
    setStatus(photoStatus, "已移除，這張不會上傳", "ok");
  } else {
    p.removed = true;
    setStatus(photoStatus, "已標記移除，按「儲存點評」後才會從 R2 刪除", "ok");
  }
  renderPhotos();
});

async function addFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  const room = MAX_PHOTOS - visiblePhotos().length;
  if (room <= 0) {
    setStatus(photoStatus, `每筆點評最多 ${MAX_PHOTOS} 張照片`, "error");
    return;
  }
  let before = 0;
  let after = 0;
  let done = 0;
  const failed = [];
  for (const file of files.slice(0, room)) {
    setStatus(photoStatus, `壓縮中…（${done + 1}／${Math.min(files.length, room)}）`);
    lockScreen(`照片壓縮中…（${done + failed.length + 1}／${Math.min(files.length, room)}）`);
    try {
      const out = await compressImage(file, { maxEdge: settings.maxEdge, quality: settings.quality });
      photos.push({ uid: ++uid, kind: "new", blob: out.blob, url: URL.createObjectURL(out.blob), width: out.width, height: out.height, bytes: out.blob.size, caption: "" });
      before += file.size;
      after += out.blob.size;
      done++;
    } catch (err) {
      failed.push(err.message);
    }
  }
  unlockScreen();
  renderPhotos();
  const skipped = files.length > room ? `，超過上限略過 ${files.length - room} 張` : "";
  if (failed.length) setStatus(photoStatus, failed[0] + skipped, "error");
  else setStatus(photoStatus, `已壓縮 ${done} 張：${formatBytes(before)} → ${formatBytes(after)}${skipped}。按「儲存點評」後上傳`, "ok");
}

for (const [btn, input] of [["#camera-btn", "#camera-input"], ["#pick-btn", "#pick-input"]]) {
  $(btn).addEventListener("click", () => $(input).click());
  $(input).addEventListener("change", async (e) => {
    await addFiles(e.target.files);
    e.target.value = "";
  });
}

// 選擇插畫：站內的 AI 插畫（public/img/illustrations/）當成一張照片加入，跟相簿照片走同一條壓縮與上傳流程
const illustSheet = $("#illust-sheet");
illustSheet.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-illust]");
  if (!btn) return;
  if (illustSheet.open) illustSheet.close();
  await addIllustration(btn.dataset.illust);
});

// 插畫不壓縮也不上傳檔案：儲存時只記檔名，後端直接引用站內原檔（不佔 R2）。回傳是否加入成功
async function addIllustration(url) {
  if (visiblePhotos().length >= MAX_PHOTOS) {
    setStatus(photoStatus, `每筆點評最多 ${MAX_PHOTOS} 張照片`, "error");
    return false;
  }
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(String(res.status));
    const blob = await res.blob();
    const bmp = await createImageBitmap(blob);
    const name = url.split("/").pop();
    photos.push({ uid: ++uid, kind: "new", illust: name, blob, url: URL.createObjectURL(blob), width: bmp.width, height: bmp.height, bytes: blob.size, caption: "" });
    bmp.close();
    renderPhotos();
    setStatus(photoStatus, "已加入插畫，按「儲存點評」後儲存（插畫直接引用站內原檔，不另外上傳）", "ok");
    return true;
  } catch {
    setStatus(photoStatus, "插畫載入失敗，請檢查網路後再試一次", "error");
    return false;
  }
}

// 自動插畫：點評沒有照片、但分類、餐點或餐廳含某張插畫的名稱時，儲存前自動加入那張插畫
// 比對順序：分類 → 餐點 → 餐廳（docs/afk-skill/adr/003）；同一層取名稱最長的，避免短名稱（如「麵線」）搶走較精確的長名稱
const ILLUSTS = [...illustSheet.querySelectorAll("[data-illust]")]
  .map((b) => ({ url: b.dataset.illust, label: b.textContent.trim() }))
  .sort((a, b) => b.label.length - a.label.length);
let illustHint = ""; // 目前顯示在照片狀態列的提示；狀態列被其他訊息蓋掉後就不再清除它

function matchIllust() {
  if (visiblePhotos().length) return null;
  const pending = tagInput.value.split(/[\s,，、]+/).map(cleanTag).filter(Boolean); // 還沒按「加入」的分類，儲存時也會一併存
  const allTags = [...tags, ...pending];
  const meal = f.meal.value;
  const title = f.title.value;
  return ILLUSTS.find((i) => allTags.some((t) => t.includes(i.label))) || ILLUSTS.find((i) => meal.includes(i.label))
    || ILLUSTS.find((i) => title.includes(i.label)) || null;
}

function updateIllustHint() {
  const m = matchIllust();
  const text = m ? `目前沒有照片，儲存時會自動加入「${m.label}」插畫` : "";
  if (text === illustHint) return;
  if (text) setStatus(photoStatus, text);
  else if (photoStatus.textContent.trim() === illustHint) setStatus(photoStatus, "");
  illustHint = text;
}

for (const type of ["input", "click", "keyup"]) form.addEventListener(type, updateIllustHint);

async function sha256Hex(blob) {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// 照片檔共用（src/media.js）：插畫只送檔名；照片先送壓縮後的雜湊，R2 已有同一張就不再傳檔
async function uploadNew(id, p) {
  const path = (q) => `/api/reviews/${id}/photos?${q}`;
  const q = new URLSearchParams({ w: p.width, h: p.height, caption: p.caption.trim() });
  if (p.illust) {
    q.set("illust", p.illust);
    return api(path(q), { method: "POST" });
  }
  if (crypto.subtle) { // 非 HTTPS 環境沒有 crypto.subtle，直接上傳，後端一樣會比對雜湊
    const probe = new URLSearchParams(q);
    probe.set("sha256", await sha256Hex(p.blob));
    const res = await api(path(probe), { method: "POST" });
    if (!res.needUpload) return res;
  }
  return api(path(q), { method: "POST", body: p.blob, headers: { "Content-Type": "image/jpeg" } });
}

async function syncPhotos(id) {
  const tasks = [];
  for (const p of photos) {
    if (p.kind === "new") tasks.push(["上傳", () => uploadNew(id, p)]);
    else if (p.removed) tasks.push(["刪除", () => api(`/api/photos/${p.id}`, { method: "DELETE" })]);
    else if (p.caption.trim() !== p.origCaption) tasks.push(["更新說明", () => api(`/api/photos/${p.id}`, { method: "PATCH", json: { caption: p.caption.trim() } })]);
  }
  let n = 0;
  const errors = [];
  for (const [label, run] of tasks) {
    setStatus(saveStatus, `處理照片中…（${++n}／${tasks.length}）`);
    lockScreen(`處理照片中…（${n}／${tasks.length}）`);
    try {
      await run();
    } catch (err) {
      errors.push(`${label}失敗：${err.message}`);
    }
  }
  return errors;
}

// ---------- 載入與儲存 ----------
function fillReview(r) {
  f.title.value = r.title;
  f.meal.value = r.meal || "";
  f.price.value = r.price;
  f.visited.value = r.visited_on || "";
  f.body.value = r.body;
  f.address.value = r.address;
  setCoords(r.lat, r.lng, { moveMap: false });
  tags = [...(r.tags || [])];
  renderTags();
  const has = Object.keys(r.ratings || {}).length > 0;
  ratingsOn.checked = has;
  ratingsBox.hidden = !has;
  renderRatings(has ? r.ratings : Object.fromEntries(RATING_DEFS.map(([k]) => [k, settings.defaultHearts])));
  photos.filter((p) => p.kind === "new").forEach((p) => URL.revokeObjectURL(p.url));
  photos = r.photos.map((p) => ({ uid: ++uid, kind: "existing", id: p.id, key: p.key, width: p.width, height: p.height, bytes: p.bytes, caption: p.caption, origCaption: p.caption }));
  renderPhotos();
  updateCount();
  $("#share-link").href = `/share?id=${r.id}`;
  $("#share-link").hidden = false;
  $("#delete-btn").hidden = false;
  document.title = `編輯：${r.title}｜食物點評`;
  updateIllustHint();
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (saving) return;
  clearInvalid();
  hideActionToast(); // 重新儲存時先收起上一次的 toast，存完再跳新的
  const errors = validate();
  if (Object.keys(errors).length) {
    setStatus(saveStatus, showFieldErrors(errors), "error");
    return;
  }
  const tagError = tagInput.value.trim() ? commitTagInput() : ""; // 輸入框還有沒按「加入」的分類，一併存
  if (tagError) {
    setStatus(saveStatus, tagError, "error");
    tagInput.focus();
    return;
  }
  const auto = matchIllust(); // 沒有照片時依分類、餐點或餐廳補一張插畫；壓縮期間 addFiles 自己會鎖畫面
  const autoAdded = auto ? await addIllustration(auto.url) : false;
  saving = true;
  lockScreen("儲存中…"); // 先鎖再停用按鈕：停用會讓瀏覽器移走焦點，鎖定時要記住的是儲存鈕
  $("#save-btn").disabled = true;
  setStatus(saveStatus, "儲存中…");
  const payload = {
    title: f.title.value.trim(), meal: f.meal.value.trim(), price: Number(f.price.value), body: f.body.value, visited_on: f.visited.value || null,
    lat: Number(f.lat.value), lng: Number(f.lng.value), address: f.address.value.trim(), ratings: collectRatings(), tags,
  };
  try {
    const data = reviewId
      ? await api(`/api/reviews/${reviewId}`, { method: "PUT", json: payload })
      : await api("/api/reviews", { method: "POST", json: payload });
    reviewId = data.review.id;
    history.replaceState(null, "", `/edit?id=${reviewId}`);
    const photoErrors = await syncPhotos(reviewId);
    const fresh = await api(`/api/reviews/${reviewId}`);
    fillReview(fresh.review);
    if (photoErrors.length) setStatus(saveStatus, `點評已儲存，但有 ${photoErrors.length} 項照片處理失敗：${photoErrors[0]}`, "error");
    else setStatus(saveStatus, "已儲存", "ok");
    if (autoAdded) setStatus(photoStatus, `沒有照片，已自動加入「${auto.label}」插畫`, "ok");
    actionToast(photoErrors.length ? "點評已儲存，部分照片處理失敗" : "已儲存點評", { href: "/", label: "返回列表" });
  } catch (err) {
    setStatus(saveStatus, showFieldErrors(err.fields) || err.message, "error");
  } finally {
    saving = false;
    $("#save-btn").disabled = false;
    unlockScreen();
  }
});

$("#delete-btn").addEventListener("click", async () => {
  if (!reviewId || !confirm("確定刪除這筆點評與所有照片？刪除後無法復原。")) return;
  try {
    await api(`/api/reviews/${reviewId}`, { method: "DELETE" });
    location.href = "/";
  } catch (err) {
    setStatus(saveStatus, err.message, "error");
  }
});

for (const el of Object.values(f)) el.addEventListener("input", () => markInvalid(el, false));
f.body.addEventListener("input", updateCount);
// 已滿 4 行時擋掉換行（選取範圍內有換行、按下去行數不會變多的情況放行）
f.body.addEventListener("beforeinput", (e) => {
  if (e.inputType !== "insertLineBreak" && e.inputType !== "insertParagraph") return;
  const v = f.body.value;
  const next = v.slice(0, f.body.selectionStart) + "\n" + v.slice(f.body.selectionEnd);
  if (lineCount(next) > BODY_MAX_LINES && lineCount(next) > lineCount(v)) e.preventDefault();
});
// 貼上或輸入法帶進多行時，第 4 行之後的內容併進第 4 行，不直接丟掉
f.body.addEventListener("input", (e) => {
  if (e.inputType === undefined || !/^insert/.test(e.inputType)) return;
  const ls = f.body.value.split("\n");
  if (ls.length <= BODY_MAX_LINES) return;
  const pos = f.body.selectionStart;
  f.body.value = [...ls.slice(0, BODY_MAX_LINES - 1), ls.slice(BODY_MAX_LINES - 1).join(" ")].join("\n");
  f.body.setSelectionRange(pos, pos);
  updateCount();
});
for (const [el] of COUNTED) el.addEventListener("input", updateCount);
window.addEventListener("beforeunload", (e) => {
  if (photos.some((p) => p.kind === "new")) e.preventDefault();
});

async function init() {
  bindLogout();
  form.inert = true; // 設定與點評載入前鎖住表單，避免使用者先改的值被載入結果蓋掉
  settings = await loadSettings();
  loadTagOptions();
  if (reviewId) {
    try {
      const { review } = await api(`/api/reviews/${reviewId}`);
      fillReview(review);
      form.inert = false;
      await initMap(review.lat, review.lng);
      return;
    } catch (err) {
      setStatus(saveStatus, err.message + "；以下改為新增點評", "error");
      reviewId = null;
      history.replaceState(null, "", "/edit");
    }
  }
  f.visited.value = today();
  ratingsOn.checked = settings.ratingsDefaultOn;
  ratingsBox.hidden = !settings.ratingsDefaultOn;
  renderRatings(Object.fromEntries(RATING_DEFS.map(([k]) => [k, settings.defaultHearts])));
  updateCount();
  setCoords(FALLBACK.lat, FALLBACK.lng, { moveMap: false });
  form.inert = false;
  await initMap(FALLBACK.lat, FALLBACK.lng);
  await locate({ fillAddress: true });
}

init();
