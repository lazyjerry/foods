// MCP 閘道串接（src/mcp.js 的 FoodsRpc）的測試：node scripts/mcp-test.mjs
// 用 wrangler dev 同時跑兩個 Worker：driver（第一個設定檔，接收測試請求）經真的服務綁定（entrypoint FoodsRpc）
// 走 RPC 呼叫 food-review，跟閘道呼叫的方式相同。D1 狀態放在暫存目錄、套用全部 migrations，不動本機開發資料。
// 地址查詢會連外，只測參數檢查。
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "foods-mcp-test-"));
const port = 8900 + Math.floor(Math.random() * 90);
const wrangler = join(root, "node_modules/.bin/wrangler");

const DRIVER = `
export default {
  async fetch(req, env) {
    const { op, tool, args, caller } = await req.json();
    try {
      const out = op === "describe" ? await env.FOODS.describe() : await env.FOODS.call(tool, args, caller);
      return Response.json({ out });
    } catch (err) {
      return Response.json({ thrown: String(err) });
    }
  },
};`;
writeFileSync(join(tmp, "driver.js"), DRIVER);
writeFileSync(join(tmp, "driver.jsonc"), JSON.stringify({
  name: "foods-mcp-test-driver",
  main: "driver.js",
  compatibility_date: "2026-11-01",
  services: [{ binding: "FOODS", service: "food-review", entrypoint: "FoodsRpc" }],
}));

const migrate = spawnSync(wrangler, ["d1", "migrations", "apply", "food-review-db", "--local", "--persist-to", tmp], { cwd: root, encoding: "utf8", env: { ...process.env, CI: "1" } });
if (migrate.status !== 0) {
  console.error(migrate.stdout, migrate.stderr);
  rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
}
const dev = spawn(wrangler, ["dev", "-c", join(tmp, "driver.jsonc"), "-c", "wrangler.jsonc", "--persist-to", tmp, "--ip", "127.0.0.1", "--port", String(port), "--show-interactive-dev-session=false"], { cwd: root, env: { ...process.env, CI: "1" }, stdio: ["ignore", "pipe", "pipe"] });
let devLog = "";
dev.stdout.on("data", (b) => (devLog += b));
dev.stderr.on("data", (b) => (devLog += b));

async function waitReady() {
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, { method: "POST", body: JSON.stringify({ op: "describe" }) });
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("wrangler dev 沒有啟動：\n" + devLog.slice(-2000));
}

let failed = 0;
let n = 0;
async function test(name, fn) {
  try {
    await fn();
    n += 1;
    console.log("通過：" + name);
  } catch (err) {
    failed += 1;
    console.log("失敗：" + name + "\n  " + String(err.stack || err).split("\n").slice(0, 4).join("\n  "));
  }
}

async function rpc(body) {
  const res = await fetch(`http://127.0.0.1:${port}/`, { method: "POST", body: JSON.stringify(body) });
  const json = await res.json();
  if (json.thrown) throw new Error("RPC 丟出例外：" + json.thrown);
  return json.out;
}
const describe = () => rpc({ op: "describe" });
const call = (tool, args, caller = { client: "test-client" }) => rpc({ op: "call", tool, args, caller });
async function ok(tool, args) {
  const r = await call(tool, args);
  assert.equal(r.ok, true, `${tool} 應成功，實際：${JSON.stringify(r)}`);
  return r.data;
}
async function fail(tool, args, pattern) {
  const r = await call(tool, args);
  assert.equal(r.ok, false, `${tool} 應失敗，實際：${JSON.stringify(r)}`);
  assert.match(r.message, pattern);
  return r.message;
}

try {
  await waitReady();

  const base = { title: "阿宗麵線", price: 75, lat: 25.044, lng: 121.507, address: "台北市萬華區峨眉街8號", meal: "大腸麵線", body: "湯頭濃", tags: ["小吃", "麵線"], ratings: { taste: 4, price: 5 }, visited_on: "2026-10-01" };
  let created;

  await test("describe()：服務名稱、範圍與 tool 前綴、每個 tool 的範圍都宣告過", async () => {
    const m = await describe();
    assert.equal(typeof m.label, "string");
    assert.ok(m.label.length > 0 && m.label.length <= 60);
    const declared = new Set(m.scopes.map((s) => s.scope));
    for (const s of m.scopes) {
      assert.match(s.scope, /^foods:[a-z0-9_-]+$/);
      assert.equal(typeof s.label, "string");
      assert.equal(typeof s.description, "string");
      assert.equal(typeof s.defaultChecked, "boolean");
    }
    assert.ok(m.tools.length > 0);
    for (const t of m.tools) {
      assert.match(t.name, /^foods_[a-z0-9_]+$/);
      assert.ok(t.title && t.description.length <= 2000, t.name);
      assert.equal(t.inputSchema.type, "object", t.name);
      assert.equal(t.inputSchema.additionalProperties, false, t.name);
      for (const [k, p] of Object.entries(t.inputSchema.properties)) assert.ok(p.description, `${t.name}.${k} 缺 description`);
      assert.ok(t.scopes.length > 0, t.name);
      for (const s of t.scopes) assert.ok(declared.has(s), `${t.name} 用到沒宣告的範圍 ${s}`);
      if (t.annotations.readOnlyHint) assert.ok(t.scopes.every((s) => s !== "foods:write"), `${t.name} 唯讀卻要 write 範圍`);
    }
    assert.deepEqual(m.tools.map((t) => t.name).sort(), ["foods_create", "foods_geocode", "foods_get", "foods_search", "foods_stats", "foods_tags", "foods_update"]);
    assert.equal(m.scopes.find((s) => s.scope === "foods:read").defaultChecked, true);
    assert.equal(m.scopes.find((s) => s.scope === "foods:write").defaultChecked, false);
    assert.equal(m.tools.find((t) => t.name === "foods_geocode").annotations.openWorldHint, true);
  });

  await test("describe() 每次回傳相同內容", async () => {
    assert.deepEqual(await describe(), await describe());
  });

  await test("foods_create：成功新增，回傳的點評帶 id、不帶照片 key", async () => {
    const data = await ok("foods_create", base);
    created = data.review;
    assert.ok(Number.isInteger(created.id));
    assert.equal(created.title, "阿宗麵線");
    assert.deepEqual(created.tags, ["小吃", "麵線"]);
    assert.deepEqual(created.photos, []);
    assert.equal("cover_key" in created, false);
  });

  await test("foods_create：缺必填、去掉空白後為空、超過上限都回說明文字", async () => {
    await fail("foods_create", { price: 10, lat: 25, lng: 121 }, /請輸入餐廳/);
    await fail("foods_create", { ...base, title: "   " }, /請輸入餐廳/);
    await fail("foods_create", { ...base, price: -1 }, /價格/);
    await fail("foods_create", { ...base, lat: 91 }, /緯度/);
    await fail("foods_create", { ...base, visited_on: "2026/10/01" }, /YYYY-MM-DD/);
    await fail("foods_create", { ...base, tags: ["有 空白"] }, /不能含空白/);
    await fail("foods_create", { ...base, title: "店".repeat(257) }, /最多 256 字/);
  });

  await test("foods_create：參數型別不對", async () => {
    await fail("foods_create", "not-an-object", /參數要是物件/);
    await fail("foods_create", [base], /參數要是物件/);
    await fail("foods_create", { ...base, tags: "小吃" }, /分類格式錯誤/);
  });

  await test("foods_get：讀得到、找不到、id 不合法", async () => {
    const data = await ok("foods_get", { id: created.id });
    assert.equal(Object.keys(data)[0], "notice");
    assert.equal(data.review.body, "湯頭濃");
    await fail("foods_get", { id: 999999 }, /找不到這筆點評/);
    await fail("foods_get", { id: "abc" }, /編號格式錯誤/);
    await fail("foods_get", {}, /編號格式錯誤/);
  });

  await test("foods_update：只改有帶的欄位，其餘沿用原值", async () => {
    const data = await ok("foods_update", { id: created.id, meal: "蚵仔麵線", ratings: { taste: 5 } });
    assert.equal(data.review.meal, "蚵仔麵線");
    assert.equal(data.review.body, "湯頭濃");
    assert.equal(data.review.price, 75);
    assert.deepEqual(data.review.ratings, { taste: 5 });
    assert.deepEqual(data.review.tags, ["小吃", "麵線"]);
    assert.equal(data.review.visited_on, "2026-10-01");
  });

  await test("foods_update：找不到、改成不合法的值", async () => {
    await fail("foods_update", { id: 999999, meal: "x" }, /找不到這筆點評/);
    await fail("foods_update", { id: created.id, title: "" }, /請輸入餐廳/);
    await fail("foods_update", { meal: "x" }, /編號格式錯誤/);
  });

  await test("foods_search：關鍵字、分頁、notice 在最前面", async () => {
    await ok("foods_create", { ...base, title: "鼎泰豐", meal: "小籠包", tags: ["點心"] });
    await ok("foods_create", { ...base, title: "林東芳牛肉麵", meal: "牛肉麵", tags: [] });
    const all = await ok("foods_search", {});
    assert.equal(Object.keys(all)[0], "notice");
    assert.equal(all.items.length, 3);
    assert.equal(all.items.some((r) => "cover_key" in r), false);
    assert.equal(all.items[0].photo_count, 0);
    const hit = await ok("foods_search", { q: "小籠包" });
    assert.deepEqual(hit.items.map((r) => r.title), ["鼎泰豐"]);
    const p1 = await ok("foods_search", { limit: 2 });
    assert.equal(p1.items.length, 2);
    assert.equal(p1.hasMore, true);
    const p2 = await ok("foods_search", { limit: 2, cursor: p1.nextCursor });
    assert.equal(p2.items.length, 1);
    assert.equal(p2.hasMore, false);
  });

  await test("foods_search：參數不合法", async () => {
    await fail("foods_search", { cursor: "bad" }, /分頁位置格式不正確/);
    await fail("foods_search", { limit: 0 }, /limit 要是 1 到 50 的整數/);
    await fail("foods_search", { limit: 51 }, /limit/);
    await fail("foods_search", { q: 123 }, /q 要是字串/);
  });

  await test("foods_tags：分類與筆數", async () => {
    const data = await ok("foods_tags", {});
    assert.deepEqual(data.tags.map((t) => t.tag).sort(), ["小吃", "點心", "麵線"].sort());
    assert.deepEqual(data.tags.find((t) => t.tag === "小吃"), { tag: "小吃", count: 1 });
  });

  await test("foods_stats：日期範圍與錯誤", async () => {
    const all = await ok("foods_stats", {});
    assert.equal(all.items.length, 3);
    assert.equal(all.truncated, false);
    const none = await ok("foods_stats", { from: "2026-10-02" });
    assert.equal(none.items.length, 0);
    await fail("foods_stats", { from: "2026-10-05", to: "2026-10-01" }, /開始日期不能晚於結束日期/);
    await fail("foods_stats", { from: "10/01" }, /YYYY-MM-DD/);
  });

  await test("foods_geocode：空白地址不連外、直接回說明文字", async () => {
    await fail("foods_geocode", { q: "  " }, /請先輸入地址/);
    await fail("foods_geocode", { q: "路".repeat(201) }, /最多 200 字/);
  });

  await test("不認得的 tool 名稱與沒帶 caller", async () => {
    await fail("foods_delete", { id: created.id }, /沒有 foods_delete 這個 tool/);
    await fail("constructor", {}, /沒有 constructor 這個 tool/);
    const r = await rpc({ op: "call", tool: "foods_tags", args: {} });
    assert.equal(r.ok, true);
  });
} finally {
  dev.kill("SIGTERM");
  await new Promise((r) => (dev.exitCode !== null ? r() : dev.once("exit", r)));
  rmSync(tmp, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} 項失敗、${n} 項通過` : `\n全部 ${n} 項通過`);
process.exit(failed ? 1 : 0);
