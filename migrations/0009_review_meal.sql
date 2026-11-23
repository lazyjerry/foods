-- 點評的「餐點」欄位：吃了什麼，選填。NOT NULL DEFAULT ''：搜尋用 || 串接欄位，NULL 會讓整筆搜不到。
ALTER TABLE reviews ADD COLUMN meal TEXT NOT NULL DEFAULT '';
