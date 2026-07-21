# Repository agent instructions

## 產品承諾

這是阿瑋許願的獨立網頁版國語／台語朗讀工具。任何介面、文件與錯誤訊息都必須誠實區分：

- 裝置提供的台灣國語聲音（`zh-TW`）
- 裝置真的提供的台語聲音（`nan-TW` 或明確標示為 Taiwanese Hokkien）
- 經台語轉寫與 TTS 後端產生的台語
- 示範／測試音訊

禁止用國語聲音冒充台語，禁止把「網頁殼可離線」寫成「任意台語可離線合成」。

## 不可破壞的規則

- 上傳文件預設只在瀏覽器解析；不得把原始檔、檔名或全文偷偷傳到後端。
- 只有使用者按下朗讀後，才能傳送當下需要合成的文字分段。
- 遠端 endpoint 必須是 HTTPS；HTTP 只允許 `localhost` 或 `127.0.0.1`。
- 存取憑證只放本次分頁的 `sessionStorage`，不得寫進 bundle、URL、log、Service Worker cache 或持久儲存。
- 長輩介面的主要操作不得只靠圖示、顏色、滑鼠 hover 或小型觸控目標。
- Service Worker 更新不得刪除使用者明確保存的語音；App shell cache 與音訊 IndexedDB 是兩套生命週期。
- 第三方模型、辭典與音訊不因本 repo 的 MIT License 而改變授權；新增資產時同步更新 `THIRD_PARTY_NOTICES.md`。

## 完成條件

- `npm test`
- `npm run build`
- 用鍵盤完成：輸入／匯入 → 選語言 → 開始 → 暫停／繼續 → 停止。
- 驗證首次載入、安裝後斷網重開、低速逐段播放與已存語音重播。
- 台語路徑失敗時顯示錯誤，不得靜默改用國語。
- README、產品規格、隱私與畫面能力說明一致。

