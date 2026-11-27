// 編輯頁草稿（public/js/draft.js）的單元測試：node scripts/draft-test.mjs
import assert from "node:assert/strict";
import { isStale, restorePhotos } from "../public/js/draft.js";

let n = 0;
const test = (name, fn) => { fn(); n += 1; console.log("通過：" + name); };

const server = [
  { id: 1, key: "a.jpg", width: 1600, height: 1067, bytes: 200000, caption: "招牌" },
  { id: 2, key: "b.jpg", width: 1200, height: 1600, bytes: 150000, caption: "" },
  { id: 3, key: "c.jpg", width: 1600, height: 900, bytes: 180000, caption: "門口" },
];

test("草稿裡改過的說明與標記移除套回伺服器照片，沒寫到的照片原樣保留", () => {
  const out = restorePhotos(server, [
    { kind: "existing", id: 1, caption: "招牌叉燒", removed: false },
    { kind: "existing", id: 2, caption: "", removed: true },
  ]);
  assert.deepEqual(out.map((p) => [p.kind, p.id, p.caption, p.origCaption, Boolean(p.removed)]), [
    ["existing", 1, "招牌叉燒", "招牌", false],
    ["existing", 2, "", "", true],
    ["existing", 3, "門口", "門口", false],
  ]);
  assert.equal(out[0].key, "a.jpg");
});

test("伺服器已經沒有的照片從草稿丟掉，新照片依草稿順序接在最後", () => {
  const out = restorePhotos(server.slice(1), [
    { kind: "new", blobId: "x", width: 800, height: 600, bytes: 9000, caption: "第一張" },
    { kind: "existing", id: 1, caption: "已被刪", removed: false },
    { kind: "new", blobId: "y", illust: "food-01.jpg", width: 1024, height: 1024, bytes: 8000, caption: "" },
  ]);
  assert.deepEqual(out.map((p) => p.kind === "new" ? ["new", p.blobId, p.illust || ""] : ["existing", p.id]), [
    ["existing", 2],
    ["existing", 3],
    ["new", "x", ""],
    ["new", "y", "food-01.jpg"],
  ]);
  assert.equal(out[2].caption, "第一張");
});

test("新點評沒有伺服器照片：只還原草稿裡的新照片", () => {
  const out = restorePhotos([], [{ kind: "new", blobId: "x", width: 1, height: 1, bytes: 1, caption: "" }]);
  assert.deepEqual(out.map((p) => p.blobId), ["x"]);
});

test("草稿之後點評在別處改過才算過期；新點評沒有過期", () => {
  assert.equal(isStale({ base: "2026-11-01T00:00:00Z" }, { updated_at: "2026-11-01T00:00:00Z" }), false);
  assert.equal(isStale({ base: "2026-11-01T00:00:00Z" }, { updated_at: "2026-11-02T00:00:00Z" }), true);
  assert.equal(isStale({ base: null }, null), false);
});

console.log(`草稿單元測試全部通過（${n} 項）`);
