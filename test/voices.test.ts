import { describe, expect, it } from "vitest";

import {
  classifyVoice,
  findMandarinVoices,
  findTaigiVoices,
  isMandarinVoice,
  isTaigiVoice,
  loadVoices,
  type VoiceLike,
  type VoiceSource
} from "../src/lib/voices";

function voice(name: string, lang: string, voiceURI = name): VoiceLike {
  return { name, lang, voiceURI, localService: true, default: false };
}

describe("voice classification", () => {
  it("accepts Taiwan Mandarin but never zh-CN or zh-HK", () => {
    expect(isMandarinVoice(voice("臺灣中文", "zh-TW"))).toBe(true);
    expect(isMandarinVoice(voice("臺灣中文", "zh-Hant-TW"))).toBe(true);
    expect(isMandarinVoice(voice("中國中文", "zh-CN"))).toBe(false);
    expect(isMandarinVoice(voice("香港中文", "zh-HK"))).toBe(false);
  });

  it("only accepts nan-TW or an explicit Taiwanese Hokkien label as Taigi", () => {
    expect(isTaigiVoice(voice("Local Nan", "nan-TW"))).toBe(true);
    expect(isTaigiVoice(voice("Taiwanese Hokkien", "zh-TW"))).toBe(true);
    expect(isTaigiVoice(voice("臺語", "nan"))).toBe(true);
    expect(isTaigiVoice(voice("Hokkien", "nan-CN"))).toBe(false);
    expect(isTaigiVoice(voice("Taiwanese Mandarin", "zh-TW"))).toBe(false);
  });

  it("does not return an explicitly Taigi-labelled zh-TW voice as Mandarin", () => {
    const voices = [
      voice("台灣國語", "zh-TW", "mandarin"),
      voice("Taiwanese Hokkien", "zh-TW", "hokkien"),
      voice("中國普通話", "zh-CN", "china")
    ];
    expect(findMandarinVoices(voices).map(({ voiceURI }) => voiceURI)).toEqual(["mandarin"]);
    expect(findTaigiVoices(voices).map(({ voiceURI }) => voiceURI)).toEqual(["hokkien"]);
    expect(classifyVoice(voices[1]!)).toBe("taigi");
  });

  it("waits for voiceschanged when the initial list is empty", async () => {
    let current: SpeechSynthesisVoice[] = [];
    let listener: EventListener | null = null;
    const expected = voice("台灣國語", "zh-TW") as SpeechSynthesisVoice;
    const source: VoiceSource = {
      getVoices: () => current,
      addEventListener: (_type, next) => { listener = next; },
      removeEventListener: () => { listener = null; }
    };

    const pending = loadVoices(source, 1_000);
    current = [expected];
    (listener as EventListener | null)?.(new Event("voiceschanged"));
    await expect(pending).resolves.toEqual([expected]);
    expect(listener).toBeNull();
  });
});
