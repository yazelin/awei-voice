import { describe, expect, it, vi } from "vitest";

import {
  BackendError,
  clearSessionToken,
  createBackendClient,
  loadSessionToken,
  saveSessionToken,
  validateBackendHealth,
  validateEndpoint
} from "../src/lib/backend";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

const realHealth = {
  status: "ok",
  mode: "concrete",
  translator: "ollama:taigi-translator",
  synthesizer: "mms:facebook/mms-tts-nan"
};
const provider = `${realHealth.translator}+${realHealth.synthesizer}`;

describe("backend endpoint and identity", () => {
  it("allows HTTPS and exact localhost HTTP only", () => {
    expect(validateEndpoint("https://voice.example/api/")).toBe("https://voice.example/api");
    expect(validateEndpoint("http://localhost:8000")).toBe("http://localhost:8000");
    expect(validateEndpoint("http://127.0.0.1:8000/")).toBe("http://127.0.0.1:8000");
    expect(() => validateEndpoint("http://voice.example")).toThrowError(BackendError);
    expect(() => validateEndpoint("http://localhost.example")).toThrowError(BackendError);
    expect(() => validateEndpoint("https://user:secret@voice.example")).toThrow(/帳號或密碼/u);
  });

  it("rejects a healthy generic or mock provider", () => {
    expect(validateBackendHealth(realHealth)).toMatchObject({ provider, targetLanguages: ["nan-TW"] });
    expect(() => validateBackendHealth({
      ...realHealth,
      synthesizer: "generic-zh-voice",
      target_languages: ["zh-TW"]
    })).toThrow(/nan-TW/u);
    expect(() => validateBackendHealth({
      ...realHealth,
      translator: "taigi-translator",
      synthesizer: "generic-voice"
    })).toThrow(/nan-TW/u);
    expect(() => validateBackendHealth({ ...realHealth, mode: "mock" })).toThrow(/測試音訊/u);

    expect(validateBackendHealth({
      status: "ok",
      mode: "mock",
      translator: "mock:taigi-translator",
      synthesizer: "mock:wav-synthesizer"
    }, true)).toMatchObject({
      provider: "mock:taigi-translator+mock:wav-synthesizer",
      isTestProvider: true,
      targetLanguages: ["nan-TW"]
    });
  });

  it("stores credentials only through the supplied session storage", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); }
    };
    saveSessionToken(" secret ", storage);
    expect(loadSessionToken(storage)).toBe("secret");
    clearSessionToken(storage);
    expect(loadSessionToken(storage)).toBeNull();
  });
});

describe("async backend client", () => {
  it("verifies health without a credential, then polls with Bearer auth", async () => {
    let polls = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/health")) return json(realHealth);
      if (init?.method === "POST") return json({ job_id: "job-1", status: "pending" }, 202);
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      polls += 1;
      if (polls === 1) return json({ job_id: "job-1", status: "pending" });
      return json({
        job_id: "job-1",
        status: "completed",
        result: {
          taigi_text: "Tsit-ê sī Tâi-gí.",
          audio_base64: btoa("RIFF"),
          mime_type: "audio/wav",
          provider
        }
      });
    });
    const client = createBackendClient({
      baseUrl: "https://voice.example",
      token: "private-token",
      fetchImpl: fetchImpl as typeof fetch,
      delay: async () => undefined
    });

    const result = await client.synthesize({ text: "這是台語。", rate: 1 });
    expect(result.taigiText).toBe("Tsit-ê sī Tâi-gí.");
    expect(result.audio.size).toBe(4);
    const calls = fetchImpl.mock.calls;
    expect(new Headers(calls[0]![1]?.headers).has("Authorization")).toBe(false);
    expect(calls.slice(1).every((call) =>
      new Headers(call[1]?.headers).get("Authorization") === "Bearer private-token"
    )).toBe(true);
    expect(JSON.parse(String(calls[1]![1]?.body))).toMatchObject({
      source_language: "zh-TW",
      target_language: "nan-TW"
    });
    const deletes = calls.filter(([, init]) => init?.method === "DELETE");
    expect(deletes).toHaveLength(1);
    expect(String(deletes[0]![0])).toBe("https://voice.example/v1/synthesis-jobs/job-1");
  });

  it("does not send an over-limit segment", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const client = createBackendClient({ baseUrl: "https://voice.example", fetchImpl });
    await expect(client.synthesize("字".repeat(281))).rejects.toThrow(/280/u);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("aborts polling and deletes the active job on cancel", async () => {
    let pollingWasAborted = false;
    const delayStarted = Promise.withResolvers<void>();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/health")) return json(realHealth);
      if (init?.method === "POST") return json({ job_id: "job-cancel", status: "pending" }, 202);
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return json({ job_id: "job-cancel", status: "pending" });
    });
    const client = createBackendClient({
      baseUrl: "https://voice.example",
      fetchImpl: fetchImpl as typeof fetch,
      delay: (_milliseconds, signal) => {
        delayStarted.resolve();
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            pollingWasAborted = signal.aborted;
            reject(new DOMException("cancelled", "AbortError"));
          }, { once: true });
        });
      }
    });

    const synthesis = client.synthesize("請停止這一段。");
    await delayStarted.promise;
    await client.cancel();
    await expect(synthesis).rejects.toMatchObject({ name: "AbortError" });
    expect(pollingWasAborted).toBe(true);
    expect(fetchImpl.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(true);
  });
});
