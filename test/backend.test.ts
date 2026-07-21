import { describe, expect, it, vi } from "vitest";

import {
  BackendError,
  clearSessionToken,
  createBackendClient,
  loadSessionToken,
  saveSessionToken,
  sessionTokenKeyForEndpoint,
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
const mandarinSynthesizer = "edge-tts-online-unofficial:zh-TW-HsiaoChenNeural";
const directTaigiProvider = `direct:nan-Latn-TW+${realHealth.synthesizer}`;
const mandarinProvider = `direct:zh-TW+${mandarinSynthesizer}`;
const multilingualHealth = {
  ...realHealth,
  mandarin_synthesizer: mandarinSynthesizer,
  source_languages: ["zh-TW", "nan-Latn-TW"],
  target_languages: ["nan-TW", "zh-TW"],
  capabilities: [
    {
      source_language: "zh-TW",
      target_language: "nan-TW",
      mode: "translate-to-taigi",
      provider
    },
    {
      source_language: "nan-Latn-TW",
      target_language: "nan-TW",
      mode: "read-taigi-romanization",
      provider: directTaigiProvider
    },
    {
      source_language: "zh-TW",
      target_language: "zh-TW",
      mode: "online-mandarin-backup",
      provider: mandarinProvider,
      network_required: true,
      unofficial: true,
      sla_guaranteed: false
    }
  ]
};

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

  it("requires the Mandarin backup to disclose its exact provider and limitations", () => {
    expect(validateBackendHealth(multilingualHealth)).toMatchObject({
      mandarinSynthesizer,
      mandarinOnlineBackup: true,
      sourceLanguages: ["zh-TW", "nan-Latn-TW"],
      targetLanguages: ["nan-TW", "zh-TW"]
    });
    expect(() => validateBackendHealth({
      ...multilingualHealth,
      capabilities: multilingualHealth.capabilities.map((capability) =>
        capability.target_language === "zh-TW"
          ? { ...capability, provider: "direct:zh-TW+tampered" }
          : capability
      )
    })).toThrow(/未完整揭露/u);
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

  it("scopes session credentials to the validated endpoint", async () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); }
    };
    const endpointA = "https://a.example/voice";
    const endpointB = "https://b.example/voice";
    const keyA = sessionTokenKeyForEndpoint(endpointA);
    const keyB = sessionTokenKeyForEndpoint(endpointB);
    expect(keyA).not.toBe(keyB);
    expect(sessionTokenKeyForEndpoint(`${endpointA}/`)).toBe(keyA);
    saveSessionToken("token-for-a", storage, keyA);

    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/health")) return json(realHealth);
      if (init?.method === "POST") {
        expect(new Headers(init.headers).has("Authorization")).toBe(false);
        return json({ job_id: "job-b", status: "pending" }, 202);
      }
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      expect(new Headers(init?.headers).has("Authorization")).toBe(false);
      return json({
        job_id: "job-b",
        status: "completed",
        result: {
          spoken_text: "Tsit-ê sī Tâi-gí.",
          taigi_text: "Tsit-ê sī Tâi-gí.",
          audio_base64: btoa("RIFF"),
          mime_type: "audio/wav",
          provider
        }
      });
    });
    const clientB = createBackendClient({
      baseUrl: endpointB,
      sessionStorage: storage,
      fetchImpl: fetchImpl as typeof fetch,
      delay: async () => undefined
    });
    await clientB.synthesize("這是台語。");

    expect(values.get(keyA)).toBe("token-for-a");
    expect(values.has(keyB)).toBe(false);
  });
});

describe("async backend client", () => {
  it("preserves an HTML 429 status and Retry-After guidance", async () => {
    const client = createBackendClient({
      baseUrl: "https://voice.example",
      fetchImpl: vi.fn(async () => new Response("<html>rate limited</html>", {
        status: 429,
        headers: {
          "Content-Type": "text/html",
          "Retry-After": "120"
        }
      })) as typeof fetch
    });

    const error = await client.health().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BackendError);
    expect(error).toMatchObject({ code: "request_failed", status: 429 });
    expect((error as Error).message).toMatch(/HTTP 429.*120 秒後再試/u);
  });

  it("uses X-RateLimit-Reset when an HTML 429 has no Retry-After", async () => {
    const client = createBackendClient({
      baseUrl: "https://voice.example",
      fetchImpl: vi.fn(async () => new Response("<html>quota</html>", {
        status: 429,
        headers: { "X-RateLimit-Reset": "1800000000" }
      })) as typeof fetch
    });

    const error = await client.health().catch((caught: unknown) => caught) as BackendError;
    expect(error.status).toBe(429);
    expect(error.message).toMatch(/X-RateLimit-Reset/u);
  });

  it.each([502, 504])("turns an HTML %i gateway response into a temporary-service error", async (status) => {
    const client = createBackendClient({
      baseUrl: "https://voice.example",
      fetchImpl: vi.fn(async () => new Response("<html>gateway failure</html>", {
        status,
        headers: { "Content-Type": "text/html" }
      })) as typeof fetch
    });

    const error = await client.health().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BackendError);
    expect(error).toMatchObject({ code: "request_failed", status });
    expect((error as Error).message).toContain(`暫時不可用（HTTP ${status}）`);
  });

  it("still rejects malformed JSON on a successful response", async () => {
    const client = createBackendClient({
      baseUrl: "https://voice.example",
      fetchImpl: vi.fn(async () => new Response("not json", { status: 200 })) as typeof fetch
    });

    const error = await client.health().catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "invalid_response", status: 200 });
  });

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

  it("uses exact route identities for Taigi direct reading and rejects tampering", async () => {
    const makeFetch = (resultProvider: string) => vi.fn(async (
      input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      const url = String(input);
      if (url.endsWith("/health")) return json(multilingualHealth);
      if (init?.method === "POST") return json({ job_id: "job-direct", status: "pending" }, 202);
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return json({
        job_id: "job-direct",
        status: "completed",
        result: {
          spoken_text: "kin-á-ji̍t thiⁿ-khì chin hó",
          taigi_text: "kin-á-ji̍t thiⁿ-khì chin hó",
          audio_base64: btoa("RIFF"),
          mime_type: "audio/wav",
          provider: resultProvider
        }
      });
    });

    const acceptedFetch = makeFetch(directTaigiProvider);
    const accepted = createBackendClient({
      baseUrl: "https://voice.example",
      fetchImpl: acceptedFetch as typeof fetch,
      delay: async () => undefined
    });
    await expect(accepted.synthesize({
      text: "kin-á-ji̍t thiⁿ-khì chin hó",
      sourceLanguage: "nan-Latn-TW",
      targetLanguage: "nan-TW"
    })).resolves.toMatchObject({ provider: directTaigiProvider });
    expect(JSON.parse(String(acceptedFetch.mock.calls[1]![1]?.body))).toMatchObject({
      source_language: "nan-Latn-TW",
      target_language: "nan-TW"
    });

    const tampered = createBackendClient({
      baseUrl: "https://voice.example",
      fetchImpl: makeFetch(`direct:nan-Latn-TW+${realHealth.synthesizer}-evil`) as typeof fetch,
      delay: async () => undefined
    });
    await expect(tampered.synthesize({
      text: "kin-á-ji̍t thiⁿ-khì chin hó",
      sourceLanguage: "nan-Latn-TW",
      targetLanguage: "nan-TW"
    })).rejects.toThrow(/provider/u);
  });

  it("accepts only the declared online Mandarin provider and spoken_text", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/health")) return json(multilingualHealth);
      if (init?.method === "POST") return json({ job_id: "job-zh", status: "pending" }, 202);
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return json({
        job_id: "job-zh",
        status: "completed",
        result: {
          spoken_text: "今天天氣很好。",
          taigi_text: null,
          audio_base64: btoa("ID3!"),
          mime_type: "audio/mpeg",
          provider: mandarinProvider
        }
      });
    });
    const client = createBackendClient({
      baseUrl: "https://voice.example",
      fetchImpl: fetchImpl as typeof fetch,
      delay: async () => undefined
    });

    await expect(client.synthesize({
      text: "今天天氣很好。",
      sourceLanguage: "zh-TW",
      targetLanguage: "zh-TW"
    })).resolves.toMatchObject({
      spokenText: "今天天氣很好。",
      taigiText: "",
      provider: mandarinProvider,
      targetLanguage: "zh-TW"
    });
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
