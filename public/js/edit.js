// 新增／編輯點評：基本欄位、地圖與地址互轉、選用評比、照片壓縮上傳。
import { $, RATING_DEFS, api, bindLogout, charCount, esc, formatBytes, loadSettings, mediaUrl, setStatus, today } from "./common.js";
import { createMap } from "./map.js";
import { compressImage } from "./photo.js";

const FALLBACK = { lat: 25.0478, lng: 121.517 }; // 台北車站：拿不到目前位置時的起點
const MAX_PHOTOS = 20;
const form = $("#review-form");
const f = {
  title: $("#title"), price: $("#price"), visited: $("#visited-on"), body: $("#body"),
  lat: $("#lat"), lng: $("#lng"), address: $("#address"), tags: $("#tag-input"),
};
const geoStatus = $("#geo-status");
const photoStatus = $("#photo-status");
const saveStatus = $("#save-status");
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
function updateCount() {
  const n = charCount(f.body.value);
  $("#body-hint").textContent = `${n}／2000 字`;
}

function markInvalid(input, on) {
  input.closest(".field")?.classList.toggle("is-invalid", on);
  input.setAttribute("aria-invalid", on ? "true" : "false");
}

function clearInvalid() {
  Object.values(f).forEach((el) => markInvalid(el, false));
}

const FIELD_MAP = { title: "title", price: "price", body: "body", lat: "lat", lng: "lng", address: "address", visited_on: "visited", tags: "tags" };

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
  if (!f.title.value.trim()) errors.title = "請輸入標題";
  const price = Number(f.price.value);
  if (f.price.value === "" || !Number.isInteger(price) || price < 0 || price > 1_000_000) errors.price = "請輸入 0 到 1,000,000 的整數價格";
  if (charCount(f.body.value) > 2000) errors.body = "點評最多 2000 字";
  const lat = Number(f.lat.value);
  const lng = Number(f.lng.value);
  if (f.lat.value === "" || !(lat >= -90 && lat <= 90)) errors.lat = "緯度要在 -90 到 90 之間";
  if (f.lng.value === "" || !(lng >= -180 && lng <= 180)) errors.lng = "經度要在 -180 到 180 之間";
  if (!f.address.value.trim()) errors.address = "請輸入地址，或在地圖上選位置後按「用座標查地址」";
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
    $("#tag-options").innerHTML = data.tags.map((t) => `<option value="${esc(t.tag)}"></option>`).join("");
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
    f.address.value = data.address;
    markInvalid(f.address, false);
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
  f.address.value = r.address || f.address.value;
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
    <div class="field"><label for="cap-${p.uid}">照片說明</label><input id="cap-${p.uid}" type="text" maxlength="100" value="${esc(p.caption)}" data-caption="${p.uid}"></div>
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
  const url = btn.dataset.illust;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(String(res.status));
    const blob = await res.blob();
    await addFiles([new File([blob], url.split("/").pop(), { type: blob.type || "image/jpeg" })]);
  } catch {
    setStatus(photoStatus, "插畫載入失敗，請檢查網路後再試一次", "error");
  }
});

async function syncPhotos(id) {
  const tasks = [];
  for (const p of photos) {
    if (p.kind === "new") tasks.push(["上傳", () => {
      const q = new URLSearchParams({ w: p.width, h: p.height, caption: p.caption.trim() });
      return api(`/api/reviews/${id}/photos?${q}`, { method: "POST", body: p.blob, headers: { "Content-Type": "image/jpeg" } });
    }]);
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
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (saving) return;
  clearInvalid();
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
  saving = true;
  lockScreen("儲存中…"); // 先鎖再停用按鈕：停用會讓瀏覽器移走焦點，鎖定時要記住的是儲存鈕
  $("#save-btn").disabled = true;
  setStatus(saveStatus, "儲存中…");
  const payload = {
    title: f.title.value.trim(), price: Number(f.price.value), body: f.body.value, visited_on: f.visited.value || null,
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
