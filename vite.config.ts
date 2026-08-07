import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  base: "/awei-voice/",
  build: {
    rollupOptions: {
      input: {
        app: "index.html",
        privacy: "privacy.html"
      }
    }
  },
  plugins: [
    VitePWA({
      registerType: "prompt",
      includeAssets: ["icon.svg", "icon-192.png", "icon-512.png", "icon-maskable-512.png", "robots.txt"],
      manifest: {
        name: "阿瑋好聲音｜國語台語朗讀",
        short_name: "阿瑋好聲音",
        description: "貼上文字或匯入文件，用大字介面聽台灣國語或台語。",
        lang: "zh-TW",
        // id 缺了的話 app 身份綁在 start_url 上,日後改路徑等於變成另一個 app
        id: "./",
        start_url: "./",
        scope: "./",
        display: "standalone",
        background_color: "#fffaf0",
        theme_color: "#9a3412",
        icons: [
          // SVG 不掛 maskable:它自己畫了圓角卡片(rx=112),Android 再套一次遮罩會變雙層圓角、
          // 卡片邊還會被切。maskable 另出一張滿版底色的 PNG。
          { src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
          { src: "icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" }
        ]
      },
      workbox: {
        navigateFallback: "index.html",
        cleanupOutdatedCaches: true,
        globPatterns: ["**/*.{js,mjs,css,html,svg,txt,woff2,png}"],
        maximumFileSizeToCacheInBytes: 2 * 1024 * 1024,
        runtimeCaching: []
      },
      devOptions: {
        enabled: false
      }
    })
  ]
});
