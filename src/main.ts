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
  sessionTokenKeyForEndpoint,
  type BackendClient,
  type BackendHealth,
  type SpeechSourceLanguage,
  type SpeechTargetLanguage,
  type SynthesisResult,
  validateEndpoint
} from "./lib/backend";
import { DeviceSpeechEngine } from "./lib/device-speech";
import { FileImportError, importDocument } from "./lib/file-import";
import { countGraphemes, splitText, validateRomanizedTaigiInput, validateText } from "./lib/text";
import { resolveRemoteEndpoint, safeRemoteEndpoint } from "./lib/reader-config";
import {
  configureSavedPlaybackButton,
  SavedAudioPlaybackController
} from "./lib/saved-audio-playback";
import {
  findMandarinVoices,
  findTaigiVoices,
  loadVoices,
  watchVoices
} from "./lib/voices";

type Language = "mandarin" | "taigi";
type ConnectionMode = "device" | "local" | "saving";
type TaigiInputMode = "translate" | "direct";

interface ReadingConfig {
  language: Language;
  taigiInputMode: TaigiInputMode | null;
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

interface PreparedAudio {
  audio: Blob;
  provider: string;
  spokenText: string;
  taigiText: string;
  cached: boolean;
}

const MAX_DEVICE_SEGMENT = 220;
const MAX_BACKEND_SEGMENT = 280;
const LOCAL_BACKEND_URL = "http://127.0.0.1:8765";
const REMOTE_ENDPOINT_KEY = "awei-voice:remote-backend-url";
const PROVIDER_MAP_KEY = "awei-voice:backend-provider-map";
const DEFAULT_REMOTE_BACKEND_URL = resolveRemoteEndpoint(
  null,
  import.meta.env.VITE_TAIGI_BACKEND_URL
);

function element<T extends Element>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`頁面缺少必要元件：${selector}`);
  return found;
}

function selectedValue<T extends string>(name: string): T {
  const input = document.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`);
  const label = name === "language"
    ? "朗讀語言"
    : name === "taigiInputMode" ? "台語輸入方式" : "連線方式";
  if (!input) throw new Error(`請選擇${label}。`);
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

function providerRouteKey(
  endpoint: string,
  source: SpeechSourceLanguage,
  target: SpeechTargetLanguage
): string {
  return `${endpoint}|${source}->${target}`;
}

function rememberProvider(
  endpoint: string,
  source: SpeechSourceLanguage,
  target: SpeechTargetLanguage,
  provider: string
): void {
  const providers = providerMap();
  providers[providerRouteKey(endpoint, source, target)] = provider;
  saveLocalStorageValue(PROVIDER_MAP_KEY, JSON.stringify(providers));
}

function rememberedProvider(
  endpoint: string,
  source: SpeechSourceLanguage,
  target: SpeechTargetLanguage
): string | null {
  return providerMap()[providerRouteKey(endpoint, source, target)] ?? null;
}

const form = element<HTMLFormElement>("#reader-form");
const sourceText = element<HTMLTextAreaElement>("#source-text");
const textCount = element<HTMLElement>("#text-count");
const fileInput = element<HTMLInputElement>("#document-file");
const fileStatus = element<HTMLElement>("#file-status");
const clearTextButton = element<HTMLButtonElement>("#clear-text");
const taigiInputSettings = element<HTMLElement>("#taigi-input-settings");
const taigiInputHelp = element<HTMLElement>("#taigi-input-help");
const voiceSelect = element<HTMLSelectElement>("#voice-select");
const deviceVoiceTools = element<HTMLElement>("#device-voice-tools");
const refreshVoicesButton = element<HTMLButtonElement>("#refresh-voices");
const voiceStatus = element<HTMLElement>("#voice-status");
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
const currentChunkLabel = element<HTMLElement>("#current-chunk-label");
const currentChunk = element<HTMLElement>("#current-chunk");
const readingProgress = element<HTMLProgressElement>("#reading-progress");
const previousButton = element<HTMLButtonElement>("#previous-chunk");
const pauseButton = element<HTMLButtonElement>("#pause-reading");
const nextButton = element<HTMLButtonElement>("#next-chunk");
const stopButton = element<HTMLButtonElement>("#stop-reading");
const taigiResult = element<HTMLElement>("#taigi-result");
const taigiResultHeading = element<HTMLElement>("#taigi-result-heading");
const providerName = element<HTMLElement>("#provider-name");
const taigiText = element<HTMLElement>("#taigi-text");
const librarySummary = element<HTMLElement>("#library-summary");
const libraryPlaybackStatus = element<HTMLElement>("#library-playback-status");
const savedAudioList = element<HTMLUListElement>("#saved-audio-list");
const clearLibraryButton = element<HTMLButtonElement>("#clear-library");
const networkStatus = element<HTMLElement>("#network-status");
const updateToast = element<HTMLElement>("#update-toast");
const applyUpdateButton = element<HTMLButtonElement>("#apply-update");

let deviceVoices: SpeechSynthesisVoice[] = [];
let tokenEndpoint: string | null = null;
let sessionSequence = 0;
let activeSession: ReadingSession | null = null;
let reusableConfig: ReadingConfig | null = null;
let savedAudioEntries: AudioCacheMetadata[] = [];

const deviceSpeech = new DeviceSpeechEngine();
const audioPlayer = new AudioQueuePlayer({
  onChange(snapshot) {
    if (!activeSession) return;
    if (snapshot.state === "error" && snapshot.error) {
      setPlayerStatus(snapshot.error);
    }
  }
});
const libraryAudioPlayer = new AudioQueuePlayer();
const savedAudioPlayback = new SavedAudioPlaybackController({
  player: libraryAudioPlayer,
  beforePlay: () => stopReading(false),
  onChange(snapshot) {
    setFieldStatus(
      libraryPlaybackStatus,
      snapshot.message,
      snapshot.state === "error" ? "error" : snapshot.state === "playing" ? "success" : "neutral"
    );
    renderSavedAudio(savedAudioEntries);
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

function currentTaigiInputMode(): TaigiInputMode {
  return selectedValue<TaigiInputMode>("taigiInputMode");
}

function preferredRemoteEndpoint(): string {
  return resolveRemoteEndpoint(
    localStorageValue(REMOTE_ENDPOINT_KEY),
    import.meta.env.VITE_TAIGI_BACKEND_URL
  );
}

function syncBackendTokenForEndpoint(endpointValue = backendUrlInput.value): void {
  let endpoint: string | null = null;
  try {
    endpoint = validateEndpoint(endpointValue);
  } catch {
    // An incomplete/invalid URL must never retain another endpoint's token.
  }
  if (endpoint === tokenEndpoint) return;
  tokenEndpoint = endpoint;
  backendTokenInput.value = endpoint
    ? sessionStorageValue(sessionTokenKeyForEndpoint(endpoint)) ?? ""
    : "";
}

function saveTokenForCurrentEndpoint(): void {
  let endpoint: string;
  try {
    endpoint = validateEndpoint(backendUrlInput.value);
  } catch {
    tokenEndpoint = null;
    backendTokenInput.value = "";
    return;
  }
  if (tokenEndpoint !== endpoint) syncBackendTokenForEndpoint(endpoint);
  saveSessionStorageValue(
    sessionTokenKeyForEndpoint(endpoint),
    backendTokenInput.value.trim()
  );
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
  if (connection !== "device") {
    const option = document.createElement("option");
    option.value = "backend";
    option.textContent = language === "taigi"
      ? "由台語語音服務決定"
      : "線上台灣國語：曉辰（zh-TW）";
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

function announceVoiceAvailability(prefix = ""): void {
  if (currentConnection() !== "device") {
    setFieldStatus(voiceStatus, "");
    return;
  }
  const available = currentLanguage() === "mandarin"
    ? findMandarinVoices(deviceVoices)
    : findTaigiVoices(deviceVoices);
  if (available.length > 0) {
    setFieldStatus(
      voiceStatus,
      `${prefix}找到 ${available.length.toLocaleString("zh-TW")} 個可用聲音。`,
      "success"
    );
  } else {
    setFieldStatus(
      voiceStatus,
      currentLanguage() === "mandarin"
        ? `${prefix}仍找不到系統的 zh-TW 聲音，已可改選「省流量服務」線上朗讀。`
        : `${prefix}仍找不到真正的台語裝置聲音，可改用台語語音服務。`,
      "error"
    );
  }
}

function syncModeCapabilities(): void {
  const language = currentLanguage();
  const taigiInputMode = currentTaigiInputMode();
  const connectionInputs = [
    ...document.querySelectorAll<HTMLInputElement>('input[name="connection"]')
  ];
  const device = connectionInputs.find(({ value }) => value === "device");
  const local = connectionInputs.find(({ value }) => value === "local");
  const saving = connectionInputs.find(({ value }) => value === "saving");

  taigiInputSettings.hidden = language !== "taigi";

  if (language === "mandarin") {
    for (const input of connectionInputs) input.disabled = input.value === "local";
    if (local?.checked && device) device.checked = true;
  } else {
    for (const input of connectionInputs) input.disabled = false;
    if (taigiInputMode === "translate") {
      if (device) device.disabled = true;
      if (device?.checked && saving) saving.checked = true;
      taigiInputHelp.textContent =
        "「華語翻成台語」一定要使用台語語音服務；裝置語音不會幫你翻譯。";
      sourceText.placeholder = "例如：今天天氣很好，我們一起去公園散步。";
    } else {
      taigiInputHelp.textContent =
        "這段文字不會再翻譯；只接受模型字表內的調符 POJ，不支援漢字或數字調號。";
      sourceText.placeholder = "例如：Kin-á-ji̍t thiⁿ-khì chin hó。";
    }
  }

  if (language === "mandarin") {
    sourceText.placeholder = "例如：今天天氣很好，我們一起去公園散步。";
  }

  const connection = currentConnection();
  const showService = connection !== "device";
  serviceSettings.hidden = !showService;
  saveAudioRow.hidden = !showService;
  deviceVoiceTools.hidden = connection !== "device";
  localLicenseHelp.hidden = !(language === "taigi" && connection === "local");

  if (showService) {
    if (connection === "local") {
      backendUrlInput.value = LOCAL_BACKEND_URL;
      backendHelp.textContent = "本機服務不會把文字送出這台電腦；瀏覽器詢問「本機網路存取」時需選擇允許。";
    } else {
      if (backendUrlInput.value === LOCAL_BACKEND_URL || !backendUrlInput.value) {
        backendUrlInput.value = preferredRemoteEndpoint();
      }
      backendHelp.textContent = language === "mandarin"
        ? `推薦服務已填入 ${DEFAULT_REMOTE_BACKEND_URL}；線上台灣國語需要網路，採非官方 edge-tts，無可用率保證。`
        : `推薦服務已填入 ${DEFAULT_REMOTE_BACKEND_URL}；遠端只接受 HTTPS，按下朗讀後才會逐段傳送文字。`;
    }
    syncBackendTokenForEndpoint();
  }

  setFieldStatus(backendStatus, "");
  renderVoiceChoices();
  announceVoiceAvailability();
}

function updateNetworkStatus(): void {
  const online = navigator.onLine;
  networkStatus.dataset.online = String(online);
  networkStatus.textContent = online ? "目前有網路" : "目前離線";
}

async function refreshVoices(announceStart = false): Promise<void> {
  refreshVoicesButton.disabled = true;
  if (announceStart) setFieldStatus(voiceStatus, "正在重新偵測裝置聲音…");
  try {
    deviceVoices = await loadVoices();
    if (
      currentLanguage() === "mandarin" &&
      currentConnection() === "device" &&
      findMandarinVoices(deviceVoices).length === 0
    ) {
      const saving = document.querySelector<HTMLInputElement>(
        'input[name="connection"][value="saving"]'
      );
      if (saving) {
        saving.checked = true;
        syncModeCapabilities();
        setFieldStatus(
          backendStatus,
          "找不到裝置的 zh-TW 聲音，已改選線上台灣國語；邀請碼可留空。"
        );
        return;
      }
    }
    renderVoiceChoices();
    announceVoiceAvailability(announceStart ? "重新偵測完成；" : "");
  } finally {
    refreshVoicesButton.disabled = false;
  }
}

function clientFor(url: string, token: string): BackendClient {
  const normalizedUrl = validateEndpoint(url);
  const normalizedToken = token.trim();
  const sessionTokenKey = sessionTokenKeyForEndpoint(normalizedUrl);
  saveSessionStorageValue(sessionTokenKey, normalizedToken);
  const client = createBackendClient({
    baseUrl: normalizedUrl,
    token: normalizedToken || undefined,
    sessionTokenKey,
    allowTestProvider: import.meta.env.DEV
  });
  return client;
}

function healthLabel(health: BackendHealth): string {
  if (currentLanguage() === "mandarin") {
    return health.isTestProvider
      ? `已連線，但目前是測試音訊：${health.provider}`
      : `服務已連線並宣告支援線上台灣國語，尚未試播（需網路、非官方、無可用率保證）：${health.mandarinSynthesizer ?? "未標示"}`;
  }
  const direct = health.sourceLanguages.includes("nan-Latn-TW")
    ? "，支援調符 POJ 直讀"
    : "";
  return health.isTestProvider
    ? `已連線，但目前是測試音訊：${health.provider}`
    : `服務已連線並宣告支援台語${direct}，尚未試播：${health.provider}`;
}

async function checkBackend(): Promise<BackendHealth> {
  checkBackendButton.disabled = true;
  setFieldStatus(backendStatus, "正在檢查，尚未傳送朗讀文字…");
  try {
    const normalizedUrl = validateEndpoint(backendUrlInput.value);
    if (currentConnection() === "saving" && !safeRemoteEndpoint(normalizedUrl)) {
      throw new Error("省流量服務必須使用 HTTPS 網址；本機 HTTP 請改選「本機服務」。");
    }
    backendUrlInput.value = normalizedUrl;
    syncBackendTokenForEndpoint(normalizedUrl);
    const client = clientFor(normalizedUrl, backendTokenInput.value);
    const health = await client.refreshHealth();
    if (currentLanguage() === "mandarin" && !health.targetLanguages.includes("zh-TW")) {
      throw new Error("服務已連線，但尚未支援線上台灣國語朗讀。");
    }
    if (
      currentLanguage() === "taigi" &&
      currentTaigiInputMode() === "direct" &&
      !health.sourceLanguages.includes("nan-Latn-TW")
    ) {
      throw new Error("服務已連線，但尚未支援調符 POJ 直接朗讀。請改選「華語翻成台語」。");
    }
    if (currentLanguage() === "taigi" && currentTaigiInputMode() === "translate") {
      rememberProvider(normalizedUrl, "zh-TW", "nan-TW", health.provider);
    }
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
  const taigiInputMode = language === "taigi" ? currentTaigiInputMode() : null;
  let preparedText = validation.text;
  if (taigiInputMode === "direct") {
    const directInput = validateRomanizedTaigiInput(validation.text);
    if (!directInput.ok) throw new Error(directInput.message);
    preparedText = directInput.text;
  }
  const connection = currentConnection();
  if (language === "taigi" && taigiInputMode === "translate" && connection === "device") {
    throw new Error("華語翻台語需要台語語音服務，不能使用裝置語音。");
  }
  const useBackend = connection !== "device";
  const maxLength = useBackend ? MAX_BACKEND_SEGMENT : MAX_DEVICE_SEGMENT;
  const voice = useBackend ? null : chosenVoice();
  if (!useBackend && !voice) {
    throw new Error(
      language === "mandarin"
        ? "這台裝置找不到 zh-TW 聲音。請改選「省流量服務」，或先安裝台灣中文語音。"
        : "這台裝置找不到真正的台語聲音。請改選本機服務或省流量服務。"
    );
  }

  let backendUrl: string | null = null;
  if (useBackend) {
    backendUrl = validateEndpoint(backendUrlInput.value);
    if (connection === "saving" && !safeRemoteEndpoint(backendUrl)) {
      throw new Error("省流量服務必須使用 HTTPS 網址；本機 HTTP 請改選「本機服務」。");
    }
    backendUrlInput.value = backendUrl;
    syncBackendTokenForEndpoint(backendUrl);
    if (connection === "saving") saveLocalStorageValue(REMOTE_ENDPOINT_KEY, backendUrl);
  }

  sourceText.value = preparedText;
  updateTextCount();
  return {
    language,
    taigiInputMode,
    connection,
    chunks: splitText(preparedText, maxLength),
    rate: rateValue(),
    voice,
    backendUrl,
    backendToken: backendTokenInput.value.trim(),
    saveAudio: useBackend && saveAudioInput.checked
  };
}

function updatePlayerPosition(session: ReadingSession): void {
  const number = session.index + 1;
  const total = session.config.chunks.length;
  playerProgress.textContent = `第 ${number.toLocaleString("zh-TW")} 段，共 ${total.toLocaleString("zh-TW")} 段`;
  currentChunk.textContent = session.config.chunks[session.index] ?? "";
  currentChunkLabel.textContent = session.config.language === "taigi"
    ? session.config.taigiInputMode === "translate"
      ? "這一段的華語原文"
      : "這一段輸入的調符 POJ"
    : "這一段的原文";
  taigiResult.hidden = session.config.language !== "taigi";
  if (session.config.language === "taigi") {
    taigiResultHeading.textContent = session.config.taigiInputMode === "translate"
      ? "華語翻成的台語稿（POJ）"
      : "直接朗讀的調符 POJ";
    taigiText.textContent = "正在準備這一段…";
    providerName.textContent = "尚未取得";
  }
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

async function cachedAudio(
  config: ReadingConfig,
  text: string
): Promise<AudioCacheEntry | null> {
  if (!audioCache || !config.backendUrl) return null;
  const source = sourceLanguage(config);
  const target = targetLanguage(config);
  const provider = rememberedProvider(config.backendUrl, source, target);
  if (!provider) return null;
  const entries = await audioCache.list();
  const match = entries.find((entry) =>
    entry.language.toLowerCase() === target.toLowerCase() &&
    entry.voice === cacheVoice(config) &&
    entry.rate === config.rate &&
    entry.provider === provider &&
    entry.text === text
  );
  return match ? audioCache.get(match.key) : null;
}

function cacheVoice(config: ReadingConfig): string {
  if (!config.backendUrl) return "";
  return `${config.backendUrl}#route=${sourceLanguage(config)}->${targetLanguage(config)}`;
}

function sourceLanguage(config: ReadingConfig): SpeechSourceLanguage {
  return config.taigiInputMode === "direct" ? "nan-Latn-TW" : "zh-TW";
}

function targetLanguage(config: ReadingConfig): SpeechTargetLanguage {
  return config.language === "taigi" ? "nan-TW" : "zh-TW";
}

async function prepareAudio(
  session: ReadingSession,
  index: number
): Promise<PreparedAudio> {
  const text = session.config.chunks[index];
  if (!text || !session.config.backendUrl || !session.backend) {
    throw new Error("語音服務設定不完整。");
  }

  const cached = await cachedAudio(session.config, text);
  if (cached) {
    return {
      audio: cached.audio,
      provider: `${cached.provider}（已保存）`,
      spokenText: cached.taigiText ?? text,
      taigiText: cached.taigiText ?? "",
      cached: true
    };
  }

  setPlayerStatus(
    session.config.language === "taigi"
      ? `正在產生第 ${index + 1} 段台語…`
      : `正在產生第 ${index + 1} 段線上台灣國語…`
  );
  const source = sourceLanguage(session.config);
  const target = targetLanguage(session.config);
  const result: SynthesisResult = await session.backend.synthesize({
    text,
    sourceLanguage: source,
    targetLanguage: target,
    rate: session.config.rate,
    signal: session.abortController.signal
  });
  rememberProvider(session.config.backendUrl, source, target, result.provider);

  if (session.config.saveAudio && audioCache) {
    try {
      const saved = await audioCache.put({
        language: target,
        voice: cacheVoice(session.config),
        rate: session.config.rate,
        provider: result.provider,
        text,
        audio: result.audio,
        ...(session.config.language === "taigi" ? { taigiText: result.taigiText } : {})
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
    spokenText: result.spokenText,
    taigiText: result.taigiText,
    cached: false
  };
}

async function playPreparedAudio(
  session: ReadingSession,
  prepared: PreparedAudio
): Promise<void> {
  if (session.config.language === "taigi") {
    taigiResult.hidden = false;
    taigiResultHeading.textContent = session.config.taigiInputMode === "translate"
      ? "華語翻成的台語稿（POJ）"
      : "直接朗讀的調符 POJ";
    providerName.textContent = prepared.provider;
    taigiText.textContent = prepared.taigiText;
  } else {
    taigiResult.hidden = true;
  }
  await waitUntilResumed(session);
  setPlayerStatus(
    session.config.language === "taigi"
      ? prepared.cached ? "播放已保存的台語語音" : "正在播放台語"
      : prepared.cached ? "播放已保存的台灣國語" : "正在播放線上台灣國語"
  );
  await audioPlayer.play(prepared.audio);
  const outcome = await audioPlayer.whenFinished();
  if (outcome.reason === "error") throw outcome.error ?? new Error("音訊無法播放。");
  if (outcome.reason !== "ended") throw new DOMException("朗讀已停止。", "AbortError");
}

async function playDeviceChunk(session: ReadingSession, text: string): Promise<void> {
  const voice = session.config.voice;
  if (!voice) throw new Error("裝置聲音設定遺失。");
  providerName.textContent = `裝置聲音：${voice.name}（${voice.lang}）`;
  if (session.config.language === "taigi") {
    taigiResult.hidden = false;
    taigiResultHeading.textContent = "直接朗讀的調符 POJ";
    taigiText.textContent = text;
  } else {
    taigiResult.hidden = true;
  }
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

  const pending = new Map<number, Promise<PreparedAudio>>();
  try {
    for (; session.index < config.chunks.length; session.index += 1) {
      if (activeSession !== session || session.abortController.signal.aborted) {
        throw new DOMException("朗讀已停止。", "AbortError");
      }
      updatePlayerPosition(session);
      const text = config.chunks[session.index];
      if (!text) continue;

      if (config.connection !== "device") {
        const prepared = await (pending.get(session.index) ?? prepareAudio(session, session.index));
        pending.delete(session.index);

        const nextIndex = session.index + 1;
        if (nextIndex < config.chunks.length) {
          const next = prepareAudio(session, nextIndex);
          // Attach a handler now so STOP during playback cannot create an
          // unhandled rejection; awaiting the original promise still reports it.
          void next.catch(() => undefined);
          pending.set(nextIndex, next);
        }
        await playPreparedAudio(session, prepared);
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
    savedAudioEntries = [];
    librarySummary.textContent = "這個瀏覽器無法保存語音。";
    savedAudioList.hidden = true;
    savedAudioList.replaceChildren();
    clearLibraryButton.disabled = true;
    return;
  }
  try {
    librarySummary.removeAttribute("data-kind");
    const entries = await audioCache.list();
    savedAudioEntries = entries;
    const bytes = entries.reduce((total, entry) => total + entry.bytes, 0);
    librarySummary.textContent = entries.length === 0
      ? "尚未保存語音。"
      : `已保存 ${entries.length.toLocaleString("zh-TW")} 段，共 ${formatBytes(bytes)}；上限 ${formatBytes(audioCache.maxBytes)}。`;
    clearLibraryButton.disabled = entries.length === 0;
    renderSavedAudio(entries);
  } catch {
    savedAudioEntries = [];
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
    details.textContent = `${entry.language}・${entry.provider}・${entry.rate}×・${formatBytes(entry.bytes)}`;
    copy.append(title, details);

    const actions = document.createElement("div");
    actions.className = "saved-audio-actions";
    const playback = document.createElement("button");
    const playbackSnapshot = savedAudioPlayback.snapshot;
    const isCurrentPlayback = configureSavedPlaybackButton(
      playback,
      playbackSnapshot,
      entry.key,
      position
    );
    playback.className = isCurrentPlayback
      ? "button button-danger library-action"
      : "button button-primary library-action";
    playback.addEventListener("click", () => {
      if (!audioCache) return;
      if (
        savedAudioPlayback.snapshot.key === entry.key &&
        (savedAudioPlayback.snapshot.state === "loading" ||
          savedAudioPlayback.snapshot.state === "playing")
      ) {
        savedAudioPlayback.stop();
        return;
      }
      void savedAudioPlayback.play(entry.key, async () => {
        const found = await audioCache?.get(entry.key) ?? null;
        if (!found) await updateLibrarySummary();
        return found;
      });
    });

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
        anchor.download = `awei-voice-${position + 1}.${audioExtension(found.mimeType)}`;
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
      if (!audioCache || !window.confirm("確定要刪除這一段已保存的語音嗎？")) return;
      if (savedAudioPlayback.snapshot.key === entry.key) savedAudioPlayback.stop();
      remove.disabled = true;
      try {
        await audioCache.delete(entry.key);
        await updateLibrarySummary();
      } catch (error) {
        showFormError(`刪除語音失敗：${errorMessage(error)}`);
        remove.disabled = false;
      }
    });
    actions.append(playback, download, remove);
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
for (const input of document.querySelectorAll<HTMLInputElement>('input[name="taigiInputMode"]')) {
  input.addEventListener("change", syncModeCapabilities);
}
for (const input of document.querySelectorAll<HTMLInputElement>('input[name="connection"]')) {
  input.addEventListener("change", syncModeCapabilities);
}

backendTokenInput.addEventListener("input", () => {
  saveTokenForCurrentEndpoint();
});

backendUrlInput.addEventListener("input", () => {
  syncBackendTokenForEndpoint();
});

refreshVoicesButton.addEventListener("click", () => {
  void refreshVoices(true);
});

const stopWatchingVoices = watchVoices((voices) => {
  deviceVoices = voices;
  renderVoiceChoices();
  announceVoiceAvailability("裝置聲音清單已更新；");
});

checkBackendButton.addEventListener("click", () => {
  void checkBackend().catch(() => undefined);
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (
    savedAudioPlayback.snapshot.state === "loading" ||
    savedAudioPlayback.snapshot.state === "playing"
  ) {
    savedAudioPlayback.stop("已停止保存語音，開始新的朗讀");
  }
  try {
    const config = collectConfig();
    const needsAudioUnlock = config.connection !== "device";
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
  if (!audioCache || !window.confirm("確定要刪除這台裝置保存的全部語音嗎？")) return;
  savedAudioPlayback.stop();
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
  savedAudioPlayback.stop("");
  audioCache?.close();
  stopWatchingVoices();
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
