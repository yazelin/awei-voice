export type AudioQueueSource = Blob | string;

export interface AudioQueueItem {
  id?: string;
  audio: AudioQueueSource;
  label?: string;
}

export type AudioQueueInput = AudioQueueItem | AudioQueueSource;
export type AudioPlayerState = "idle" | "loading" | "playing" | "paused" | "stopped" | "ended" | "error";

export interface AudioPlayerSnapshot {
  state: AudioPlayerState;
  currentIndex: number;
  total: number;
  current: AudioQueueItem | null;
  error: string | null;
}

export interface AudioPlaybackResult {
  reason: "ended" | "stopped" | "replaced" | "error";
  error?: Error;
}

export interface AudioLike {
  src: string;
  currentTime: number;
  play(): Promise<void> | void;
  pause(): void;
  load?(): void;
  removeAttribute?(name: string): void;
  addEventListener(type: "ended" | "error", listener: EventListener): void;
  removeEventListener(type: "ended" | "error", listener: EventListener): void;
}

export interface AudioQueuePlayerOptions {
  audio?: AudioLike;
  createAudio?: () => AudioLike;
  createObjectURL?: (blob: Blob) => string;
  revokeObjectURL?: (url: string) => void;
  onChange?: (snapshot: AudioPlayerSnapshot) => void;
  onTrackChange?: (item: AudioQueueItem, index: number, total: number) => void;
}

interface NormalizedQueueItem extends AudioQueueItem {
  id: string;
}

function defaultAudio(): AudioLike {
  if (typeof Audio !== "function") throw new Error("目前環境無法播放音訊。");
  return new Audio();
}

/** A short, uncompressed silent clip used only to unlock the same media element. */
function silentWav(): Blob {
  const sampleRate = 8_000;
  const sampleCount = 800;
  const bytesPerSample = 2;
  const dataSize = sampleCount * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, value: string): void => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, bytesPerSample * 8, true);
  writeAscii(36, "data");
  view.setUint32(40, dataSize, true);
  return new Blob([buffer], { type: "audio/wav" });
}

function itemFor(input: AudioQueueInput, index: number): NormalizedQueueItem {
  if (typeof input === "string" || input instanceof Blob) {
    return { id: `segment-${index + 1}`, audio: input };
  }
  if (!input || !(typeof input.audio === "string" || input.audio instanceof Blob)) {
    throw new TypeError("播放佇列含有無效的音訊。");
  }
  return { ...input, id: input.id?.trim() || `segment-${index + 1}` };
}

export class AudioQueuePlayer {
  private readonly audio: AudioLike;
  private readonly createObjectURL: (blob: Blob) => string;
  private readonly revokeObjectURL: (url: string) => void;
  private readonly onChange?: (snapshot: AudioPlayerSnapshot) => void;
  private readonly onTrackChange?: (item: AudioQueueItem, index: number, total: number) => void;

  private queue: NormalizedQueueItem[] = [];
  private index = -1;
  private stateValue: AudioPlayerState = "idle";
  private errorValue: Error | null = null;
  private objectUrl = "";
  private generation = 0;
  private endedListener: EventListener | null = null;
  private errorListener: EventListener | null = null;
  private finishPromise: Promise<AudioPlaybackResult> = Promise.resolve({ reason: "ended" });
  private finishResolver: ((result: AudioPlaybackResult) => void) | null = null;
  private unlocked = false;

  constructor(options: AudioQueuePlayerOptions = {}) {
    this.audio = options.audio ?? options.createAudio?.() ?? defaultAudio();
    this.createObjectURL = options.createObjectURL ?? ((blob) => URL.createObjectURL(blob));
    this.revokeObjectURL = options.revokeObjectURL ?? ((url) => URL.revokeObjectURL(url));
    this.onChange = options.onChange;
    this.onTrackChange = options.onTrackChange;
  }

  get state(): AudioPlayerState {
    return this.stateValue;
  }

  get currentIndex(): number {
    return this.index;
  }

  get total(): number {
    return this.queue.length;
  }

  get current(): AudioQueueItem | null {
    return this.queue[this.index] ?? null;
  }

  get snapshot(): AudioPlayerSnapshot {
    return {
      state: this.stateValue,
      currentIndex: this.index,
      total: this.queue.length,
      current: this.current,
      error: this.errorValue?.message ?? null
    };
  }

  whenFinished(): Promise<AudioPlaybackResult> {
    return this.finishPromise;
  }

  /**
   * Call synchronously from the user's click/submit handler before awaiting a
   * remote synthesis job. Mobile browsers may otherwise reject the eventual
   * play() after transient user activation has expired.
   */
  async unlock(): Promise<void> {
    if (this.unlocked) return;
    this.generation += 1;
    this.resetElement();
    try {
      this.objectUrl = this.createObjectURL(silentWav());
      this.audio.src = this.objectUrl;
      this.audio.load?.();
      await Promise.resolve(this.audio.play());
      this.unlocked = true;
    } catch (error) {
      const resolved = error instanceof Error ? error : new Error("瀏覽器不允許播放音訊。");
      throw new Error("瀏覽器尚未允許播放台語音訊，請再按一次「開始朗讀」。", {
        cause: resolved
      });
    } finally {
      this.resetElement();
    }
  }

  private emit(): void {
    this.onChange?.(this.snapshot);
  }

  private setState(state: AudioPlayerState, error: Error | null = null): void {
    this.stateValue = state;
    this.errorValue = error;
    this.emit();
  }

  private settle(result: AudioPlaybackResult): void {
    const resolve = this.finishResolver;
    this.finishResolver = null;
    resolve?.(result);
  }

  private detachTrackListeners(): void {
    if (this.endedListener) this.audio.removeEventListener("ended", this.endedListener);
    if (this.errorListener) this.audio.removeEventListener("error", this.errorListener);
    this.endedListener = null;
    this.errorListener = null;
  }

  private releaseObjectUrl(): void {
    if (this.objectUrl) this.revokeObjectURL(this.objectUrl);
    this.objectUrl = "";
  }

  private resetElement(): void {
    this.audio.pause();
    this.detachTrackListeners();
    this.releaseObjectUrl();
    try {
      this.audio.currentTime = 0;
    } catch {
      // Some media elements reject currentTime changes before metadata loads.
    }
    this.audio.removeAttribute?.("src");
    if (!this.audio.removeAttribute) this.audio.src = "";
    this.audio.load?.();
  }

  private sourceFor(item: NormalizedQueueItem): string {
    if (typeof item.audio === "string") return item.audio;
    this.objectUrl = this.createObjectURL(item.audio);
    return this.objectUrl;
  }

  private finishNaturally(): void {
    this.generation += 1;
    this.resetElement();
    this.setState("ended");
    this.settle({ reason: "ended" });
  }

  private fail(error: unknown): void {
    const resolved = error instanceof Error ? error : new Error("音訊格式無法播放。");
    this.generation += 1;
    this.resetElement();
    this.setState("error", resolved);
    this.settle({ reason: "error", error: resolved });
  }

  private async attemptPlay(generation: number): Promise<void> {
    try {
      await Promise.resolve(this.audio.play());
      if (generation === this.generation && this.stateValue === "loading") this.setState("playing");
    } catch (error) {
      if (generation !== this.generation) return;
      if (this.stateValue === "paused" && error instanceof Error && error.name === "AbortError") return;
      this.fail(error);
      throw error;
    }
  }

  private async loadCurrent(autoplay: boolean): Promise<void> {
    const item = this.queue[this.index];
    if (!item) {
      this.finishNaturally();
      return;
    }

    const generation = ++this.generation;
    this.resetElement();
    try {
      this.audio.src = this.sourceFor(item);
      this.audio.load?.();
    } catch (error) {
      this.fail(error);
      throw error;
    }

    this.endedListener = () => {
      if (generation !== this.generation) return;
      if (this.index + 1 >= this.queue.length) {
        this.finishNaturally();
        return;
      }
      this.index += 1;
      void this.loadCurrent(true).catch(() => undefined);
    };
    this.errorListener = () => {
      if (generation === this.generation) this.fail(new Error("音訊格式無法播放。"));
    };
    this.audio.addEventListener("ended", this.endedListener);
    this.audio.addEventListener("error", this.errorListener);
    this.onTrackChange?.(item, this.index, this.queue.length);

    if (!autoplay) {
      this.setState("paused");
      return;
    }
    this.setState("loading");
    await this.attemptPlay(generation);
  }

  async play(inputs: readonly AudioQueueInput[] | AudioQueueInput, startIndex = 0): Promise<void> {
    const source = Array.isArray(inputs) ? inputs : [inputs];
    if (source.length === 0) throw new RangeError("播放佇列不可為空。");
    if (!Number.isSafeInteger(startIndex) || startIndex < 0 || startIndex >= source.length) {
      throw new RangeError("開始播放的段落位置不正確。");
    }

    if (this.finishResolver) this.settle({ reason: "replaced" });
    this.generation += 1;
    this.resetElement();
    this.queue = source.map(itemFor);
    this.index = startIndex;
    this.finishPromise = new Promise((resolve) => { this.finishResolver = resolve; });
    await this.loadCurrent(true);
  }

  enqueue(inputs: readonly AudioQueueInput[] | AudioQueueInput): void {
    const source = Array.isArray(inputs) ? inputs : [inputs];
    const offset = this.queue.length;
    this.queue.push(...source.map((item, index) => itemFor(item, offset + index)));
    this.emit();
  }

  pause(): void {
    if (this.stateValue !== "playing" && this.stateValue !== "loading") return;
    // Record pause intent before pause(), since it can reject a pending play().
    this.setState("paused");
    this.audio.pause();
  }

  async resume(): Promise<void> {
    if (this.stateValue !== "paused" || this.index < 0) return;
    const generation = this.generation;
    this.setState("loading");
    await this.attemptPlay(generation);
  }

  stop(): void {
    if (this.stateValue === "idle" || (this.stateValue === "stopped" && this.queue.length === 0)) return;
    this.generation += 1;
    this.resetElement();
    this.queue = [];
    this.index = -1;
    this.setState("stopped");
    this.settle({ reason: "stopped" });
  }

  async skip(offset = 1): Promise<void> {
    if (!Number.isSafeInteger(offset) || offset === 0) return;
    if (this.index < 0 || this.queue.length === 0) return;
    const target = this.index + offset;
    if (target >= this.queue.length) {
      this.finishNaturally();
      return;
    }
    const paused = this.stateValue === "paused";
    this.index = Math.max(0, target);
    await this.loadCurrent(!paused);
  }

  next(): Promise<void> {
    return this.skip(1);
  }

  previous(): Promise<void> {
    return this.skip(-1);
  }

  async skipTo(index: number): Promise<void> {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.queue.length) {
      throw new RangeError("指定的段落位置不正確。");
    }
    if (this.index < 0) return;
    await this.skip(index - this.index);
  }
}
