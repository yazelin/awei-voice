# 阿瑋好聲音

阿瑋好聲音是願望池 #26 的獨立網頁版朗讀工具：貼上文字或匯入文件，以大字介面聽台灣國語，或把華語轉成實驗性台語後朗讀。

- 線上網頁：<https://yazelin.github.io/awei-voice/>
- 線上語音服務：`https://ching-tech.ddns.net/awei-voice`

線上語音服務已接上網頁，第一次使用可不填邀請碼，但匿名使用有共用限額。它不是商用 SLA 服務，也尚未完成台語母語者品質驗收。

## 實際使用

1. 開啟線上網頁，輸入文字，或匯入 TXT、Markdown、文字型 PDF、DOCX。
2. 選擇「台灣國語」或「台語 Beta」。
3. 台灣國語會優先偵測裝置的 `zh-TW` 聲音；找不到時可改用「省流量服務」的線上備援。
4. 台語請先選輸入方式：
   - **華語翻成台語**：輸入一般華語漢字，服務會先轉成 POJ 台語稿，再產生台語音訊。
   - **POJ 調符直接朗讀**：輸入已經寫好的 POJ，以調符表示聲調，不再翻譯。
5. 使用推薦的省流量服務時，網址已預填；邀請碼可以留空。按「開始朗讀」即可逐段產生、逐段播放。
6. 台語模式會顯示實際產生的 POJ 稿與 provider。勾選「保存產生的語音」後，可在同一瀏覽器離線重播。

目前**不支援漢字台文直接朗讀**，也不會把數字調號自動轉成 POJ。若文字是漢字，請選「華語翻成台語」；直接朗讀只接受符合 MMS 字表、以調符標聲調的 POJ。系統也不會把國語聲音冒充台語。

## 真正的語音路徑

| 功能 | 實際處理方式 | 需要網路 |
|---|---|---|
| 台灣國語裝置語音 | 瀏覽器／作業系統提供的 `zh-TW` voice，直接朗讀原文 | 視 voice 而定 |
| 台灣國語線上備援 | 後端透過非官方 `edge-tts` 使用線上 `zh-TW` 聲音 | 是 |
| 華語翻成台語 | 華語分段送到 Groq 翻成 POJ，再由部署主機上的 `facebook/mms-tts-nan` 合成 | 是 |
| POJ 調符直接朗讀 | 相容 POJ 分段直接交給部署主機上的 MMS，不送 Groq | 是 |
| 已保存語音 | 從本瀏覽器 IndexedDB 重播 | 否 |

`edge-tts` 是 Microsoft Edge 線上語音服務的非官方 client，沒有本專案可保證的可用率或服務承諾。MMS 是 Min Nan 研究模型、採 CC BY-NC 4.0，尚未證明自然台灣腔；因此介面只稱「台語 Beta」，不宣稱「正宗」或已通過母語者驗收。

## 匿名限額與邀請碼

- 開頁即可匿名使用，但匿名訪客共用服務端配額；額度用完或服務繁忙時需稍後再試。
- 目前推薦服務不需要邀請碼；自行架設成邀請制時才需輸入管理者提供的 token。
- 邀請碼只存於本次分頁的 `sessionStorage`；不寫入網址、bundle、log、Service Worker cache 或長期儲存，關閉分頁後消失。
- 語音服務網址可保存在 `localStorage`，方便下次使用。

## 離線與低網速邊界

- 安裝／快取完成後，PWA 外殼、文字與文件解析可以離線開啟。
- 已明確保存的音訊可以離線重播，但瀏覽器可能因清除站台資料或空間不足而移除它。
- 裝置 voice 是否真的離線由作業系統決定；`localService` 標記不能取代實際斷網試播。
- 線上台灣國語、Groq 翻譯與線上台語合成都需要網路。PWA 可離線開啟，不等於能離線產生任意新語音。
- 省流量模式每段最多送 280 字，第一段完成即可播放，下一段在背景準備；這是逐段傳輸，不是即時位元流串流。
- 若自行安裝本機 Ollama＋MMS，且模型已完整下載，可在沒有外網時進行華語轉 POJ 與台語合成；設定方式見[後端指南](docs/backend.md)。

## 隱私摘要

文件在瀏覽器內解析，選取文件不會自動上傳。只有按下朗讀後，才會傳送當下要合成的文字分段：

- 華語翻台語：Groq 會收到華語分段；MMS 在本服務部署主機上收到轉換後的 POJ。
- POJ 直讀：部署主機上的 MMS 收到 POJ，不會呼叫 Groq。
- 線上台灣國語：`edge-tts` 所連接的線上語音服務會收到國語分段。
- 裝置語音：本網站不連自訂後端，但瀏覽器／作業系統提供的非本機 voice 仍可能把文字送給其供應者。

本專案沒有廣告、analytics 或追蹤像素。完整說明見[隱私說明](PRIVACY.md)。

## 開發與驗證

需要 Node.js 22 或更新版本：

```bash
npm install
npm run dev
npm test
npm run build
```

完整規格與仍待完成的品質門檻見[產品規格](docs/product-spec.md)、[缺口盤點](docs/gap-analysis.md)及[母語者試聽規範](docs/listening-test.md)。

## 從兩個延伸專案沿用的經驗

- [`mandarin-taigi`](https://github.com/yazelin/mandarin-taigi)：PWA 分層快取、大字介面、來源授權，以及「官方單詞錄音不等於任意句子 TTS」。
- [`taigi-news-reader`](https://github.com/yazelin/taigi-news-reader)：華語轉 POJ、MMS 台語 TTS、非同步工作、取消、配額、IndexedDB 重播與隱私邊界。

這個 repo 重用已驗證的 backend 契約與經驗，但仍把模型限制及尚未完成的真人驗收公開標示。

## 授權

本專案自己的程式碼採 MIT License，© 2026 林亞澤。第三方套件、模型、線上服務及其產生內容不會因此變成 MIT；詳見 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

---

亞澤的其他作品：[GitHub](https://github.com/yazelin) · [個人網站](https://yazelin.github.io/) · [Facebook](https://www.facebook.com/yazelin.j303) · [請我喝杯咖啡](https://buymeacoffee.com/yazelin)
