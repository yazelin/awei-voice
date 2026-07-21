import { normalizeText } from "./text";

export const AUDIO_CACHE_SCHEMA_VERSION = 1;
export const DEFAULT_AUDIO_CACHE_MAX_BYTES = 50 * 1024 * 1024;
export const DEFAULT_AUDIO_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

export interface AudioCacheKeyParts {
  language: string;
  voice: string;
  rate: number;
  provider: string;
  text: string;
}

export interface AudioCachePutValue extends AudioCacheKeyParts {
  audio: Blob;
  taigiText?: string;
}

export interface AudioCacheMetadata extends AudioCacheKeyParts {
  key: string;
  mimeType: string;
  bytes: number;
  createdAt: number;
  lastAccessedAt: number;
  expiresAt: number;
  taigiText?: string;
}

export interface AudioCacheEntry extends AudioCacheMetadata {
  audio: Blob;
}

export type AudioCachePutResult =
  | { saved: true; entry: AudioCacheMetadata; evictedKeys: string[] }
  | { saved: false; reason: "disabled" | "empty" | "too_large"; bytes: number };

export interface AudioCacheOptions {
  enabled?: boolean;
  indexedDB?: IDBFactory;
  databaseName?: string;
  storeName?: string;
  maxBytes?: number;
  ttlMs?: number;
  now?: () => number;
  subtle?: SubtleCrypto;
}

interface StoredAudioEntry extends AudioCacheMetadata {
  schemaVersion: number;
  audioBytes: ArrayBuffer;
}

function isBlobLike(value: unknown): value is Blob {
  return Boolean(value && typeof value === "object" &&
    typeof (value as Blob).size === "number" &&
    typeof (value as Blob).type === "string" &&
    typeof (value as Blob).slice === "function");
}

function isArrayBufferLike(value: unknown): value is ArrayBuffer {
  return Boolean(value && typeof value === "object" &&
    Object.prototype.toString.call(value) === "[object ArrayBuffer]" &&
    typeof (value as ArrayBuffer).byteLength === "number");
}

function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === "function") return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) resolve(reader.result);
      else reject(new Error("無法讀取要保存的音訊。"));
    };
    reader.onerror = () => reject(reader.error ?? new Error("無法讀取要保存的音訊。"));
    reader.readAsArrayBuffer(blob);
  });
}

function canonicalLanguage(language: string): string {
  const candidate = String(language || "").trim().replace(/_/gu, "-");
  if (!candidate) throw new TypeError("音訊快取必須指定語言。");
  try {
    return new Intl.Locale(candidate).toString();
  } catch {
    throw new TypeError("音訊快取的語言標籤格式不正確。");
  }
}

export function canonicalizeAudioCacheKey(parts: AudioCacheKeyParts): AudioCacheKeyParts {
  const text = normalizeText(parts.text);
  const voice = String(parts.voice || "").trim();
  const provider = String(parts.provider || "").trim();
  const rate = Number(parts.rate);
  if (!text) throw new TypeError("音訊快取不可保存空白文字。");
  if (!voice) throw new TypeError("音訊快取必須指定 voice。");
  if (!provider) throw new TypeError("音訊快取必須指定 provider。");
  if (!Number.isFinite(rate) || rate <= 0) throw new TypeError("音訊快取的語速格式不正確。");

  return {
    language: canonicalLanguage(parts.language),
    voice,
    rate,
    provider,
    text
  };
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function createAudioCacheKey(
  parts: AudioCacheKeyParts,
  subtle: SubtleCrypto = globalThis.crypto.subtle
): Promise<string> {
  if (!subtle) throw new Error("目前瀏覽器無法建立安全的音訊快取索引。");
  const canonical = canonicalizeAudioCacheKey(parts);
  const encoded = new TextEncoder().encode(JSON.stringify({
    version: AUDIO_CACHE_SCHEMA_VERSION,
    ...canonical
  }));
  return `audio-v${AUDIO_CACHE_SCHEMA_VERSION}-${hex(await subtle.digest("SHA-256", encoded))}`;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("音訊儲存操作失敗。"));
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("音訊儲存操作已中止。"));
    transaction.onerror = () => reject(transaction.error ?? new Error("音訊儲存操作失敗。"));
  });
}

function metadataFor(entry: StoredAudioEntry): AudioCacheMetadata {
  const metadata: AudioCacheMetadata = {
    key: entry.key,
    language: entry.language,
    voice: entry.voice,
    rate: entry.rate,
    provider: entry.provider,
    text: entry.text,
    mimeType: entry.mimeType,
    bytes: entry.bytes,
    createdAt: entry.createdAt,
    lastAccessedAt: entry.lastAccessedAt,
    expiresAt: entry.expiresAt
  };
  if (entry.taigiText !== undefined) metadata.taigiText = entry.taigiText;
  return metadata;
}

export class AudioCache {
  readonly maxBytes: number;
  readonly ttlMs: number;

  private enabledValue: boolean;
  private readonly factory: IDBFactory;
  private readonly databaseName: string;
  private readonly storeName: string;
  private readonly now: () => number;
  private readonly subtle: SubtleCrypto;
  private opening: Promise<IDBDatabase> | null = null;
  private operations: Promise<void> = Promise.resolve();

  constructor(options: AudioCacheOptions = {}) {
    const factory = options.indexedDB ?? globalThis.indexedDB;
    const subtle = options.subtle ?? globalThis.crypto?.subtle;
    if (!factory) throw new Error("目前瀏覽器不支援 IndexedDB，無法保存語音。");
    if (!subtle) throw new Error("目前瀏覽器不支援安全的快取索引。");
    this.factory = factory;
    this.subtle = subtle;
    this.enabledValue = options.enabled === true;
    this.databaseName = options.databaseName ?? "awei-voice-audio";
    this.storeName = options.storeName ?? "audioSegments";
    this.maxBytes = options.maxBytes ?? DEFAULT_AUDIO_CACHE_MAX_BYTES;
    this.ttlMs = options.ttlMs ?? DEFAULT_AUDIO_CACHE_TTL_MS;
    this.now = options.now ?? Date.now;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes <= 0) {
      throw new RangeError("音訊快取容量必須大於 0。");
    }
    if (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0) {
      throw new RangeError("音訊快取保存期限必須大於 0。");
    }
  }

  get enabled(): boolean {
    return this.enabledValue;
  }

  async setEnabled(value: boolean, clearWhenDisabled = true): Promise<void> {
    this.enabledValue = value === true;
    if (!this.enabledValue && clearWhenDisabled) await this.clear();
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operations.then(operation, operation);
    this.operations = result.then(() => undefined, () => undefined);
    return result;
  }

  private database(): Promise<IDBDatabase> {
    if (!this.opening) {
      const attempt = new Promise<IDBDatabase>((resolve, reject) => {
        const request = this.factory.open(this.databaseName, AUDIO_CACHE_SCHEMA_VERSION);
        request.onupgradeneeded = () => {
          const database = request.result;
          const store = database.objectStoreNames.contains(this.storeName)
            ? request.transaction?.objectStore(this.storeName)
            : database.createObjectStore(this.storeName, { keyPath: "key" });
          if (store && !store.indexNames.contains("lastAccessedAt")) {
            store.createIndex("lastAccessedAt", "lastAccessedAt");
          }
          if (store && !store.indexNames.contains("expiresAt")) store.createIndex("expiresAt", "expiresAt");
        };
        request.onsuccess = () => {
          const database = request.result;
          database.onversionchange = () => {
            database.close();
            this.opening = null;
          };
          resolve(database);
        };
        request.onerror = () => reject(request.error ?? new Error("無法開啟語音儲存空間。"));
        request.onblocked = () => reject(new Error("語音儲存空間正被其他分頁更新，請稍後再試。"));
      });
      this.opening = attempt;
      attempt.catch(() => {
        if (this.opening === attempt) this.opening = null;
      });
    }
    return this.opening;
  }

  private async allRecords(): Promise<StoredAudioEntry[]> {
    const database = await this.database();
    const transaction = database.transaction(this.storeName, "readonly");
    const completed = transactionComplete(transaction);
    const result = await requestResult(transaction.objectStore(this.storeName).getAll()) as StoredAudioEntry[];
    await completed;
    return result.filter((entry) => entry.schemaVersion === AUDIO_CACHE_SCHEMA_VERSION);
  }

  private async writeChanges(deletedKeys: readonly string[], put?: StoredAudioEntry): Promise<void> {
    if (deletedKeys.length === 0 && !put) return;
    const database = await this.database();
    const transaction = database.transaction(this.storeName, "readwrite");
    const completed = transactionComplete(transaction);
    const store = transaction.objectStore(this.storeName);
    for (const key of new Set(deletedKeys)) store.delete(key);
    if (put) store.put(put);
    await completed;
  }

  private async activeRecords(currentTime: number): Promise<StoredAudioEntry[]> {
    const records = await this.allRecords();
    const expired = records.filter((entry) =>
      !Number.isFinite(entry.expiresAt) || entry.expiresAt <= currentTime ||
      !isArrayBufferLike(entry.audioBytes) || entry.audioBytes.byteLength !== entry.bytes
    );
    if (expired.length > 0) await this.writeChanges(expired.map(({ key }) => key));
    return records.filter((entry) => !expired.includes(entry));
  }

  async get(partsOrKey: AudioCacheKeyParts | string): Promise<AudioCacheEntry | null> {
    return this.serialize(async () => {
      if (!this.enabledValue) return null;
      const key = typeof partsOrKey === "string"
        ? partsOrKey
        : await createAudioCacheKey(partsOrKey, this.subtle);
      const currentTime = this.now();
      const records = await this.activeRecords(currentTime);
      const found = records.find((entry) => entry.key === key);
      if (!found) return null;
      const touched: StoredAudioEntry = {
        ...found,
        lastAccessedAt: currentTime,
        expiresAt: currentTime + this.ttlMs
      };
      await this.writeChanges([], touched);
      return {
        ...metadataFor(touched),
        audio: new Blob([touched.audioBytes], { type: touched.mimeType })
      };
    });
  }

  async put(value: AudioCachePutValue): Promise<AudioCachePutResult> {
    return this.serialize(async () => {
      const bytes = isBlobLike(value.audio) ? value.audio.size : 0;
      if (!this.enabledValue) return { saved: false, reason: "disabled", bytes };
      if (!isBlobLike(value.audio) || bytes === 0) return { saved: false, reason: "empty", bytes: 0 };
      if (bytes > this.maxBytes) return { saved: false, reason: "too_large", bytes };

      const canonical = canonicalizeAudioCacheKey(value);
      const key = await createAudioCacheKey(canonical, this.subtle);
      const audioBytes = await blobToArrayBuffer(value.audio);
      const currentTime = this.now();
      const records = await this.activeRecords(currentTime);
      const existing = records.find((entry) => entry.key === key);
      const candidates = records.filter((entry) => entry.key !== key);
      let totalBytes = candidates.reduce((total, entry) => total + entry.bytes, 0);
      const evictedKeys: string[] = [];

      for (const candidate of [...candidates].sort((left, right) =>
        left.lastAccessedAt - right.lastAccessedAt || left.createdAt - right.createdAt
      )) {
        if (totalBytes + bytes <= this.maxBytes) break;
        totalBytes -= candidate.bytes;
        evictedKeys.push(candidate.key);
      }

      const stored: StoredAudioEntry = {
        schemaVersion: AUDIO_CACHE_SCHEMA_VERSION,
        key,
        ...canonical,
        audioBytes,
        mimeType: value.audio.type || "application/octet-stream",
        bytes,
        createdAt: existing?.createdAt ?? currentTime,
        lastAccessedAt: currentTime,
        expiresAt: currentTime + this.ttlMs
      };
      if (value.taigiText !== undefined) stored.taigiText = value.taigiText;
      await this.writeChanges(evictedKeys, stored);
      return { saved: true, entry: metadataFor(stored), evictedKeys };
    });
  }

  async list(): Promise<AudioCacheMetadata[]> {
    return this.serialize(async () => {
      const records = await this.activeRecords(this.now());
      return records
        .sort((left, right) => right.lastAccessedAt - left.lastAccessedAt || right.createdAt - left.createdAt)
        .map(metadataFor);
    });
  }

  async delete(partsOrKey: AudioCacheKeyParts | string): Promise<void> {
    return this.serialize(async () => {
      const key = typeof partsOrKey === "string"
        ? partsOrKey
        : await createAudioCacheKey(partsOrKey, this.subtle);
      await this.writeChanges([key]);
    });
  }

  async clear(): Promise<void> {
    return this.serialize(async () => {
      const database = await this.database();
      const transaction = database.transaction(this.storeName, "readwrite");
      const completed = transactionComplete(transaction);
      transaction.objectStore(this.storeName).clear();
      await completed;
    });
  }

  async estimate(): Promise<{ bytes: number; entries: number; maxBytes: number }> {
    return this.serialize(async () => {
      const records = await this.activeRecords(this.now());
      return {
        bytes: records.reduce((total, entry) => total + entry.bytes, 0),
        entries: records.length,
        maxBytes: this.maxBytes
      };
    });
  }

  close(): void {
    void this.opening?.then((database) => database.close());
    this.opening = null;
  }
}
