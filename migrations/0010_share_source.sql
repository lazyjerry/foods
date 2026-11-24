-- 分享連結的建立來源：'web' 是分享頁「分享網頁」頁籤建的，'image' 是分享圖打開「分享網頁網址」時建的。
-- 既有連結無從分辨，一律當成 'web'。同一筆點評的連結是冪等共用的，來源記第一次建立的那一邊。
ALTER TABLE shares ADD COLUMN source TEXT NOT NULL DEFAULT 'web' CHECK (source IN ('web', 'image'));
