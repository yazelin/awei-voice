import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const CORPUS_PATH = resolve(process.cwd(), "quality/taigi-listening-corpus.csv");

const EXPECTED_QUOTAS = {
  "日常生活與語助詞": 24,
  "數字與格式": 18,
  "台灣人名與地名": 18,
  "多音與專名": 18,
  "國台語夾雜": 18,
  長段落: 24
} as const;

interface CorpusEntry {
  readonly id: string;
  readonly category: string;
  readonly input: string;
  readonly expected_notes: string;
}

async function readCorpus(): Promise<{
  source: string;
  rows: string[][];
  entries: CorpusEntry[];
}> {
  const source = (await readFile(CORPUS_PATH, "utf8")).replace(/\r\n/gu, "\n");
  const rows = parseCsv(source);
  const [header, ...dataRows] = rows;

  expect(header).toEqual(["id", "category", "input", "expected_notes"]);
  for (const row of dataRows) {
    expect(row, `每列都必須恰好有四個欄位：${JSON.stringify(row)}`).toHaveLength(4);
  }

  return {
    source,
    rows,
    entries: dataRows.map(([id = "", category = "", input = "", expected_notes = ""]) => ({
      id,
      category,
      input,
      expected_notes
    }))
  };
}

describe("台語母語者固定試聽語料", () => {
  it("包含恰好 120 筆、唯一 ID 與完整必填欄位", async () => {
    const { entries } = await readCorpus();

    expect(entries).toHaveLength(120);
    expect(new Set(entries.map(({ id }) => id)).size).toBe(120);
    for (const entry of entries) {
      expect(entry.id.trim()).not.toBe("");
      expect(entry.category.trim()).not.toBe("");
      expect(entry.input.trim()).not.toBe("");
      expect(entry.expected_notes.trim()).not.toBe("");
    }
  });

  it("六種類別與規格配額完全一致", async () => {
    const { entries } = await readCorpus();
    const actual = Object.fromEntries(
      Object.keys(EXPECTED_QUOTAS).map((category) => [
        category,
        entries.filter((entry) => entry.category === category).length
      ])
    );

    expect(actual).toEqual(EXPECTED_QUOTAS);
    expect(new Set(entries.map(({ category }) => category))).toEqual(
      new Set(Object.keys(EXPECTED_QUOTAS))
    );
  });

  it("每個長段落都有 100 到 300 個中文字元", async () => {
    const { entries } = await readCorpus();
    const longEntries = entries.filter(({ category }) => category === "長段落");

    for (const entry of longEntries) {
      const hanCharacterCount = entry.input.match(/\p{Script=Han}/gu)?.length ?? 0;
      expect(
        hanCharacterCount,
        `${entry.id} 目前只有 ${hanCharacterCount} 個中文字元`
      ).toBeGreaterThanOrEqual(100);
      expect(
        hanCharacterCount,
        `${entry.id} 目前有 ${hanCharacterCount} 個中文字元，超過規格上限`
      ).toBeLessThanOrEqual(300);
    }
  });

  it("人名全部標示為常見虛構組合，且語料沒有聯絡個資", async () => {
    const { entries } = await readCorpus();
    const nameAndPlaceEntries = entries.filter(
      ({ category }) => category === "台灣人名與地名"
    );

    for (const entry of nameAndPlaceEntries) {
      expect(entry.expected_notes).toMatch(/虛構姓名/u);
    }
    for (const entry of entries) {
      expect(entry.input).not.toMatch(/09\d{8}/u);
      expect(entry.input).not.toMatch(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/u);
    }
  });

  it("整份 CSV 使用一致且可逆的正確 quoting", async () => {
    const { source, rows } = await readCorpus();

    expect(serializeCsv(rows)).toBe(source);
  });
});

function parseCsv(source: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let fieldStarted = false;

  const finishField = (): void => {
    row.push(field);
    field = "";
    fieldStarted = false;
  };
  const finishRow = (): void => {
    finishField();
    rows.push(row);
    row = [];
  };

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];

    if (inQuotes) {
      if (character === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"') {
      if (fieldStarted) throw new Error("CSV 引號只能出現在欄位開頭");
      inQuotes = true;
      fieldStarted = true;
    } else if (character === ",") {
      finishField();
    } else if (character === "\n") {
      finishRow();
    } else {
      field += character;
      fieldStarted = true;
    }
  }

  if (inQuotes) throw new Error("CSV 有未關閉的引號");
  if (field.length > 0 || fieldStarted || row.length > 0) finishRow();

  return rows;
}

function serializeCsv(rows: readonly (readonly string[])[]): string {
  return `${rows
    .map((row) =>
      row.map((field) => `"${field.replaceAll('"', '""')}"`).join(",")
    )
    .join("\n")}\n`;
}
