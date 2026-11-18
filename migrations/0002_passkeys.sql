-- 通行金鑰（WebAuthn）與登入方式設定。
CREATE TABLE passkeys (
  id TEXT PRIMARY KEY,               -- credential ID（base64url）
  public_key TEXT NOT NULL,          -- COSE 公鑰（base64url）
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT NOT NULL DEFAULT '[]',
  name TEXT NOT NULL,
  device_type TEXT,
  backed_up INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);

CREATE TABLE auth_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  password_login INTEGER NOT NULL DEFAULT 1
);
INSERT INTO auth_config (id, password_login) VALUES (1, 1);
