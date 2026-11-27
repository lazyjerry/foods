// 編輯頁草稿：還沒儲存的輸入暫存在這台裝置的 IndexedDB，重開編輯頁時還原（不送到伺服器）。
// 草稿一筆點評一份（新點評是 "new"、既有點評是 "review-<id>"），表單內容存在 drafts；
// 待上傳的照片檔另存在 blobs，加入照片時寫一次，草稿本身每次只寫小小的 JSON。
// IndexedDB 不能用（無痕模式、空間不足）時一律安靜略過，編輯頁照常運作，只是沒有草稿。

const DB_NAME = "foods-draft";
const DRAFTS = "drafts";
const BLOBS = "blobs";

// 草稿的照片清單套回伺服器目前的照片：
// 伺服器照片依伺服器順序，草稿改過的說明、標記移除套上去；草稿裡有、伺服器已經沒有的丟掉；
// 待上傳的新照片依草稿順序接在最後（blob 由呼叫端依 blobId 取回）。
export function restorePhotos(serverPhotos, draftPhotos) {
  const edits = new Map(draftPhotos.filter((p) => p.kind === "existing").map((p) => [p.id, p]));
  const existing = serverPhotos.map((p) => {
    const d = edits.get(p.id);
    return {
      kind: "existing", id: p.id, key: p.key, width: p.width, height: p.height, bytes: p.bytes,
      caption: d ? d.caption : p.caption, origCaption: p.caption, removed: Boolean(d?.removed),
    };
  });
  const fresh = draftPhotos.filter((p) => p.kind === "new").map((p) => ({ ...p }));
  return [...existing, ...fresh];
}

// 草稿建立之後，這筆點評在別處（別的裝置、別的分頁）又被儲存過
export function isStale(draft, review) {
  return Boolean(review && draft.base && review.updated_at !== draft.base);
}

let dbPromise;
function openDb() {
  dbPromise ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(DRAFTS);
      req.result.createObjectStore(BLOBS);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

// 在一個交易裡跑 fn(stores)，交易完成後回傳 fn 的結果；任何錯誤回 fallback
async function run(mode, fn, fallback = null) {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction([DRAFTS, BLOBS], mode);
      let out;
      tx.oncomplete = () => resolve(out);
      tx.onerror = tx.onabort = () => reject(tx.error);
      out = fn({ drafts: tx.objectStore(DRAFTS), blobs: tx.objectStore(BLOBS) });
    });
  } catch {
    return fallback;
  }
}

const result = (req) => {
  const box = {};
  req.onsuccess = () => { box.value = req.result; };
  return box;
};

export async function loadDraft(key) {
  const box = await run("readonly", (s) => result(s.drafts.get(key)));
  return box?.value || null;
}

export async function getBlob(id) {
  const box = await run("readonly", (s) => result(s.blobs.get(id)));
  return box?.value || null;
}

// 回傳是否寫入成功
export async function saveDraft(key, record) {
  return run("readwrite", (s) => { s.drafts.put(record, key); return true; }, false);
}

export async function putBlob(id, blob) {
  return run("readwrite", (s) => { s.blobs.put(blob, id); return true; }, false);
}

export async function deleteBlob(id) {
  return run("readwrite", (s) => { s.blobs.delete(id); return true; }, false);
}

// 刪掉沒有任何草稿引用的照片檔（加入照片後草稿還沒寫就關頁、草稿被刪掉之後留下的）
export async function sweepBlobs() {
  const box = await run("readonly", (s) => ({ drafts: result(s.drafts.getAll()), blobs: result(s.blobs.getAllKeys()) }));
  if (!box) return;
  const used = new Set(box.drafts.value.flatMap((d) => d.photos.map((p) => p.blobId).filter(Boolean)));
  const orphans = box.blobs.value.filter((id) => !used.has(id));
  if (orphans.length) await run("readwrite", (s) => { orphans.forEach((id) => s.blobs.delete(id)); });
}

export async function clearDraft(key) {
  await run("readwrite", (s) => { s.drafts.delete(key); });
  await sweepBlobs();
}

// 登出時整個清掉，換人登入不會看到上一個人的草稿。先關掉這頁開著的連線，不然刪除會被擋住；
// 別的分頁還開著編輯頁時刪除會等到那頁關掉才生效，這裡不等
export async function clearAllDrafts() {
  try {
    if (dbPromise) (await dbPromise.catch(() => null))?.close();
    dbPromise = null;
    await new Promise((resolve) => {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = req.onerror = req.onblocked = resolve;
    });
  } catch {
    // 不能用 IndexedDB 就沒有草稿可清
  }
}
