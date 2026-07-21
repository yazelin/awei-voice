#!/usr/bin/env node

import { pathToFileURL } from "node:url";

export const DEFAULT_ORIGIN = "https://yazelin.github.io";

const ROUTES = Object.freeze([
  Object.freeze({
    label: "zh-TW->nan-TW",
    sourceLanguage: "zh-TW",
    targetLanguage: "nan-TW",
    text: "今天天氣真好。",
    mimeType: "audio/wav",
    audioKind: "wav"
  }),
  Object.freeze({
    label: "nan-Latn-TW->nan-TW",
    sourceLanguage: "nan-Latn-TW",
    targetLanguage: "nan-TW",
    text: "Kin-á-ji̍t thiⁿ-khì chin hó。",
    expectedSpokenText: "kin-á-ji̍t thinn-khì chin hó",
    mimeType: "audio/wav",
    audioKind: "wav"
  }),
  Object.freeze({
    label: "zh-TW->zh-TW",
    sourceLanguage: "zh-TW",
    targetLanguage: "zh-TW",
    text: "你好，這是阿瑋好聲音。",
    mimeType: "audio/mpeg",
    audioKind: "mp3"
  })
]);

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

export class SmokeError extends Error {
  constructor(code) {
    super(code);
    this.name = "SmokeError";
    this.code = code;
  }
}

function fail(code) {
  throw new SmokeError(code);
}

function record(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  return value;
}

function safeIdentity(value, code) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail(code);
  }
  return value;
}

function exactStringSet(value, required, code) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) fail(code);
  const available = new Set(value);
  if (required.some((item) => !available.has(item))) fail(code);
}

export function normalizeEndpoint(value) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    fail("invalid_endpoint");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    fail("invalid_endpoint");
  }
  return url.toString().replace(/\/+$/u, "");
}

export function normalizeOrigin(value) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    fail("invalid_origin");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    fail("invalid_origin");
  }
  return url.origin;
}

function headerTokens(response, name) {
  return new Set(
    String(response.headers.get(name) || "")
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean)
  );
}

function verifyCors(response, origin, code) {
  if (response.headers.get("access-control-allow-origin") !== origin) fail(code);
  if (response.headers.get("access-control-allow-credentials") === "true") fail(code);
  if (!headerTokens(response, "vary").has("origin")) fail(code);
}

function verifyNoStore(response, code) {
  const cacheControl = String(response.headers.get("cache-control") || "").toLowerCase();
  if (!cacheControl.split(",").some((part) => part.trim() === "no-store")) fail(code);
}

function capabilityFor(body, sourceLanguage, targetLanguage, code) {
  if (!Array.isArray(body.capabilities)) fail(code);
  const matches = body.capabilities.filter((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    return value.source_language === sourceLanguage && value.target_language === targetLanguage;
  });
  if (matches.length !== 1) fail(code);
  return matches[0];
}

function verifyHealth(value) {
  const body = record(value, "health_shape");
  if (body.status !== "ok" || body.mode !== "concrete") fail("health_not_concrete");
  const translator = safeIdentity(body.translator, "health_translator");
  const synthesizer = safeIdentity(body.synthesizer, "health_synthesizer");
  const mandarinSynthesizer = safeIdentity(
    body.mandarin_synthesizer,
    "health_mandarin_synthesizer"
  );
  exactStringSet(body.source_languages, ["zh-TW", "nan-Latn-TW"], "health_sources");
  exactStringSet(body.target_languages, ["nan-TW", "zh-TW"], "health_targets");

  const expectedProviders = new Map([
    ["zh-TW->nan-TW", `${translator}+${synthesizer}`],
    ["nan-Latn-TW->nan-TW", `direct:nan-Latn-TW+${synthesizer}`],
    ["zh-TW->zh-TW", `direct:zh-TW+${mandarinSynthesizer}`]
  ]);
  if (body.provider !== undefined && body.provider !== expectedProviders.get("zh-TW->nan-TW")) {
    fail("health_provider_mismatch");
  }

  const translated = capabilityFor(body, "zh-TW", "nan-TW", "health_translate_capability");
  if (
    translated.mode !== "translate-to-taigi" ||
    translated.provider !== expectedProviders.get("zh-TW->nan-TW")
  ) {
    fail("health_translate_provider");
  }
  const direct = capabilityFor(body, "nan-Latn-TW", "nan-TW", "health_direct_capability");
  if (
    direct.mode !== "read-taigi-romanization" ||
    direct.provider !== expectedProviders.get("nan-Latn-TW->nan-TW")
  ) {
    fail("health_direct_provider");
  }
  const mandarin = capabilityFor(body, "zh-TW", "zh-TW", "health_mandarin_capability");
  if (
    mandarin.mode !== "online-mandarin-backup" ||
    mandarin.provider !== expectedProviders.get("zh-TW->zh-TW") ||
    mandarin.network_required !== true ||
    mandarin.unofficial !== true ||
    mandarin.sla_guaranteed !== false
  ) {
    fail("health_mandarin_provider");
  }
  return expectedProviders;
}

function verifyAccess(value) {
  const body = record(value, "access_shape");
  if (body.authentication_required !== false || body.subject !== "local-open-access") {
    fail("access_not_anonymous");
  }
  const remaining = record(body.remaining, "access_remaining");
  const requiredCharacters = ROUTES.reduce((sum, route) => sum + [...route.text].length, 0);
  for (const key of ["subject_jobs", "global_jobs"]) {
    if (!Number.isInteger(remaining[key]) || remaining[key] < ROUTES.length) {
      fail("access_job_quota");
    }
  }
  for (const key of ["subject_characters", "global_characters"]) {
    if (!Number.isInteger(remaining[key]) || remaining[key] < requiredCharacters) {
      fail("access_character_quota");
    }
  }
}

export function decodeAudioBase64(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !BASE64.test(value)
  ) {
    fail("audio_base64_invalid");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0 || bytes.toString("base64") !== value) fail("audio_base64_invalid");
  return bytes;
}

function verifyMagic(bytes, kind) {
  if (kind === "wav") {
    if (
      bytes.length < 12 ||
      bytes.subarray(0, 4).toString("ascii") !== "RIFF" ||
      bytes.subarray(8, 12).toString("ascii") !== "WAVE"
    ) {
      fail("audio_magic_mismatch");
    }
    return;
  }
  const hasId3 = bytes.length >= 3 && bytes.subarray(0, 3).toString("ascii") === "ID3";
  const hasMpegFrame = bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
  if (!hasId3 && !hasMpegFrame) fail("audio_magic_mismatch");
}

function verifyResult(value, route, expectedProvider) {
  const result = record(value, "result_shape");
  if (safeIdentity(result.provider, "result_provider") !== expectedProvider) {
    fail("result_provider_mismatch");
  }
  if (result.mime_type !== route.mimeType) fail("result_mime_mismatch");
  if (typeof result.spoken_text !== "string" || !result.spoken_text.trim()) {
    fail("result_spoken_text");
  }
  if (route.targetLanguage === "nan-TW") {
    if (typeof result.taigi_text !== "string" || !result.taigi_text.trim()) {
      fail("result_taigi_text");
    }
    if (result.spoken_text.trim() !== result.taigi_text.trim()) fail("result_taigi_text_mismatch");
    if (
      route.expectedSpokenText &&
      (
        result.spoken_text !== route.expectedSpokenText ||
        result.taigi_text !== route.expectedSpokenText
      )
    ) {
      fail("result_direct_normalization");
    }
  } else if (result.taigi_text !== null || result.spoken_text !== route.text) {
    fail("result_mandarin_text");
  }
  const bytes = decodeAudioBase64(result.audio_base64);
  verifyMagic(bytes, route.audioKind);
  return { bytes: bytes.length, provider: expectedProvider };
}

function defaultSleep(milliseconds, signal) {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new SmokeError("interrupted"));
      return;
    }
    const timer = setTimeout(done, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(new SmokeError("interrupted"));
    };
    function done() {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function responseJson(response, code) {
  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  if (!contentType.includes("application/json")) fail(code);
  try {
    return await response.json();
  } catch {
    fail(code);
  }
}

function combineSignal(parentSignal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  if (parentSignal?.aborted) controller.abort();
  else parentSignal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", abort);
    }
  };
}

export async function runLiveSmoke(endpoint, options = {}) {
  const baseUrl = normalizeEndpoint(endpoint);
  const origin = normalizeOrigin(options.origin ?? DEFAULT_ORIGIN);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") fail("fetch_unavailable");
  const logger = options.logger ?? ((line) => console.log(line));
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const signal = options.signal;
  const requestTimeoutMs = options.requestTimeoutMs ?? 35_000;
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  const jobDeadlineMs = options.jobDeadlineMs ?? 8 * 60_000;
  const minCreateIntervalMs = options.minCreateIntervalMs ?? 10_100;
  if (
    requestTimeoutMs <= 0 ||
    pollIntervalMs < 0 ||
    jobDeadlineMs <= 0 ||
    minCreateIntervalMs < 0
  ) {
    fail("invalid_timing");
  }

  const activeJobs = new Set();
  let lastCreateAt = Number.NEGATIVE_INFINITY;

  const log = (fields) => logger(JSON.stringify(fields));
  const urlFor = (path) => `${baseUrl}/${path.replace(/^\/+/, "")}`;

  async function request(path, init, code, cleanup = false) {
    const combined = combineSignal(cleanup ? undefined : signal, requestTimeoutMs);
    try {
      return await fetchImpl(urlFor(path), {
        ...init,
        cache: "no-store",
        redirect: "error",
        signal: combined.signal
      });
    } catch {
      if (!cleanup && signal?.aborted) fail("interrupted");
      if (combined.timedOut()) fail(`${code}_timeout`);
      fail(`${code}_network`);
    } finally {
      combined.dispose();
    }
  }

  async function cleanupJob(jobId) {
    const response = await request(
      `/v1/synthesis-jobs/${encodeURIComponent(jobId)}`,
      { method: "DELETE", headers: { Accept: "application/json", Origin: origin } },
      "cleanup",
      true
    );
    if (response.status !== 204 && response.status !== 404) fail("cleanup_status");
    verifyCors(response, origin, "cleanup_cors");
    activeJobs.delete(jobId);
  }

  async function runRoute(route, expectedProvider) {
    const waitForCreate = Math.max(0, lastCreateAt + minCreateIntervalMs - now());
    await sleep(waitForCreate, signal);
    lastCreateAt = now();

    let jobId = null;
    let outcome;
    let routeError = null;
    try {
      const created = await request(
        "/v1/synthesis-jobs",
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            Origin: origin
          },
          body: JSON.stringify({
            text: route.text,
            source_language: route.sourceLanguage,
            target_language: route.targetLanguage,
            rate: 1.0
          })
        },
        "create"
      );
      verifyCors(created, origin, "create_cors");
      verifyNoStore(created, "create_cache");
      const createdBody = record(await responseJson(created, "create_json"), "create_shape");
      if (
        typeof createdBody.job_id === "string" &&
        createdBody.job_id.length > 0 &&
        createdBody.job_id.length <= 128 &&
        !/[\u0000-\u001f\u007f]/u.test(createdBody.job_id)
      ) {
        jobId = createdBody.job_id;
        activeJobs.add(jobId);
      }
      if (created.status !== 202 || createdBody.status !== "pending" || !jobId || !UUID_V4.test(jobId)) {
        fail("create_contract");
      }

      const deadline = now() + jobDeadlineMs;
      while (now() < deadline) {
        const polled = await request(
          `/v1/synthesis-jobs/${encodeURIComponent(jobId)}`,
          { method: "GET", headers: { Accept: "application/json", Origin: origin } },
          "poll"
        );
        if (polled.status !== 200) fail("poll_status");
        verifyCors(polled, origin, "poll_cors");
        verifyNoStore(polled, "poll_cache");
        const body = record(await responseJson(polled, "poll_json"), "poll_shape");
        if (body.job_id !== jobId) fail("poll_job_id");
        if (body.status === "completed") {
          outcome = verifyResult(body.result, route, expectedProvider);
          break;
        }
        if (body.status === "failed") fail("job_failed");
        if (body.status !== "pending") fail("poll_status_value");
        await sleep(pollIntervalMs, signal);
      }
      if (!outcome) fail("job_deadline");
    } catch (error) {
      routeError = error instanceof SmokeError ? error : new SmokeError("route_failure");
    }

    let cleanupError = null;
    if (jobId) {
      try {
        await cleanupJob(jobId);
      } catch (error) {
        cleanupError = error instanceof SmokeError ? error : new SmokeError("cleanup_failure");
      }
    }
    if (routeError) throw routeError;
    if (cleanupError) throw cleanupError;
    log({ route: route.label, status: "completed", bytes: outcome.bytes, provider: outcome.provider });
  }

  let smokeError = null;
  try {
    const health = await request(
      "/health",
      { method: "GET", headers: { Accept: "application/json" } },
      "health"
    );
    if (health.status !== 200) fail("health_status");
    verifyNoStore(health, "health_cache");
    const providers = verifyHealth(await responseJson(health, "health_json"));
    log({ route: "health", status: "ok" });

    const preflight = await request(
      "/v1/synthesis-jobs",
      {
        method: "OPTIONS",
        headers: {
          Origin: origin,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "authorization, content-type"
        }
      },
      "preflight"
    );
    if (preflight.status !== 200 && preflight.status !== 204) fail("preflight_status");
    verifyCors(preflight, origin, "preflight_cors");
    if (!headerTokens(preflight, "access-control-allow-methods").has("post")) {
      fail("preflight_methods");
    }
    const allowedHeaders = headerTokens(preflight, "access-control-allow-headers");
    if (!allowedHeaders.has("authorization") || !allowedHeaders.has("content-type")) {
      fail("preflight_headers");
    }
    log({ route: "preflight", status: "ok" });

    const access = await request(
      "/v1/access",
      { method: "GET", headers: { Accept: "application/json", Origin: origin } },
      "access"
    );
    if (access.status !== 200) fail("access_status");
    verifyCors(access, origin, "access_cors");
    verifyNoStore(access, "access_cache");
    verifyAccess(await responseJson(access, "access_json"));
    log({ route: "access", status: "ok" });

    for (const route of ROUTES) {
      await runRoute(route, providers.get(route.label));
    }
    log({ route: "all", status: "passed" });
  } catch (error) {
    smokeError = error instanceof SmokeError ? error : new SmokeError("unexpected_failure");
  } finally {
    for (const jobId of [...activeJobs]) {
      try {
        await cleanupJob(jobId);
      } catch {
        if (!smokeError) smokeError = new SmokeError("cleanup_failure");
      }
    }
  }
  if (smokeError) throw smokeError;
}

function usage() {
  return [
    "Usage: node scripts/live-smoke.mjs <https-base-endpoint> [--origin <https-origin>]",
    `Default origin: ${DEFAULT_ORIGIN}`,
    "Runs three bounded synthesis jobs and deletes every created job; no token is accepted or logged."
  ].join("\n");
}

function parseCli(argv) {
  let endpoint = null;
  let origin = DEFAULT_ORIGIN;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--help" || value === "-h") return { help: true };
    if (value === "--origin") {
      if (index + 1 >= argv.length) fail("usage");
      origin = argv[++index];
      continue;
    }
    if (value.startsWith("-")) fail("usage");
    if (endpoint !== null) fail("usage");
    endpoint = value;
  }
  if (!endpoint) fail("usage");
  return { endpoint, origin, help: false };
}

async function main() {
  let args;
  try {
    args = parseCli(process.argv.slice(2));
  } catch {
    console.error(usage());
    process.exitCode = 2;
    return;
  }
  if (args.help) {
    console.log(usage());
    return;
  }

  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    await runLiveSmoke(args.endpoint, { origin: args.origin, signal: controller.signal });
  } catch (error) {
    const code = error instanceof SmokeError ? error.code : "unexpected_failure";
    console.error(JSON.stringify({ route: "all", status: "failed", error: code }));
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
