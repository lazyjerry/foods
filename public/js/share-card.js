// 分享卡片（公開分享頁與分享頁「已分享的連結」共用）：對話框放網址、複製、系統分享，
// 以及用 canvas 自己畫的連結卡片圖，不用截圖套件。
// 資料一律走公開 API；封面照片是 data URI，canvas 不會被跨站圖片汙染而無法匯出。
// 設定頁開著稱呼浮水印時，封面壓上和公開頁相同的浮水印，訪客不會經由卡片拿到沒有浮水印的照片。
import { $, formatPrice, ratingSummary, setStatus, watermark } from "./common.js";

// 卡片是要傳出去的圖：固定用 Jerry UI 淺色配色，不跟著深色模式
const C = { paper: "#f5f3ed", grid: "rgba(23, 30, 52, 0.055)", card: "#fffefa", ink: "#171e34", ink2: "#555a6d", muted: "#707486", coral: "#ed735f", white: "#fff" };
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const W = 1080;
const PAD = 64; // 畫布邊距
const LINE = 4; // 卡片墨線粗細（網頁 2px 的兩倍）
const SHADOW = 12; // 硬陰影位移
const BAR = 14; // 頂部珊瑚色條
const CARD_W = W - PAD * 2 - SHADOW;
const INNER = 56;
const TEXT_W = CARD_W - INNER * 2;
const MAX_ITEMS = 3; // 分類卡片列出的點評數

const dialog = $("#share-card");
const urlInput = $("#share-card-url");
const preview = $("#share-card-preview");
const save = $("#share-card-save");
const imageBtn = $("#share-card-image");
const linkBtn = $("#share-card-link");
const status = $("#share-card-status");
let current = { url: "", title: "", file: null, objectUrl: "" };
let seq = 0; // 連續開不同連結時，只採用最後一次的結果

const sans = () => getComputedStyle(document.body).fontFamily;

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

function loadImg(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img.naturalWidth ? img : null);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

// 依寬度逐字斷行，空白合併成一格；超過 maxLines 時最後一行加刪節號
function wrap(ctx, text, maxW, maxLines) {
  const lines = [];
  let line = "";
  for (const ch of String(text || "").replace(/\s+/g, " ").trim()) {
    if (line && ctx.measureText(line + ch).width > maxW) {
      lines.push(line);
      line = ch === " " ? "" : ch;
    } else {
      line += ch;
    }
  }
  if (line) lines.push(line);
  if (lines.length <= maxLines) return lines;
  const out = lines.slice(0, maxLines);
  let last = out[maxLines - 1];
  while (last && ctx.measureText(last + "…").width > maxW) last = [...last].slice(0, -1).join("");
  out[maxLines - 1] = last + "…";
  return out;
}

// 公開 API 的資料 → 卡片要放的內容；文字與公開頁的標題、副標一致
function content(data) {
  const by = data.nickname ? `${data.nickname} 分享的` : "分享的";
  const rs = data.reviews || [];
  if (data.share.kind === "tag") {
    return {
      eyebrow: `${by}分類`,
      title: `#${data.share.tag}`,
      meta: `共 ${rs.length} 筆點評`,
      ratings: [],
      body: "",
      items: rs.slice(0, MAX_ITEMS).map((r) => ({ title: r.meal ? `${r.title}・${r.meal}` : r.title, price: formatPrice(r.price) })),
      more: rs.length > MAX_ITEMS ? `還有 ${rs.length - MAX_ITEMS} 筆點評` : "",
      tags: [],
    };
  }
  const r = rs[0];
  if (!r) return { eyebrow: `${by}點評`, title: "分享的點評", meta: "", ratings: [], body: "", items: [], more: "", tags: [] };
  return {
    eyebrow: `${by}點評`,
    title: r.title,
    meta: [r.meal, formatPrice(r.price), r.visited_on].filter(Boolean).join(" · "),
    ratings: ratingSummary(r.ratings),
    body: r.body || "",
    items: [],
    more: "",
    tags: r.tags || [],
  };
}

async function loadCover(token, data) {
  const photo = (data.reviews || []).find((r) => r.photos?.length)?.photos[0];
  if (!photo) return null;
  try {
    const { src } = await getJson(`/api/public/shares/${encodeURIComponent(token)}/photos/${Number(photo.id)}`);
    return await loadImg(data.watermark === false ? src : await watermark(src, data.nickname || "吃過筆記"));
  } catch {
    return null; // 封面載不到就畫沒有照片的版本
  }
}

// 標籤 chip 排成最多兩列
function layoutTags(ctx, tags) {
  ctx.font = `700 24px ${sans()}`;
  const chips = [];
  let x = 0;
  let row = 0;
  for (const tag of tags) {
    const label = `#${tag}`;
    const w = Math.min(ctx.measureText(label).width + 32, TEXT_W);
    if (x && x + w > TEXT_W) {
      row += 1;
      x = 0;
    }
    if (row > 1) break;
    chips.push({ label, x, row, w });
    x += w + 12;
  }
  return { chips, height: chips.length ? (chips[chips.length - 1].row + 1) * 60 - 12 : 0 };
}

// 卡片內容由上往下排；draw 為 false 時只量高度，兩次走同一段程式，量與畫不會對不上
function paint(ctx, c, cover, draw) {
  const x0 = PAD;
  const left = x0 + INNER;
  const put = (fn) => draw && fn();
  let y = PAD + BAR;
  ctx.textBaseline = "top";
  ctx.textAlign = "left";

  if (cover) {
    const coverH = Math.round((CARD_W * 630) / 1200);
    put(() => {
      const scale = Math.max(CARD_W / cover.naturalWidth, coverH / cover.naturalHeight);
      const sw = CARD_W / scale;
      const sh = coverH / scale;
      ctx.drawImage(cover, (cover.naturalWidth - sw) / 2, (cover.naturalHeight - sh) / 2, sw, sh, x0, y, CARD_W, coverH);
      ctx.fillStyle = C.ink;
      ctx.fillRect(x0, y + coverH, CARD_W, LINE);
    });
    y += coverH + LINE;
  }
  y += INNER;

  ctx.font = `800 26px ${MONO}`;
  const eyebrow = wrap(ctx, c.eyebrow, TEXT_W, 1)[0] || "";
  put(() => {
    ctx.fillStyle = C.coral;
    ctx.fillText(eyebrow, left, y);
  });
  y += 26 + 24;

  const titleSize = cover ? 56 : 72;
  const titleLH = Math.round(titleSize * 1.25);
  ctx.font = `900 ${titleSize}px ${sans()}`;
  const titleLines = wrap(ctx, c.title, TEXT_W, cover ? 3 : 4);
  put(() => {
    ctx.fillStyle = C.ink;
    titleLines.forEach((line, i) => ctx.fillText(line, left, y + i * titleLH + (titleLH - titleSize) / 2));
  });
  y += titleLines.length * titleLH;

  if (c.meta) {
    y += 20;
    ctx.font = `700 30px ${sans()}`;
    const meta = wrap(ctx, c.meta, TEXT_W, 1)[0];
    put(() => {
      ctx.fillStyle = C.muted;
      ctx.fillText(meta, left, y);
    });
    y += 30;
  }

  if (c.ratings.length) {
    // 兩欄：類別用深灰、心形用珊瑚色
    y += 32;
    const colW = TEXT_W / 2;
    ctx.font = `700 30px ${sans()}`;
    c.ratings.forEach((t, i) => {
      const cut = t.lastIndexOf(" ");
      const label = t.slice(0, cut + 1);
      const x = left + (i % 2) * colW;
      const ry = y + Math.floor(i / 2) * 48;
      put(() => {
        ctx.fillStyle = C.ink2;
        ctx.fillText(label, x, ry);
        ctx.fillStyle = C.coral;
        ctx.fillText(t.slice(cut + 1), x + ctx.measureText(label).width, ry);
      });
    });
    y += Math.ceil(c.ratings.length / 2) * 48 - 12;
  }

  if (c.body) {
    y += 36;
    ctx.font = `500 30px ${sans()}`;
    const lines = wrap(ctx, c.body, TEXT_W - 30, cover ? 4 : 6);
    put(() => {
      ctx.fillStyle = C.coral;
      ctx.fillRect(left, y, 8, lines.length * 48 - 6);
      ctx.fillStyle = C.ink2;
      lines.forEach((line, i) => ctx.fillText(line, left + 30, y + i * 48 + 6));
    });
    y += lines.length * 48;
  }

  if (c.items.length) {
    // 分類：前幾筆店名與價格，一列一條細線
    y += 28;
    for (const it of c.items) {
      put(() => {
        ctx.fillStyle = C.ink;
        ctx.fillRect(left, y, TEXT_W, 2);
      });
      ctx.font = `700 28px ${sans()}`;
      const priceW = ctx.measureText(it.price).width;
      put(() => {
        ctx.fillStyle = C.muted;
        ctx.textAlign = "right";
        ctx.fillText(it.price, left + TEXT_W, y + 22);
        ctx.textAlign = "left";
      });
      ctx.font = `800 34px ${sans()}`;
      const name = wrap(ctx, it.title, TEXT_W - priceW - 32, 1)[0] || "";
      put(() => {
        ctx.fillStyle = C.ink;
        ctx.fillText(name, left, y + 18);
      });
      y += 72;
    }
    if (c.more) {
      y += 8;
      ctx.font = `700 26px ${sans()}`;
      put(() => {
        ctx.fillStyle = C.muted;
        ctx.fillText(c.more, left, y);
      });
      y += 26;
    }
  }

  const tags = layoutTags(ctx, c.tags);
  if (tags.height) {
    y += 36;
    ctx.font = `700 24px ${sans()}`;
    put(() => {
      for (const chip of tags.chips) {
        const cx = left + chip.x;
        const cy = y + chip.row * 60;
        ctx.fillStyle = C.white;
        ctx.fillRect(cx, cy, chip.w, 48);
        ctx.strokeStyle = C.ink;
        ctx.lineWidth = 3;
        ctx.strokeRect(cx + 1.5, cy + 1.5, chip.w - 3, 45);
        ctx.fillStyle = C.ink2;
        ctx.fillText(wrap(ctx, chip.label, chip.w - 32, 1)[0], cx + 16, cy + 12);
      }
    });
    y += tags.height;
  }

  // 頁尾：品牌方塊、站名與網域
  y += 44;
  put(() => {
    ctx.fillStyle = C.ink;
    ctx.fillRect(left, y, TEXT_W, LINE);
  });
  y += LINE + 32;
  put(() => {
    ctx.fillStyle = C.coral;
    ctx.fillRect(left, y, 52, 52);
    ctx.strokeStyle = C.ink;
    ctx.lineWidth = LINE;
    ctx.strokeRect(left + LINE / 2, y + LINE / 2, 52 - LINE, 52 - LINE);
    ctx.fillStyle = C.white;
    ctx.font = `800 26px ${MONO}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("食", left + 26, y + 27);
    ctx.textAlign = "left";
    ctx.fillStyle = C.ink;
    ctx.font = `800 28px ${sans()}`;
    ctx.fillText("吃過筆記", left + 72, y + 27);
    ctx.textAlign = "right";
    ctx.fillStyle = C.muted;
    ctx.font = `700 24px ${MONO}`;
    ctx.fillText(location.host, left + TEXT_W, y + 27);
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
  });
  y += 52 + INNER;
  return y - PAD; // 卡片高度
}

function drawCard(c, cover) {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const cardH = paint(ctx, c, cover, false);
  canvas.width = W;
  canvas.height = PAD + cardH + SHADOW + PAD;

  // 背景方格紙
  ctx.fillStyle = C.paper;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = C.grid;
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let x = 0; x <= canvas.width; x += 48) ctx.moveTo(x + 1, 0), ctx.lineTo(x + 1, canvas.height);
  for (let y = 0; y <= canvas.height; y += 48) ctx.moveTo(0, y + 1), ctx.lineTo(canvas.width, y + 1);
  ctx.stroke();

  // 卡片：硬陰影、底色、墨線外框、珊瑚色頂條（Jerry UI 的 .card 放大兩倍）
  ctx.fillStyle = C.ink;
  ctx.fillRect(PAD + SHADOW, PAD + SHADOW, CARD_W, cardH);
  ctx.fillStyle = C.card;
  ctx.fillRect(PAD, PAD, CARD_W, cardH);
  ctx.fillStyle = C.coral;
  ctx.fillRect(PAD, PAD, CARD_W, BAR);
  paint(ctx, c, cover, true);
  ctx.strokeStyle = C.ink;
  ctx.lineWidth = LINE;
  ctx.strokeRect(PAD + LINE / 2, PAD + LINE / 2, CARD_W - LINE, cardH - LINE);

  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("無法產生圖片"))), "image/jpeg", 0.92));
}

function fileName(title) {
  const name = String(title || "").replace(/[\\/:*?"<>|#\s]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return `${name || "吃過筆記"}-分享卡片.jpg`;
}

function note(text) {
  const p = document.createElement("p");
  p.className = "meta";
  p.textContent = text;
  return p;
}

// 開對話框並產生卡片；data 是公開 API 的回應，公開頁已經載過就直接傳進來，不再抓一次
export async function openShareCard(token, data = null) {
  if (!dialog || typeof dialog.showModal !== "function") return;
  const id = ++seq;
  if (current.objectUrl) URL.revokeObjectURL(current.objectUrl);
  current = { url: `${location.origin}/s/${token}`, title: "", file: null, objectUrl: "" };
  urlInput.value = current.url;
  linkBtn.hidden = !navigator.share;
  save.hidden = true;
  imageBtn.hidden = true;
  setStatus(status, "");
  preview.replaceChildren(note("產生分享卡片中…"));
  if (!dialog.open) dialog.showModal();
  try {
    const d = data || (await getJson(`/api/public/shares/${encodeURIComponent(token)}`));
    const c = content(d);
    const blob = await drawCard(c, await loadCover(token, d));
    if (id !== seq) return;
    current.title = c.title;
    current.file = new File([blob], fileName(c.title), { type: "image/jpeg" });
    current.objectUrl = URL.createObjectURL(blob);
    const img = new Image();
    img.src = current.objectUrl;
    img.alt = `「${c.title}」的分享卡片`;
    preview.replaceChildren(img);
    save.href = current.objectUrl;
    save.download = current.file.name;
    save.hidden = false;
    imageBtn.hidden = !navigator.canShare?.({ files: [current.file] });
  } catch (err) {
    if (id === seq) preview.replaceChildren(note(`無法產生分享卡片：${err.message}`));
  }
}

// 使用者取消系統分享會丟 AbortError，不當成錯誤
async function nativeShare(payload) {
  try {
    await navigator.share(payload);
  } catch (err) {
    if (err.name !== "AbortError") setStatus(status, `無法分享：${err.message}`, "error");
  }
}

if (dialog) {
  $("#share-card-copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(current.url);
    } catch {
      urlInput.select(); // 非 HTTPS 或權限被擋時，選取起來讓使用者自己複製
      setStatus(status, "請手動複製網址", "error");
      return;
    }
    setStatus(status, "已複製網址", "ok");
  });
  urlInput.addEventListener("focus", () => urlInput.select());
  linkBtn.addEventListener("click", () => nativeShare({ title: current.title || document.title, url: current.url }));
  imageBtn.addEventListener("click", () => current.file && nativeShare({ files: [current.file], title: current.title }));
}
