-- 共用照片檔（R2）的併發與中斷保護，邏輯在 src/media.js：
-- blob_locks：以 R2 key 為單位的租約鎖。上傳去重與回收 R2 檔都要先拿鎖，避免「剛數完沒人引用就被別人引用、接著檔被刪」。
--   expires_at 是毫秒時間戳；持有者中斷時鎖會在到期後自動失效，別人可以接手。
-- blob_gc：待回收的 R2 key。刪照片紀錄與登記待回收在同一個交易裡；上傳在寫 R2 之前先登記。
--   回收時（拿到鎖、確認沒有照片引用）才刪 R2 檔並移除登記；中途失敗就留著，交給排程重試。
CREATE TABLE blob_locks (
  key TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE blob_gc (
  key TEXT PRIMARY KEY,
  queued_at TEXT NOT NULL
);
