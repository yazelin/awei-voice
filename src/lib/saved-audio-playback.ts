import type { AudioPlaybackResult, AudioQueuePlayer } from "./audio-player";

export type SavedPlaybackState = "idle" | "loading" | "playing" | "error";

export interface SavedPlaybackSnapshot {
  state: SavedPlaybackState;
  key: string | null;
  message: string;
}

export interface SavedAudioValue {
  audio: Blob;
}

type PlaybackPlayer = Pick<
  AudioQueuePlayer,
  "unlock" | "play" | "whenFinished" | "stop"
>;

export interface SavedAudioPlaybackOptions {
  player: PlaybackPlayer;
  beforePlay?: () => void | Promise<void>;
  onChange?: (snapshot: SavedPlaybackSnapshot) => void;
}

export function configureSavedPlaybackButton(
  button: HTMLButtonElement,
  snapshot: SavedPlaybackSnapshot,
  key: string,
  position: number
): boolean {
  const active = snapshot.key === key &&
    (snapshot.state === "loading" || snapshot.state === "playing");
  button.type = "button";
  button.textContent = active ? "停止" : "播放";
  button.setAttribute(
    "aria-label",
    `${active ? "停止" : "播放"}第 ${position + 1} 段已保存語音`
  );
  return active;
}

/** Coordinates user activation, IndexedDB loading, replacement and stop races. */
export class SavedAudioPlaybackController {
  private readonly player: PlaybackPlayer;
  private readonly beforePlay?: () => void | Promise<void>;
  private readonly onChange?: (snapshot: SavedPlaybackSnapshot) => void;
  private generation = 0;
  private unlockPromise: Promise<void> | null = null;
  private snapshotValue: SavedPlaybackSnapshot = {
    state: "idle",
    key: null,
    message: ""
  };

  constructor(options: SavedAudioPlaybackOptions) {
    this.player = options.player;
    this.beforePlay = options.beforePlay;
    this.onChange = options.onChange;
  }

  get snapshot(): SavedPlaybackSnapshot {
    return this.snapshotValue;
  }

  private emit(state: SavedPlaybackState, key: string | null, message: string): void {
    this.snapshotValue = { state, key, message };
    this.onChange?.(this.snapshotValue);
  }

  private unlockFromGesture(): Promise<void> {
    if (!this.unlockPromise) {
      this.unlockPromise = this.player.unlock().catch((error: unknown) => {
        this.unlockPromise = null;
        throw error;
      });
    }
    return this.unlockPromise;
  }

  async play(
    key: string,
    load: () => Promise<SavedAudioValue | null>
  ): Promise<void> {
    const normalizedKey = key.trim();
    if (!normalizedKey) throw new TypeError("保存語音缺少識別碼。");

    const run = ++this.generation;
    this.player.stop();
    // Must start before the first await while the click still has user activation.
    const unlock = this.unlockFromGesture();
    const preparation = (() => {
      try {
        return Promise.resolve(this.beforePlay?.());
      } catch (error) {
        return Promise.reject(error);
      }
    })();
    const loaded = (() => {
      try {
        return Promise.resolve(load());
      } catch (error) {
        return Promise.reject(error);
      }
    })();
    this.emit("loading", normalizedKey, "正在讀取這台裝置保存的語音…");

    try {
      const [, , value] = await Promise.all([unlock, preparation, loaded]);
      if (run !== this.generation) return;
      if (!value || value.audio.size === 0) {
        throw new Error("找不到這段已保存的語音，可能已被清除。");
      }
      await this.player.play(value.audio);
      if (run !== this.generation) return;
      this.emit("playing", normalizedKey, "正在播放已保存的語音");
      const outcome: AudioPlaybackResult = await this.player.whenFinished();
      if (run !== this.generation) return;
      if (outcome.reason === "error") {
        throw outcome.error ?? new Error("已保存的音訊無法播放。");
      }
      if (outcome.reason === "ended") {
        this.emit("idle", null, "已保存的語音播放完畢");
      } else {
        this.emit("idle", null, "已停止播放保存的語音");
      }
    } catch (error) {
      if (run !== this.generation) return;
      const message = error instanceof Error && error.message
        ? error.message
        : "已保存的語音無法播放。";
      this.player.stop();
      this.emit("error", normalizedKey, message);
    }
  }

  stop(message = "已停止播放保存的語音"): void {
    this.generation += 1;
    this.player.stop();
    this.emit("idle", null, message);
  }
}
