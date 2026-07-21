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
      includeAssets: ["icon.svg", "robots.txt"],
      manifest: {
        name: "阿瑋好聲音｜國語台語朗讀",
        short_name: "阿瑋好聲音",
        description: "貼上文字或匯入文件，用大字介面聽台灣國語或台語。",
        lang: "zh-TW",
        start_url: "./",
        scope: "./",
        display: "standalone",
        background_color: "#fffaf0",
        theme_color: "#9a3412",
        icons: [
          {
            src: "icon.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "any maskable"
          }
        ]
      },
      workbox: {
        navigateFallback: "index.html",
        cleanupOutdatedCaches: true,
        globPatterns: ["**/*.{js,mjs,css,html,svg,txt,woff2}"],
        maximumFileSizeToCacheInBytes: 2 * 1024 * 1024,
        runtimeCaching: []
      },
      devOptions: {
        enabled: false
      }
    })
  ]
});
