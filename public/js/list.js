// 點評列表：搜尋、分頁載入。
import { $, api, autoLoadMore, bindLogout, esc, formatPrice, mediaUrl, ratingSummary, setStatus, tagBadges } from "./common.js";

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
  const meta = [formatPrice(r.price), r.visited_on, r.photo_count ? `${r.photo_count} 張照片` : ""].filter(Boolean).join(" · ");
  const rating = ratingSummary(r.ratings);
  return `<article class="app-review">
  ${cover}
  <div class="app-review-body">
    <h3><a href="/edit?id=${r.id}">${esc(r.title)}</a></h3>
    <p class="meta">${esc(meta)}</p>
    ${tagBadges(r.tags, "/")}
    <p class="app-review-addr">${esc(r.address)}</p>
    ${rating.length ? `<p class="app-review-hearts">${rating.map(esc).join("　")}</p>` : ""}
    ${r.body ? `<p class="app-review-text">${esc(r.body)}</p>` : ""}
    <div class="actions"><a class="btn is-sm secondary" href="/edit?id=${r.id}">編輯</a><a class="btn is-sm secondary" href="/share?id=${r.id}">分享</a></div>
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
  setStatus(status, "載入中…");
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
    if (!shown) setStatus(status, query ? `找不到符合「${query}」的點評，換個關鍵字試試` : "還沒有點評，按「新增點評」記下第一筆");
    else setStatus(status, `${query ? `「${query}」的結果：` : ""}已顯示 ${shown} 筆${data.hasMore ? "，還有更多" : ""}`, "ok");
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
