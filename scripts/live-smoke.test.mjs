import assert from "node:assert/strict";
import test from "node:test";

import { runLiveSmoke, SmokeError } from "./live-smoke.mjs";

const origin = "https://yazelin.github.io";
const translator = "openai-compatible:example/model";
const synthesizer = "mms:facebook/mms-tts-nan";
const mandarinSynthesizer = "edge-tts-online-unofficial:zh-TW-HsiaoChenNeural";
const providers = {
  "zh-TW->nan-TW": `${translator}+${synthesizer}`,
  "nan-Latn-TW->nan-TW": `direct:nan-Latn-TW+${synthesizer}`,
  "zh-TW->zh-TW": `direct:zh-TW+${mandarinSynthesizer}`
};
const jobIds = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003"
];

const cors = {
  "Access-Control-Allow-Origin": origin,
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "600",
  "Cache-Control": "no-store, max-age=0",
  Vary: "Origin"
};

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers }
  });
}

function wavBase64() {
  const bytes = Buffer.alloc(44);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(36, 4);
  bytes.write("WAVE", 8, "ascii");
  return bytes.toString("base64");
}

function mp3Base64(valid = true) {
  return Buffer.from(valid ? [0x49, 0x44, 0x33, 0x04, 0x00, 0x00] : [0x4e, 0x4f, 0x50, 0x45])
    .toString("base64");
}

function health() {
  return {
    status: "ok",
    mode: "concrete",
    translator,
    synthesizer,
    mandarin_synthesizer: mandarinSynthesizer,
    source_languages: ["zh-TW", "nan-Latn-TW"],
    target_languages: ["nan-TW", "zh-TW"],
    capabilities: [
      {
        source_language: "zh-TW",
        target_language: "nan-TW",
        mode: "translate-to-taigi",
        provider: providers["zh-TW->nan-TW"]
      },
      {
        source_language: "nan-Latn-TW",
        target_language: "nan-TW",
        mode: "read-taigi-romanization",
        provider: providers["nan-Latn-TW->nan-TW"]
      },
      {
        source_language: "zh-TW",
        target_language: "zh-TW",
        mode: "online-mandarin-backup",
        provider: providers["zh-TW->zh-TW"],
        network_required: true,
        unofficial: true,
        sla_guaranteed: false
      }
    ]
  };
}

function mockService({ validMp3 = true } = {}) {
  const jobs = new Map();
  const deleted = [];
  const requests = [];
  let createCount = 0;
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/awei-voice/u, "");
    const method = init.method || "GET";
    requests.push({ path, method });
    if (path === "/health" && method === "GET") return json(health());
    if (path === "/v1/synthesis-jobs" && method === "OPTIONS") {
      assert.equal(new Headers(init.headers).get("Origin"), origin);
      return new Response(null, { status: 200, headers: cors });
    }
    if (path === "/v1/access" && method === "GET") {
      return json({
        authentication_required: false,
        subject: "local-open-access",
        remaining: {
          subject_jobs: 20,
          subject_characters: 2_000,
          global_jobs: 20,
          global_characters: 2_000
        }
      }, 200, cors);
    }
    if (path === "/v1/synthesis-jobs" && method === "POST") {
      const body = JSON.parse(String(init.body));
      const label = `${body.source_language}->${body.target_language}`;
      assert.equal(body.rate, 1);
      const jobId = jobIds[createCount++];
      jobs.set(jobId, { label, text: body.text });
      return json({ job_id: jobId, status: "pending" }, 202, cors);
    }
    const match = path.match(/^\/v1\/synthesis-jobs\/([^/]+)$/u);
    if (match) {
      const jobId = decodeURIComponent(match[1]);
      if (method === "DELETE") {
        deleted.push(jobId);
        jobs.delete(jobId);
        return new Response(null, { status: 204, headers: cors });
      }
      const job = jobs.get(jobId);
      assert.ok(job);
      const isMandarin = job.label === "zh-TW->zh-TW";
      const taigiText = isMandarin
        ? null
        : job.label === "nan-Latn-TW->nan-TW"
          ? "kin-á-ji̍t thinn-khì chin hó"
          : "Kin-á-ji̍t thiⁿ-khì chin hó。";
      return json({
        job_id: jobId,
        status: "completed",
        result: {
          spoken_text: isMandarin ? job.text : taigiText,
          taigi_text: taigiText,
          audio_base64: isMandarin ? mp3Base64(validMp3) : wavBase64(),
          mime_type: isMandarin ? "audio/mpeg" : "audio/wav",
          provider: providers[job.label]
        }
      }, 200, cors);
    }
    throw new Error("unexpected mock request");
  };
  return { fetchImpl, deleted, requests };
}

const fastOptions = {
  minCreateIntervalMs: 0,
  pollIntervalMs: 0,
  jobDeadlineMs: 1_000,
  requestTimeoutMs: 1_000
};

test("validates all formal routes and cleans up every job", async () => {
  const service = mockService();
  const lines = [];
  await runLiveSmoke("https://voice.test/awei-voice", {
    ...fastOptions,
    fetchImpl: service.fetchImpl,
    logger: (line) => lines.push(line)
  });

  assert.deepEqual(service.deleted, jobIds);
  assert.equal(service.requests.filter(({ method }) => method === "POST").length, 3);
  assert.deepEqual(lines.map((line) => JSON.parse(line).route), [
    "health",
    "preflight",
    "access",
    "zh-TW->nan-TW",
    "nan-Latn-TW->nan-TW",
    "zh-TW->zh-TW",
    "all"
  ]);
  assert.ok(lines.every((line) => !line.includes("今天天氣") && !line.includes("阿瑋")));
});

test("rejects bad MP3 magic and still cleans up every created job", async () => {
  const service = mockService({ validMp3: false });
  await assert.rejects(
    runLiveSmoke("https://voice.test/awei-voice", {
      ...fastOptions,
      fetchImpl: service.fetchImpl,
      logger: () => undefined
    }),
    (error) => error instanceof SmokeError && error.code === "audio_magic_mismatch"
  );
  assert.deepEqual(service.deleted, jobIds);
});

test("accepts only HTTPS endpoints without embedded URL data", async () => {
  for (const endpoint of [
    "http://voice.test/awei-voice",
    "https://user:secret@voice.test/awei-voice",
    "https://voice.test/awei-voice?token=secret",
    "not-a-url"
  ]) {
    await assert.rejects(
      runLiveSmoke(endpoint, { ...fastOptions, fetchImpl: () => assert.fail("must not fetch") }),
      (error) => error instanceof SmokeError && error.code === "invalid_endpoint"
    );
  }
});
