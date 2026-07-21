export const MAX_IMPORT_FILE_BYTES = 10 * 1024 * 1024;

export type ImportedFileFormat = "txt" | "md" | "pdf" | "docx";

export type FileImportErrorCode =
  | "UNSUPPORTED_TYPE"
  | "FILE_TOO_LARGE"
  | "DECODE_FAILED"
  | "ENCRYPTED_PDF"
  | "NO_READABLE_TEXT"
  | "PARSE_FAILED"
  | "READ_FAILED";

export class FileImportError extends Error {
  readonly code: FileImportErrorCode;

  constructor(code: FileImportErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FileImportError";
    this.code = code;
  }
}

export interface ImportedDocument {
  readonly name: string;
  readonly format: ImportedFileFormat;
  readonly size: number;
  readonly text: string;
  readonly paragraphs: readonly string[];
  readonly characterCount: number;
}

export type BinaryDocumentParser = (data: ArrayBuffer) => Promise<string>;

export interface FileImportParsers {
  readonly parsePdf?: BinaryDocumentParser;
  readonly parseDocx?: BinaryDocumentParser;
}

interface NormalizedText {
  readonly text: string;
  readonly paragraphs: readonly string[];
}

const MIME_FORMATS: Readonly<Record<string, ImportedFileFormat>> = {
  "text/plain": "txt",
  "text/markdown": "md",
  "text/x-markdown": "md",
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "docx"
};

const SUPPORTED_FORMAT_MESSAGE =
  "目前只支援 TXT、Markdown（.md）、文字型 PDF 與 DOCX。請將文件另存成其中一種格式後再匯入。";

/**
 * Read a supported document without sending its name, contents, or extracted text
 * anywhere. PDF and DOCX parsers can be injected so callers and tests do not need
 * to start PDF.js's worker.
 */
export async function importDocument(
  file: File,
  parsers: FileImportParsers = {}
): Promise<ImportedDocument> {
  const format = detectFormat(file);

  if (file.size > MAX_IMPORT_FILE_BYTES) {
    throw new FileImportError(
      "FILE_TOO_LARGE",
      "檔案超過 10 MiB。請刪減內容、拆成較小的檔案，或直接貼上要朗讀的段落。"
    );
  }

  let data: ArrayBuffer;
  try {
    data = await file.arrayBuffer();
  } catch (cause) {
    throw new FileImportError(
      "READ_FAILED",
      "瀏覽器無法讀取這個檔案。請確認檔案仍在裝置上，再重新選取一次。",
      { cause }
    );
  }

  let extractedText: string;
  if (format === "txt" || format === "md") {
    extractedText = decodeUtf8(data);
    if (format === "md") {
      extractedText = markdownToReadableText(extractedText);
    }
  } else {
    const parser =
      format === "pdf"
        ? (parsers.parsePdf ?? parsePdfInBrowser)
        : (parsers.parseDocx ?? parseDocxInBrowser);

    try {
      extractedText = await parser(data);
    } catch (cause) {
      if (cause instanceof FileImportError) {
        throw cause;
      }
      if (format === "pdf" && isPasswordError(cause)) {
        throw new FileImportError(
          "ENCRYPTED_PDF",
          "這份 PDF 有密碼保護，第一版無法解析。請先解除密碼保護，或另存成 TXT、DOCX 後再匯入。",
          { cause }
        );
      }

      const label = format === "pdf" ? "PDF" : "DOCX";
      throw new FileImportError(
        "PARSE_FAILED",
        `無法解析這份 ${label} 文件。請確認檔案沒有損壞，或另存成 TXT 後再試。`,
        { cause }
      );
    }
  }

  const normalized = normalizeReadableText(extractedText);
  if (!containsReadableText(normalized.text)) {
    throw noReadableTextError(format);
  }

  return {
    name: file.name,
    format,
    size: file.size,
    text: normalized.text,
    paragraphs: normalized.paragraphs,
    characterCount: Array.from(normalized.text).length
  };
}

export function detectFormat(file: Pick<File, "name" | "type">): ImportedFileFormat {
  const extension = file.name.toLocaleLowerCase("en-US").match(/\.([^.]+)$/u)?.[1];

  if (extension === "txt") return "txt";
  if (extension === "md" || extension === "markdown") return "md";
  if (extension === "pdf") return "pdf";
  if (extension === "docx") return "docx";

  const mime = file.type.toLocaleLowerCase("en-US").split(";", 1)[0]?.trim();
  const format = mime ? MIME_FORMATS[mime] : undefined;
  if (format) return format;

  throw new FileImportError("UNSUPPORTED_TYPE", SUPPORTED_FORMAT_MESSAGE);
}

export function normalizeReadableText(rawText: string): NormalizedText {
  const lines = rawText
    .normalize("NFC")
    .replace(/^\uFEFF/u, "")
    .replace(/\r\n?/gu, "\n")
    .replace(/\f/gu, "\n\n")
    .replace(/[\u0000-\u0008\u000B\u000E-\u001F\u007F]/gu, " ")
    .split("\n")
    .map((line) => line.replace(/[\t\u00A0 ]+/gu, " ").trim());

  const paragraphs: string[] = [];
  let currentLines: string[] = [];

  const flushParagraph = (): void => {
    if (currentLines.length > 0) {
      paragraphs.push(currentLines.join("\n"));
      currentLines = [];
    }
  };

  for (const line of lines) {
    if (line.length === 0) {
      flushParagraph();
    } else {
      currentLines.push(line);
    }
  }
  flushParagraph();

  return {
    text: paragraphs.join("\n\n"),
    paragraphs
  };
}

function decodeUtf8(data: ArrayBuffer): string {
  const bytes = new Uint8Array(data);
  const hasUtf16ByteOrderMark =
    (bytes[0] === 0xff && bytes[1] === 0xfe) ||
    (bytes[0] === 0xfe && bytes[1] === 0xff);

  try {
    if (hasUtf16ByteOrderMark) {
      throw new TypeError("UTF-16 is outside the supported import format");
    }

    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(text)) {
      throw new TypeError("The text contains binary control characters");
    }
    return text;
  } catch (cause) {
    throw new FileImportError(
      "DECODE_FAILED",
      "無法以 UTF-8 讀取這份文字檔。請用文字編輯器另存為 UTF-8 編碼後，再重新匯入。",
      { cause }
    );
  }
}

function markdownToReadableText(markdown: string): string {
  return markdown
    .replace(/^ {0,3}(?:`{3,}|~{3,}).*$/gmu, "")
    .replace(/!\[([^\]]*)\]\([^\n)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^\n)]*\)/gu, "$1")
    .replace(/^ {0,3}#{1,6}[\t ]+/gmu, "")
    .replace(/^ {0,3}>[\t ]?/gmu, "")
    .replace(/^ {0,3}(?:[-+*]|\d+[.)])[\t ]+/gmu, "")
    .replace(/^ {0,3}(?:[-*_][\t ]*){3,}$/gmu, "")
    .replace(/`([^`\n]+)`/gu, "$1")
    .replace(/(\*\*|__|~~)([^\n]+?)\1/gu, "$2")
    .replace(/(?<!\w)([*_])([^\n]+?)\1(?!\w)/gu, "$2")
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<\/?[a-z][^>]*>/giu, "");
}

async function parsePdfInBrowser(data: ArrayBuffer): Promise<string> {
  const pdfjs = await import("pdfjs-dist");
  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    const workerModule = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
    pdfjs.GlobalWorkerOptions.workerSrc = workerModule.default;
  }

  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(data) });
  try {
    const document = await loadingTask.promise;
    const pages: string[] = [];

    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const textContent = await page.getTextContent();
      pages.push(joinPdfTextItems(textContent.items));
      page.cleanup();
    }

    return pages.join("\n\n");
  } finally {
    await loadingTask.destroy();
  }
}

function joinPdfTextItems(items: readonly unknown[]): string {
  let text = "";

  for (const item of items) {
    if (!isPdfTextItem(item) || item.str.length === 0) continue;

    const previousCharacter = text.at(-1) ?? "";
    const firstCharacter = item.str.at(0) ?? "";
    if (
      /[A-Za-z0-9]/u.test(previousCharacter) &&
      /[A-Za-z0-9]/u.test(firstCharacter)
    ) {
      text += " ";
    }
    text += item.str;
    if (item.hasEOL) text += "\n";
  }

  return text;
}

function isPdfTextItem(value: unknown): value is { str: string; hasEOL?: boolean } {
  return (
    typeof value === "object" &&
    value !== null &&
    "str" in value &&
    typeof value.str === "string"
  );
}

async function parseDocxInBrowser(data: ArrayBuffer): Promise<string> {
  const module = await import("mammoth");
  const result = await module.extractRawText({ arrayBuffer: data });
  return result.value;
}

function containsReadableText(text: string): boolean {
  return text.replace(/[\s\u200B-\u200D\u2060\uFEFF]/gu, "").length > 0;
}

function noReadableTextError(format: ImportedFileFormat): FileImportError {
  if (format === "pdf") {
    return new FileImportError(
      "NO_READABLE_TEXT",
      "PDF 內找不到可朗讀文字，可能是掃描圖片。第一版不支援 OCR；請改用文字型 PDF，或直接貼上文字。"
    );
  }

  return new FileImportError(
    "NO_READABLE_TEXT",
    "文件內找不到可朗讀文字。請確認文件不是空白，再改存成 TXT，或直接貼上文字。"
  );
}

function isPasswordError(cause: unknown): boolean {
  if (!(cause instanceof Error)) return false;
  const diagnostic = `${cause.name} ${cause.message}`.toLocaleLowerCase("en-US");
  return /password|encrypted|encryption|密碼|加密/u.test(diagnostic);
}
