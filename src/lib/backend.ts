import { validateText } from "./text";

export const MAX_SYNTHESIS_SEGMENT_LENGTH = 280;
export const SESSION_TOKEN_KEY = "awei-voice:backend-bearer-token";

export type BackendErrorCode =
  | "unsafe_endpoint"
  | "invalid_response"
  | "invalid_provider"
  | "request_failed"
  | "timeout"
  | "busy";

export class BackendError extends Error {
  readonly code: BackendErrorCode;
  readonly status?: number;

  constructor(code: BackendErrorCode, message: string, status?: number) {
    super(message);
    this.name = "BackendError";
    this.code = code;
    this.status = status;
  }
}

export interface BackendHealth {
  status: "ok";
  mode: "concrete" | "mock";
  translator: string;
  synthesizer: string;
  provider: string;
  targetLanguages: string[];
  isTestProvider: boolean;
}

export interface SynthesisResult {
  audio: Blob;
  audioBase64: string;
  mimeType: string;
  provider: string;
  taigiText: string;
  jobId: string;
}

export interface SynthesizeRequest {
  text: string;
  rate?: number;
  signal?: AbortSignal;
  onJobCreated?: (jobId: string) => void | Promise<void>;
}

type TokenProvider = () => string | null | undefined | Promise<string | null | undefined>;
type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export interface BackendClientOptions {
  baseUrl: string;
  token?: string | TokenProvider;
  fetchImpl?: typeof fetch;
  sessionStorage?: StorageLike | null;
  sessionTokenKey?: string;
  allowTestProvider?: boolean;
  pollIntervalMs?: number;
  deadlineMs?: number;
  requestTimeoutMs?: number;
  delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
}

export interface BackendClient {
  readonly baseUrl: string;
  health(signal?: AbortSignal): Promise<BackendHealth>;
  refreshHealth(signal?: AbortSignal): Promise<BackendHealth>;
  synthesize(request: SynthesizeRequest): Promise<SynthesisResult>;
  synthesize(text: string, rate?: number, signal?: AbortSignal): Promise<SynthesisResult>;
  cancel(): Promise<void>;
  setToken(token: string | null, persist?: boolean): void;
  clearToken(): void;
}

export function validateEndpoint(input: string): string {
  const value = String(input || "").trim();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BackendError("unsafe_endpoint", "語音服務網址格式不正確。");
  }

  const isLocalHttp =
    url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if (url.protocol !== "https:" && !isLocalHttp) {
    throw new BackendError(
      "unsafe_endpoint",
      "遠端語音服務必須使用 HTTPS；HTTP 只允許 localhost 或 127.0.0.1。"
    );
  }
  if (url.username || url.password) {
    throw new BackendError("unsafe_endpoint", "語音服務網址不可包含帳號或密碼。");
  }
  if (url.search || url.hash) {
    throw new BackendError("unsafe_endpoint", "語音服務網址不可包含查詢參數或片段。");
  }

  return url.toString().replace(/\/+$/u, "");
}

export function isSafeEndpoint(input: string): boolean {
  try {
    validateEndpoint(input);
    return true;
  } catch {
    return false;
  }
}

function defaultSessionStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function validToken(token: string): string {
  const normalized = token.trim();
  if (!normalized || normalized.length > 4_096 || /[\r\n]/u.test(normalized)) {
    throw new TypeError("存取憑證格式不正確。");
  }
  return normalized;
}

export function saveSessionToken(
  token: string,
  storage: StorageLike | null = defaultSessionStorage(),
  key = SESSION_TOKEN_KEY
): void {
  if (!storage) throw new Error("目前瀏覽器無法使用分頁階段儲存空間。");
  storage.setItem(key, validToken(token));
}

export function loadSessionToken(
  storage: StorageLike | null = defaultSessionStorage(),
  key = SESSION_TOKEN_KEY
): string | null {
  if (!storage) return null;
  const token = storage.getItem(key);
  if (!token) return null;
  try {
    return validToken(token);
  } catch {
    storage.removeItem(key);
    return null;
  }
}

export function clearSessionToken(
  storage: StorageLike | null = defaultSessionStorage(),
  key = SESSION_TOKEN_KEY
): void {
  storage?.removeItem(key);
}

function normalizedLanguage(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const locale = new Intl.Locale(value.trim().replace(/_/gu, "-"));
    return locale.language.toLowerCase() === "nan" && locale.region?.toUpperCase() === "TW"
      ? "nan-TW"
      : locale.toString();
  } catch {
    return null;
  }
}

function taigiProviderLabel(value: string): boolean {
  return /(?:mms[-_:/]tts[-_:/]nan|(?:tai[\s_-]*gi|taigi)|taiwan(?:ese)?[\s_-]*hokkien|(?:臺灣|台灣)?(?:臺語|台語)|臺灣閩南語|台灣閩南語)/iu.test(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** Reject a healthy-but-generic or Mandarin backend before any text is sent. */
export function validateBackendHealth(value: unknown, allowTestProvider = false): BackendHealth {
  if (!value || typeof value !== "object") {
    throw new BackendError("invalid_response", "語音服務的健康檢查格式不正確。");
  }
  const body = value as Record<string, unknown>;
  const mode = body.mode;
  const translator = typeof body.translator === "string" ? body.translator.trim() : "";
  const synthesizer = typeof body.synthesizer === "string" ? body.synthesizer.trim() : "";
  const provider = typeof body.provider === "string" && body.provider.trim()
    ? body.provider.trim()
    : `${translator}+${synthesizer}`;

  if (body.status !== "ok" || (mode !== "concrete" && mode !== "mock") || !translator || !synthesizer) {
    throw new BackendError("invalid_response", "語音服務沒有回傳完整的 provider 身分。");
  }

  const advertised = [
    ...stringArray(body.target_languages),
    ...stringArray(body.supported_languages),
    ...stringArray((body.capabilities as Record<string, unknown> | undefined)?.target_languages),
    ...(typeof body.target_language === "string" ? [body.target_language] : [])
  ];
  const targetLanguages = [...new Set(advertised.map(normalizedLanguage).filter((item): item is string => Boolean(item)))];
  const explicitlyAdvertised = advertised.length > 0;
  const advertisesNanTw = targetLanguages.includes("nan-TW");
  // A translator mentioning Taigi is not enough: the synthesizer itself must
  // advertise nan/Taiwanese Hokkien unless the health contract lists nan-TW.
  const labelIdentifiesTaigi = taigiProviderLabel(synthesizer);
  const isTestProvider = mode === "mock";

  const invalidConcreteProvider =
    !isTestProvider && !advertisesNanTw && (explicitlyAdvertised || !labelIdentifiesTaigi);
  if (invalidConcreteProvider || (isTestProvider && !allowTestProvider)) {
    throw new BackendError(
      "invalid_provider",
      isTestProvider
        ? "這是示範／測試音訊 provider，不是真正的台語 TTS。"
        : "語音服務未明確標示支援 nan-TW／Taiwanese Hokkien，已停止以免誤用國語聲音。"
    );
  }

  return {
    status: "ok",
    mode,
    translator,
    synthesizer,
    provider,
    targetLanguages: advertisesNanTw ? [...new Set([...targetLanguages, "nan-TW"])] : ["nan-TW"],
    isTestProvider
  };
}

function endpointFor(baseUrl: string, path: string): string {
  return `${baseUrl}/${path.replace(/^\/+/, "")}`;
}

function abortError(): Error {
  if (typeof DOMException === "function") return new DOMException("語音工作已取消。", "AbortError");
  const error = new Error("語音工作已取消。");
  error.name = "AbortError";
  return error;
}

function defaultDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(done, milliseconds);
    const cancelled = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancelled);
      reject(abortError());
    };
    function done(): void {
      signal.removeEventListener("abort", cancelled);
      resolve();
    }
    signal.addEventListener("abort", cancelled, { once: true });
  });
}

function responseMessage(body: unknown, status: number): string {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    for (const candidate of [record.error, record.detail, record.message]) {
      if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    }
  }
  return `語音服務回傳錯誤（HTTP ${status}）。`;
}

async function parseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new BackendError("invalid_response", "語音服務回傳了無法辨識的內容。", response.status);
  }
}

function decodeBase64(base64: string, mimeType: string): Blob {
  const dataUrl = base64.match(/^data:([^;,]+);base64,(.+)$/su);
  const payload = dataUrl?.[2] ?? base64;
  const resolvedMimeType = dataUrl?.[1] ?? mimeType;
  try {
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new Blob([bytes], { type: resolvedMimeType });
  } catch {
    throw new BackendError("invalid_response", "語音服務回傳的音訊資料已損毀。");
  }
}

interface ActiveRun {
  cancelled: boolean;
  workController: AbortController;
  createPromise: Promise<string> | null;
  jobId: string;
  cleanupPromise: Promise<void> | null;
}

export function createBackendClient(options: BackendClientOptions): BackendClient {
  const baseUrl = validateEndpoint(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new TypeError("目前環境沒有可用的 fetch。");

  const storage = options.sessionStorage === undefined ? defaultSessionStorage() : options.sessionStorage;
  const tokenKey = options.sessionTokenKey ?? SESSION_TOKEN_KEY;
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  const deadlineMs = options.deadlineMs ?? 10 * 60_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 20_000;
  const delay = options.delay ?? defaultDelay;
  const now = options.now ?? Date.now;
  if (pollIntervalMs < 0 || deadlineMs <= 0 || requestTimeoutMs <= 0) {
    throw new RangeError("語音服務的等候時間設定不正確。");
  }

  let memoryToken: string | TokenProvider | null = options.token ?? null;
  let verifiedHealth: BackendHealth | null = null;
  let healthPromise: Promise<BackendHealth> | null = null;
  let activeRun: ActiveRun | null = null;

  async function accessToken(): Promise<string | null> {
    const value = typeof memoryToken === "function"
      ? await memoryToken()
      : memoryToken ?? loadSessionToken(storage, tokenKey);
    return typeof value === "string" && value.trim() ? validToken(value) : null;
  }

  async function request(
    path: string,
    init: RequestInit,
    signal: AbortSignal | undefined,
    authenticated: boolean
  ): Promise<{ response: Response; body: unknown }> {
    if (signal?.aborted) throw abortError();
    const controller = new AbortController();
    let timedOut = false;
    const cancel = (): void => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, requestTimeoutMs);

    try {
      const headers = new Headers(init.headers);
      if (authenticated) {
        const token = await accessToken();
        if (token) headers.set("Authorization", `Bearer ${token}`);
      } else {
        headers.delete("Authorization");
      }
      const response = await fetchImpl(endpointFor(baseUrl, path), {
        ...init,
        headers,
        signal: controller.signal,
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        referrerPolicy: "no-referrer"
      });
      if (response.status === 204) return { response, body: null };
      const body = await parseJson(response);
      if (!response.ok) {
        throw new BackendError("request_failed", responseMessage(body, response.status), response.status);
      }
      return { response, body };
    } catch (error) {
      if (timedOut) throw new BackendError("timeout", "語音服務請求逾時，請檢查連線後再試。");
      if (signal?.aborted) throw abortError();
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
    }
  }

  async function probeHealth(signal?: AbortSignal): Promise<BackendHealth> {
    const { body } = await request("/health", { method: "GET" }, signal, false);
    return validateBackendHealth(body, options.allowTestProvider === true);
  }

  async function health(signal?: AbortSignal): Promise<BackendHealth> {
    if (verifiedHealth) return verifiedHealth;
    if (!healthPromise) {
      const current = probeHealth(signal)
        .then((result) => {
          verifiedHealth = result;
          return result;
        })
        .finally(() => {
          if (healthPromise === current) healthPromise = null;
        });
      healthPromise = current;
    }
    return healthPromise;
  }

  async function refreshHealth(signal?: AbortSignal): Promise<BackendHealth> {
    verifiedHealth = null;
    healthPromise = null;
    return health(signal);
  }

  async function deleteJob(jobId: string): Promise<void> {
    try {
      await request(`/v1/synthesis-jobs/${encodeURIComponent(jobId)}`, { method: "DELETE" }, undefined, true);
    } catch (error) {
      if (error instanceof BackendError && error.status === 404) return;
      throw error;
    }
  }

  async function cleanup(run: ActiveRun): Promise<void> {
    if (!run.jobId) return;
    if (!run.cleanupPromise) run.cleanupPromise = deleteJob(run.jobId);
    await run.cleanupPromise;
  }

  async function cancelRun(run: ActiveRun): Promise<void> {
    run.cancelled = true;
    run.workController.abort();
    if (run.createPromise) {
      try {
        await run.createPromise;
      } catch {
        return;
      }
    }
    if (run.jobId) await cleanup(run);
  }

  async function cancel(): Promise<void> {
    const run = activeRun;
    if (!run) return;
    await cancelRun(run);
  }

  async function createJob(run: ActiveRun, text: string, rate: number): Promise<string> {
    const { response, body } = await request(
      "/v1/synthesis-jobs",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          source_language: "zh-TW",
          target_language: "nan-TW",
          rate
        })
      },
      undefined,
      true
    );
    const record = body as Record<string, unknown> | null;
    if (response.status !== 202 || record?.status !== "pending" || typeof record.job_id !== "string" || !record.job_id) {
      throw new BackendError("invalid_response", "語音服務建立工作時回傳了無效結果。");
    }
    run.jobId = record.job_id;
    return record.job_id;
  }

  function completedResult(value: unknown, jobId: string, service: BackendHealth): SynthesisResult {
    if (!value || typeof value !== "object") {
      throw new BackendError("invalid_response", "語音服務沒有回傳合成結果。");
    }
    const result = value as Record<string, unknown>;
    const taigiText = typeof result.taigi_text === "string" ? result.taigi_text.trim() : "";
    const audioBase64 = typeof result.audio_base64 === "string"
      ? result.audio_base64
      : typeof result.audio === "string" ? result.audio : "";
    const mimeType = typeof result.mime_type === "string"
      ? result.mime_type
      : typeof result.content_type === "string" ? result.content_type : "";
    const provider = typeof result.provider === "string" ? result.provider.trim() : "";
    const expectedProviders = new Set([service.provider, `${service.translator}+${service.synthesizer}`]);

    if (!taigiText || !audioBase64 || !mimeType.startsWith("audio/") || !provider) {
      throw new BackendError("invalid_response", "語音服務沒有回傳完整的台語稿、音訊與 provider。");
    }
    if (!expectedProviders.has(provider)) {
      throw new BackendError("invalid_provider", "合成結果的 provider 與健康檢查不一致，已拒絕播放。");
    }

    const audio = decodeBase64(audioBase64, mimeType);
    if (audio.size === 0) {
      throw new BackendError("invalid_response", "語音服務回傳了空白音訊。");
    }
    return {
      audio,
      audioBase64: audioBase64.replace(/^data:[^;,]+;base64,/su, ""),
      mimeType: audio.type || mimeType,
      provider,
      taigiText,
      jobId
    };
  }

  async function performSynthesis(requestValue: SynthesizeRequest): Promise<SynthesisResult> {
    if (activeRun) throw new BackendError("busy", "已有一段語音正在產生，請稍候或先停止。");

    const validation = validateText(requestValue.text, MAX_SYNTHESIS_SEGMENT_LENGTH);
    if (!validation.ok) throw new TypeError(validation.message);
    const rate = requestValue.rate ?? 1;
    if (!Number.isFinite(rate) || rate < 0.5 || rate > 1.5) {
      throw new RangeError("語速必須介於 0.5× 到 1.5×。");
    }

    const run: ActiveRun = {
      cancelled: false,
      workController: new AbortController(),
      createPromise: null,
      jobId: "",
      cleanupPromise: null
    };
    activeRun = run;
    const externalAbort = (): void => { void cancelRun(run); };
    if (requestValue.signal?.aborted) run.cancelled = true;
    else requestValue.signal?.addEventListener("abort", externalAbort, { once: true });

    try {
      if (run.cancelled) throw abortError();
      const service = await health(run.workController.signal);
      if (run.cancelled) throw abortError();

      run.createPromise = createJob(run, validation.text, rate);
      const jobId = await run.createPromise;
      if (run.cancelled) {
        await cleanup(run);
        throw abortError();
      }
      await requestValue.onJobCreated?.(jobId);

      const deadline = now() + deadlineMs;
      while (now() < deadline) {
        if (run.cancelled || run.workController.signal.aborted) throw abortError();
        const { body } = await request(
          `/v1/synthesis-jobs/${encodeURIComponent(jobId)}`,
          { method: "GET" },
          run.workController.signal,
          true
        );
        if (!body || typeof body !== "object") {
          throw new BackendError("invalid_response", "語音服務回傳了無效的工作狀態。");
        }
        const record = body as Record<string, unknown>;
        if (record.job_id !== jobId) {
          throw new BackendError("invalid_response", "語音服務回傳了不相符的工作編號。");
        }
        if (record.status === "completed") {
          // Decode and validate before deleting so a malformed terminal result
          // still reaches the common error cleanup. A valid result is returned
          // only after the server releases this job's outstanding-owner slot.
          const result = completedResult(record.result, jobId, service);
          await cleanup(run);
          if (run.cancelled || requestValue.signal?.aborted) throw abortError();
          return result;
        }
        if (record.status === "failed") {
          throw new BackendError(
            "request_failed",
            typeof record.error === "string" && record.error ? record.error : "台語語音產生失敗。"
          );
        }
        if (record.status !== "pending") {
          throw new BackendError("invalid_response", "語音服務回傳了未知的工作狀態。");
        }
        await delay(pollIntervalMs, run.workController.signal);
        if (run.cancelled || run.workController.signal.aborted) throw abortError();
      }
      throw new BackendError("timeout", "台語語音產生等候逾時，請稍後再試。");
    } catch (error) {
      if (run.jobId) {
        try {
          await cleanup(run);
        } catch {
          // Keep the original synthesis/cancellation failure actionable.
        }
      }
      if (run.cancelled || requestValue.signal?.aborted) throw abortError();
      throw error;
    } finally {
      requestValue.signal?.removeEventListener("abort", externalAbort);
      if (activeRun === run) activeRun = null;
    }
  }

  function synthesize(
    requestOrText: SynthesizeRequest | string,
    rate = 1,
    signal?: AbortSignal
  ): Promise<SynthesisResult> {
    return performSynthesis(
      typeof requestOrText === "string" ? { text: requestOrText, rate, signal } : requestOrText
    );
  }

  function setToken(token: string | null, persist = false): void {
    memoryToken = token === null ? null : validToken(token);
    if (persist && token !== null) saveSessionToken(token, storage, tokenKey);
    else if (persist) clearSessionToken(storage, tokenKey);
  }

  function clearToken(): void {
    memoryToken = null;
    clearSessionToken(storage, tokenKey);
  }

  return { baseUrl, health, refreshHealth, synthesize, cancel, setToken, clearToken };
}
