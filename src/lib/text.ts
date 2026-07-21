export const MAX_TEXT_LENGTH = 30_000;
export const DEFAULT_SEGMENT_LENGTH = 280;

export type TextValidationCode = "empty" | "too_long" | "control_character";

export type TextValidationResult =
  | { ok: true; text: string; length: number }
  | { ok: false; code: TextValidationCode; message: string; length?: number };

export class TextValidationError extends Error {
  readonly code: TextValidationCode;

  constructor(code: TextValidationCode, message: string) {
    super(message);
    this.name = "TextValidationError";
    this.code = code;
  }
}

// Keep newlines and tabs (which normalizeText handles), while rejecting control
// characters that can make the preview differ from the text sent for synthesis.
const INVISIBLE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b\u200e\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u;
const NON_ROMANIZED_SCRIPT = /[\u2e80-\u2fff\u3040-\u30ff\u3100-\u312f\u31a0-\u31bf\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/u;
const MMS_NAN_ALLOWED = new Set(Array.from(
  "abceghijklmnopstuàáâèéêìíîòóôùúûāēīńōūǹḿ\u0302\u0304\u030d\u0358 '-"
));
const MMS_NAN_FORMAT_MAP: Readonly<Record<string, string>> = {
  "ⁿ": "nn",
  "‘": "'",
  "’": "'",
  "‛": "'",
  "ʼ": "'",
  "＇": "'",
  "‐": "-",
  "‑": "-",
  "‒": "-",
  "–": "-",
  "—": "-",
  "―": "-",
  "﹘": "-",
  "﹣": "-",
  "－": "-"
};

function graphemeSegmenter(): Intl.Segmenter | null {
  if (typeof Intl.Segmenter !== "function") return null;
  return new Intl.Segmenter("zh-TW", { granularity: "grapheme" });
}

export function toGraphemes(text: string): string[] {
  const value = String(text);
  const segmenter = graphemeSegmenter();
  if (!segmenter) {
    const result: string[] = [];
    const codePoints = Array.from(value);
    let current = "";
    let regionalIndicators = 0;
    let joinNext = false;

    for (const codePoint of codePoints) {
      const scalar = codePoint.codePointAt(0) ?? 0;
      const isRegionalIndicator = scalar >= 0x1f1e6 && scalar <= 0x1f1ff;
      const isExtension = /\p{Mark}/u.test(codePoint) ||
        (scalar >= 0xfe00 && scalar <= 0xfe0f) ||
        (scalar >= 0x1f3fb && scalar <= 0x1f3ff) ||
        (scalar >= 0xe0020 && scalar <= 0xe007f) ||
        codePoint === "\u200c";

      if (!current) {
        current = codePoint;
        regionalIndicators = isRegionalIndicator ? 1 : 0;
      } else if (joinNext || isExtension || codePoint === "\u200d") {
        current += codePoint;
        joinNext = codePoint === "\u200d";
      } else if (isRegionalIndicator && regionalIndicators === 1) {
        current += codePoint;
        regionalIndicators = 2;
      } else if (current === "\r" && codePoint === "\n") {
        current += codePoint;
      } else {
        result.push(current);
        current = codePoint;
        regionalIndicators = isRegionalIndicator ? 1 : 0;
      }
      if (codePoint === "\u200d") joinNext = true;
    }
    if (current) result.push(current);
    return result;
  }
  return Array.from(segmenter.segment(value), ({ segment }) => segment);
}

export function countGraphemes(text: string): number {
  const segmenter = graphemeSegmenter();
  if (!segmenter) return toGraphemes(String(text)).length;

  let count = 0;
  for (const _part of segmenter.segment(String(text))) count += 1;
  return count;
}

export function normalizeText(input: string): string {
  return String(input ?? "")
    .replace(/\r\n?/gu, "\n")
    .replace(/[\t\u00a0 ]+/gu, " ")
    .replace(/ *\n */gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim()
    .normalize("NFC");
}

export function validateText(input: string, maxLength = MAX_TEXT_LENGTH): TextValidationResult {
  if (!Number.isSafeInteger(maxLength) || maxLength < 1) {
    throw new RangeError("文字上限必須是大於 0 的整數。");
  }

  const raw = String(input ?? "");
  if (INVISIBLE_CONTROL.test(raw)) {
    return {
      ok: false,
      code: "control_character",
      message: "文字含有不可見的控制字元，請移除後再朗讀。"
    };
  }

  const text = normalizeText(raw);
  if (!text) {
    return { ok: false, code: "empty", message: "請先輸入或匯入要朗讀的文字。" };
  }

  const length = countGraphemes(text);
  if (length > maxLength) {
    return {
      ok: false,
      code: "too_long",
      length,
      message: `文字共有 ${length.toLocaleString("zh-TW")} 字，請縮短到 ${maxLength.toLocaleString("zh-TW")} 字以內。`
    };
  }

  return { ok: true, text, length };
}

export function normalizeAndValidateText(input: string, maxLength = MAX_TEXT_LENGTH): string {
  const result = validateText(input, maxLength);
  if (!result.ok) throw new TextValidationError(result.code, result.message);
  return result.text;
}

export type RomanizedTaigiValidationResult =
  | { ok: true; text: string }
  | { ok: false; message: string };

/** Normalize and admit only the exact facebook/mms-tts-nan POJ vocabulary. */
export function validateRomanizedTaigiInput(input: string): RomanizedTaigiValidationResult {
  if (NON_ROMANIZED_SCRIPT.test(input)) {
    return { ok: false, message: "POJ 直接朗讀不接受漢字；請改用「華語翻成台語」。" };
  }

  const formatted = Array.from(String(input), (character) =>
    MMS_NAN_FORMAT_MAP[character] ?? character
  ).join("");
  const punctuationAsSpaces = Array.from(formatted, (character) =>
    !MMS_NAN_ALLOWED.has(character) && /\p{Punctuation}/u.test(character)
      ? " "
      : character
  ).join("");
  const text = punctuationAsSpaces
    .split(/\s+/u)
    .filter(Boolean)
    .join(" ")
    .normalize("NFC")
    .toLowerCase();

  if (!text) {
    return { ok: false, message: "請輸入使用調符的 POJ 羅馬字。" };
  }
  const unsupported = [...new Set(Array.from(text).filter((character) =>
    !MMS_NAN_ALLOWED.has(character)
  ))];
  if (unsupported.some((character) => /[0-9]/u.test(character))) {
    return {
      ok: false,
      message: "目前不支援數字調號（例如 tai5-gi2）；請改用 á、à、â、ā 等調符 POJ。"
    };
  }
  if (unsupported.length > 0) {
    return {
      ok: false,
      message: `這個語音模型不支援字元「${unsupported.slice(0, 6).join("、")}」；請改用調符 POJ。`
    };
  }
  if (![...text].some((character) => MMS_NAN_ALLOWED.has(character) && /\p{Letter}/u.test(character))) {
    return { ok: false, message: "POJ 直接朗讀至少需要一個可朗讀的字母。" };
  }
  return { ok: true, text };
}

const SENTENCE_END = /[。！？!?；;…]/u;
const CLAUSE_END = /[，、,:：]/u;
const CLOSING_PUNCTUATION = /[」』）》”’】]/u;

function bestBreakIndex(graphemes: readonly string[], maxLength: number): number {
  const windowLength = Math.min(graphemes.length, maxLength);
  if (windowLength === graphemes.length) return windowLength;

  const minimumNaturalBreak = Math.max(1, Math.floor(maxLength * 0.4));
  let sentence = -1;
  let clause = -1;
  let whitespace = -1;

  for (let index = 0; index < windowLength; index += 1) {
    const grapheme = graphemes[index];
    if (grapheme === undefined) continue;
    const end = index + 1;
    if (SENTENCE_END.test(grapheme)) sentence = end;
    else if (sentence === index && CLOSING_PUNCTUATION.test(grapheme)) sentence = end;
    else if (CLAUSE_END.test(grapheme)) clause = end;
    else if (/\s/u.test(grapheme)) whitespace = end;
  }

  for (const candidate of [sentence, clause, whitespace]) {
    if (candidate >= minimumNaturalBreak) return candidate;
  }
  return windowLength;
}

function splitLongParagraph(paragraph: string, maxLength: number): string[] {
  const pieces: string[] = [];
  let graphemes = toGraphemes(paragraph.trim());

  while (graphemes.length > maxLength) {
    const cut = bestBreakIndex(graphemes, maxLength);
    const piece = graphemes.slice(0, cut).join("").trim();
    if (piece) pieces.push(piece);
    graphemes = graphemes.slice(cut);
    while (graphemes[0] !== undefined && /^\s$/u.test(graphemes[0])) graphemes.shift();
  }

  const remainder = graphemes.join("").trim();
  if (remainder) pieces.push(remainder);
  return pieces;
}

/**
 * Split text for incremental synthesis. Every returned segment is at most
 * maxLength user-perceived characters and boundaries never bisect a grapheme.
 */
export function splitText(input: string, maxLength = DEFAULT_SEGMENT_LENGTH): string[] {
  if (!Number.isSafeInteger(maxLength) || maxLength < 1) {
    throw new RangeError("每段字數必須是大於 0 的整數。");
  }

  const normalized = normalizeAndValidateText(input);
  const pieces = normalized
    .split(/\n+/u)
    .filter(Boolean)
    .flatMap((paragraph) => splitLongParagraph(paragraph, maxLength));

  const result: string[] = [];
  let current = "";

  for (const piece of pieces) {
    const combined = current ? `${current}\n${piece}` : piece;
    if (countGraphemes(combined) <= maxLength) {
      current = combined;
      continue;
    }
    if (current) result.push(current);
    current = piece;
  }
  if (current) result.push(current);
  return result;
}

// Compatibility with the terminology used in the older extension project.
export const chunkText = splitText;
