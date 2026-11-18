-- 儲存空間用量快取（設定頁「用量」卡）。只有一列，由 src/storage.js 定期重算。
-- d1_bytes 取自 D1 查詢回傳的 meta.size_after；r2_bytes／r2_objects 由 R2 list() 逐頁加總。
CREATE TABLE storage_stats (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  d1_bytes INTEGER NOT NULL,
  r2_bytes INTEGER NOT NULL,
  r2_objects INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
