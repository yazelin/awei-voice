# 阿瑋好聲音

阿瑋想要一個讓長輩也能輕鬆使用的網頁：貼上文字或匯入文件，按大按鈕，就能聽台灣國語或台語。這個 repo 是願望池 #26 的完整獨立網頁版，不是既有字典或 Chrome 新聞擴充套件的改名版本。

線上版：<https://yazelin.github.io/awei-voice/>

## 現在能做什麼

- 貼上最多 30,000 字，或在瀏覽器內匯入 TXT、Markdown、文字型 PDF、DOCX。
- 明確切換「台灣國語」與「台語 Beta」。
- 大字、高對比、鍵盤可操作的播放、暫停、繼續、停止與跳段介面。
- 台灣國語只使用裝置列出的 `zh-TW` voice，不退回 `zh-CN`。
- 台語只使用真正的 `nan-TW`／Taiwanese Hokkien 裝置 voice，或經 health check 確認的台語後端；失敗時不會拿國語冒充。
- 省流量模式逐段合成、完成第一段就開始播放；使用者可選擇把台語音訊留在 IndexedDB，重播不再連網。
- 可安裝成 PWA；App shell、文件解析、裝置 voice 與已保存音訊可在斷網時使用。
- 支援本機後端。完成一次模型下載後，可讓同一台電腦在沒有外網時處理台語。

## 三種使用方式

### 裝置語音（可能離線）

網頁不連自訂 TTS 後端。台灣國語需要裝置列出 `zh-TW` voice；任意台語則只有裝置真的列出 `nan-TW` 或 Taiwanese Hokkien voice 時才開放。選單會把瀏覽器回報的 `localService` 聲音標成「裝置內」，其他標成「可能需連網」；後者可能由作業系統或瀏覽器的語音供應者處理文字。這個旗標也不是跨平台離線保證，正式使用前仍要實際斷網試播。

### 本機服務

台語文字送到同一台電腦的 `http://127.0.0.1:8765`。參考後端沿用 `taigi-news-reader` 已驗證的「繁中 → 台語 POJ → MMS Min Nan WAV」pipeline；模型與 Ollama 完成首次下載後可以不連外網。這條路徑需要家人先協助安裝，而且目前仍是非商用、待母語者驗收的 Beta。第一次從線上版連本機服務時，瀏覽器可能詢問「本機網路存取」，需由使用者明確允許。

### 省流量服務

連到自行選擇的 HTTPS 語音服務。網頁每次最多送出 280 字，只處理即將播放的段落；保存成功音訊後，下一次播放同一內容不再耗流量。Repo 不內建公開 API key，也不偷偷指定第三方服務。

## 立即開發

需要 Node.js 22 或更新版本：

```bash
npm install
npm run dev
```

驗證：

```bash
npm test
npm run build
```

本機台語後端的 Docker／Ollama 安裝與安全設定見 [後端指南](docs/backend.md)。

## 能力邊界

「正宗」不能只靠模型名稱判定。本專案把台語 provider、台語稿與已知限制攤在畫面上，並以母語者試聽作正式門檻。通過 [試聽規範](docs/listening-test.md) 前，介面只寫「台語 Beta」，不宣稱已驗收的正宗台語。

目前沒有找到一個同時具備「可商用、可下載、真正台灣台語、任意漢字、瀏覽器離線」的成熟公開模型：

- `facebook/mms-tts-nan` 是 Min Nan 研究模型，權重採 CC BY-NC 4.0，不能當一般商用服務；也不保證台灣腔。
- MMS vocab 主要是拉丁字母與音標，繁中內容必須先可靠地轉成台語羅馬字。
- Web Speech 的 `zh-TW` 只是裝置回報的語言標籤，不保證每台機器音色一致、一定離線或已通過台灣口音評測。
- PWA 首次造訪與模型首次下載仍需要網路；瀏覽器也可能清除站台儲存。

完整規格、假設與驗收標準見 [產品規格](docs/product-spec.md)，兩個延伸專案的覆蓋差異見 [缺口盤點](docs/gap-analysis.md)。

## 從兩個延伸專案學到什麼

- [`mandarin-taigi`](https://github.com/yazelin/mandarin-taigi)：App shell／資料／音訊分層快取、教育部原音授權、大字介面，以及「官方單詞錄音不等於句子 TTS」。
- [`taigi-news-reader`](https://github.com/yazelin/taigi-news-reader)：真台語 provider、POJ gate、非同步 job、取消與配額、IndexedDB 重播、安全與隱私邊界。

這個 repo 重用的是經驗與明確的 backend 契約；網頁導覽、雙語 orchestrator、文件匯入、離線語意與省流量播放都重新為阿瑋的願望設計。

## 隱私

無廣告、無追蹤、無 analytics。文件在瀏覽器解析；只有按下朗讀後，台語模式才把當下需要的文字分段送往你選定的服務。Bearer token 只放在本次分頁。詳見 [隱私說明](PRIVACY.md)。

## 授權

程式碼採 MIT License，© 2026 林亞澤。第三方模型、資料與語音不會因此變成 MIT；詳見 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

---

亞澤的其他作品：[GitHub](https://github.com/yazelin) · [個人網站](https://yazelin.github.io/) · [Facebook](https://www.facebook.com/yazelin.j303) · [請我喝杯咖啡](https://buymeacoffee.com/yazelin)
