import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FileImportError,
  MAX_IMPORT_FILE_BYTES,
  detectFormat,
  importDocument
} from "../src/lib/file-import";

function fileFromBytes(
  name: string,
  bytes: Uint8Array,
  type = "application/octet-stream"
): File {
  const data = bytes.slice().buffer as ArrayBuffer;
  return {
    name,
    type,
    size: data.byteLength,
    lastModified: 0,
    arrayBuffer: vi.fn(async () => data.slice(0))
  } as unknown as File;
}

function textFile(name: string, text: string, type = "text/plain"): File {
  return fileFromBytes(name, new TextEncoder().encode(text), type);
}

async function getImportError(promise: Promise<unknown>): Promise<FileImportError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(FileImportError);
    return error as FileImportError;
  }
  throw new Error("預期匯入失敗，但 Promise 成功完成");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("importDocument", () => {
  it("以嚴格 UTF-8 匯入 TXT，並保留可朗讀段落", async () => {
    const result = await importDocument(
      textFile("長輩須知.txt", "\uFEFF第一段。\r\n仍是第一段。\r\n\r\n第二段🙂。")
    );

    expect(result).toEqual({
      name: "長輩須知.txt",
      format: "txt",
      size: expect.any(Number),
      text: "第一段。\n仍是第一段。\n\n第二段🙂。",
      paragraphs: ["第一段。\n仍是第一段。", "第二段🙂。"],
      characterCount: Array.from("第一段。\n仍是第一段。\n\n第二段🙂。").length
    });
  });

  it("把常見 Markdown 標記轉成適合朗讀的文字", async () => {
    const result = await importDocument(
      textFile(
        "提醒.md",
        "# 今日提醒\n\n- 記得吃 **早餐**\n- 打給[阿瑋](https://example.test)\n\n> 慢慢來。",
        "text/markdown"
      )
    );

    expect(result.text).toBe("今日提醒\n\n記得吃 早餐\n打給阿瑋\n\n慢慢來。");
    expect(result.paragraphs).toEqual([
      "今日提醒",
      "記得吃 早餐\n打給阿瑋",
      "慢慢來。"
    ]);
  });

  it("用注入的 PDF parser 在本機抽字，且不發出網路請求", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const parsePdf = vi.fn(async (data: ArrayBuffer) => {
      expect(Array.from(new Uint8Array(data))).toEqual([0x25, 0x50, 0x44, 0x46]);
      return "第一頁\n\n第二頁";
    });

    const result = await importDocument(
      fileFromBytes(
        "文章.pdf",
        new Uint8Array([0x25, 0x50, 0x44, 0x46]),
        "application/pdf"
      ),
      { parsePdf }
    );

    expect(parsePdf).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      format: "pdf",
      text: "第一頁\n\n第二頁",
      paragraphs: ["第一頁", "第二頁"]
    });
  });

  it("用注入的 DOCX parser 匯入段落", async () => {
    const parseDocx = vi.fn(async () => "標題\n\n內文");
    const result = await importDocument(
      fileFromBytes(
        "文章.docx",
        new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      ),
      { parseDocx }
    );

    expect(parseDocx).toHaveBeenCalledOnce();
    expect(result.format).toBe("docx");
    expect(result.paragraphs).toEqual(["標題", "內文"]);
  });

  it("在讀取內容前拒絕超過 10 MiB 的檔案", async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
    const oversizedFile = {
      name: "太大.txt",
      type: "text/plain",
      size: MAX_IMPORT_FILE_BYTES + 1,
      arrayBuffer
    } as unknown as File;

    const error = await getImportError(importDocument(oversizedFile));

    expect(error.code).toBe("FILE_TOO_LARGE");
    expect(error.message).toMatch(/10 MiB/u);
    expect(error.message).toMatch(/拆成較小/u);
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it("拒絕不支援的格式並說明可採取的下一步", async () => {
    const error = await getImportError(
      importDocument(textFile("舊文件.doc", "not a doc", "application/msword"))
    );

    expect(error.code).toBe("UNSUPPORTED_TYPE");
    expect(error.message).toMatch(/TXT.*Markdown.*PDF.*DOCX/u);
    expect(error.message).toMatch(/另存/u);
  });

  it("拒絕非 UTF-8 與含二進位控制字元的文字檔", async () => {
    const invalidUtf8 = await getImportError(
      importDocument(fileFromBytes("big5.txt", new Uint8Array([0xc3, 0x28]), "text/plain"))
    );
    const binaryText = await getImportError(
      importDocument(fileFromBytes("binary.txt", new Uint8Array([0x41, 0x00, 0x42]), "text/plain"))
    );

    expect(invalidUtf8).toMatchObject({ code: "DECODE_FAILED" });
    expect(binaryText).toMatchObject({ code: "DECODE_FAILED" });
    expect(invalidUtf8.message).toMatch(/另存為 UTF-8/u);
  });

  it("辨識加密 PDF，且不把它誤報成一般損壞", async () => {
    const passwordError = new Error("No password given");
    passwordError.name = "PasswordException";

    const error = await getImportError(
      importDocument(fileFromBytes("祕密.pdf", new Uint8Array([1])), {
        parsePdf: vi.fn(async () => Promise.reject(passwordError))
      })
    );

    expect(error.code).toBe("ENCRYPTED_PDF");
    expect(error.message).toMatch(/解除密碼保護/u);
  });

  it("對掃描型或空白 PDF 提供 OCR 範圍說明", async () => {
    const error = await getImportError(
      importDocument(fileFromBytes("掃描.pdf", new Uint8Array([1])), {
        parsePdf: vi.fn(async () => " \n \u200B ")
      })
    );

    expect(error.code).toBe("NO_READABLE_TEXT");
    expect(error.message).toMatch(/掃描圖片/u);
    expect(error.message).toMatch(/不支援 OCR/u);
    expect(error.message).toMatch(/直接貼上文字/u);
  });

  it("對損壞的 DOCX 提供改存 TXT 的做法", async () => {
    const error = await getImportError(
      importDocument(fileFromBytes("損壞.docx", new Uint8Array([1])), {
        parseDocx: vi.fn(async () => Promise.reject(new Error("invalid zip")))
      })
    );

    expect(error.code).toBe("PARSE_FAILED");
    expect(error.message).toMatch(/DOCX/u);
    expect(error.message).toMatch(/另存成 TXT/u);
  });

  it("檔案讀取失敗時提示重新選取", async () => {
    const file = {
      name: "移動過的檔案.txt",
      type: "text/plain",
      size: 20,
      arrayBuffer: vi.fn(async () => Promise.reject(new Error("NotReadableError")))
    } as unknown as File;

    const error = await getImportError(importDocument(file));

    expect(error.code).toBe("READ_FAILED");
    expect(error.message).toMatch(/重新選取/u);
  });
});

describe("detectFormat", () => {
  it("副檔名缺漏時可使用瀏覽器提供的 MIME type", () => {
    expect(detectFormat({ name: "下載項目", type: "application/pdf" })).toBe("pdf");
  });

  it("接受 .markdown 副檔名", () => {
    expect(detectFormat({ name: "說明.MARKDOWN", type: "" })).toBe("md");
  });
});
