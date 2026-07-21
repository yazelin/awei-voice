# 台語後端：本機與遠端部署

本專案的網頁後端不是重新發明 TTS。它以完整 commit
`967d7370fb5f3b22cc4492c5ee5753fba3ae2904` 安裝已驗證的
[`taigi-news-reader`](https://github.com/yazelin/taigi-news-reader) backend，
保留原本的非同步 synthesis job、Bearer token、quota、Ollama translator、
MMS 與 remote-provider contract；外層只改成適合一般網頁的 exact-origin
閘門與 CORS。網頁不需要、也不應送 `X-Taigi-Extension-Id`。

## 能力邊界

- `GET /health` 是不下載模型的輕量資訊檢查，只表示 process 已啟動並列出
  mode／translator／synthesizer；它不保證 Ollama 已有模型，也不保證 MMS
  權重已下載。
- 真實本機路徑是「繁中 → Ollama/Qwen 實驗性台語翻譯 →
  `facebook/mms-tts-nan` 實驗性 Min Nan 語音」。它不會失敗後改用國語。
- MMS checkpoint 是 **CC BY-NC 4.0**，不是本 repo 的 MIT 資產，不可直接
  當成未設限商用服務。它尚未通過 R6 母語試聽，不保證自然台灣腔。
- Ollama 產出的台語稿即使通過 POJ 字元白名單，也仍須台語母語者驗收語意、
  用詞與發音，通過前不可宣稱「正宗」。
- Python 套件、Ollama/Qwen 與 MMS 權重都需要第一次連網下載。下載完成並保留
  cache 後才可驗證離線合成；「剛 clone 完」不是離線可用。

完整授權說明見 [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md)。

## API contract

前端只使用 async contract：

1. `POST /v1/synthesis-jobs` 送出一個最長 280 字的前端分段；後端上限較大，
   但不應用它來上傳全文。回應 HTTP 202、UUID4 `job_id` 與 `pending`。
2. `GET /v1/synthesis-jobs/{job_id}` 短輪詢，回應 `pending`、`completed`
   （含 `taigi_text`、base64 WAV、MIME type、provider）或 `failed`。
3. 讀到 terminal response 後立即 `DELETE /v1/synthesis-jobs/{job_id}`；使用者
   按停止時也 DELETE。Job 在單一 process 記憶體中，重啟即遺失，因此必須
   維持一個 uvicorn worker／replica。
4. `GET /v1/access` 驗證 token 並取得 quota。`POST /v1/synthesize` 在 wrapper
   中固定關閉，避免網頁維持一個可能很久的 request。

建立工作的 JSON：

```json
{
  "text": "今天天氣真好。",
  "source_language": "zh-TW",
  "target_language": "nan-TW",
  "rate": 1.0
}
```

啟用 access control 時，每個 `/v1/` actual request 都送
`Authorization: Bearer <invite-token>`。Token 是服務的驗證憑證；Origin 只防止
未列名網頁從瀏覽器呼叫，不能取代驗證，因為非瀏覽器 client 可自行偽造 Origin。

## Exact web origins

`AWEI_ALLOWED_WEB_ORIGINS` 是逗號分隔的完整 origin，例如：

```dotenv
AWEI_ALLOWED_WEB_ORIGINS=https://yazelin.github.io,https://preview.example.com
AWEI_ALLOW_LOCALHOST_ORIGINS=true
```

不得填 `*`、path、query、fragment 或尾斜線；非 localhost 的 HTTP origin 會在
啟動時直接失敗。本機開發預設精確接受任意 port 的
`http(s)://localhost` 與 `http(s)://127.0.0.1`，可在遠端環境設
`AWEI_ALLOW_LOCALHOST_ORIGINS=false`。任何帶有未允許 Origin 的 actual
request（包含 `/health`）回 403，preflight 回 400，且不含
`Access-Control-Allow-Origin`；舊 Chrome extension origin 也不在白名單。

沒有 Origin 的 health probe、reverse-proxy 與 CLI request 仍可通過 origin
gate；同網域前端若瀏覽器送出 Origin，仍須把該 origin 明列在設定中。遠端部署
務必同時開 Bearer access control。CORS 只允許
`Authorization`、`Content-Type` 與 GET／POST／DELETE／OPTIONS，從未允許 `*`。

從公開 HTTPS 網頁連到 `127.0.0.1` 時，Chrome 142 起會先顯示「本機網路存取」
權限提示；使用者拒絕後，網頁就不能連本機後端。這是瀏覽器的安全邊界，不應以
關閉安全設定繞過。前端必須由使用者按下檢查／朗讀後才發出請求，讓權限提示有
清楚脈絡。見 [Chrome Local Network Access 說明](https://developer.chrome.com/blog/local-network-access)。

## 不下載模型的 mock smoke

Mock 會產生 deterministic 測試 WAV，**不是台語 TTS**：

```bash
python3.12 -m venv .venv
source .venv/bin/activate
python -m pip install -e 'server[dev]'
TAIGI_PROVIDER_MODE=mock uvicorn awei_voice_server.app:app \
  --host 127.0.0.1 --port 8765
curl http://127.0.0.1:8765/health
```

Docker smoke 同樣不裝 Torch、不下載模型：

```bash
AWEI_INSTALL_LOCAL_MMS=0 TAIGI_PROVIDER_MODE=mock \
  docker compose up --build backend
curl http://127.0.0.1:8765/health
```

預期 health 明列 `mode: "mock"`、`mock:taigi-translator` 與
`mock:wav-synthesizer`，畫面也必須標成測試音訊。

## 本機 Ollama + MMS

這是需要家人／管理者安裝的 reference path，不是要求長輩自行設定：

```bash
ollama serve
ollama pull qwen3:4b-instruct-2507-q4_K_M

source .venv/bin/activate
python -m pip install --index-url https://download.pytorch.org/whl/cpu \
  'torch>=2.6,<3'
python -m pip install -e 'server[mms]'
TAIGI_PROVIDER_MODE=concrete \
TAIGI_OLLAMA_BASE_URL=http://127.0.0.1:11434 \
TAIGI_OLLAMA_MODEL=qwen3:4b-instruct-2507-q4_K_M \
TAIGI_MMS_MODEL=facebook/mms-tts-nan \
uvicorn awei_voice_server.app:app --host 127.0.0.1 --port 8765
```

第一次真實 synthesis 才會 lazy-load／下載 MMS 權重。保持外網、完成一次真人可
辨識的 job，再保留 Ollama 與 Hugging Face cache；之後拔除外網重啟並再跑同一
段 smoke，才算驗證「本機離線服務」。只有 `/health` 成功不算。

Compose 也提供 optional Ollama profile，並用 volume 保存 Ollama 與 MMS cache：

```bash
docker compose --profile local-model up -d ollama
docker compose exec ollama ollama pull qwen3:4b-instruct-2507-q4_K_M
docker compose up --build backend
```

Backend image 以非 root `awei` 使用者執行、read-only root filesystem、drop all
capabilities，並把模型與 quota 寫進各自 volume。Host port 只綁
`127.0.0.1`。

## 遠端 HTTPS 部署

Compose 刻意不提供公開 HTTP listener；將 host 上的 HTTPS reverse proxy 接到
`127.0.0.1:8765`，只公開 `/health`、`/v1/access` 與
`/v1/synthesis-jobs[/…]`，並另外設定 request-size、create/poll rate limit 與
TLS。前端 endpoint 必須是 HTTPS。

遠端至少設定：

```dotenv
AWEI_ALLOWED_WEB_ORIGINS=https://yazelin.github.io
AWEI_ALLOW_LOCALHOST_ORIGINS=false
TAIGI_REQUIRE_ACCESS_TOKEN=true
TAIGI_ALLOW_DIRECT_SYNTHESIS=false
TAIGI_ACCESS_TOKEN_HASHES=tester-a=<64-char-lowercase-sha256>
```

每位使用者給不同高熵 token，server 只存
`subject=sha256(token)`。不要把 plaintext token 或 provider key 放進 repo、前端
bundle、URL、log 或 reverse-proxy access log；前端也只能存於該分頁的
`sessionStorage`。缺少／錯誤 token 都回相同 401。Quota SQLite 只保存假名
subject 與計數，不保存原文、台語稿、音訊或 token。

遠端若改用 OpenAI-compatible／Gemini translator 或 remote TTS，文字會離開部署
主機；營運者必須在設定畫面與隱私文件揭露實際 provider、費用、保存／訓練條款
與資料處理者。本機 Ollama+MMS 的隱私說明不可套用到這種路徑。

例如 generic OpenAI-compatible translator + remote Taiwanese Hokkien TTS：

```dotenv
TAIGI_TRANSLATOR_PROVIDER=openai_compatible
TAIGI_OPENAI_BASE_URL=https://translator.example.com/v1
TAIGI_OPENAI_API_KEY=<server-only-key>
TAIGI_OPENAI_MODEL=<exact-model-name>
TAIGI_TTS_PROVIDER=remote
TAIGI_REMOTE_TTS_URL=https://tts.example.com/synthesize
TAIGI_REMOTE_TTS_API_KEY=<server-only-key>
```

Remote TTS 必須接受 `{text, language: "nan-TW", rate}` 並回傳
`{audio_base64, mime_type: "audio/wav"}`。它也必須經母語試聽；「遠端」不代表已
驗證台灣腔。這種部署不需要 MMS 時，以 `AWEI_INSTALL_LOCAL_MMS=0` 建 image，
避免安裝未使用的 Torch／MMS runtime。

## 測試

測試注入 upstream mock provider，不會連 Ollama 或下載 MMS：

```bash
source .venv/bin/activate
python -m pytest -q test_server
```

涵蓋 configured origin、localhost、拒絕未列名 origin、CORS preflight、health、
Bearer Authorization passthrough、async job 與固定關閉 direct synthesis。
