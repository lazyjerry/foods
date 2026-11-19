# 專案規範

## 插畫檔案（`public/img/illustrations/`）

插畫是永久檔：一個檔名一旦進了版控，就保持原名、原位置永遠留著。新增插畫一律用新的檔名。

- **為什麼**：照片紀錄以 `illust/<檔名>` 直接引用站內原檔，不在 R2 另存副本（`src/media.js`）。檔案改名或刪掉，所有引用它的照片都會破圖，而且沒有備份可救。
- **新增**：檔名符合 `src/media.js` 的 `ILLUST_KEY`（目前是 `food-NN.jpg`、`meal-NN.jpg`，編號接在最後一號之後），再加進 `scripts/build_pages.py` 的 `ILLUSTRATIONS`。
- **不想再讓人選某張**：只從 `ILLUSTRATIONS` 拿掉，選擇插畫的對話框就不會再出現它；檔案留在原處，舊照片照常顯示。
- **重畫某張**：換掉的內容會直接套用到所有引用它的舊點評。要保留舊的樣子，就用新檔名另存一張。
- **ILLUST_KEY 只能放寬**：改得更嚴，會讓既有的 `illust/` key 被當成無效、讀不到。
- **檢查**：`python3 scripts/check_illustrations.py`（`scripts/check.sh` 會跑）比對 git 歷史，曾經進過版控的插畫檔名少了任何一個，或有檔名不符合 `ILLUST_KEY`，就失敗。
