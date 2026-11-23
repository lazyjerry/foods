// 點評列表：搜尋、分頁載入；可切換成地圖模式（ADR 029）。
import { $, api, autoLoadMore, bindLogout, bindNavMenus, esc, formatPrice, hearts, mediaUrl, navMenu, ratingSummary, RATING_DEFS, setStatus, tagBadges } from "./common.js";
import { createReviewMap } from "./map.js";

const PAGE = 20;
const list = $("#review-list");
const status = $("#list-status");
const more = $("#more-btn");
const input = $("#q");
let shown = 0;
let query = new URLSearchParams(location.search).get("q") || "";

function item(r) {
  const noPhoto = Math.abs(Number(r.id) || 0) % 5 + 1;
  const cover = r.cover_key
    ? `<a class="app-review-cover" href="/edit?id=${r.id}"><img src="${mediaUrl(r.cover_key)}" alt="${esc(r.title)} 的照片" loading="lazy"></a>`
    : `<a class="app-review-cover" href="/edit?id=${r.id}"><img src="/img/no-photo-${noPhoto}.svg" alt="${esc(r.title)} 尚無照片" loading="lazy"></a>`;
  const meta = [r.meal, formatPrice(r.price), r.visited_on, r.photo_count ? `${r.photo_count} 張照片` : ""].filter(Boolean).join(" · "); // 餐點放第一項，緊接在店名下方
  const rating = ratingSummary(r.ratings);
  return `<article class="app-review">
  ${cover}
  <div class="app-review-body">
    <h3><a href="/edit?id=${r.id}">${esc(r.title)}</a></h3>
    <p class="meta">${esc(meta)}</p>
    ${tagBadges(r.tags, "/")}
    ${r.address ? `<p class="app-review-addr">${esc(r.address)}</p>` : ""}
    ${rating.length ? `<p class="app-review-hearts">${rating.map((t) => `<span>${esc(t)}</span>`).join("")}</p>` : ""}
    ${r.body ? `<p class="app-review-text">${esc(r.body)}</p>` : ""}
    <div class="actions"><a class="btn is-sm secondary" href="/edit?id=${r.id}">編輯</a><a class="btn is-sm secondary" href="/share?id=${r.id}">分享</a>${navMenu(r.lat, r.lng, r.title)}</div>
  </div>
</article>`;
}

// cursor 分頁（ADR 024）；seq 在重設搜尋時加一，丟棄還沒回來的舊請求，避免舊結果插進新清單。
let cursor = null;
let seq = 0;

async function load(reset) {
  if (reset) {
    seq += 1;
    cursor = null;
    shown = 0;
    list.innerHTML = "";
    more.hidden = true;
  } else if (more.disabled) return;
  const mine = seq;
  listQuery = query;
  say("list", "載入中…");
  more.disabled = true;
  try {
    const params = new URLSearchParams({ limit: PAGE });
    if (cursor) params.set("cursor", cursor);
    if (query) params.set("q", query);
    const data = await api("/api/reviews?" + params);
    if (mine !== seq) return;
    list.insertAdjacentHTML("beforeend", data.items.map(item).join(""));
    shown += data.items.length;
    cursor = data.nextCursor;
    more.hidden = !data.hasMore;
    if (!shown) say("list", query ? `找不到符合「${query}」的點評，換個關鍵字試試` : "還沒有點評，按「新增點評」記下第一筆");
    else say("list", `${query ? `「${query}」的結果：` : ""}已顯示 ${shown} 筆${data.hasMore ? "，還有更多" : ""}`, "ok");
    recheck();
  } catch (err) {
    if (mine === seq) {
      listQuery = null;
      say("list", err.message, "error");
    }
  } finally {
    if (mine === seq) more.disabled = false;
  }
}

const recheck = autoLoadMore(more, () => load(false));

// ── 地圖模式（ADR 029） ──
// 圖釘：依評比平均分四級上色，中間寫平均心數；同一座標（約 1 公尺內）的多筆點評合併成一支，右上角標筆數。
// popup：單筆顯示封面、店名、價格與日期、口味與平均、分類、地址、內文摘要與「編輯／分享／導航」；
// 多筆時列出每一筆的店名、價格、日期與平均，導航只放一個。
const views = { list: $("#list-view"), map: $("#map-view") };
const said = { list: ["", ""], map: ["", ""] };
let view = new URLSearchParams(location.search).get("view") === "map" ? "map" : "list";
let listQuery = null; // 列表目前內容對應的關鍵字；null 代表還沒載入或載入失敗，切回來要重載
let mapQuery = null;
let mapReady = null;
let mapSeq = 0;

function say(v, text, state = "") {
  said[v] = [text, state];
  if (v === view) setStatus(status, text, state);
}

function average(ratings) {
  const values = RATING_DEFS.map(([k]) => Number(ratings?.[k])).filter((n) => n >= 1 && n <= 5);
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

const round1 = (n) => Math.round(n * 10) / 10;

// 分級用四捨五入後的值，跟圖釘上顯示的數字一致（圖例見 build_pages.py 的 MAP_LEGEND）
function tier(avg) {
  if (avg === null) return "none";
  if (avg >= 4.5) return "top";
  if (avg >= 3.5) return "good";
  return "low";
}

function placesOf(items) {
  const byKey = new Map();
  for (const r of items) {
    const key = `${Number(r.lat).toFixed(5)},${Number(r.lng).toFixed(5)}`;
    if (!byKey.has(key)) byKey.set(key, { lat: r.lat, lng: r.lng, reviews: [] });
    byKey.get(key).reviews.push(r);
  }
  return [...byKey.values()].map((p) => {
    const avgs = p.reviews.map((r) => average(r.ratings)).filter((a) => a !== null);
    const avg = avgs.length ? round1(avgs.reduce((a, b) => a + b, 0) / avgs.length) : null;
    const label = p.reviews.length > 1 ? `${p.reviews[0].title} 等 ${p.reviews.length} 筆點評` : p.reviews[0].title;
    return { ...p, avg, label, count: p.reviews.length };
  });
}

function pinHtml(place) {
  const n = place.reviews.length;
  const value = place.avg === null ? "–" : place.avg.toFixed(1);
  return `<span class="app-pin app-pin-${tier(place.avg)}"><span class="app-pin-value">${value}</span></span>${n > 1 ? `<span class="app-pin-count">${n}</span>` : ""}`;
}

const coverSrc = (r) => (r.cover_key ? mediaUrl(r.cover_key) : `/img/no-photo-${(Math.abs(Number(r.id) || 0) % 5) + 1}.svg`);
const navBtn = (p) => navMenu(p.lat, p.lng, p.label);

function rateLine(r, short = false) {
  const avg = average(r.ratings);
  const parts = [];
  if (!short && r.ratings?.taste) parts.push(`口味 ${hearts(r.ratings.taste)}`);
  if (avg !== null) parts.push(`平均 ${round1(avg).toFixed(1)}`);
  return parts.join(" · ");
}

function popupTags(tags) {
  if (!tags?.length) return "";
  const items = tags.slice(0, 3).map((t) => `<li class="badge"><a class="app-tag-link" href="/?view=map&amp;q=${encodeURIComponent(t)}">#${esc(t)}</a></li>`);
  return `<ul class="badges" aria-label="分類">${items.join("")}</ul>`;
}

function popupOne(place) {
  const r = place.reviews[0];
  const meta = [r.meal, formatPrice(r.price), r.visited_on].filter(Boolean).join(" · ");
  const rate = rateLine(r);
  return `<div class="app-pop">
  <div class="app-pop-head">
    <img src="${coverSrc(r)}" alt="" loading="lazy">
    <div class="app-pop-title"><h3><a href="/edit?id=${r.id}">${esc(r.title)}</a></h3><div class="app-pop-meta">${esc(meta)}</div></div>
  </div>
  ${rate ? `<div class="app-pop-hearts">${esc(rate)}</div>` : ""}
  ${popupTags(r.tags)}
  ${r.address ? `<div class="app-pop-addr">${esc(r.address)}</div>` : ""}
  ${r.excerpt ? `<div class="app-pop-text">${esc(r.excerpt)}</div>` : ""}
  <div class="app-pop-actions"><a class="btn is-sm secondary" href="/edit?id=${r.id}">編輯</a><a class="btn is-sm secondary" href="/share?id=${r.id}">分享</a>${navBtn(place)}</div>
</div>`;
}

function popupMany(place) {
  const rows = place.reviews.map((r) => {
    const meta = [r.meal, formatPrice(r.price), r.visited_on, rateLine(r, true)].filter(Boolean).join(" · ");
    return `<li><img src="${coverSrc(r)}" alt="" loading="lazy"><div class="app-pop-title"><a href="/edit?id=${r.id}">${esc(r.title)}</a><div class="app-pop-meta">${esc(meta)}</div></div></li>`;
  });
  return `<div class="app-pop">
  <h3>同一地點 ${place.reviews.length} 筆點評</h3>
  ${place.reviews[0].address ? `<div class="app-pop-addr">${esc(place.reviews[0].address)}</div>` : ""}
  <ul class="app-pop-list">${rows.join("")}</ul>
  <div class="app-pop-actions">${navBtn(place)}</div>
</div>`;
}

async function loadMap() {
  const mine = ++mapSeq;
  mapQuery = query;
  say("map", "載入地圖…");
  try {
    mapReady ??= createReviewMap($("#review-map"), { pin: pinHtml, popup: (p) => (p.reviews.length > 1 ? popupMany(p) : popupOne(p)) })
      .catch((err) => {
        mapReady = null;
        throw err;
      });
    const path = "/api/reviews/map" + (query ? "?" + new URLSearchParams({ q: query }) : "");
    const [map, data] = await Promise.all([mapReady, api(path)]);
    if (mine !== mapSeq) return;
    // 載入途中切回列表：容器隱藏時 fitBounds 算不出範圍，等下次切回地圖再畫
    if (view !== "map") {
      mapQuery = null;
      return;
    }
    const places = placesOf(data.items);
    map.show(places);
    const n = data.items.length;
    if (!n) say("map", query ? `找不到符合「${query}」的點評，換個關鍵字試試` : "還沒有點評，按「新增點評」記下第一筆");
    else say("map", `${query ? `「${query}」的結果：` : ""}地圖上 ${n} 筆點評、${places.length} 個地點${data.truncated ? `，只顯示最新 ${n} 筆` : ""}`, "ok");
  } catch (err) {
    if (mine !== mapSeq) return;
    mapQuery = null;
    say("map", err.message, "error");
  }
}

// 依目前檢視載入；關鍵字沒變就沿用已載入的內容（force 時一律重載，例如再按一次搜尋）
function refresh(force = false) {
  if (view === "list") {
    if (force || listQuery !== query) load(true);
    else recheck();
  } else if (force || mapQuery !== query) loadMap();
  else mapReady?.then((m) => m.refresh(), () => {});
}

function setView(v) {
  view = v;
  views.list.hidden = v !== "list";
  views.map.hidden = v !== "map";
  const radio = document.querySelector(`input[name="view"][value="${v}"]`);
  if (radio) radio.checked = true;
  setStatus(status, ...said[v]);
  refresh();
}

document.querySelectorAll('input[name="view"]').forEach((el) =>
  el.addEventListener("change", () => {
    if (!el.checked) return;
    const url = new URL(location.href);
    if (el.value === "map") url.searchParams.set("view", "map");
    else url.searchParams.delete("view");
    history.replaceState(null, "", url);
    setView(el.value);
  }),
);

$("#search-form").addEventListener("submit", (e) => {
  e.preventDefault();
  query = input.value.trim();
  const url = new URL(location.href);
  if (query) url.searchParams.set("q", query);
  else url.searchParams.delete("q");
  history.replaceState(null, "", url);
  refresh(true);
});
more.addEventListener("click", () => load(false));
input.value = query;
bindLogout();
bindNavMenus();
setView(view);
