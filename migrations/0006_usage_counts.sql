-- 設定頁「用量」卡加上「今日（UTC）」的 D1 讀寫列數與 Worker 請求數，來源是 Cloudflare GraphQL Analytics API（帳號合計）。
-- 沒設定 CF_ACCOUNT_ID／CF_ANALYTICS_TOKEN 或查詢失敗時存 NULL，用量卡顯示「—」。
ALTER TABLE storage_stats ADD COLUMN usage_date TEXT;
ALTER TABLE storage_stats ADD COLUMN d1_rows_read INTEGER;
ALTER TABLE storage_stats ADD COLUMN d1_rows_written INTEGER;
ALTER TABLE storage_stats ADD COLUMN worker_requests INTEGER;
