-- 照片檔共用：同一個 R2 檔（內容雜湊 blobs/<sha256>.jpg）或站內插畫（illust/<檔名>）可被多筆照片引用，
-- 所以 r2_key 拿掉 UNIQUE，改成一般索引（刪除時要數還有沒有其他照片引用同一個 key）。
-- SQLite 不能直接拿掉欄位限制，只能重建資料表；沒有其他資料表參照 photos，可以直接換掉。
CREATE TABLE photos_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id INTEGER NOT NULL REFERENCES reviews (id) ON DELETE CASCADE,
  r2_key TEXT NOT NULL,
  caption TEXT NOT NULL DEFAULT '',
  width INTEGER,
  height INTEGER,
  bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
INSERT INTO photos_new (id, review_id, r2_key, caption, width, height, bytes, created_at)
  SELECT id, review_id, r2_key, caption, width, height, bytes, created_at FROM photos;
-- 沿用舊表的 AUTOINCREMENT 序號，已刪照片的 id 不會被重新使用
UPDATE sqlite_sequence SET seq = MAX(seq, IFNULL((SELECT seq FROM sqlite_sequence WHERE name = 'photos'), 0)) WHERE name = 'photos_new';
DROP TABLE photos;
ALTER TABLE photos_new RENAME TO photos;
CREATE INDEX idx_photos_review ON photos (review_id, id);
CREATE INDEX idx_photos_created ON photos (created_at DESC, id DESC);
CREATE INDEX idx_photos_key ON photos (r2_key);
