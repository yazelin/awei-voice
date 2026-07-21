# 正式語音服務 smoke

需要 Node.js 22。先跑不連外的 mock 單元測試：

```bash
npm run test:smoke
```

部署完成後，對指定的 HTTPS base endpoint 執行：

```bash
npm run smoke:live -- https://ching-tech.ddns.net/awei-voice
```

預設只允許 `https://yazelin.github.io` origin。工具不接受 token，也不輸出樣本文字或音訊；它依序驗證 health、CORS／匿名額度與三條正式語音 route，精確核對 provider、台語稿、MIME、base64 及 WAV／MP3 magic，最後刪除每一個建立的 job。每次正式執行仍會消耗 3 個共用合成額度，請勿用迴圈反覆執行。
