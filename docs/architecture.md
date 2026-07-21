# 架構與決策

## 系統邊界

```text
TXT / MD / PDF / DOCX
        │（只在瀏覽器解析）
        ▼
繁中原文 → 正規化與自然分段
        ├─ 台灣國語 → 裝置 zh-TW Web Speech
        └─ 台語 Beta
             ├─ 裝置真正 nan-TW voice
             └─ async backend job
                   ├─ 繁中 → 台語 POJ
                   └─ 真台語 TTS → 音訊＋台語稿＋provider
        │
        ├─ 即時播放
        └─ 使用者 opt-in → IndexedDB（50 MiB / 7 天 LRU）
```

## ADR-001：不把教育部詞條音檔拼成句子

`mandarin-taigi` 的教育部詞條音檔是可信的單詞原音，但採 CC BY-ND 3.0 TW，而且詞與句子存在跨詞變調、輕讀與韻律差異。拼接不只可能形成衍生素材，也會產生不自然甚至錯誤的句子，所以本 repo 不複製音檔包、不把單詞 MP3 當 TTS。

## ADR-002：國語嚴格只接受 zh-TW

裝置 Web Speech 是最低流量、最容易上手的第一條路，但 `getVoices()` 只回報作業系統已有的 voice。找不到 `zh-TW` 時顯示缺少聲音，不自動退到 `zh-CN` 或 `cmn-CN`。畫面顯示實際 voice 名稱，避免把語言 tag 當成品質保證。

## ADR-003：台語失敗不得降級國語

裝置 voice 必須明確標為 `nan-TW`／Taiwanese Hokkien；後端 health 與 synthesis response 也必須識別台語 provider。任何翻譯、POJ gate、TTS、網路或播放錯誤都直接顯示，沒有「先讓它出聲」的國語 fallback。

## ADR-004：低網速先解 transport 與等待順序

舊原型以完整 base64 PCM WAV 回傳，且每一段播完才開始下一段，長文會有大流量與空檔。網頁版先做到：

- 原文每段最多 280 字。
- 第一段完成立即播放。
- 播放第 N 段時預先產生第 N+1 段。
- 成功音訊可 opt-in 保存，重播 cache hit 不連網。
- client 接受 WAV／MP3／Opus 等 server 宣告的可播放 MIME；不把格式寫死。

真正 HTTP audio streaming、Range resume 與 server-side Opus encode 是後端下一階段；UI 不會把逐段模式寫成位元流串流。

## ADR-005：離線是一組可驗證能力，不是一個標語

- App shell precache 完成後，網頁可以斷網開啟。
- 文件 parser bundle 完成快取後，可以斷網抽字。
- 裝置 voice 是否離線由作業系統決定。
- `localService` 只作畫面提示；非本機 voice 可能由平台送出文字，本機 voice 也必須以實際斷網試播驗證。
- 本機 backend 只有在模型、translator、runtime 都完成首次下載且飛航測試通過後，才可稱為離線台語生成。
- 已保存音訊可斷網重播，但瀏覽器仍可能驅逐儲存。

## ADR-006：現有後端採 pin + web-origin wrapper

`taigi-news-reader` backend 已有 181 項測試紀錄、非同步工作、provider gate、取消、配額與記憶體邊界。新 repo 以完整 commit SHA dependency 重用，再由外層 middleware 精確允許設定的網頁 origins；不複製 Chrome extension identity，也不使用 CORS `*`。

參考 MMS provider 是 CC BY-NC 4.0 且只保證 Min Nan，不保證台灣腔。它只供非商用 Beta／研究；商用部署必須換 provider 或取得額外權利。
