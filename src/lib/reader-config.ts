import { validateEndpoint } from "./backend";

export const BUILTIN_REMOTE_BACKEND_URL = "https://ching-tech.ddns.net/awei-voice";

/** Remote mode never accepts localhost HTTP, even though local mode does. */
export function safeRemoteEndpoint(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    const endpoint = validateEndpoint(value);
    return new URL(endpoint).protocol === "https:" ? endpoint : null;
  } catch {
    return null;
  }
}

export function resolveRemoteEndpoint(
  savedEndpoint: string | null | undefined,
  configuredDefault: string | null | undefined
): string {
  return safeRemoteEndpoint(savedEndpoint)
    ?? safeRemoteEndpoint(configuredDefault)
    ?? BUILTIN_REMOTE_BACKEND_URL;
}
