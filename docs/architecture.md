# 架構與決策

## 上線系統邊界

```text
GitHub Pages：yazelin.github.io/awei-voice
  TXT / MD / PDF / DOCX
      │（只在瀏覽器解析）
      ▼
  原文正規化、自然分段（遠端每段最多 280 字）
      ├─ 台灣國語
      │    ├─ 優先：裝置 zh-TW Web Speech
      │    └─ 線上：ching-tech.ddns.net/awei-voice
      │             └─ edge-tts 非官方線上 zh-TW → MP3
      └─ 台語 Beta
           ├─ 華語輸入 zh-TW
           │    └─ Groq：華語 → 實驗性 POJ
           │             └─ 部署主機 MMS Min Nan → WAV
           └─ POJ 輸入 nan-Latn-TW
                └─ 不翻譯，部署主機 MMS Min Nan → WAV
      │
      ├─ 逐段播放
      └─ 使用者 opt-in → IndexedDB（50 MiB / 7 天 LRU）
```

推薦後端允許匿名限額使用。匿名請求仍通過 exact-origin gate、邊緣限流及 durable 共用配額；若改連邀請制部署，Bearer token 在前端只存於 `sessionStorage`。

## ADR-001：不把教育部詞條音檔拼成句子

`mandarin-taigi` 的教育部詞條音檔是可信的單詞原音，但採 CC BY-ND 3.0 TW，且詞與句子有跨詞變調、輕讀和韻律差異。本 repo 不複製音檔包，也不把單詞 MP3 拼成任意句子 TTS。

## ADR-002：台灣國語採裝置優先、明確線上備援

裝置 Web Speech 是流量最低的優先路徑，只接受 `zh-TW`，不自動退到 `zh-CN`。`getVoices()` 只反映當下瀏覽器／作業系統能力；`localService` 不能保證真的離線。

裝置缺少 `zh-TW` 時，使用者可改用推薦後端。線上備援透過 `edge-tts` 呼叫 Microsoft Edge 使用的線上語音服務，國語文字會離開部署主機。`edge-tts` 是非官方 client，因此 health 與介面必須揭露「需要網路、非官方、無 SLA」，不得把它寫成官方 API 或離線 voice。

## ADR-003：台語輸入型別必須明確

後端只接受兩種台語來源：

- `zh-TW → nan-TW`：華語分段送 Groq 轉 POJ，再交 MMS。
- `nan-Latn-TW → nan-TW`：使用者提供的 POJ 直接交 MMS，不呼叫 Groq。

`nan-Latn-TW` 會先正規化大小寫、上標鼻音、撇號／連字號、標點與空白，再以 MMS 的精確 POJ 字表驗證。漢字、數字調號與字表外字母會在建立工作前拒絕；漢字台文不是「已是台語」的可機器判定證據，且 MMS vocab 不是任意漢字 G2P。這些限制要在輸入前、錯誤訊息與文件中一致呈現。

## ADR-004：台語失敗不得降級國語

台語 health 必須揭露 `nan-TW` target 與實際 synthesizer；result 必須回傳 POJ、音訊及與 route 相符的 provider。任何翻譯、POJ gate、MMS、網路或播放錯誤都直接顯示，不能因為「至少有聲音」就改播國語。

MMS 是實驗性 Min Nan 模型，不保證台灣腔；Groq 產出的 POJ 也尚未經母語者驗證。技術路由成功不等於「正宗」。

## ADR-005：低網速先做有界分段與預取

- 每段最多 280 字。
- 第一段完成立即播放。
- 播放第 N 段時預先產生第 N+1 段。
- 成功音訊可由使用者選擇保存；相同文字、source／target route、provider 與語速命中後不連網。
- Client 接受 server 宣告的可播放 MIME，不把國語 MP3 與台語 WAV 混為同一格式保證。

這是逐段非同步工作，不是 HTTP 位元流 streaming，也沒有 Range resume 的宣稱。

## ADR-006：離線是一組分開驗證的能力

- App shell precache 完成後，網頁可斷網開啟。
- Parser bundle 快取後，可離線抽取本機文件文字。
- 裝置 voice 是否離線由平台決定，需實際斷網試播。
- 已保存音訊可離線重播，但瀏覽器仍可能驅逐資料。
- 推薦後端、Groq 與 edge-tts 都需要網路。
- 自架本機 Ollama＋MMS 只有在 runtime、模型及 cache 全部下載完成，並通過拔網 smoke 後，才可稱為離線台語生成。

PWA 可離線開啟不等於可離線產生任意新語音。

## ADR-007：公開匿名不等於公開無限額

線上使用者可把 token 留空，降低長輩第一次使用門檻；後端仍把匿名流量映射到 durable 共用 quota，並配合 reverse proxy 的 IP／速率／request-size 限制。另一個部署若改成邀請制，可為 token 分配獨立 subject，但 server 只保存 token digest 與計數，不應保存明文 token 或朗讀內容。

CORS 不是 authentication。Wrapper 精確允許 `https://yazelin.github.io` 等設定 origin，拒絕 `*`；公開 endpoint 仍需 quota 與邊緣保護。

## ADR-008：重用 pin 住的後端，資料流由 wrapper 公開揭露

`taigi-news-reader` backend 提供非同步工作、provider gate、取消、配額及資源上限。本 repo 以完整 commit SHA dependency 重用，再由 web wrapper 加上 exact-origin、匿名配額及台灣國語線上備援。

Production translation 使用 Groq，MMS 留在部署主機；POJ 直讀繞過 Groq；國語線上備援使用 edge-tts。若部署者改成 Ollama、Gemini 或 remote TTS，必須同步更新 health、README、隱私與第三方資料邊界，不能沿用 production 敘述。

## ADR-009：授權與品質是獨立 gate

- `facebook/mms-tts-nan`：CC BY-NC 4.0，僅作非商用實驗性路徑。
- `edge-tts`：LGPL-3.0（其中 `srt_composer.py` 為 MIT）；開源 client 的授權不代表 Microsoft 線上服務或聲音的使用權。
- Groq：外部 API 服務，依其獨立條款與資料政策。

以上任一元件能正常回應，都不能取代 [`listening-test.md`](listening-test.md) 的台語母語者驗收。
