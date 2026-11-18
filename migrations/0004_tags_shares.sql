-- 分類標籤（ADR 019）與公開分享連結（ADR 020）。
-- tags：JSON 字串陣列，例如 ["拉麵","日式"]；搜尋串進 instr()，依標籤篩選用 json_each。
ALTER TABLE reviews ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';

-- 公開分享：token 是 16 bytes 隨機值的 base64url，/s/<token> 免登入。
-- kind = 'tag' 時用 tag 欄，kind = 'review' 時用 review_id；點評刪除時一併刪掉分享。
CREATE TABLE shares (
  token TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('tag', 'review')),
  tag TEXT,
  review_id INTEGER REFERENCES reviews (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  CHECK ((kind = 'tag' AND tag IS NOT NULL AND review_id IS NULL) OR (kind = 'review' AND review_id IS NOT NULL AND tag IS NULL))
);
CREATE UNIQUE INDEX idx_shares_tag ON shares (tag) WHERE kind = 'tag';
CREATE UNIQUE INDEX idx_shares_review ON shares (review_id) WHERE kind = 'review';
