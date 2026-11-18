-- 帳號（ADR 018）。密碼以 PBKDF2-SHA256 加鹽雜湊保存（src/password.js），不存明文。
-- password_hash 為 NULL：尚未設定密碼，登入時改比對 Worker secret APP_PASSWORD，成功後立即寫入雜湊。
--   用途是舊站平移（既有密碼照常能登入）與救援（把雜湊清成 NULL 即可用 APP_PASSWORD 登入）。
-- session_version：改密碼時遞增，簽進 session cookie，其他裝置的登入隨之失效。
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT,
  session_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  password_changed_at TEXT
);
INSERT INTO users (id, username, created_at) VALUES (1, 'admin', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- 通行金鑰歸屬帳號；既有的金鑰都歸給第一個帳號。
-- SQLite 的 ADD COLUMN 在外鍵啟用時不能帶非 NULL 預設值的 REFERENCES，所以不宣告外鍵。
ALTER TABLE passkeys ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1;
CREATE INDEX idx_passkeys_user ON passkeys (user_id);
