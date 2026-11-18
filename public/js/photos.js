// 照片集：搜尋、分頁、開原圖、下載壓縮檔。
import { $, api, autoLoadMore, bindLogout, esc, formatBytes, mediaUrl, setStatus, tagBadges } from "./common.js";

const PAGE = 24;
const gallery = $("#gallery");
const status = $("#gallery-status");
const more = $("#more-btn");
const input = $("#q");
let shown = 0;
let query = new URLSearchParams(location.search).get("q") || "";

function fileName(p) {
  const base = String(p.title || "photo").replace(/[\\/:*?"<>|]/g, "").trim().slice(0, 60) || "photo";
  return `${base}-${p.id}.jpg`;
}

function tile(p) {
  const meta = [p.caption, p.visited_on, `${formatBytes(p.bytes)}`].filter(Boolean).join(" · ");
  return `<figure class="app-shot">
  <a href="${mediaUrl(p.key)}" target="_blank" rel="noopener"><img src="${mediaUrl(p.key)}" alt="${esc(p.caption || p.title)}" width="${p.width || ""}" height="${p.height || ""}" loading="lazy"></a>
  <figcaption class="app-shot-body">
    <strong><a href="/edit?id=${p.review_id}">${esc(p.title)}</a></strong>
    <span class="meta">${esc(meta)}</span>
    <span class="meta">${esc(p.address)}</span>
    ${tagBadges(p.tags, "/photos")}
    <span class="actions"><a class="btn is-sm" href="${mediaUrl(p.key, true)}" download="${esc(fileName(p))}">下載照片</a><a class="btn is-sm secondary" href="/share?id=${p.review_id}&amp;photo=${p.id}">做分享圖</a></span>
  </figcaption>
</figure>`;
}

// cursor 分頁（ADR 024）；seq 在重設搜尋時加一，丟棄還沒回來的舊請求，避免舊結果插進新清單。
let cursor = null;
let seq = 0;

async function load(reset) {
  if (reset) {
    seq += 1;
    cursor = null;
    shown = 0;
    gallery.innerHTML = "";
    more.hidden = true;
  } else if (more.disabled) return;
  const mine = seq;
  setStatus(status, "載入中…");
  more.disabled = true;
  try {
    const params = new URLSearchParams({ limit: PAGE });
    if (cursor) params.set("cursor", cursor);
    if (query) params.set("q", query);
    const data = await api("/api/photos?" + params);
    if (mine !== seq) return;
    gallery.insertAdjacentHTML("beforeend", data.items.map(tile).join(""));
    shown += data.items.length;
    cursor = data.nextCursor;
    more.hidden = !data.hasMore;
    if (!shown) setStatus(status, query ? `找不到符合「${query}」的照片，換個關鍵字試試` : "還沒有照片，在新增點評時按「拍照」或「從相簿選擇」");
    else setStatus(status, `${query ? `「${query}」的結果：` : ""}已顯示 ${shown} 張${data.hasMore ? "，還有更多" : ""}`, "ok");
    recheck();
  } catch (err) {
    if (mine === seq) setStatus(status, err.message, "error");
  } finally {
    if (mine === seq) more.disabled = false;
  }
}

const recheck = autoLoadMore(more, () => load(false));

$("#search-form").addEventListener("submit", (e) => {
  e.preventDefault();
  query = input.value.trim();
  const url = new URL(location.href);
  if (query) url.searchParams.set("q", query);
  else url.searchParams.delete("q");
  history.replaceState(null, "", url);
  load(true);
});
more.addEventListener("click", () => load(false));
input.value = query;
bindLogout();
load(true);
