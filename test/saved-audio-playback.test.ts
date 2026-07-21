import { describe, expect, it, vi } from "vitest";

import type { AudioPlaybackResult } from "../src/lib/audio-player";
import { AudioCache } from "../src/lib/audio-cache";
import {
  SavedAudioPlaybackController,
  type SavedPlaybackSnapshot
} from "../src/lib/saved-audio-playback";

class FakePlayer {
  unlockCalls = 0;
  stopCalls = 0;
  played: Blob[] = [];
  private completion = Promise.withResolvers<AudioPlaybackResult>();

  unlock(): Promise<void> {
    this.unlockCalls += 1;
    return Promise.resolve();
  }

  play(audio: Blob): Promise<void> {
    this.played.push(audio);
    this.completion = Promise.withResolvers<AudioPlaybackResult>();
    return Promise.resolve();
  }

  whenFinished(): Promise<AudioPlaybackResult> {
    return this.completion.promise;
  }

  stop(): void {
    this.stopCalls += 1;
    this.completion.resolve({ reason: "stopped" });
  }

  finish(result: AudioPlaybackResult = { reason: "ended" }): void {
    this.completion.resolve(result);
  }
}

describe("saved audio playback controller", () => {
  it("unlocks synchronously, then plays a Blob loaded after the click", async () => {
    const player = new FakePlayer();
    const states: SavedPlaybackSnapshot[] = [];
    const controller = new SavedAudioPlaybackController({
      player,
      onChange: (snapshot) => states.push(snapshot)
    });
    const audio = new Blob(["saved"], { type: "audio/wav" });

    const playback = controller.play("cache-one", async () => ({ audio }));
    expect(player.unlockCalls).toBe(1);
    await vi.waitFor(() => expect(player.played).toEqual([audio]));
    expect(controller.snapshot).toMatchObject({ state: "playing", key: "cache-one" });
    player.finish();
    await playback;
    expect(controller.snapshot).toMatchObject({ state: "idle", key: null });
    expect(states.map(({ state }) => state)).toContain("loading");
  });

  it("does not let a slow stale IndexedDB load replace the newer selection", async () => {
    const player = new FakePlayer();
    const controller = new SavedAudioPlaybackController({ player });
    const first = Promise.withResolvers<{ audio: Blob } | null>();
    const second = Promise.withResolvers<{ audio: Blob } | null>();
    const firstRun = controller.play("first", () => first.promise);
    const secondRun = controller.play("second", () => second.promise);
    const secondAudio = new Blob(["second"]);

    second.resolve({ audio: secondAudio });
    await Promise.resolve();
    await Promise.resolve();
    first.resolve({ audio: new Blob(["first"]) });
    await firstRun;
    expect(player.played).toEqual([secondAudio]);
    controller.stop();
    await secondRun;
  });

  it("stops a pending load without starting late playback", async () => {
    const player = new FakePlayer();
    const controller = new SavedAudioPlaybackController({ player });
    const pending = Promise.withResolvers<{ audio: Blob } | null>();
    const run = controller.play("pending", () => pending.promise);
    controller.stop();
    pending.resolve({ audio: new Blob(["late"]) });
    await run;

    expect(player.played).toEqual([]);
    expect(controller.snapshot).toMatchObject({ state: "idle", key: null });
  });

  it("plays a Blob retrieved from IndexedDB after the cache is reopened", async () => {
    const databaseName = `saved-playback-${crypto.randomUUID()}`;
    const writer = new AudioCache({ enabled: true, databaseName });
    await writer.put({
      language: "nan-TW",
      voice: "saved-test",
      rate: 1,
      provider: "test-taigi-provider",
      text: "tsia̍h-pá--buē",
      audio: new Blob(["RIFF"], { type: "audio/wav" })
    });
    const [metadata] = await writer.list();
    writer.close();
    expect(metadata).toBeDefined();

    const reader = new AudioCache({ enabled: true, databaseName });
    const player = new FakePlayer();
    const controller = new SavedAudioPlaybackController({ player });
    const run = controller.play(metadata!.key, () => reader.get(metadata!.key));
    await vi.waitFor(() => expect(player.played).toHaveLength(1));
    expect(player.played[0]?.size).toBe(4);
    player.finish();
    await run;
    reader.close();
  });
});
