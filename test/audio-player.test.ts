import { describe, expect, it } from "vitest";

import {
  AudioQueuePlayer,
  type AudioLike,
  type AudioPlayerSnapshot
} from "../src/lib/audio-player";

class FakeAudio implements AudioLike {
  src = "";
  currentTime = 0;
  playCalls = 0;
  pauseCalls = 0;
  loadCalls = 0;
  private readonly listeners = new Map<string, Set<EventListener>>();

  play(): Promise<void> {
    this.playCalls += 1;
    return Promise.resolve();
  }

  pause(): void {
    this.pauseCalls += 1;
  }

  load(): void {
    this.loadCalls += 1;
  }

  removeAttribute(name: string): void {
    if (name === "src") this.src = "";
  }

  addEventListener(type: "ended" | "error", listener: EventListener): void {
    const values = this.listeners.get(type) ?? new Set<EventListener>();
    values.add(listener);
    this.listeners.set(type, values);
  }

  removeEventListener(type: "ended" | "error", listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: "ended" | "error"): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(new Event(type));
  }
}

describe("AudioQueuePlayer", () => {
  it("unlocks its reusable media element during a user gesture", async () => {
    const audio = new FakeAudio();
    const revoked: string[] = [];
    const player = new AudioQueuePlayer({
      audio,
      createObjectURL: (blob) => {
        expect(blob.type).toBe("audio/wav");
        expect(blob.size).toBeGreaterThan(44);
        return "blob:silent-unlock";
      },
      revokeObjectURL: (url) => revoked.push(url)
    });

    const unlocked = player.unlock();
    expect(audio.playCalls).toBe(1);
    await unlocked;
    expect(audio.src).toBe("");
    expect(revoked).toEqual(["blob:silent-unlock"]);

    await player.unlock();
    expect(audio.playCalls).toBe(1);
  });

  it("plays queued audio in order and resolves when the last item ends", async () => {
    const audio = new FakeAudio();
    const tracks: string[] = [];
    const states: AudioPlayerSnapshot[] = [];
    const player = new AudioQueuePlayer({
      audio,
      onTrackChange: (item) => tracks.push(item.id ?? ""),
      onChange: (snapshot) => states.push(snapshot)
    });

    await player.play([
      { id: "one", audio: "one.wav" },
      { id: "two", audio: "two.wav" }
    ]);
    expect(player.state).toBe("playing");
    expect(audio.src).toBe("one.wav");
    audio.dispatch("ended");
    await Promise.resolve();
    expect(audio.src).toBe("two.wav");
    expect(audio.playCalls).toBe(2);
    audio.dispatch("ended");
    await expect(player.whenFinished()).resolves.toEqual({ reason: "ended" });
    expect(player.state).toBe("ended");
    expect(tracks).toEqual(["one", "two"]);
    expect(states.some(({ state }) => state === "loading")).toBe(true);
  });

  it("pauses, resumes, skips, and stops without stale playback", async () => {
    const audio = new FakeAudio();
    const player = new AudioQueuePlayer({ audio });
    await player.play(["one.wav", "two.wav", "three.wav"]);
    player.pause();
    expect(player.state).toBe("paused");
    await player.skip();
    expect(player.currentIndex).toBe(1);
    expect(player.state).toBe("paused");
    expect(audio.src).toBe("two.wav");
    await player.resume();
    expect(player.state).toBe("playing");
    player.stop();
    expect(player.snapshot).toMatchObject({ state: "stopped", currentIndex: -1, total: 0 });
    await expect(player.whenFinished()).resolves.toEqual({ reason: "stopped" });
  });

  it("revokes generated object URLs on track changes", async () => {
    const audio = new FakeAudio();
    const revoked: string[] = [];
    let next = 0;
    const player = new AudioQueuePlayer({
      audio,
      createObjectURL: () => `blob:test-${++next}`,
      revokeObjectURL: (url) => revoked.push(url)
    });
    await player.play([new Blob(["one"]), new Blob(["two"])]);
    audio.dispatch("ended");
    await Promise.resolve();
    expect(revoked).toEqual(["blob:test-1"]);
    player.stop();
    expect(revoked).toEqual(["blob:test-1", "blob:test-2"]);
  });
});
