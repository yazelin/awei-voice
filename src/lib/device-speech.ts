export interface DeviceVoiceLike {
  name: string;
  lang: string;
  voiceURI?: string;
}

export interface UtteranceLike {
  text: string;
  voice: SpeechSynthesisVoice | null;
  lang: string;
  rate: number;
  pitch: number;
  volume: number;
  onend: ((event: Event) => void) | null;
  onerror: ((event: SpeechSynthesisErrorEvent) => void) | null;
}

export interface SpeechSynthesisLike {
  paused: boolean;
  speaking: boolean;
  speak(utterance: SpeechSynthesisUtterance): void;
  cancel(): void;
  pause(): void;
  resume(): void;
}

export interface SpeakOptions {
  voice: SpeechSynthesisVoice;
  rate: number;
  signal?: AbortSignal;
}

export function speechAbortError(): DOMException {
  return new DOMException("朗讀已停止。", "AbortError");
}

export class DeviceSpeechEngine {
  readonly #synthesis: SpeechSynthesisLike;
  readonly #makeUtterance: (text: string) => SpeechSynthesisUtterance;
  #activeReject: ((reason?: unknown) => void) | null = null;
  #generation = 0;

  constructor(
    synthesis: SpeechSynthesisLike = window.speechSynthesis,
    makeUtterance: (text: string) => SpeechSynthesisUtterance = (text) =>
      new SpeechSynthesisUtterance(text)
  ) {
    this.#synthesis = synthesis;
    this.#makeUtterance = makeUtterance;
  }

  get paused(): boolean {
    return this.#synthesis.paused;
  }

  get speaking(): boolean {
    return this.#synthesis.speaking;
  }

  speak(text: string, { voice, rate, signal }: SpeakOptions): Promise<void> {
    const cleanText = text.trim();
    if (!cleanText) return Promise.reject(new Error("沒有可以朗讀的文字。"));
    if (!Number.isFinite(rate) || rate < 0.5 || rate > 2) {
      return Promise.reject(new Error("朗讀速度必須介於 0.5 到 2 倍。"));
    }

    this.stop();
    if (signal?.aborted) return Promise.reject(speechAbortError());
    const generation = ++this.#generation;
    const utterance = this.#makeUtterance(cleanText);
    utterance.voice = voice;
    utterance.lang = voice.lang;
    utterance.rate = rate;
    utterance.pitch = 1;
    utterance.volume = 1;

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (outcome?: unknown) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", aborted);
        if (this.#activeReject === reject) this.#activeReject = null;
        utterance.onend = null;
        utterance.onerror = null;
        if (outcome === undefined) resolve();
        else reject(outcome);
      };
      const aborted = () => {
        if (generation !== this.#generation) return;
        this.#generation += 1;
        this.#synthesis.cancel();
        finish(speechAbortError());
      };

      this.#activeReject = reject;
      utterance.onend = () => {
        if (generation === this.#generation) finish();
      };
      utterance.onerror = (event) => {
        if (generation !== this.#generation) return;
        const code = event.error || "unknown";
        finish(new Error(`裝置語音無法朗讀（${code}）。`));
      };
      signal?.addEventListener("abort", aborted, { once: true });

      try {
        this.#synthesis.speak(utterance);
      } catch (error) {
        finish(error instanceof Error ? error : new Error("裝置語音無法啟動。"));
      }
    });
  }

  pause(): void {
    if (this.#synthesis.speaking && !this.#synthesis.paused) {
      this.#synthesis.pause();
    }
  }

  resume(): void {
    if (this.#synthesis.paused) this.#synthesis.resume();
  }

  stop(): void {
    if (!this.#activeReject && !this.#synthesis.speaking) return;
    this.#generation += 1;
    const reject = this.#activeReject;
    this.#activeReject = null;
    this.#synthesis.cancel();
    reject?.(speechAbortError());
  }
}

