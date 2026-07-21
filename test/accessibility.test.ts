import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import axe from "axe-core";
import { beforeEach, describe, expect, it } from "vitest";

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
});
