// 統計頁的計算：純函式，不碰 DOM，可直接用 node 測（scripts/stats-calc-test.mjs）。
// 輸入是 GET /api/stats 的 items：{ id, title, price, date: "YYYY-MM-DD", ratings: { key: 1–5 }, tags: [] }。
import { RATING_DEFS } from "./common.js";

const KEYS = RATING_DEFS.map(([k]) => k);
const DAY = 86400000;

// 一筆點評的分數：basis 是 "overall"（有填的評比取平均）或單一評比 key；沒有分數回 null
export function scoreOf(item, basis = "overall") {
  const r = item.ratings || {};
  if (basis !== "overall") return Number.isInteger(r[basis]) ? r[basis] : null;
  const vals = KEYS.map((k) => r[k]).filter(Number.isInteger);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

const mean = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : null);

export function overview(items) {
  const scores = items.map((it) => scoreOf(it)).filter((s) => s !== null);
  const spend = items.reduce((a, it) => a + it.price, 0);
  const categories = RATING_DEFS.map(([key, label]) => {
    const vals = items.map((it) => scoreOf(it, key)).filter((s) => s !== null);
    return { key, label, avg: mean(vals), count: vals.length };
  });
  const tagCount = new Map();
  for (const it of items) for (const t of it.tags || []) tagCount.set(t, (tagCount.get(t) || 0) + 1);
  const tags = [...tagCount].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, "zh-Hant")).slice(0, 8);
  const prices = items.map((it) => it.price);
  return {
    count: items.length, spend, avgPrice: mean(prices), maxPrice: prices.length ? Math.max(...prices) : null, minPrice: prices.length ? Math.min(...prices) : null,
    avgScore: mean(scores), rated: scores.length, categories, tags,
  };
}

// 前 n 名與後 n 名：同分時較近的日期在前；後段排除已在前段的點評，筆數少時兩邊不重複
export function topBottom(items, basis = "overall", n = 5) {
  const scored = items.map((it) => ({ ...it, score: scoreOf(it, basis) })).filter((it) => it.score !== null);
  const newer = (a, b) => b.date.localeCompare(a.date) || b.id - a.id;
  const best = [...scored].sort((a, b) => b.score - a.score || newer(a, b)).slice(0, n);
  const taken = new Set(best.map((it) => it.id));
  const worst = scored.filter((it) => !taken.has(it.id)).sort((a, b) => a.score - b.score || newer(a, b)).slice(0, n);
  return { best, worst, rated: scored.length };
}

// 兩項評比對照：5×5 格（x、y 都是 1–5），只算兩項都有填的點評
export function pairGrid(items, kx, ky) {
  const cells = Array.from({ length: 5 }, () => Array.from({ length: 5 }, () => []));
  let higher = 0;
  let lower = 0;
  let equal = 0;
  const xs = [];
  const ys = [];
  for (const it of items) {
    const x = scoreOf(it, kx);
    const y = scoreOf(it, ky);
    if (x === null || y === null) continue;
    cells[y - 1][x - 1].push(it);
    xs.push(x);
    ys.push(y);
    if (x > y) higher += 1;
    else if (x < y) lower += 1;
    else equal += 1;
  }
  const max = Math.max(0, ...cells.flat().map((c) => c.length));
  return { cells, max, n: xs.length, avgX: mean(xs), avgY: mean(ys), higher, lower, equal };
}

// ---------- 趨勢 ----------
const toMs = (d) => Date.parse(d + "T00:00:00Z");
const toDate = (ms) => new Date(ms).toISOString().slice(0, 10);

// 範圍越長格子越粗：45 天內每日、210 天內每週、10 年內每月，再長每年
export function granularity(from, to) {
  const days = Math.round((toMs(to) - toMs(from)) / DAY) + 1;
  if (days <= 45) return "day";
  if (days <= 210) return "week";
  if (days <= 3660) return "month";
  return "year";
}

export function bucketKey(date, unit) {
  if (unit === "day") return date;
  if (unit === "month") return date.slice(0, 7);
  if (unit === "year") return date.slice(0, 4);
  const ms = toMs(date);
  return toDate(ms - ((new Date(ms).getUTCDay() + 6) % 7) * DAY); // 週一開始
}

function nextKey(key, unit) {
  if (unit === "day") return toDate(toMs(key) + DAY);
  if (unit === "week") return toDate(toMs(key) + 7 * DAY);
  if (unit === "year") return String(Number(key) + 1);
  const [y, m] = key.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

export const UNIT_TEXT = { day: "每日", week: "每週", month: "每月", year: "每年" };

// sameYear：範圍都在同一年時月份只寫「3月」，標籤短一點，手機上不會被切掉
export function bucketLabel(key, unit, sameYear = false) {
  if (unit === "day" || unit === "week") return `${Number(key.slice(5, 7))}/${Number(key.slice(8, 10))}${unit === "week" ? " 起" : ""}`;
  if (unit === "month") return sameYear ? `${Number(key.slice(5, 7))}月` : `${key.slice(0, 4)}/${key.slice(5, 7)}`;
  return `${key} 年`;
}

// from／to 省略時用資料最早與最晚的日期；沒有資料的格子也列出（次數 0），趨勢才不會跳格
export function trend(items, from, to) {
  const dates = items.map((it) => it.date).sort();
  const start = from || dates[0];
  const end = to || dates[dates.length - 1];
  if (!start || !end) return { unit: "day", buckets: [] };
  const unit = granularity(start, end);
  const map = new Map();
  const endKey = bucketKey(end, unit);
  const sameYear = start.slice(0, 4) === end.slice(0, 4);
  for (let k = bucketKey(start, unit); k <= endKey; k = nextKey(k, unit)) map.set(k, { key: k, label: bucketLabel(k, unit, sameYear), count: 0, spend: 0, scores: [] });
  for (const it of items) {
    const b = map.get(bucketKey(it.date, unit));
    if (!b) continue;
    b.count += 1;
    b.spend += it.price;
    const s = scoreOf(it);
    if (s !== null) b.scores.push(s);
  }
  const buckets = [...map.values()].map(({ scores, ...b }) => ({ ...b, avg: mean(scores) }));
  return { unit, buckets };
}
