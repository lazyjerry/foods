// 公開分享頁（/s/<token>，ADR 020–022）：免登入、唯讀。
// 照片逐張向 API 取得 base64 data URI 再放進 <img>，畫面與 DOM 不出現圖片網址。
import { $, esc, formatPrice, ratingSummary, setStatus, tagBadges } from "./common.js";

const token = location.pathname.split("/").pop() || "";
const list = $("#shared-list");
const status = $("#shared-status");
const base = `/api/public/shares/${encodeURIComponent(token)}`;
let mark = "吃過筆記"; // 照片浮水印文字：設定頁的稱呼

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
  return `<figure><img data-photo="${p.id}" alt="${esc(p.caption || title)}"${ratio}>${p.caption ? `<figcaption>${esc(p.caption)}</figcaption>` : ""}</figure>`;
}

function item(r, kind) {
  const meta = [formatPrice(r.price), r.visited_on, kind === "tag" && r.photo_count > 1 ? `${r.photo_count} 張照片` : ""].filter(Boolean).join(" · ");
  const rating = ratingSummary(r.ratings);
  return `<article class="app-review app-shared-review"><div class="app-review-body">
  <h3>${esc(r.title)}</h3>
  <p class="meta">${esc(meta)}</p>
  ${tagBadges(r.tags)}
  <p class="app-review-addr">${esc(r.address)}</p>
  ${rating.length ? `<p class="app-review-hearts">${rating.map(esc).join("　")}</p>` : ""}
  ${r.body ? `<p class="app-shared-text">${esc(r.body)}</p>` : ""}
  ${r.photos.length ? `<div class="app-shared-photos">${r.photos.map((p) => photoSlot(p, r.title)).join("")}</div>` : ""}
</div></article>`;
}

// 照片燒進稱呼的半透明斜向浮水印：直接畫進圖片，另存或截圖都帶著浮水印。沒設稱呼時用品牌名。
function watermark(src, text) {
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

// 一次一張，避免同時把多張 base64 塞進記憶體與網路
async function loadPhotos() {
  for (const img of list.querySelectorAll("img[data-photo]")) {
    try {
      const { src } = await getJson(`${base}/photos/${Number(img.dataset.photo)}`);
      img.src = await watermark(src, mark);
    } catch {
      img.alt = "照片載入失敗";
    }
    img.removeAttribute("data-photo");
  }
}

async function init() {
  setStatus(status, "載入中…");
  try {
    const data = await getJson(base);
    const heading = data.share.kind === "tag" ? `#${data.share.tag}` : data.reviews[0]?.title || "分享的點評";
    mark = data.nickname || "吃過筆記";
    const by = data.nickname ? `${data.nickname} 分享的` : "分享的";
    $("#shared-title").textContent = heading;
    $("#shared-title").nextElementSibling.textContent = data.share.kind === "tag" ? `${by}分類，共 ${data.reviews.length} 筆點評` : `${by}點評`;
    document.title = `${heading}｜吃過筆記`;
    list.innerHTML = data.reviews.map((r) => item(r, data.share.kind)).join("");
    if (!data.reviews.length) setStatus(status, "這個分類目前沒有點評");
    else setStatus(status, "");
    await loadPhotos();
  } catch (err) {
    $("#shared-title").textContent = "無法開啟";
    $("#shared-title").nextElementSibling.textContent = "連結可能已停止分享";
    setStatus(status, err.message, "error");
  }
}

init();
