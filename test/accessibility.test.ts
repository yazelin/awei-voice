import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import axe from "axe-core";
import { beforeEach, describe, expect, it } from "vitest";

import { configureSavedPlaybackButton } from "../src/lib/saved-audio-playback";

describe("首頁靜態無障礙", () => {
  beforeEach(async () => {
    const html = await readFile(resolve(process.cwd(), "index.html"), "utf8");
    document.open();
    document.write(html);
    document.close();
  });

  it("通過可在 jsdom 驗證的 axe 規則", async () => {
    const result = await axe.run(document, {
      rules: {
        // jsdom does not calculate rendered foreground/background colors.
        "color-contrast": { enabled: false }
      }
    });
    expect(
      result.violations.map(({ id, nodes }) => ({ id, targets: nodes.map((node) => node.target) }))
    ).toEqual([]);
  });

  it("主要控制都有文字，且表單有一個提交按鈕", () => {
    const buttons = [...document.querySelectorAll<HTMLButtonElement>("button")];
    expect(buttons.length).toBeGreaterThan(6);
    expect(buttons.every((button) => Boolean(button.textContent?.trim()))).toBe(true);
    expect(document.querySelectorAll('button[type="submit"]')).toHaveLength(1);
  });

  it("清楚區分台語翻譯與羅馬字直讀，憑證欄不預填", () => {
    expect(document.querySelectorAll('input[name="taigiInputMode"]')).toHaveLength(2);
    expect(document.body.textContent).toContain("華語翻成台語");
    expect(document.body.textContent).toContain("調符 POJ 直接朗讀");
    expect(document.body.textContent).toContain("不支援漢字、數字調號");
    const token = document.querySelector<HTMLInputElement>("#backend-token");
    expect(token?.type).toBe("password");
    expect(token?.value).toBe("");
    expect(document.querySelector("#taigi-result")?.hasAttribute("aria-live")).toBe(true);
    expect(document.querySelector("#refresh-voices")?.textContent).toContain("重新偵測");
    const playbackStatus = document.querySelector("#library-playback-status");
    expect(playbackStatus?.getAttribute("role")).toBe("status");
    expect(playbackStatus?.getAttribute("aria-live")).toBe("polite");
  });

  it("保存語音的播放與停止按鈕都有完整可朗讀名稱", () => {
    const button = document.createElement("button");
    expect(configureSavedPlaybackButton(button, {
      state: "idle",
      key: null,
      message: ""
    }, "saved-one", 0)).toBe(false);
    expect(button.textContent).toBe("播放");
    expect(button.getAttribute("aria-label")).toBe("播放第 1 段已保存語音");

    expect(configureSavedPlaybackButton(button, {
      state: "playing",
      key: "saved-one",
      message: "正在播放"
    }, "saved-one", 0)).toBe(true);
    expect(button.textContent).toBe("停止");
    expect(button.getAttribute("aria-label")).toBe("停止第 1 段已保存語音");
  });
});
