// 統計頁計算（public/js/stats-calc.js）的單元測試：node scripts/stats-calc-test.mjs
import assert from "node:assert/strict";
import { bucketKey, granularity, overview, pairGrid, scoreOf, topBottom, trend } from "../public/js/stats-calc.js";

const it = (id, date, price, ratings = {}, tags = []) => ({ id, title: `店 ${id}`, date, price, ratings, tags });
const items = [
  it(1, "2026-01-05", 100, { taste: 5, price: 2 }, ["拉麵"]),
  it(2, "2026-01-20", 300, { taste: 3, price: 3 }, ["拉麵", "日式"]),
  it(3, "2026-03-02", 200, { taste: 1, price: 5 }),
  it(4, "2026-03-02", 50),
  it(5, "2026-02-10", 80, { taste: 4 }),
  it(6, "2026-02-11", 120, { taste: 4, service: 2 }),
  it(7, "2026-02-12", 90, { taste: 2, price: 2 }),
];
let n = 0;
const test = (name, fn) => { fn(); n += 1; console.log("通過：" + name); };

test("綜合分數取有填評比的平均，沒填回 null", () => {
  assert.equal(scoreOf(items[0]), 3.5);
  assert.equal(scoreOf(items[3]), null);
  assert.equal(scoreOf(items[0], "price"), 2);
  assert.equal(scoreOf(items[4], "price"), null);
});

test("總覽：筆數、花費、平均、各項評比與常用分類", () => {
  const o = overview(items);
  assert.equal(o.count, 7);
  assert.equal(o.spend, 940);
  assert.equal(o.rated, 6);
  assert.deepEqual([o.maxPrice, o.minPrice], [300, 50]);
  assert.equal(o.categories.find((c) => c.key === "taste").count, 6);
  assert.equal(o.categories.find((c) => c.key === "ambience").avg, null);
  assert.deepEqual(o.tags[0], { tag: "拉麵", count: 2 });
  assert.equal(overview([]).avgPrice, null);
});

test("前五名與後五名不重複，同分時日期較近的在前", () => {
  const { best, worst, rated } = topBottom(items, "taste");
  assert.equal(rated, 6);
  assert.deepEqual(best.map((x) => x.id), [1, 6, 5, 2, 7]); // 6、5 同為 4 分，6 的日期較近
  assert.deepEqual(worst.map((x) => x.id), [3]);
  const few = topBottom(items.slice(0, 3));
  assert.equal(few.best.length, 3);
  assert.equal(few.worst.length, 0);
});

test("兩項評比對照只算兩項都有填的點評", () => {
  const g = pairGrid(items, "taste", "price");
  assert.equal(g.n, 4);
  assert.equal(g.cells[1][4][0].id, 1); // 價位 2、口味 5
  assert.deepEqual([g.higher, g.lower, g.equal], [1, 1, 2]);
  assert.equal(g.max, 1);
});

test("趨勢的格子粗細與週起始日", () => {
  assert.equal(granularity("2026-01-01", "2026-02-14"), "day");
  assert.equal(granularity("2026-01-01", "2026-06-01"), "week");
  assert.equal(granularity("2020-01-01", "2026-06-01"), "month");
  assert.equal(granularity("2010-01-01", "2026-06-01"), "year");
  assert.equal(bucketKey("2026-11-18", "week"), "2026-11-16"); // 週三 → 週一
  assert.equal(bucketKey("2026-11-16", "week"), "2026-11-16");
  assert.equal(bucketKey("2026-11-22", "week"), "2026-11-16"); // 週日歸前一個週一
});

test("趨勢補齊沒有資料的格子，跨年月份正確", () => {
  const t = trend(items, "2025-11-01", "2026-03-31");
  assert.equal(t.unit, "week");
  const m = trend(items, "2025-06-01", "2026-03-31");
  assert.equal(m.unit, "month");
  assert.deepEqual(m.buckets.map((b) => b.key), ["2025-06", "2025-07", "2025-08", "2025-09", "2025-10", "2025-11", "2025-12", "2026-01", "2026-02", "2026-03"]);
  const jan = m.buckets.find((b) => b.key === "2026-01");
  assert.deepEqual([jan.count, jan.spend, jan.avg], [2, 400, 3.25]);
  assert.equal(m.buckets[0].avg, null);
  assert.deepEqual([m.buckets[0].label, trend(items, "2026-01-01", "2026-12-31").buckets[2].label], ["2025/06", "3月"]);
  const all = trend(items); // 不給範圍時用資料最早到最晚
  assert.equal(all.buckets[0].key, bucketKey("2026-01-05", all.unit));
  assert.deepEqual(trend([], "", ""), { unit: "day", buckets: [] });
});

console.log(`統計計算測試全部通過：${n} 項`);
