import { describe, expect, it } from "vitest";

import {
  BUILTIN_REMOTE_BACKEND_URL,
  resolveRemoteEndpoint,
  safeRemoteEndpoint
} from "../src/lib/reader-config";

describe("reader remote service configuration", () => {
  it("ships an HTTPS default and permits a saved HTTPS endpoint", () => {
    expect(BUILTIN_REMOTE_BACKEND_URL).toBe("https://ching-tech.ddns.net/awei-voice");
    expect(resolveRemoteEndpoint("https://family.example/voice/", undefined))
      .toBe("https://family.example/voice");
  });

  it("never promotes HTTP or credential-bearing values into remote mode", () => {
    expect(safeRemoteEndpoint("http://127.0.0.1:8765")).toBeNull();
    expect(safeRemoteEndpoint("https://user:secret@voice.example")).toBeNull();
    expect(resolveRemoteEndpoint("http://voice.example", "also invalid"))
      .toBe(BUILTIN_REMOTE_BACKEND_URL);
  });
});
