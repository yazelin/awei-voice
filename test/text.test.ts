import { describe, expect, it } from "vitest";

import {
  TextValidationError,
  countGraphemes,
  normalizeAndValidateText,
  normalizeText,
  splitText,
  validateText
} from "../src/lib/text";

describe("text", () => {
  it("normalizes Windows lines and repeated horizontal whitespace", () => {
    expect(normalizeText("  第一行\t \r\n 第二行\n\n\n第三行  ")).toBe("第一行\n第二行\n\n第三行");
  });

  it("returns actionable validation errors", () => {
    expect(validateText(" \n ")).toMatchObject({ ok: false, code: "empty" });
    expect(validateText("正常\u0000藏字")).toMatchObject({ ok: false, code: "control_character" });
    expect(validateText("正常\u200b藏字")).toMatchObject({ ok: false, code: "control_character" });
    expect(validateText("一二三", 2)).toMatchObject({ ok: false, code: "too_long", length: 3 });
    expect(() => normalizeAndValidateText("\u0001")).toThrowError(TextValidationError);
  });

  it("prefers Chinese paragraph and sentence boundaries", () => {
    expect(splitText("第一句。第二句。\n第三段。", 6)).toEqual(["第一句。", "第二句。", "第三段。"]);
  });

  it("never splits a Unicode grapheme cluster", () => {
    const family = "👨‍👩‍👧‍👦";
    const chunks = splitText(`${family}${family}${family}`, 2);
    expect(chunks).toEqual([`${family}${family}`, family]);
    expect(chunks.every((chunk) => countGraphemes(chunk) <= 2)).toBe(true);
    expect(chunks.join("")).toBe(`${family}${family}${family}`);
  });

  it("keeps every synthesis segment within 280 graphemes", () => {
    const chunks = splitText(`開頭，${"甲".repeat(600)}。`);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((chunk) => countGraphemes(chunk) <= 280)).toBe(true);
  });
});
