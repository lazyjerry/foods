-- 點評、照片中繼資料與設定。照片本體在 R2（只存壓縮後的 JPEG）。
CREATE TABLE reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  price INTEGER NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  address TEXT NOT NULL,
  ratings TEXT NOT NULL DEFAULT '{}',
  visited_on TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_reviews_created ON reviews (created_at DESC, id DESC);

CREATE TABLE photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id INTEGER NOT NULL REFERENCES reviews (id) ON DELETE CASCADE,
  r2_key TEXT NOT NULL UNIQUE,
  caption TEXT NOT NULL DEFAULT '',
  width INTEGER,
  height INTEGER,
  bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_photos_review ON photos (review_id, id);
CREATE INDEX idx_photos_created ON photos (created_at DESC, id DESC);

CREATE TABLE settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
