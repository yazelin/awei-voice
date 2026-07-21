# 語音後端：上線服務與自架指南

推薦的線上 endpoint 已部署在：

```text
https://ching-tech.ddns.net/awei-voice
```

線上網頁預填此網址，匿名訪客可把邀請碼留空。匿名流量有服務端共用 quota 與 reverse proxy 限流；這是開放 Beta，不是無限額或 SLA 服務。

後端以 `server/pyproject.toml` 中完整 commit SHA pin 住 [`taigi-news-reader`](https://github.com/yazelin/taigi-news-reader)，沿用非同步 synthesis job、provider contract、取消、quota 與資源上限；本 repo 的 wrapper 負責 exact web origin、公開匿名 quota 與網頁資料流。

## Production 的實際 provider

| Route | Production 處理 | 外部資料邊界 |
|---|---|---|
| `zh-TW → nan-TW` | Groq 把華語轉成 POJ；部署主機上的 `facebook/mms-tts-nan` 合成 WAV | Groq 收到華語分段 |
| `nan-Latn-TW → nan-TW` | 不翻譯，部署主機上的 MMS 直接合成 WAV | POJ 留在本服務主機，不送 Groq |
| `zh-TW → zh-TW` | 非官方 `edge-tts` 線上台灣國語備援，回 MP3 | 線上語音服務收到國語分段 |

`nan-Latn-TW` 只接受 `facebook/mms-tts-nan` 字表可處理的 POJ。前後端會把大小寫、上標鼻音、常見撇號／連字號與標點正規化，但數字調號或字表外字母會在建立工作前／進入 TTS 前明確拒絕；**漢字台文不能宣告成 `nan-Latn-TW` 直接朗讀**。

Groq 翻譯、POJ gate 和 MMS 成功都不等於語言品質已驗收。MMS 是 CC BY-NC 4.0 的實驗性 Min Nan 模型，不保證台灣腔；`edge-tts` 是非官方 client、需要網路且無可用率保證。

## API contract

前端只使用 async contract；production base path 之後的路徑如下：

1. `GET /health`：回傳 provider 與 route 能力，不下載模型，也不保證一次真實合成一定成功。
2. `GET /v1/access`：顯示是否要求驗證及目前 quota／reset 狀態。
3. `POST /v1/synthesis-jobs`：建立工作，回 HTTP 202、UUID4 `job_id` 與 `pending`。
4. `GET /v1/synthesis-jobs/{job_id}`：短輪詢 `pending`、`completed` 或 `failed`。
5. `DELETE /v1/synthesis-jobs/{job_id}`：播放取得 terminal response 後清理，或在使用者停止時取消。

Wrapper 固定關閉 `POST /v1/synthesize`，避免瀏覽器維持一個長時間 request。Job 留在單一 process 記憶體中，因此 deployment 維持一個 uvicorn worker／replica。

### 華語翻台語

```json
{
  "text": "今天天氣真好。",
  "source_language": "zh-TW",
  "target_language": "nan-TW",
  "rate": 1.0
}
```

成功 result 包含 `spoken_text`、`taigi_text`（POJ）、base64 WAV、`mime_type` 與 `provider`。

### POJ 直接朗讀

```json
{
  "text": "Kin-á-ji̍t thiⁿ-khì chin hó。",
  "source_language": "nan-Latn-TW",
  "target_language": "nan-TW",
  "rate": 1.0
}
```

此 route 的 provider 必須是 `direct:nan-Latn-TW+<synthesizer>`，不能把 translator 寫進 provider，也不應呼叫 Groq。

### 線上台灣國語

```json
{
  "text": "今天天氣真好。",
  "source_language": "zh-TW",
  "target_language": "zh-TW",
  "rate": 1.0
}
```

Health 必須把該 capability 標為 `online-mandarin-backup`、`network_required: true`、`unofficial: true`、`sla_guaranteed: false`。成功 result 的 `taigi_text` 為空，`spoken_text` 為國語原文，音訊通常是 MP3。

## 匿名 quota 與 token

Production 開啟 `TAIGI_ENFORCE_OPEN_ACCESS_QUOTA=true`，即使 `TAIGI_REQUIRE_ACCESS_TOKEN=false`，匿名工作仍由 SQLite 原子保留每日 jobs／characters 的 subject 與 global quota。舊日期會被清理；quota DB 不需要保存原文、POJ、音訊或 token。

正式公開服務的匿名訪客共同使用每日 120 jobs／60,000 字；這能容納一份
30,000 字輸入在 280 字分段下所需的最多 108 段，卻不是每位訪客各有一份額度。
本機 Compose 預設提高為單機每日 500 jobs／200,000 字，避免沿用 upstream
20-job 公開預設而讓合法長文中途停止；管理者仍可用同名環境變數調低。

目前線上服務可匿名使用，因此前端應讓 token 留空。若另一個部署改成 `TAIGI_REQUIRE_ACCESS_TOKEN=true`，每位使用者應使用不同高熵 token，server 只設定 `subject=sha256(token)`；前端只能把 plaintext token 放在 `sessionStorage`，不得放進 repo、bundle、URL、`localStorage`、log、Service Worker 或音訊 cache。缺少與錯誤 token 回相同 401。

## Exact web origins

`AWEI_ALLOWED_WEB_ORIGINS` 是逗號分隔的完整 origin，例如：

```dotenv
AWEI_ALLOWED_WEB_ORIGINS=https://yazelin.github.io
AWEI_ALLOW_LOCALHOST_ORIGINS=false
AWEI_REQUIRE_WEB_ORIGIN=true
```

不得填 `*`、path、query、fragment 或尾斜線；非 localhost 的 HTTP origin 在啟動時失敗。帶有未允許 Origin 的 actual request 會被 wrapper 拒絕。沒有 Origin 的監控 probe 是否允許，應由 reverse proxy／`AWEI_REQUIRE_WEB_ORIGIN` 與路由規則共同限制。

CORS 只允許 `Authorization`、`Content-Type` 及 GET／POST／DELETE／OPTIONS，從未把 CORS 當成 quota 或 authentication 的替代品。

從公開 HTTPS 頁面連 `127.0.0.1` 時，瀏覽器可能要求「本機網路存取」權限；使用者拒絕後無法連本機後端，不應用關閉瀏覽器安全功能來繞過。

## 不下載模型的 mock smoke

Mock 只產生 deterministic 測試 WAV，**不是台語 TTS**：

```bash
python3.12 -m venv .venv
source .venv/bin/activate
python -m pip install -e 'server[dev]'
TAIGI_PROVIDER_MODE=mock \
AWEI_ALLOWED_WEB_ORIGINS=https://yazelin.github.io \
uvicorn awei_voice_server.app:create_app --factory \
  --host 127.0.0.1 --port 8765
curl http://127.0.0.1:8765/health
```

Docker smoke：

```bash
AWEI_INSTALL_LOCAL_MMS=0 TAIGI_PROVIDER_MODE=mock \
  docker compose up --build backend
curl http://127.0.0.1:8765/health
```

Mock health 與畫面必須清楚標成測試 provider，不能拿來聲稱台語已能使用。

## 本機 Ollama＋MMS

這條路徑需要家人／管理者設定，不要求長輩自行安裝：

```bash
ollama serve
ollama pull qwen3:4b-instruct-2507-q4_K_M

source .venv/bin/activate
python -m pip install --index-url https://download.pytorch.org/whl/cpu \
  'torch>=2.6,<3'
python -m pip install -e 'server[mms]'
TAIGI_PROVIDER_MODE=concrete \
TAIGI_TRANSLATOR_PROVIDER=ollama \
TAIGI_TTS_PROVIDER=mms \
TAIGI_MANDARIN_TTS_PROVIDER=edge \
AWEI_ALLOWED_WEB_ORIGINS=https://yazelin.github.io \
AWEI_ALLOW_LOCALHOST_ORIGINS=true \
TAIGI_OLLAMA_BASE_URL=http://127.0.0.1:11434 \
TAIGI_OLLAMA_MODEL=qwen3:4b-instruct-2507-q4_K_M \
TAIGI_MMS_MODEL=facebook/mms-tts-nan \
TAIGI_DAILY_SUBJECT_JOB_LIMIT=500 \
TAIGI_DAILY_SUBJECT_CHARACTER_LIMIT=200000 \
TAIGI_DAILY_GLOBAL_JOB_LIMIT=500 \
TAIGI_DAILY_GLOBAL_CHARACTER_LIMIT=200000 \
uvicorn awei_voice_server.app:create_app --factory \
  --host 127.0.0.1 --port 8765
```

第一次真實 synthesis 會下載／lazy-load MMS。只有完成一個真人可辨識的 job、保留 Ollama 與 Hugging Face cache，接著拔除外網並再次完成華語→POJ→MMS smoke，才算本機台語離線驗證。`/health` 成功不算。

本機沒有外網時：

- Ollama＋MMS 台語 route 可在模型齊全後運作。
- POJ 直讀可使用 MMS，不需 Ollama。
- edge-tts 台灣國語備援不可用；應改用裝置 `zh-TW` voice。

## 遠端 HTTPS 部署

Container host port 只綁 `127.0.0.1`；由 HTTPS reverse proxy 公開 `/awei-voice/health`、`/awei-voice/v1/access` 與 `/awei-voice/v1/synthesis-jobs[/…]`，並設定 TLS、request-size、IP rate limit、timeout 與正確 path stripping。不要公開 direct synthesis。

Production 類型設定：

```dotenv
AWEI_ALLOWED_WEB_ORIGINS=https://yazelin.github.io
AWEI_ALLOW_LOCALHOST_ORIGINS=false
AWEI_REQUIRE_WEB_ORIGIN=true

TAIGI_PROVIDER_MODE=concrete
TAIGI_TRANSLATOR_PROVIDER=openai_compatible
TAIGI_OPENAI_BASE_URL=https://api.groq.com/openai/v1
TAIGI_OPENAI_API_KEY=<server-only-secret>
TAIGI_OPENAI_MODEL=<tested-groq-model>
TAIGI_TTS_PROVIDER=mms
TAIGI_MMS_MODEL=facebook/mms-tts-nan
TAIGI_MANDARIN_TTS_PROVIDER=edge
TAIGI_EDGE_TTS_VOICE=zh-TW-HsiaoChenNeural

TAIGI_REQUIRE_ACCESS_TOKEN=false
TAIGI_ENFORCE_OPEN_ACCESS_QUOTA=true
TAIGI_ALLOW_DIRECT_SYNTHESIS=false
```

Groq key 只能存在 server secret。Reverse-proxy access log 不應記錄 Authorization、request body 或 query 中的敏感內容。

若改用 Gemini、Ollama 或 remote TTS，必須更新 health provider 身分、隱私說明及第三方 notices；不能繼續宣稱「Groq 收華語、MMS 留本機」。

## 測試

測試注入 provider doubles，不連 Groq／edge-tts、不下載 MMS：

```bash
source .venv/bin/activate
python -m pytest -q test_server
```

至少涵蓋 exact origin、匿名 quota、async job、三種 language pair、拒絕漢字 `nan-Latn-TW`、provider 身分、取消與 direct synthesis 關閉。前端另以 `npm test`、`npm run build` 驗證 contract 與介面。
