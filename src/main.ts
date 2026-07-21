import "./styles.css";

import { registerSW } from "virtual:pwa-register";

import {
  AudioCache,
  type AudioCacheEntry,
  type AudioCacheMetadata
} from "./lib/audio-cache";
import { AudioQueuePlayer } from "./lib/audio-player";
import {
  createBackendClient,
  SESSION_TOKEN_KEY,
  type BackendClient,
  type BackendHealth,
  type SynthesisResult,
  validateEndpoint
} from "./lib/backend";
import { DeviceSpeechEngine } from "./lib/device-speech";
import { FileImportError, importDocument } from "./lib/file-import";
import { countGraphemes, splitText, validateText } from "./lib/text";
import {
  findMandarinVoices,
  findTaigiVoices,
  loadVoices
} from "./lib/voices";

type Language = "mandarin" | "taigi";
type ConnectionMode = "device" | "local" | "saving";

interface ReadingConfig {
  language: Language;
  connection: ConnectionMode;
  chunks: string[];
  rate: number;
  voice: SpeechSynthesisVoice | null;
  backendUrl: string | null;
  backendToken: string;
  saveAudio: boolean;
}

interface ReadingSession {
  id: number;
  config: ReadingConfig;
  index: number;
  abortController: AbortController;
  paused: boolean;
  resumeWaiters: Set<() => void>;
  backend: BackendClient | null;
}

interface PreparedTaigi {
  audio: Blob;
  provider: string;
  taigiText: string;
  cached: boolean;
}

const MAX_DEVICE_SEGMENT = 220;
const MAX_BACKEND_SEGMENT = 280;
const LOCAL_BACKEND_URL = "http://127.0.0.1:8765";
const REMOTE_ENDPOINT_KEY = "awei-voice:remote-backend-url";
const PROVIDER_MAP_KEY = "awei-voice:backend-provider-map";

function element<T extends Element>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`頁面缺少必要元件：${selector}`);
  return found;
}

function selectedValue<T extends string>(name: string): T {
  const input = document.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`);
  if (!input) throw new Error(`請選擇${name === "language" ? "朗讀語言" : "連線方式"}。`);
  return input.value as T;
}

function errorMessage(error: unknown): string {
  if (error instanceof FileImportError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return "發生未預期的錯誤，請重新整理後再試。";
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && error.name === "AbortError";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function localStorageValue(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function saveLocalStorageValue(key: string, value: string): boolean {
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function sessionStorageValue(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function saveSessionStorageValue(key: string, value: string): boolean {
  try {
    if (value) window.sessionStorage.setItem(key, value);
    else window.sessionStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

function providerMap(): Record<string, string> {
  try {
    const value: unknown = JSON.parse(localStorageValue(PROVIDER_MAP_KEY) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter(
        (entry): entry is [string, string] =>
          typeof entry[0] === "string" && typeof entry[1] === "string" && Boolean(entry[1])
      )
    );
  } catch {
    return {};
  }
}

function rememberProvider(endpoint: string, provider: string): void {
  const providers = providerMap();
  providers[endpoint] = provider;
  saveLocalStorageValue(PROVIDER_MAP_KEY, JSON.stringify(providers));
}

function rememberedProvider(endpoint: string): string | null {
  return providerMap()[endpoint] ?? null;
}

const form = element<HTMLFormElement>("#reader-form");
const sourceText = element<HTMLTextAreaElement>("#source-text");
const textCount = element<HTMLElement>("#text-count");
const fileInput = element<HTMLInputElement>("#document-file");
const fileStatus = element<HTMLElement>("#file-status");
const clearTextButton = element<HTMLButtonElement>("#clear-text");
const voiceSelect = element<HTMLSelectElement>("#voice-select");
const serviceSettings = element<HTMLElement>("#service-settings");
const backendUrlInput = element<HTMLInputElement>("#backend-url");
const backendTokenInput = element<HTMLInputElement>("#backend-token");
const backendHelp = element<HTMLElement>("#backend-help");
const localLicenseHelp = element<HTMLElement>("#local-license-help");
const backendStatus = element<HTMLElement>("#backend-status");
const checkBackendButton = element<HTMLButtonElement>("#check-backend");
const saveAudioRow = element<HTMLElement>("#save-audio-row");
const saveAudioInput = element<HTMLInputElement>("#save-audio");
const startButton = element<HTMLButtonElement>("#start-reading");
const formError = element<HTMLElement>("#form-error");
const playerPanel = element<HTMLElement>("#player-panel");
const playerProgress = element<HTMLElement>("#player-progress");
const playerStatus = element<HTMLElement>("#player-status");
const currentChunk = element<HTMLElement>("#current-chunk");
const readingProgress = element<HTMLProgressElement>("#reading-progress");
const previousButton = element<HTMLButtonElement>("#previous-chunk");
const pauseButton = element<HTMLButtonElement>("#pause-reading");
const nextButton = element<HTMLButtonElement>("#next-chunk");
const stopButton = element<HTMLButtonElement>("#stop-reading");
const providerName = element<HTMLElement>("#provider-name");
const taigiText = element<HTMLElement>("#taigi-text");
const librarySummary = element<HTMLElement>("#library-summary");
const savedAudioList = element<HTMLUListElement>("#saved-audio-list");
const clearLibraryButton = element<HTMLButtonElement>("#clear-library");
const networkStatus = element<HTMLElement>("#network-status");
const updateToast = element<HTMLElement>("#update-toast");
const applyUpdateButton = element<HTMLButtonElement>("#apply-update");

let deviceVoices: SpeechSynthesisVoice[] = [];
let sessionSequence = 0;
let activeSession: ReadingSession | null = null;
let reusableConfig: ReadingConfig | null = null;

const deviceSpeech = new DeviceSpeechEngine();
const audioPlayer = new AudioQueuePlayer({
  onChange(snapshot) {
    if (!activeSession || activeSession.config.language !== "taigi") return;
    if (snapshot.state === "error" && snapshot.error) {
      setPlayerStatus(snapshot.error);
    }
  }
});

let audioCache: AudioCache | null = null;
try {
  // Reading existing opt-in entries is always enabled; writes only happen when
  // the user checks the save box for the current run.
  audioCache = new AudioCache({ enabled: true });
} catch {
  saveAudioInput.disabled = true;
  saveAudioRow.setAttribute("title", "這個瀏覽器無法使用 IndexedDB 保存語音。");
}

function setFieldStatus(
  target: HTMLElement,
  message: string,
  kind: "success" | "error" | "neutral" = "neutral"
): void {
  target.textContent = message;
  if (kind === "neutral") target.removeAttribute("data-kind");
  else target.dataset.kind = kind;
}

function showFormError(message: string): void {
  formError.textContent = message;
  formError.hidden = false;
  formError.focus?.();
}

function clearFormError(): void {
  formError.textContent = "";
  formError.hidden = true;
}

function setPlayerStatus(message: string): void {
  playerStatus.textContent = message;
}

function setLibraryWarning(message: string): void {
  librarySummary.textContent = message;
  librarySummary.dataset.kind = "error";
}

function updateTextCount(): void {
  const count = countGraphemes(sourceText.value);
  textCount.textContent = `${count.toLocaleString("zh-TW")} / 30,000 字`;
  textCount.dataset.over = String(count > 30_000);
}

function currentLanguage(): Language {
  return selectedValue<Language>("language");
}

function currentConnection(): ConnectionMode {
  return selectedValue<ConnectionMode>("connection");
}

function chosenVoice(): SpeechSynthesisVoice | null {
  return deviceVoices.find((voice) => voice.voiceURI === voiceSelect.value) ?? null;
}

function voiceOptionLabel(voice: SpeechSynthesisVoice): string {
  const local = voice.localService ? "裝置內" : "可能需連網";
  return `${voice.name}（${voice.lang}，${local}）`;
}

function renderVoiceChoices(): void {
  const language = currentLanguage();
  const connection = currentConnection();
  const available = language === "mandarin"
    ? findMandarinVoices(deviceVoices)
    : findTaigiVoices(deviceVoices);

  voiceSelect.replaceChildren();
  if (language === "taigi" && connection !== "device") {
    const option = document.createElement("option");
    option.value = "backend";
    option.textContent = "由台語語音服務決定";
    voiceSelect.append(option);
    voiceSelect.disabled = true;
    return;
  }

  voiceSelect.disabled = available.length === 0;
  if (available.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = language === "mandarin"
      ? "找不到裝置的 zh-TW 聲音"
      : "找不到真正的台語裝置聲音";
    voiceSelect.append(option);
    return;
  }

  for (const voice of available) {
    const option = document.createElement("option");
    option.value = voice.voiceURI;
    option.textContent = voiceOptionLabel(voice);
    voiceSelect.append(option);
  }
}

function syncModeCapabilities(): void {
  const language = currentLanguage();
  const connectionInputs = [
    ...document.querySelectorAll<HTMLInputElement>('input[name="connection"]')
  ];

  if (language === "mandarin") {
    const device = connectionInputs.find(({ value }) => value === "device");
    if (device) device.checked = true;
    for (const input of connectionInputs) input.disabled = input.value !== "device";
  } else {
    for (const input of connectionInputs) input.disabled = false;
  }

  const connection = currentConnection();
  const showService = language === "taigi" && connection !== "device";
  serviceSettings.hidden = !showService;
  saveAudioRow.hidden = !showService;
  localLicenseHelp.hidden = !(showService && connection === "local");

  if (showService) {
    if (connection === "local") {
      backendUrlInput.value = LOCAL_BACKEND_URL;
      backendHelp.textContent = "本機服務不會把文字送出這台電腦；瀏覽器詢問「本機網路存取」時需選擇允許。";
    } else if (backendUrlInput.value === LOCAL_BACKEND_URL || !backendUrlInput.value) {
      backendUrlInput.value = localStorageValue(REMOTE_ENDPOINT_KEY) ?? "";
      backendHelp.textContent = "遠端服務只接受 HTTPS；文字會送到你填寫的服務。";
    }
    backendTokenInput.value = sessionStorageValue(SESSION_TOKEN_KEY) ?? "";
  }

  setFieldStatus(backendStatus, "");
  renderVoiceChoices();
}

function updateNetworkStatus(): void {
  const online = navigator.onLine;
  networkStatus.dataset.online = String(online);
  networkStatus.textContent = online ? "目前有網路" : "目前離線";
}

async function refreshVoices(): Promise<void> {
  deviceVoices = await loadVoices();
  renderVoiceChoices();
}

function clientFor(url: string, token: string): BackendClient {
  const normalizedToken = token.trim();
  saveSessionStorageValue(SESSION_TOKEN_KEY, normalizedToken);
  const client = createBackendClient({
    baseUrl: url,
    token: normalizedToken || undefined,
    allowTestProvider: import.meta.env.DEV
  });
  return client;
}

function healthLabel(health: BackendHealth): string {
  return health.isTestProvider
    ? `已連線，但目前是測試音訊：${health.provider}`
    : `台語服務可用：${health.provider}`;
}

async function checkBackend(): Promise<BackendHealth> {
  const normalizedUrl = validateEndpoint(backendUrlInput.value);
  backendUrlInput.value = normalizedUrl;
  checkBackendButton.disabled = true;
  setFieldStatus(backendStatus, "正在檢查，尚未傳送朗讀文字…");
  try {
    const client = clientFor(normalizedUrl, backendTokenInput.value);
    const health = await client.refreshHealth();
    rememberProvider(normalizedUrl, health.provider);
    if (currentConnection() === "saving") {
      saveLocalStorageValue(REMOTE_ENDPOINT_KEY, normalizedUrl);
    }
    setFieldStatus(backendStatus, healthLabel(health), "success");
    return health;
  } catch (error) {
    const message = errorMessage(error);
    setFieldStatus(backendStatus, message, "error");
    throw error;
  } finally {
    checkBackendButton.disabled = false;
  }
}

function rateValue(): number {
  const value = Number(selectedValue<string>("rate"));
  if (![0.75, 1, 1.25].includes(value)) throw new Error("請選擇有效的朗讀速度。");
  return value;
}

function collectConfig(): ReadingConfig {
  const validation = validateText(sourceText.value);
  if (!validation.ok) throw new Error(validation.message);

  const language = currentLanguage();
  const connection = currentConnection();
  const useBackend = language === "taigi" && connection !== "device";
  const maxLength = useBackend ? MAX_BACKEND_SEGMENT : MAX_DEVICE_SEGMENT;
  const voice = useBackend ? null : chosenVoice();
  if (!useBackend && !voice) {
    throw new Error(
      language === "mandarin"
        ? "這台裝置找不到 zh-TW 聲音。請先在系統安裝台灣中文語音。"
        : "這台裝置找不到真正的台語聲音。請改選本機服務或省流量服務。"
    );
  }

  let backendUrl: string | null = null;
  if (useBackend) {
    backendUrl = validateEndpoint(backendUrlInput.value);
    backendUrlInput.value = backendUrl;
    if (connection === "saving") saveLocalStorageValue(REMOTE_ENDPOINT_KEY, backendUrl);
  }

  sourceText.value = validation.text;
  updateTextCount();
  return {
    language,
    connection,
    chunks: splitText(validation.text, maxLength),
    rate: rateValue(),
    voice,
    backendUrl,
    backendToken: backendTokenInput.value,
    saveAudio: useBackend && saveAudioInput.checked
  };
}

function updatePlayerPosition(session: ReadingSession): void {
  const number = session.index + 1;
  const total = session.config.chunks.length;
  playerProgress.textContent = `第 ${number.toLocaleString("zh-TW")} 段，共 ${total.toLocaleString("zh-TW")} 段`;
  currentChunk.textContent = session.config.chunks[session.index] ?? "";
  readingProgress.max = total;
  readingProgress.value = session.index;
  readingProgress.textContent = `${Math.round((session.index / total) * 100)}%`;
  previousButton.disabled = session.index <= 0;
  nextButton.disabled = session.index >= total - 1;
}

function wakeSession(session: ReadingSession): void {
  for (const resolve of session.resumeWaiters) resolve();
  session.resumeWaiters.clear();
}

async function waitUntilResumed(session: ReadingSession): Promise<void> {
  if (!session.paused) return;
  await new Promise<void>((resolve, reject) => {
    const resumed = (): void => {
      session.abortController.signal.removeEventListener("abort", aborted);
      resolve();
    };
    const aborted = (): void => {
      session.resumeWaiters.delete(resumed);
      reject(new DOMException("朗讀已停止。", "AbortError"));
    };
    session.resumeWaiters.add(resumed);
    session.abortController.signal.addEventListener("abort", aborted, { once: true });
  });
}

async function cachedTaigi(
  config: ReadingConfig,
  text: string
): Promise<AudioCacheEntry | null> {
  if (!audioCache || !config.backendUrl) return null;
  const provider = rememberedProvider(config.backendUrl);
  if (!provider) return null;
  const entries = await audioCache.list();
  const match = entries.find((entry) =>
    entry.language.toLowerCase() === "nan-TW".toLowerCase() &&
    entry.voice === config.backendUrl &&
    entry.rate === config.rate &&
    entry.provider === provider &&
    entry.text === text
  );
  return match ? audioCache.get(match.key) : null;
}

async function prepareTaigi(
  session: ReadingSession,
  index: number
): Promise<PreparedTaigi> {
  const text = session.config.chunks[index];
  if (!text || !session.config.backendUrl || !session.backend) {
    throw new Error("台語服務設定不完整。");
  }

  const cached = await cachedTaigi(session.config, text);
  if (cached) {
    return {
      audio: cached.audio,
      provider: `${cached.provider}（已保存）`,
      taigiText: cached.taigiText ?? "這筆舊快取沒有保存台語稿。",
      cached: true
    };
  }

  setPlayerStatus(`正在產生第 ${index + 1} 段台語…`);
  const result: SynthesisResult = await session.backend.synthesize({
    text,
    rate: session.config.rate,
    signal: session.abortController.signal
  });
  rememberProvider(session.config.backendUrl, result.provider);

  if (session.config.saveAudio && audioCache) {
    try {
      const saved = await audioCache.put({
        language: "nan-TW",
        voice: session.config.backendUrl,
        rate: session.config.rate,
        provider: result.provider,
        text,
        audio: result.audio,
        taigiText: result.taigiText
      });
      if (saved.saved) {
        await updateLibrarySummary();
      } else {
        const reason = saved.reason === "too_large"
          ? "音訊大於保存上限"
          : saved.reason === "empty" ? "服務回傳空音訊" : "保存功能目前未啟用";
        setLibraryWarning(`這一段沒有保存（${reason}），但仍會正常播放。`);
      }
    } catch (error) {
      setLibraryWarning(`這一段沒有保存（${errorMessage(error)}），但仍會正常播放。`);
    }
  }

  return {
    audio: result.audio,
    provider: result.provider,
    taigiText: result.taigiText,
    cached: false
  };
}

async function playPreparedTaigi(
  session: ReadingSession,
  prepared: PreparedTaigi
): Promise<void> {
  providerName.textContent = prepared.provider;
  taigiText.textContent = prepared.taigiText;
  await waitUntilResumed(session);
  setPlayerStatus(prepared.cached ? "播放已保存的台語語音" : "正在播放台語");
  await audioPlayer.play(prepared.audio);
  const outcome = await audioPlayer.whenFinished();
  if (outcome.reason === "error") throw outcome.error ?? new Error("音訊無法播放。");
  if (outcome.reason !== "ended") throw new DOMException("朗讀已停止。", "AbortError");
}

async function playDeviceChunk(session: ReadingSession, text: string): Promise<void> {
  const voice = session.config.voice;
  if (!voice) throw new Error("裝置聲音設定遺失。");
  providerName.textContent = `裝置聲音：${voice.name}（${voice.lang}）`;
  taigiText.textContent = session.config.language === "taigi"
    ? "裝置直接朗讀原文，沒有另做國語轉台語。"
    : "台灣國語模式直接朗讀原文。";
  await waitUntilResumed(session);
  setPlayerStatus(
    session.config.language === "taigi" ? "正在播放裝置台語" : "正在播放台灣國語"
  );
  await deviceSpeech.speak(text, {
    voice,
    rate: session.config.rate,
    signal: session.abortController.signal
  });
}

async function runReading(config: ReadingConfig, startIndex = 0): Promise<void> {
  await stopReading(false);
  const id = ++sessionSequence;
  const session: ReadingSession = {
    id,
    config,
    index: Math.max(0, Math.min(startIndex, config.chunks.length - 1)),
    abortController: new AbortController(),
    paused: false,
    resumeWaiters: new Set(),
    backend: config.backendUrl ? clientFor(config.backendUrl, config.backendToken) : null
  };
  activeSession = session;
  reusableConfig = config;
  playerPanel.hidden = false;
  pauseButton.textContent = "暫停";
  startButton.disabled = true;
  clearFormError();

  const pending = new Map<number, Promise<PreparedTaigi>>();
  try {
    for (; session.index < config.chunks.length; session.index += 1) {
      if (activeSession !== session || session.abortController.signal.aborted) {
        throw new DOMException("朗讀已停止。", "AbortError");
      }
      updatePlayerPosition(session);
      const text = config.chunks[session.index];
      if (!text) continue;

      if (config.language === "taigi" && config.connection !== "device") {
        const prepared = await (pending.get(session.index) ?? prepareTaigi(session, session.index));
        pending.delete(session.index);

        const nextIndex = session.index + 1;
        if (nextIndex < config.chunks.length) {
          const next = prepareTaigi(session, nextIndex);
          // Attach a handler now so STOP during playback cannot create an
          // unhandled rejection; awaiting the original promise still reports it.
          void next.catch(() => undefined);
          pending.set(nextIndex, next);
        }
        await playPreparedTaigi(session, prepared);
      } else {
        await playDeviceChunk(session, text);
      }
      readingProgress.value = session.index + 1;
    }

    if (activeSession === session) {
      setPlayerStatus("全文朗讀完成");
      playerProgress.textContent = `完成，共 ${config.chunks.length.toLocaleString("zh-TW")} 段`;
      pauseButton.disabled = true;
      previousButton.disabled = config.chunks.length <= 1;
      nextButton.disabled = true;
      startButton.disabled = false;
      activeSession = null;
    }
  } catch (error) {
    if (activeSession !== session || isAbort(error)) return;
    activeSession = null;
    startButton.disabled = false;
    pauseButton.disabled = false;
    const message = errorMessage(error);
    setPlayerStatus(`朗讀失敗：${message}`);
    showFormError(message);
  }
}

async function stopReading(showStatus = true): Promise<void> {
  const session = activeSession;
  if (!session) return;
  activeSession = null;
  session.abortController.abort();
  session.paused = false;
  wakeSession(session);
  deviceSpeech.stop();
  audioPlayer.stop();
  try {
    await session.backend?.cancel();
  } catch {
    // Local client cancellation is best-effort; the UI is already stopped.
  }
  startButton.disabled = false;
  pauseButton.disabled = false;
  pauseButton.textContent = "暫停";
  if (showStatus) setPlayerStatus("已停止朗讀");
}

async function restartAt(index: number): Promise<void> {
  const config = activeSession?.config ?? reusableConfig;
  if (!config || index < 0 || index >= config.chunks.length) return;
  await runReading(config, index);
}

async function togglePause(): Promise<void> {
  const session = activeSession;
  if (!session) return;
  if (session.paused) {
    session.paused = false;
    wakeSession(session);
    deviceSpeech.resume();
    await audioPlayer.resume();
    pauseButton.textContent = "暫停";
    setPlayerStatus("繼續朗讀");
  } else {
    session.paused = true;
    deviceSpeech.pause();
    audioPlayer.pause();
    pauseButton.textContent = "繼續";
    setPlayerStatus("已暫停");
  }
}

async function updateLibrarySummary(): Promise<void> {
  if (!audioCache) {
    librarySummary.textContent = "這個瀏覽器無法保存語音。";
    savedAudioList.hidden = true;
    savedAudioList.replaceChildren();
    clearLibraryButton.disabled = true;
    return;
  }
  try {
    librarySummary.removeAttribute("data-kind");
    const entries = await audioCache.list();
    const bytes = entries.reduce((total, entry) => total + entry.bytes, 0);
    librarySummary.textContent = entries.length === 0
      ? "尚未保存語音。"
      : `已保存 ${entries.length.toLocaleString("zh-TW")} 段，共 ${formatBytes(bytes)}；上限 ${formatBytes(audioCache.maxBytes)}。`;
    clearLibraryButton.disabled = entries.length === 0;
    renderSavedAudio(entries);
  } catch {
    setLibraryWarning("目前無法讀取保存的語音。");
    savedAudioList.hidden = true;
    savedAudioList.replaceChildren();
    clearLibraryButton.disabled = true;
  }
}

function savedAudioLabel(entry: AudioCacheEntry | AudioCacheMetadata): string {
  const singleLine = entry.text.replace(/\s+/gu, " ").trim();
  return singleLine.length > 48 ? `${singleLine.slice(0, 48)}…` : singleLine;
}

function audioExtension(mimeType: string): string {
  if (/mpeg|mp3/iu.test(mimeType)) return "mp3";
  if (/ogg/iu.test(mimeType)) return "ogg";
  if (/webm/iu.test(mimeType)) return "webm";
  return "wav";
}

function renderSavedAudio(entries: AudioCacheMetadata[]): void {
  savedAudioList.replaceChildren();
  savedAudioList.hidden = entries.length === 0;

  entries.forEach((entry, position) => {
    const item = document.createElement("li");
    item.className = "saved-audio-item";

    const copy = document.createElement("div");
    const title = document.createElement("p");
    title.className = "saved-audio-title";
    title.textContent = savedAudioLabel(entry);
    const details = document.createElement("p");
    details.className = "saved-audio-meta";
    details.textContent = `${entry.provider}・${entry.rate}×・${formatBytes(entry.bytes)}`;
    copy.append(title, details);

    const actions = document.createElement("div");
    actions.className = "saved-audio-actions";
    const download = document.createElement("button");
    download.type = "button";
    download.className = "button button-secondary library-action";
    download.textContent = "下載";
    download.setAttribute("aria-label", `下載第 ${position + 1} 段已保存語音`);
    download.addEventListener("click", async () => {
      if (!audioCache) return;
      download.disabled = true;
      try {
        const found = await audioCache.get(entry.key);
        if (!found) {
          await updateLibrarySummary();
          return;
        }
        const url = URL.createObjectURL(found.audio);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `awei-taigi-${position + 1}.${audioExtension(found.mimeType)}`;
        anchor.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
      } catch (error) {
        showFormError(`下載語音失敗：${errorMessage(error)}`);
      } finally {
        download.disabled = false;
      }
    });

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "button button-quiet library-action";
    remove.textContent = "刪除";
    remove.setAttribute("aria-label", `刪除第 ${position + 1} 段已保存語音`);
    remove.addEventListener("click", async () => {
      if (!audioCache || !window.confirm("確定要刪除這一段已保存的台語語音嗎？")) return;
      remove.disabled = true;
      try {
        await audioCache.delete(entry.key);
        await updateLibrarySummary();
      } catch (error) {
        showFormError(`刪除語音失敗：${errorMessage(error)}`);
        remove.disabled = false;
      }
    });
    actions.append(download, remove);
    item.append(copy, actions);
    savedAudioList.append(item);
  });
}

sourceText.addEventListener("input", updateTextCount);

clearTextButton.addEventListener("click", () => {
  sourceText.value = "";
  fileInput.value = "";
  setFieldStatus(fileStatus, "");
  clearFormError();
  updateTextCount();
  sourceText.focus();
});

fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  fileInput.disabled = true;
  setFieldStatus(fileStatus, `正在本機讀取「${file.name}」…`);
  try {
    const imported = await importDocument(file);
    sourceText.value = imported.text;
    updateTextCount();
    clearFormError();
    setFieldStatus(
      fileStatus,
      `已在這台裝置讀取「${imported.name}」，共 ${imported.characterCount.toLocaleString("zh-TW")} 字，尚未上傳。`,
      "success"
    );
  } catch (error) {
    setFieldStatus(fileStatus, errorMessage(error), "error");
  } finally {
    fileInput.disabled = false;
    fileInput.value = "";
  }
});

for (const input of document.querySelectorAll<HTMLInputElement>('input[name="language"]')) {
  input.addEventListener("change", syncModeCapabilities);
}
for (const input of document.querySelectorAll<HTMLInputElement>('input[name="connection"]')) {
  input.addEventListener("change", syncModeCapabilities);
}

checkBackendButton.addEventListener("click", () => {
  void checkBackend().catch(() => undefined);
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  try {
    const config = collectConfig();
    const needsAudioUnlock = config.language === "taigi" && config.connection !== "device";
    if (!needsAudioUnlock) {
      void runReading(config);
      return;
    }

    // unlock() calls HTMLMediaElement.play() before its first await, while this
    // submit event still carries the user's activation. Synthesis may take far
    // longer than mobile Safari/Chrome keep that transient permission alive.
    startButton.disabled = true;
    void audioPlayer.unlock()
      .then(() => runReading(config))
      .catch((error: unknown) => {
        startButton.disabled = false;
        showFormError(errorMessage(error));
      });
  } catch (error) {
    showFormError(errorMessage(error));
  }
});

pauseButton.addEventListener("click", () => {
  void togglePause();
});

stopButton.addEventListener("click", () => {
  void stopReading();
});

previousButton.addEventListener("click", () => {
  const index = activeSession?.index ?? 0;
  void restartAt(Math.max(0, index - 1));
});

nextButton.addEventListener("click", () => {
  const index = activeSession?.index ?? -1;
  void restartAt(index + 1);
});

clearLibraryButton.addEventListener("click", async () => {
  if (!audioCache || !window.confirm("確定要刪除這台裝置保存的全部台語語音嗎？")) return;
  clearLibraryButton.disabled = true;
  await audioCache.clear();
  await updateLibrarySummary();
});

window.addEventListener("online", updateNetworkStatus);
window.addEventListener("offline", updateNetworkStatus);
window.addEventListener("beforeunload", () => {
  activeSession?.abortController.abort();
  deviceSpeech.stop();
  audioPlayer.stop();
  audioCache?.close();
});

let updateServiceWorker: ((reloadPage?: boolean) => Promise<void>) | undefined;
updateServiceWorker = registerSW({
  onNeedRefresh() {
    updateToast.hidden = false;
  },
  onOfflineReady() {
    networkStatus.textContent = "網頁已可離線開啟";
  },
  onRegisterError(error) {
    console.error("PWA 註冊失敗", error);
  }
});

applyUpdateButton.addEventListener("click", () => {
  void updateServiceWorker?.(true);
});

updateNetworkStatus();
updateTextCount();
syncModeCapabilities();
void refreshVoices();
void updateLibrarySummary();
