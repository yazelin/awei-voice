export interface VoiceLike {
  readonly default?: boolean;
  readonly lang: string;
  readonly localService?: boolean;
  readonly name: string;
  readonly voiceURI: string;
}

export type VoiceKind = "mandarin" | "taigi" | "other";

export interface VoiceSource {
  getVoices(): SpeechSynthesisVoice[];
  addEventListener?(type: "voiceschanged", listener: EventListener): void;
  removeEventListener?(type: "voiceschanged", listener: EventListener): void;
}

function canonicalLocale(language: string): Intl.Locale | null {
  const candidate = String(language || "").trim().replace(/_/gu, "-");
  if (!candidate) return null;
  try {
    return new Intl.Locale(candidate);
  } catch {
    return null;
  }
}

export function isZhTwLanguage(language: string): boolean {
  const locale = canonicalLocale(language);
  return locale?.language.toLowerCase() === "zh" && locale.region?.toUpperCase() === "TW";
}

export function isNanTwLanguage(language: string): boolean {
  const locale = canonicalLocale(language);
  return locale?.language.toLowerCase() === "nan" && locale.region?.toUpperCase() === "TW";
}

function hasExplicitTaigiLabel(voice: VoiceLike): boolean {
  const label = `${voice.name} ${voice.voiceURI}`.normalize("NFKC");
  return /(?:taiwan(?:ese)?[\s_-]*(?:hokkien|min[\s_-]*nan)|(?:hokkien|min[\s_-]*nan)[\s_(\/-]*taiwan|(?:tai[\s_-]*gi|taigi)|(?:臺灣|台灣)?(?:臺語|台語)|臺灣閩南語|台灣閩南語)/iu.test(label);
}

/** A device voice is Taigi only when its locale or its product label says so. */
export function isTaigiVoice(voice: VoiceLike): boolean {
  return isNanTwLanguage(voice.lang) || hasExplicitTaigiLabel(voice);
}

/** zh-CN/zh-HK voices are deliberately excluded. */
export function isMandarinVoice(voice: VoiceLike): boolean {
  return !isTaigiVoice(voice) && isZhTwLanguage(voice.lang);
}

export function classifyVoice(voice: VoiceLike): VoiceKind {
  if (isTaigiVoice(voice)) return "taigi";
  if (isMandarinVoice(voice)) return "mandarin";
  return "other";
}

function preferLocalAndDefault<T extends VoiceLike>(left: T, right: T): number {
  const leftRank = Number(left.localService !== false) * 2 + Number(left.default === true);
  const rightRank = Number(right.localService !== false) * 2 + Number(right.default === true);
  return rightRank - leftRank || left.name.localeCompare(right.name, "zh-TW");
}

export function findMandarinVoices<T extends VoiceLike>(voices: readonly T[]): T[] {
  return voices.filter(isMandarinVoice).sort(preferLocalAndDefault);
}

export function findTaigiVoices<T extends VoiceLike>(voices: readonly T[]): T[] {
  return voices.filter(isTaigiVoice).sort(preferLocalAndDefault);
}

export const findTaiwaneseVoices = findTaigiVoices;

function defaultVoiceSource(): VoiceSource | null {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return null;
  return window.speechSynthesis;
}

/**
 * Browsers often expose an empty voice list during first paint. Wait once for
 * voiceschanged, but always settle so an unavailable device voice cannot hang
 * the interface.
 */
export function loadVoices(
  source: VoiceSource | null = defaultVoiceSource(),
  timeoutMs = 1_500
): Promise<SpeechSynthesisVoice[]> {
  if (!source) return Promise.resolve([]);
  const initial = source.getVoices();
  if (initial.length > 0) return Promise.resolve([...initial]);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    return Promise.reject(new RangeError("等待裝置聲音的時間不得小於 0。"));
  }

  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      source.removeEventListener?.("voiceschanged", changed);
      resolve([...source.getVoices()]);
    };
    const changed: EventListener = () => finish();

    timer = setTimeout(finish, timeoutMs);
    source.addEventListener?.("voiceschanged", changed);
  });
}
