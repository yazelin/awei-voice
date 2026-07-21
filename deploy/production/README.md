# 正式網頁語音後端部署

這份部署把 API 放在 `https://ching-tech.ddns.net/awei-voice`。它與既有
`/taigi-tts` 使用不同 container alias、路由與 quota volume；加入本設定時不得
刪除、取代或改寫舊服務的 location。

公開路徑支援三種明確模式：

- `zh-TW → nan-TW`：Groq/OpenAI-compatible 翻成 POJ，再由本機 MMS 產生台語 WAV。
- `nan-Latn-TW → nan-TW`：略過翻譯，正規化後由 MMS 朗讀使用者提供、以調符標聲調的相容 POJ。
- `zh-TW → zh-TW`：`edge-tts` 的台灣中文線上備援，回傳 MP3。它需要網路，
  是非官方 client，沒有 SLA，絕不可標示為離線語音。

MMS `facebook/mms-tts-nan` 是 CC BY-NC 4.0 reference model，本部署只適用
非商用情境。產生 WAV 不代表腔調與翻譯品質已通過母語者驗收。

## 部署前檢查

目標主機是 `192.168.11.11`。下列既有資源只引用、不複製秘密值：

- `/home/ct/taigi-news-reader/deploy/lan/backend.env`：須為 `0600`，提供現有
  Groq server-side key。不要 `cat`、source、提交或貼出內容。
- external network `taigi_news_reader_edge`：既有 nginx 必須已持久加入。
- external volume `taigi-news-reader-lan_model-cache`：重用 Hugging Face 模型；
  Awei 自己另建 `quota-data`，不與舊服務共用 SQLite。

用既有 env 檔只做 Compose 變數代入；它不會整包掛進新 container。先執行唯讀檢查，
而且只用 `config --quiet`，不要把含 key 的完整 rendered config 印到終端或紀錄：

```bash
cd /home/ct/awei-voice/deploy/production
test "$(stat -c %a /home/ct/taigi-news-reader/deploy/lan/backend.env)" = 600
docker network inspect taigi_news_reader_edge
docker volume inspect taigi-news-reader-lan_model-cache
docker compose \
  --env-file /home/ct/taigi-news-reader/deploy/lan/backend.env \
  -f compose.yaml config --quiet
```

解析後必須確認 backend 沒有 `ports:`、`AWEI_REQUIRE_WEB_ORIGIN=true`、
`TAIGI_REQUIRE_ACCESS_TOKEN=false`、`TAIGI_ENFORCE_OPEN_ACCESS_QUOTA=true`，且只有
一個 replica／worker。公開匿名請求共用 durable UTC-day 120 jobs／60,000 字
上限；nginx 另有每 IP create/poll/connection 上限。Origin 能被非瀏覽器偽造，
因此它只是 defense-in-depth，不能取代配額與 edge 限流。

## 啟動 backend

```bash
docker compose \
  --env-file /home/ct/taigi-news-reader/deploy/lan/backend.env \
  -f compose.yaml build backend
docker run --rm --entrypoint id awei-voice-server:production
docker run --rm \
  -v taigi-news-reader-lan_model-cache:/var/cache/awei \
  --entrypoint sh awei-voice-server:production \
  -c 'test "$(id -u):$(id -g)" = 999:999 && test -r /var/cache/awei/huggingface && test -w /var/cache/awei/huggingface'
docker compose \
  --env-file /home/ct/taigi-news-reader/deploy/lan/backend.env \
  -f compose.yaml up -d backend
docker compose \
  --env-file /home/ct/taigi-news-reader/deploy/lan/backend.env \
  -f compose.yaml ps
docker compose \
  --env-file /home/ct/taigi-news-reader/deploy/lan/backend.env \
  -f compose.yaml exec backend \
  python -c "import edge_tts; print(edge_tts.__version__)"
docker compose \
  --env-file /home/ct/taigi-news-reader/deploy/lan/backend.env \
  -f compose.yaml exec backend \
  python -c "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:8765/health', timeout=3).read().decode())"
docker network inspect taigi_news_reader_edge
```

health 必須分開列出 `synthesizer`（台語）與 `mandarin_synthesizer`，並宣告
`zh-TW→zh-TW` capability 的 `network_required=true`、`unofficial=true`、
`sla_guaranteed=false`。第一次 MMS 請求可能下載／載入大型模型，應預留時間。

## 納入既有 nginx

1. 將 `nginx/01-awei-voice-http.conf.example` 以 `01-awei-voice-http.conf`
   放入 nginx 的 `http` context；檔名必須排在既有 `00-taigi-http.conf` 後，讓
   共用的 `map_hash_bucket_size` 先於所有新 `map` 解析。
2. 將 `nginx/awei-voice-locations.inc` 放入既有 `ching-tech.ddns.net` HTTPS
   `server` block。保留 `.inc`，不可讓 `conf.d/*.conf` 在 http context 直接載入
   location。
3. 先用 disposable harness 驗 syntax，再在真正 container 中測試並 atomic
   reload：

```bash
docker run --rm --network taigi_news_reader_edge \
  -v "$PWD/nginx:/config:ro" nginx:1.29.3-alpine \
  nginx -t -c /config/nginx.conf.test
docker exec nginx getent hosts awei-voice-backend
docker exec nginx nginx -t
docker exec nginx nginx -s reload
```

若 nginx 前面另有 CDN／proxy，`$remote_addr` 可能只看見 proxy IP；不得直接信任
client 提供的 `X-Forwarded-For`。必須先 pin 可信 proxy 網段並重新驗證 real-IP 與
rate-limit key。

## 公開 smoke test

```bash
curl --fail https://ching-tech.ddns.net/awei-voice/health
curl -i https://ching-tech.ddns.net/awei-voice/v1/access
curl -i https://ching-tech.ddns.net/awei-voice/v1/access \
  -H 'Origin: https://not-allowed.example'
curl -i -X OPTIONS \
  https://ching-tech.ddns.net/awei-voice/v1/synthesis-jobs \
  -H 'Origin: https://yazelin.github.io' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type'
curl -i https://ching-tech.ddns.net/awei-voice/v1/access \
  -H 'Origin: https://yazelin.github.io'
```

預期：health 無 Origin 為 200；任何 `/v1/` 缺 Origin 或錯誤 Origin 為 403；
正式 Pages Origin 的 preflight 與 access 為 200，且 CORS 只回該 exact Origin。
`/v1/access` 應顯示 `authentication_required=false` 但仍有 subject/global limits，
不是無限制服務。`/awei-voice/v1/synthesize` 與未知 `/v1/` 路徑必須是 404。

接著由正式網頁逐一驗證：華語→台語顯示 `spoken_text/taigi_text` 並播放 WAV；
POJ 調符直讀不經 translator；裝置缺 `zh-TW` 時的國語備援回
`taigi_text=null`、MP3 與 `direct:zh-TW+edge-tts-online-unofficial:...` provider。

## 回復

先從 TLS server 移除 `awei-voice-locations.inc` include，`nginx -t` 成功後才
reload；再移除 http-context 檔案並再次 test/reload。確認舊 `/taigi-tts` 與其他
virtual host 正常後，才執行：

```bash
docker compose \
  --env-file /home/ct/taigi-news-reader/deploy/lan/backend.env \
  -f compose.yaml down
```

保留 external network、共用 model cache 與 Awei quota volume，除非管理者另行
確認資料保留需求並明確授權刪除。不要使用 `down -v`。
