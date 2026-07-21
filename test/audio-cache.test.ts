import { describe, expect, it } from "vitest";

import { AudioCache, createAudioCacheKey, type AudioCacheKeyParts } from "../src/lib/audio-cache";

const base: AudioCacheKeyParts = {
  language: "nan-TW",
  voice: "mms-tts-nan",
  rate: 1,
  provider: "ollama+mms",
  text: "食飽未？"
};

function databaseName(): string {
  return `awei-audio-test-${crypto.randomUUID()}`;
}

describe("AudioCache", () => {
  it("is opt-in and keys every synthesis input dimension", async () => {
    const cache = new AudioCache({ databaseName: databaseName() });
    const disabled = await cache.put({ ...base, audio: new Blob(["1234"], { type: "audio/wav" }) });
    expect(disabled).toMatchObject({ saved: false, reason: "disabled" });
    expect(await cache.list()).toEqual([]);

    const baseline = await createAudioCacheKey(base);
    await expect(createAudioCacheKey({ ...base, language: "zh-TW" })).resolves.not.toBe(baseline);
    await expect(createAudioCacheKey({ ...base, voice: "another" })).resolves.not.toBe(baseline);
    await expect(createAudioCacheKey({ ...base, rate: 1.25 })).resolves.not.toBe(baseline);
    await expect(createAudioCacheKey({ ...base, provider: "other" })).resolves.not.toBe(baseline);
    await expect(createAudioCacheKey({ ...base, text: "無仝款" })).resolves.not.toBe(baseline);
    cache.close();
  });

  it("stores and retrieves an opted-in audio Blob", async () => {
    const cache = new AudioCache({ enabled: true, databaseName: databaseName() });
    const saved = await cache.put({
      ...base,
      taigiText: "Tsia̍h-pá--buē?",
      audio: new Blob(["RIFF"], { type: "audio/wav" })
    });
    expect(saved.saved).toBe(true);
    const found = await cache.get(base);
    expect(found).toMatchObject({ text: base.text, provider: base.provider, bytes: 4, taigiText: "Tsia̍h-pá--buē?" });
    expect(found?.audio).toBeInstanceOf(Blob);
    cache.close();
  });

  it("reports an oversized segment without writing it", async () => {
    const cache = new AudioCache({ enabled: true, databaseName: databaseName(), maxBytes: 3 });
    await expect(cache.put({
      ...base,
      audio: new Blob(["1234"], { type: "audio/wav" })
    })).resolves.toEqual({ saved: false, reason: "too_large", bytes: 4 });
    await expect(cache.list()).resolves.toEqual([]);
    cache.close();
  });

  it("evicts the least recently used audio over the byte limit", async () => {
    let now = 1;
    const cache = new AudioCache({
      enabled: true,
      databaseName: databaseName(),
      maxBytes: 8,
      now: () => now
    });
    const put = (text: string) => cache.put({ ...base, text, audio: new Blob(["1234"], { type: "audio/wav" }) });
    await put("甲");
    now += 1;
    await put("乙");
    now += 1;
    await cache.get({ ...base, text: "甲" });
    now += 1;
    const result = await put("丙");
    expect(result.saved && result.evictedKeys).toHaveLength(1);
    expect((await cache.list()).map(({ text }) => text)).toEqual(["丙", "甲"]);
    expect(await cache.get({ ...base, text: "乙" })).toBeNull();
    cache.close();
  });

  it("expires entries after seven-day-style TTL and supports delete/clear", async () => {
    let now = 0;
    const cache = new AudioCache({
      enabled: true,
      databaseName: databaseName(),
      ttlMs: 10,
      now: () => now
    });
    await cache.put({ ...base, text: "甲", audio: new Blob(["1"]) });
    await cache.put({ ...base, text: "乙", audio: new Blob(["2"]) });
    await cache.delete({ ...base, text: "甲" });
    expect((await cache.list()).map(({ text }) => text)).toEqual(["乙"]);
    now = 11;
    expect(await cache.list()).toEqual([]);
    await cache.put({ ...base, text: "丙", audio: new Blob(["3"]) });
    await cache.clear();
    expect(await cache.estimate()).toMatchObject({ bytes: 0, entries: 0 });
    cache.close();
  });
});
