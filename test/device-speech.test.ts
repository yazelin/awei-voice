import { describe, expect, it, vi } from "vitest";

import {
  DeviceSpeechEngine,
  type SpeechSynthesisLike,
  type UtteranceLike
} from "../src/lib/device-speech";

function fixture() {
  let latest: UtteranceLike | undefined;
  const synthesis: SpeechSynthesisLike = {
    paused: false,
    speaking: false,
    speak: vi.fn((utterance: SpeechSynthesisUtterance) => {
      latest = utterance as unknown as UtteranceLike;
      synthesis.speaking = true;
    }),
    cancel: vi.fn(() => {
      synthesis.speaking = false;
      synthesis.paused = false;
    }),
    pause: vi.fn(() => {
      synthesis.paused = true;
    }),
    resume: vi.fn(() => {
      synthesis.paused = false;
    })
  };
  const makeUtterance = (text: string) =>
    ({
      text,
      voice: null,
      lang: "",
      rate: 1,
      pitch: 1,
      volume: 1,
      onend: null,
      onerror: null
    }) as unknown as SpeechSynthesisUtterance;
  return {
    engine: new DeviceSpeechEngine(synthesis, makeUtterance),
    synthesis,
    latest: () => latest
  };
}

const voice = {
  default: false,
  lang: "zh-TW",
  localService: true,
  name: "台灣國語",
  voiceURI: "tw"
} as SpeechSynthesisVoice;

describe("DeviceSpeechEngine", () => {
  it("套用指定 voice 與速度，並在 onend 後完成", async () => {
    const { engine, latest } = fixture();
    const speaking = engine.speak("你好", { voice, rate: 0.75 });
    expect(latest()?.voice).toBe(voice);
    expect(latest()?.lang).toBe("zh-TW");
    expect(latest()?.rate).toBe(0.75);
    latest()?.onend?.(new Event("end"));
    await expect(speaking).resolves.toBeUndefined();
  });

  it("停止時取消裝置語音並以 AbortError 結束", async () => {
    const { engine, synthesis } = fixture();
    const speaking = engine.speak("一段文字", { voice, rate: 1 });
    engine.stop();
    await expect(speaking).rejects.toMatchObject({ name: "AbortError" });
    expect(synthesis.cancel).toHaveBeenCalled();
  });

  it("支援暫停與繼續", () => {
    const { engine, synthesis } = fixture();
    void engine.speak("一段文字", { voice, rate: 1 }).catch(() => undefined);
    engine.pause();
    expect(synthesis.pause).toHaveBeenCalled();
    engine.resume();
    expect(synthesis.resume).toHaveBeenCalled();
    engine.stop();
  });

  it("拒絕不安全的速度", async () => {
    const { engine } = fixture();
    await expect(engine.speak("你好", { voice, rate: 3 })).rejects.toThrow(
      "朗讀速度"
    );
  });
});

