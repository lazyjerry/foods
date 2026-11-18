// 公開分享頁（/s/<token>，ADR 020–022）：免登入、唯讀。
// 照片逐張向 API 取得 base64 data URI 再放進 <img>，畫面與 DOM 不出現圖片網址。
import { $, bindNavMenus, esc, formatPrice, NO_ADDRESS, navMenu, ratingSummary, setStatus, tagBadges, watermark } from "./common.js";
import { openShareCard } from "./share-card.js";

const token = location.pathname.split("/").pop() || "";
const list = $("#shared-list");
const status = $("#shared-status");
const base = `/api/public/shares/${encodeURIComponent(token)}`;
let mark = "吃過筆記"; // 照片浮水印文字：設定頁的稱呼；設定頁關掉稱呼浮水印時為空字串，照片不壓

async function getJson(path) {
  let res;
  try {
    res = await fetch(path, { credentials: "omit" });
  } catch {
    throw new Error("連不上伺服器，請確認網路後再試一次");
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `伺服器錯誤（${res.status}），請稍後再試`);
  return data;
}

function photoSlot(p, title) {
  const ratio = p.width && p.height ? ` width="${p.width}" height="${p.height}"` : "";
  return `<figure><button class="app-photo-open" type="button" aria-label="放大照片"><img data-photo="${p.id}" alt="${esc(p.caption || title)}"${ratio}></button>${p.caption ? `<figcaption>${esc(p.caption)}</figcaption>` : ""}</figure>`;
}

// 一張照片直接放；兩張以上做成左右滑動的輪播（scroll-snap），下方有上一張、下一張與張數
function photoBlock(r) {
  const slots = r.photos.map((p) => photoSlot(p, r.title)).join("");
  if (r.photos.length < 2) return `<div class="app-shared-photos">${slots}</div>`;
  return `<div class="app-shared-photos app-slider">
  <div class="app-slider-track" tabindex="0" aria-label="${esc(r.title)} 的照片，可左右滑動">${slots}</div>
  <div class="app-slider-bar"><button class="btn secondary" type="button" data-slide="-1" aria-label="上一張">‹</button><span class="app-slider-count" aria-live="polite">1 / ${r.photos.length}</span><button class="btn secondary" type="button" data-slide="1" aria-label="下一張">›</button></div>
</div>`;
}

function item(r, kind) {
  const meta = [formatPrice(r.price), r.visited_on, kind === "tag" && r.photo_count > 1 ? `${r.photo_count} 張照片` : ""].filter(Boolean).join(" · ");
  const rating = ratingSummary(r.ratings);
  return `<article class="app-review app-shared-review"><div class="app-review-body">
  <h3>${esc(r.title)}</h3>
  <p class="meta app-shared-meta">${esc(meta)}</p>
  ${tagBadges(r.tags)}
  <p class="app-review-addr">${esc(r.address || NO_ADDRESS)}</p>
  <div class="actions">${navMenu(r.lat, r.lng, r.title)}</div>
  ${rating.length ? `<ul class="app-shared-hearts">${rating.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : ""}
  ${r.body ? `<p class="app-shared-text">${esc(r.body)}</p>` : ""}
</div>${r.photos.length ? photoBlock(r) : ""}</article>`;
}

// 一次一張，避免同時把多張 base64 塞進記憶體與網路
async function loadPhotos() {
  for (const img of list.querySelectorAll("img[data-photo]")) {
    try {
      const { src } = await getJson(`${base}/photos/${Number(img.dataset.photo)}`);
      img.src = mark ? await watermark(src, mark) : src;
    } catch {
      img.alt = "照片載入失敗";
    }
    img.removeAttribute("data-photo");
  }
}

// 輪播：張數跟著捲動位置更新，按鈕一次捲一張寬
function bindSliders() {
  for (const slider of list.querySelectorAll(".app-slider")) {
    const track = slider.querySelector(".app-slider-track");
    const count = slider.querySelector(".app-slider-count");
    const [prev, next] = slider.querySelectorAll("[data-slide]");
    const total = track.children.length;
    const index = () => Math.round(track.scrollLeft / (track.clientWidth || 1));
    const update = () => {
      const i = index();
      count.textContent = `${i + 1} / ${total}`;
      prev.disabled = i <= 0;
      next.disabled = i >= total - 1;
    };
    for (const b of [prev, next]) {
      b.addEventListener("click", () => track.scrollTo({ left: (index() + Number(b.dataset.slide)) * track.clientWidth, behavior: "smooth" }));
    }
    track.addEventListener("scroll", update, { passive: true });
    update();
  }
}

// 點照片開大圖（<dialog>）：同一筆點評的已載入照片可左右切換，方向鍵、滑動也行；關閉時輪播停在最後看的那張
const box = $("#photo-box");
let boxImgs = [];
let boxIndex = 0;

function showBox(i) {
  boxIndex = (i + boxImgs.length) % boxImgs.length;
  const img = boxImgs[boxIndex];
  $("#photo-box-img").src = img.src;
  $("#photo-box-img").alt = img.alt;
  $("#photo-box-caption").textContent = img.closest("figure").querySelector("figcaption")?.textContent || "";
  $("#photo-box-count").textContent = `${boxIndex + 1} / ${boxImgs.length}`;
  $("#photo-box-bar").hidden = boxImgs.length < 2;
}

function bindPhotoBox() {
  if (!box || typeof box.showModal !== "function") return;
  list.addEventListener("click", (e) => {
    const img = e.target.closest(".app-photo-open")?.querySelector("img");
    if (!img?.src) return; // 還沒載入的照片不開
    boxImgs = [...img.closest(".app-shared-photos").querySelectorAll("img")].filter((x) => x.src);
    showBox(boxImgs.indexOf(img));
    box.showModal();
  });
  $("#photo-box-close").addEventListener("click", () => box.close());
  box.addEventListener("click", (e) => {
    if (e.target === box) box.close(); // 點背景關閉
  });
  for (const b of box.querySelectorAll("[data-box]")) b.addEventListener("click", () => showBox(boxIndex + Number(b.dataset.box)));
  box.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") showBox(boxIndex - 1);
    if (e.key === "ArrowRight") showBox(boxIndex + 1);
  });
  let startX = null;
  box.addEventListener("pointerdown", (e) => (startX = e.clientX));
  box.addEventListener("pointerup", (e) => {
    const dx = startX === null ? 0 : e.clientX - startX;
    startX = null;
    if (Math.abs(dx) > 50 && boxImgs.length > 1) showBox(boxIndex + (dx < 0 ? 1 : -1));
  });
  box.addEventListener("close", () => {
    const figure = boxImgs[boxIndex]?.closest("figure");
    const track = figure?.closest(".app-slider-track");
    if (track) track.scrollTo({ left: [...track.children].indexOf(figure) * track.clientWidth });
  });
}

// GA4（ADR 028）：設定頁有填評估 ID 才載入 gtag。
// 送給 GA 的網址含分享 token：實際 ID 下 page_location 覆寫不生效（config、set、手動 page_view 都試過），使用者接受
function loadAnalytics(id) {
  if (!/^G-[A-Z0-9]{4,20}$/.test(id)) return;
  window.dataLayer = window.dataLayer || [];
  window.gtag = function gtag() {
    window.dataLayer.push(arguments); // gtag 要的是 arguments 物件，不能改成陣列
  };
  window.gtag("js", new Date());
  window.gtag("config", id);
  const s = document.createElement("script");
  s.async = true;
  s.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}`;
  document.head.append(s);
}

async function init() {
  setStatus(status, "載入中…");
  try {
    const data = await getJson(base);
    const heading = data.share.kind === "tag" ? `#${data.share.tag}` : data.reviews[0]?.title || "分享的點評";
    mark = data.watermark === false ? "" : data.nickname || "吃過筆記";
    const by = data.nickname ? `${data.nickname} 分享的` : "分享的";
    $("#shared-title").textContent = heading;
    $("#shared-title").nextElementSibling.textContent = data.share.kind === "tag" ? `${by}分類，共 ${data.reviews.length} 筆點評` : `${by}點評`;
    document.title = `${heading}｜吃過筆記`;
    if (data.gaMeasurementId) loadAnalytics(data.gaMeasurementId);
    list.innerHTML = data.reviews.map((r) => item(r, data.share.kind)).join("");
    bindSliders();
    const shareBtn = $("#share-open");
    shareBtn.hidden = false;
    shareBtn.addEventListener("click", () => openShareCard(token, data));
    if (!data.reviews.length) setStatus(status, "這個分類目前沒有點評");
    else setStatus(status, "");
    await loadPhotos();
  } catch (err) {
    $("#shared-title").textContent = "無法開啟";
    $("#shared-title").nextElementSibling.textContent = "連結可能已停止分享";
    setStatus(status, err.message, "error");
  }
}

bindPhotoBox();
bindNavMenus();
init();
