// 統計頁：依日期範圍取回點評（GET /api/stats），總覽、前五名、兩項評比對照與趨勢都在這裡畫。
// 計算放在 stats-calc.js（純函式）；這裡只管表單、網址參數與畫面。
import { $, RATING_DEFS, api, bindLogout, esc, formatPrice, setStatus, today } from "./common.js";
import { UNIT_TEXT, overview, pairGrid, scoreOf, topBottom, trend } from "./stats-calc.js";

const LABEL = Object.fromEntries(RATING_DEFS);
const form = $("#range-form");
const fromInput = $("#stats-from");
const toInput = $("#stats-to");
const status = $("#stats-status");
const presets = [...document.querySelectorAll('input[name="range"]')];

let items = [];
let range = { from: "", to: "" };
let seq = 0;

const fmtScore = (s) => (Number.isInteger(s) ? String(s) : s.toFixed(1));
const editUrl = (id) => `/edit?id=${encodeURIComponent(id)}`;

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// 一筆點評的一列：名次或格位、店名、日期與價格、分數、「修改」直接進編輯頁
function rankItem(it, no, score) {
  const meta = [it.date, formatPrice(it.price), ...(it.tags || []).slice(0, 3).map((t) => `#${t}`)].join(" · ");
  return `<li class="app-rank-item">
  <span class="app-rank-no" aria-hidden="true">${no}</span>
  <div class="app-rank-body"><a class="app-rank-title" href="${editUrl(it.id)}">${esc(it.title)}</a><p class="meta app-rank-meta">${esc(meta)}</p></div>
  ${score === null ? "" : `<strong class="app-rank-score">${fmtScore(score)} ♥</strong>`}
  <a class="btn is-sm secondary" href="${editUrl(it.id)}" aria-label="修改「${esc(it.title)}」">修改</a>
</li>`;
}

// ---------- 02 總覽 ----------
function renderOverview() {
  const o = overview(items);
  const values = [String(o.count), formatPrice(o.spend), o.avgPrice === null ? "—" : formatPrice(Math.round(o.avgPrice)),
    o.avgScore === null ? "—" : `${o.avgScore.toFixed(1)} ♥`, `${o.rated} 筆`,
    o.maxPrice === null ? "—" : formatPrice(o.maxPrice), o.minPrice === null ? "—" : formatPrice(o.minPrice)];
  document.querySelectorAll("#kpi dd").forEach((dd, i) => { dd.textContent = values[i]; });

  $("#cat-avg").innerHTML = o.categories.map((c) => {
    const level = c.avg === null ? "" : c.avg >= 4 ? "is-good" : c.avg >= 3 ? "is-mid" : "";
    const pct = c.avg === null ? 0 : Math.round((c.avg / 5) * 100);
    return `<div class="app-meter-item">
  <div class="meter-head"><span>${esc(c.label)}（${c.count} 筆）</span><strong class="${level}">${c.avg === null ? "沒有資料" : `${c.avg.toFixed(1)} ♥`}</strong></div>
  <div class="meter" role="img" aria-label="${esc(c.label)} ${pct}%"><span></span></div>
</div>`;
  }).join("");
  // 量表寬度用 --value（Jerry UI F7 的規格），不寫進 HTML 的 style 屬性
  $("#cat-avg").querySelectorAll(".meter > span").forEach((bar, i) => {
    const avg = o.categories[i].avg;
    bar.style.setProperty("--value", `${avg === null ? 0 : (avg / 5) * 100}%`);
  });

  $("#top-tags").innerHTML = o.tags.length
    ? `<ul class="badges" aria-label="常用分類">${o.tags.map((t) => `<li class="badge"><a class="app-tag-link" href="/?q=${encodeURIComponent(t.tag)}">#${esc(t.tag)} × ${t.count}</a></li>`).join("")}</ul>`
    : '<p class="hint">這段期間的點評沒有分類</p>';
}

// ---------- 03 前五名 ----------
function renderRank() {
  const basis = $("#rank-basis").value;
  const { best, worst, rated } = topBottom(items, basis);
  $("#best-list").innerHTML = best.map((it, i) => rankItem(it, i + 1, it.score)).join("");
  $("#worst-list").innerHTML = worst.map((it, i) => rankItem(it, i + 1, it.score)).join("");
  const name = basis === "overall" ? "綜合評比" : `「${LABEL[basis]}」`;
  if (!rated) setStatus($("#rank-status"), `這段期間沒有填${name}的點評`, "error");
  else if (rated <= 5) setStatus($("#rank-status"), `只有 ${rated} 筆填了${name}，全部列在左邊`, "ok");
  else setStatus($("#rank-status"), `依${name}排序，共 ${rated} 筆；同分時較近的日期在前`, "ok");
}

// ---------- 04 兩項評比對照 ----------
let pickedCell = null;

function renderPair() {
  const kx = $("#pair-x").value;
  const ky = $("#pair-y").value;
  const grid = $("#pair-grid");
  const list = $("#pair-list");
  list.innerHTML = "";
  if (kx === ky) {
    grid.innerHTML = "";
    setStatus($("#pair-status"), "橫軸和縱軸選了同一項，請換一項比較", "error");
    return;
  }
  const g = pairGrid(items, kx, ky);
  const [lx, ly] = [LABEL[kx], LABEL[ky]];
  const head = [1, 2, 3, 4, 5].map((x) => `<th class="app-pair-tick" scope="col">${x}</th>`).join("");
  const rows = [5, 4, 3, 2, 1].map((y) => {
    const cells = [1, 2, 3, 4, 5].map((x) => {
      const n = g.cells[y - 1][x - 1].length;
      const cls = ["app-pair-cell", x === y ? "app-pair-eq" : ""].filter(Boolean).join(" ");
      return `<td><button type="button" class="${cls}" data-x="${x}" data-y="${y}" aria-pressed="false" aria-label="${esc(lx)} ${x}、${esc(ly)} ${y}：${n} 筆"${n ? "" : " disabled"}>${n || ""}</button></td>`;
    }).join("");
    return `<tr><th class="app-pair-tick" scope="row">${y}</th>${cells}</tr>`;
  }).join("");
  grid.innerHTML = `<p class="app-pair-axis">↑ 縱軸：${esc(ly)}（心）</p>
<table class="app-pair"><caption class="visually-hidden">${esc(lx)}與${esc(ly)}的分數分布，每格是筆數</caption>
<thead><tr><th class="app-pair-tick" scope="col"><span class="visually-hidden">${esc(ly)}＼${esc(lx)}</span></th>${head}</tr></thead><tbody>${rows}</tbody></table>
<p class="app-pair-axis is-x">橫軸：${esc(lx)}（心）→　虛線格代表兩項同分</p>`;
  grid.querySelectorAll(".app-pair-cell").forEach((btn) => {
    const n = g.cells[btn.dataset.y - 1][btn.dataset.x - 1].length;
    btn.style.setProperty("--value", g.max ? String(n / g.max) : "0");
  });

  if (!g.n) {
    setStatus($("#pair-status"), `這段期間沒有「${lx}」和「${ly}」都有填的點評，換一組評比試試`, "error");
    return;
  }
  setStatus($("#pair-status"),
    `${lx}平均 ${g.avgX.toFixed(1)}、${ly}平均 ${g.avgY.toFixed(1)}（${g.n} 筆）：${lx}比${ly}高 ${g.higher} 筆、低 ${g.lower} 筆、同分 ${g.equal} 筆。點格子看是哪幾筆`, "ok");

  const show = (x, y) => {
    const hit = g.cells[y - 1][x - 1];
    grid.querySelectorAll(".app-pair-cell").forEach((b) => b.setAttribute("aria-pressed", String(+b.dataset.x === x && +b.dataset.y === y)));
    list.innerHTML = hit.map((it) => rankItem(it, `${x}／${y}`, scoreOf(it))).join("");
    pickedCell = { kx, ky, x, y };
  };
  grid.querySelectorAll(".app-pair-cell").forEach((btn) => btn.addEventListener("click", () => show(+btn.dataset.x, +btn.dataset.y)));
  // 重新載入資料（換日期範圍）時保留同一組評比已選的格子
  if (pickedCell && pickedCell.kx === kx && pickedCell.ky === ky && g.cells[pickedCell.y - 1][pickedCell.x - 1].length) show(pickedCell.x, pickedCell.y);
}

// ---------- 05 趨勢 ----------
const METRIC = {
  count: { value: (b) => b.count, text: (v) => `${v} 次`, short: (v) => String(v), name: "用餐次數" },
  spend: { value: (b) => b.spend, text: (v) => formatPrice(v), short: (v) => (v >= 1000 ? `${+(v / 1000).toFixed(1)}k` : String(v)), name: "花費" },
  avg: { value: (b) => b.avg, text: (v) => (v === null ? "沒有評比" : `${v.toFixed(1)} ♥`), short: (v) => v.toFixed(1), name: "平均心數" },
};

function renderTrend() {
  const metric = METRIC[document.querySelector('input[name="trend-metric"]:checked')?.value || "count"];
  const chart = $("#trend-chart");
  const { unit, buckets } = trend(items, range.from, range.to);
  if (!items.length || !buckets.length) {
    chart.innerHTML = "";
    setStatus($("#trend-status"), "這段期間沒有點評，換個日期範圍試試", "error");
    return;
  }
  const vals = buckets.map(metric.value);
  const max = metric === METRIC.avg ? 5 : Math.max(1, ...vals.map((v) => v || 0));
  // 標籤最多約 12 個（手機 6 個），其他格留空避免擠在一起
  const every = Math.ceil(buckets.length / (matchMedia("(max-width: 760px)").matches ? 6 : 12));
  const showVal = buckets.length <= 16;
  chart.setAttribute("aria-label", `${metric.name}趨勢，${UNIT_TEXT[unit]}一格`);
  chart.innerHTML = buckets.map((b, i) => {
    const v = vals[i];
    const text = metric.text(v);
    return `<li class="app-trend-col${showVal ? " is-labeled" : ""}" tabindex="0" title="${esc(b.label)}：${esc(text)}">
  <span class="app-trend-val" aria-hidden="true">${v ? esc(metric.short(v)) : ""}</span>
  <span class="app-trend-bar" aria-hidden="true"><span class="app-trend-fill"></span></span>
  <span class="app-trend-label" aria-hidden="true">${i % every === 0 ? esc(b.label) : ""}</span>
  <span class="visually-hidden">${esc(b.label)}：${esc(text)}</span>
</li>`;
  }).join("");
  chart.querySelectorAll(".app-trend-fill").forEach((bar, i) => bar.style.setProperty("--value", `${((vals[i] || 0) / max) * 100}%`));

  const valid = buckets.map((b, i) => ({ b, v: vals[i] })).filter((x) => x.v !== null);
  const top = valid.reduce((a, x) => (x.v > a.v ? x : a), valid[0]);
  let summary = `${UNIT_TEXT[unit]}一格，共 ${buckets.length} 格；`;
  if (metric === METRIC.avg) {
    if (!valid.length) summary += "這段期間的點評都沒有評比";
    else {
      const low = valid.reduce((a, x) => (x.v < a.v ? x : a), valid[0]);
      summary += `最高 ${top.b.label}（${metric.text(top.v)}）、最低 ${low.b.label}（${metric.text(low.v)}）；沒有評比的格子留空`;
    }
  } else {
    const total = vals.reduce((a, v) => a + v, 0);
    summary += `最多在 ${top.b.label}（${metric.text(top.v)}），平均每格 ${metric === METRIC.spend ? formatPrice(Math.round(total / buckets.length)) : `${(total / buckets.length).toFixed(1)} 次`}`;
  }
  setStatus($("#trend-status"), summary, "ok");
}

function renderAll() {
  renderOverview();
  renderRank();
  renderPair();
  renderTrend();
}

// ---------- 01 日期範圍 ----------
async function load() {
  const mine = ++seq;
  setStatus(status, "載入中…");
  try {
    const params = new URLSearchParams();
    if (range.from) params.set("from", range.from);
    if (range.to) params.set("to", range.to);
    const qs = params.toString();
    const data = await api("/api/stats" + (qs ? "?" + qs : ""));
    if (mine !== seq) return;
    items = data.items;
    const dates = items.map((it) => it.date).sort();
    const span = range.from || range.to
      ? `${range.from || "最早"} 至 ${range.to || "最新"}`
      : dates.length ? `全部日期（${dates[0]} 至 ${dates[dates.length - 1]}）` : "全部日期";
    if (data.truncated) setStatus(status, `${span}：點評太多，只統計最近 ${items.length} 筆，請縮小日期範圍`, "error");
    else setStatus(status, `${span}：共 ${items.length} 筆點評`, items.length ? "ok" : "error");
    renderAll();
  } catch (err) {
    if (mine === seq) setStatus(status, err.message, "error");
  }
}

function syncUrl() {
  const url = new URL(location.href);
  for (const k of ["from", "to"]) {
    if (range[k]) url.searchParams.set(k, range[k]);
    else url.searchParams.delete(k);
  }
  history.replaceState(null, "", url);
}

function applyPreset(value) {
  range = value === "all" ? { from: "", to: "" } : { from: daysAgo(Number(value) - 1), to: today() };
  fromInput.value = range.from;
  toInput.value = range.to;
  syncUrl();
  load();
}

presets.forEach((r) => r.addEventListener("change", () => r.checked && applyPreset(r.value)));
// 自己改日期就不再是快速範圍，取消選取，避免看起來還在「近 30 天」
for (const el of [fromInput, toInput]) el.addEventListener("input", () => presets.forEach((r) => { r.checked = false; }));

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const from = fromInput.value;
  const to = toInput.value;
  if (from && to && from > to) {
    setStatus(status, "開始日期不能晚於結束日期，請對調後再查", "error");
    return;
  }
  range = { from, to };
  if (!from && !to) presets.forEach((r) => { r.checked = r.value === "all"; });
  syncUrl();
  load();
});

$("#rank-basis").addEventListener("change", renderRank);
$("#pair-x").addEventListener("change", renderPair);
$("#pair-y").addEventListener("change", renderPair);
document.querySelectorAll('input[name="trend-metric"]').forEach((r) => r.addEventListener("change", renderTrend));

function init() {
  bindLogout();
  const q = new URLSearchParams(location.search);
  const valid = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || "") ? v : "");
  range = { from: valid(q.get("from")), to: valid(q.get("to")) };
  fromInput.value = range.from;
  toInput.value = range.to;
  if (range.from || range.to) presets.forEach((r) => { r.checked = false; });
  load();
}

init();
