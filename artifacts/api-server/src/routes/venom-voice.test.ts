/**
 * venom-voice.test.ts — route tests for the hands-free voice endpoints.
 *
 * The router factory takes injected fakes for the audio module, availability
 * probe, and auth resolver, so these tests exercise the real HTTP behavior
 * (status codes, SSE framing, validation, limits) without any OpenAI calls.
 */

import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { Buffer } from "node:buffer";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import express from "express";
import {
  createVenomVoiceRouter,
  VOICE_DECISION_RECORD_BUDGET_MS,
  type VenomVoiceAudioModule,
} from "./venom-voice";
import type {
  VoiceJudgeInput,
  VoiceJudgeVerdict,
} from "../lib/venom-voice-restraint";
import type {
  VoiceDecisionRecord,
  VoiceDecisionOutcome,
} from "../lib/venom-voice-decision-store";
import {
  voiceRestraintThresholds,
  type StoredVoiceDecision,
} from "../lib/venom-voice-decision-report";
import { MAX_API_JSON_BODY_BYTES } from "./venom-workspace-router";

const USER_ID = "user_voiceTester";

// A tiny but real WebM header (EBML magic) so detectAudioFormat fakes stay
// honest about receiving binary, not text.
const WEBM_BYTES = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02, 0x03]);
const MP4_BYTES = Buffer.from("....ftypisom-mp4-audio-bytes", "utf8");

type AudioModuleOverrides = Partial<VenomVoiceAudioModule>;

type HarnessOptions = {
  available?: boolean;
  userId?: string | null;
  audioModule?: AudioModuleOverrides;
  /** Rejects the lazy import itself (audio module missing). */
  failModuleLoad?: boolean;
  /** Judge behavior for ambiguous turns; defaults to "no verdict" (null). */
  judgeTurn?: (input: VoiceJudgeInput) => Promise<VoiceJudgeVerdict | null>;
  /** Makes the fake store's record() reject. */
  failDecisionRecord?: boolean;
  /** Delays the fake store's record() by this many ms before it lands. */
  recordDelayMs?: number;
  /** Makes the fake store's record() never resolve at all. */
  recordHangs?: boolean;
  /** Makes the fake store's recordOutcome() reject. */
  failOutcomeRecord?: boolean;
  /** What the fake store answers for recordOutcome. Default: recorded. */
  outcomeRecorded?: boolean;
  /** What the fake store's listForUser returns. Default: no rows. */
  decisionRows?: StoredVoiceDecision[];
  /** Makes the fake store's listForUser reject. */
  failDecisionList?: boolean;
};

type Harness = {
  baseUrl: string;
  close: () => Promise<void>;
  calls: {
    speechToText: Array<{ bytes: number; format: string | undefined }>;
    ensureCompatibleFormat: number;
    textToSpeech: Array<{ text: string; voice: string | undefined }>;
    judged: VoiceJudgeInput[];
    decisionsRecorded: VoiceDecisionRecord[];
    outcomesRecorded: Array<{
      userId: string;
      decisionId: string;
      outcome: VoiceDecisionOutcome;
    }>;
    decisionListRequests: Array<{ userId: string; since: Date }>;
  };
};

async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const calls: Harness["calls"] = {
    speechToText: [],
    ensureCompatibleFormat: 0,
    textToSpeech: [],
    judged: [],
    decisionsRecorded: [],
    outcomesRecorded: [],
    decisionListRequests: [],
  };

  const audioModule: VenomVoiceAudioModule = {
    async speechToText(buffer, format) {
      calls.speechToText.push({ bytes: buffer.byteLength, format });
      return "hello from the mic";
    },
    async textToSpeechStream(_text, voice) {
      calls.textToSpeech.push({ text: _text, voice });
      return (async function* () {
        yield Buffer.from("pcm-one").toString("base64");
        yield Buffer.from("pcm-two").toString("base64");
      })();
    },
    detectAudioFormat(buffer) {
      if (buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
        return "webm";
      }
      if (buffer.includes(Buffer.from("ftyp"))) return "mp4";
      return "unknown";
    },
    async ensureCompatibleFormat(buffer) {
      calls.ensureCompatibleFormat += 1;
      return { buffer, format: "wav" as const };
    },
    ...options.audioModule,
  };

  const app = express();
  app.use(express.json({ limit: MAX_API_JSON_BODY_BYTES }));
  app.use(
    "/api",
    createVenomVoiceRouter({
      isAvailable: () => options.available ?? true,
      resolveUserId: () =>
        options.userId === undefined ? USER_ID : options.userId,
      loadAudioModule: options.failModuleLoad
        ? () => Promise.reject(new Error("integration env vars missing"))
        : () => Promise.resolve(audioModule),
      judgeTurn: async (input) => {
        calls.judged.push(input);
        return options.judgeTurn ? options.judgeTurn(input) : null;
      },
      decisionStore: {
        async record(decision) {
          if (options.failDecisionRecord) {
            throw new Error("decision store is down");
          }
          if (options.recordHangs) {
            await new Promise<never>(() => {});
          }
          if (options.recordDelayMs) {
            await new Promise((resolve) =>
              setTimeout(resolve, options.recordDelayMs),
            );
          }
          calls.decisionsRecorded.push(decision);
        },
        async recordOutcome(userId, decisionId, outcome) {
          if (options.failOutcomeRecord) {
            throw new Error("outcome store is down");
          }
          calls.outcomesRecorded.push({ userId, decisionId, outcome });
          return { recorded: options.outcomeRecorded ?? true };
        },
        async listForUser(userId, since) {
          if (options.failDecisionList) {
            throw new Error("decision store is down");
          }
          calls.decisionListRequests.push({ userId, since });
          return options.decisionRows ?? [];
        },
      },
    }),
  );

  const server: Server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Server has no port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/api`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
    calls,
  };
}

function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Parses `data:` SSE frames from a fully buffered response body. */
function parseSseEvents(raw: string): string[] {
  return raw
    .split("\n\n")
    .map((block) => block.trim())
    .filter((block) => block.startsWith("data: "))
    .map((block) => block.slice("data: ".length));
}

// ── Auth ─────────────────────────────────────────────────────────────────────

test("voice endpoints require auth", async () => {
  const harness = await startHarness({ userId: null });
  try {
    const catalog = await fetch(`${harness.baseUrl}/venom/voice/catalog`);
    assert.equal(catalog.status, 401);
    const transcribe = await postJson(
      `${harness.baseUrl}/venom/voice/transcribe`,
      { audioBase64: WEBM_BYTES.toString("base64") },
    );
    assert.equal(transcribe.status, 401);
    const speak = await postJson(`${harness.baseUrl}/venom/voice/speak`, {
      text: "hi",
      presetId: "sam",
    });
    assert.equal(speak.status, 401);
  } finally {
    await harness.close();
  }
});

// ── Catalog ──────────────────────────────────────────────────────────────────

test("catalog lists six named presets with availability", async () => {
  const harness = await startHarness({ available: true });
  try {
    const response = await fetch(`${harness.baseUrl}/venom/voice/catalog`);
    assert.equal(response.status, 200);
    const presets = (await response.json()) as Array<{
      id: string;
      name: string;
      persona: string;
      tone: string;
      sampleText: string;
      available: boolean;
      availabilityText: string;
    }>;
    assert.equal(presets.length, 6);
    assert.deepEqual(
      presets.map((preset) => preset.id).sort(),
      ["elijah", "isla", "marcus", "maya", "rowan", "sam"],
    );
    for (const preset of presets) {
      assert.ok(preset.name.length > 0, "preset has a human name");
      assert.ok(preset.persona.length > 0, "preset has a persona line");
      assert.ok(preset.sampleText.length > 0, "preset has sample text");
      assert.equal(preset.available, true);
      // Provider voice ids must never leak into the catalog.
      const serialized = JSON.stringify(preset).toLowerCase();
      for (const provider of [
        "alloy",
        "echo",
        "fable",
        "onyx",
        "nova",
        "shimmer",
      ]) {
        assert.ok(
          !serialized.includes(`"${provider}"`),
          `catalog must not expose provider voice "${provider}"`,
        );
      }
    }
  } finally {
    await harness.close();
  }
});

test("catalog marks presets unavailable when the integration is absent", async () => {
  const harness = await startHarness({ available: false });
  try {
    const response = await fetch(`${harness.baseUrl}/venom/voice/catalog`);
    assert.equal(response.status, 200);
    const presets = (await response.json()) as Array<{
      available: boolean;
      availabilityText: string;
    }>;
    assert.ok(presets.every((preset) => preset.available === false));
    assert.ok(presets.every((preset) => preset.availabilityText.length > 0));
  } finally {
    await harness.close();
  }
});

// ── Transcribe ───────────────────────────────────────────────────────────────

test("transcribe rejects malformed bodies", async () => {
  const harness = await startHarness();
  try {
    const missing = await postJson(
      `${harness.baseUrl}/venom/voice/transcribe`,
      {},
    );
    assert.equal(missing.status, 400);
    const wrongType = await postJson(
      `${harness.baseUrl}/venom/voice/transcribe`,
      { audioBase64: 42 },
    );
    assert.equal(wrongType.status, 400);
  } finally {
    await harness.close();
  }
});

test("transcribe answers 503 voice_unavailable when not configured", async () => {
  const harness = await startHarness({ available: false });
  try {
    const response = await postJson(
      `${harness.baseUrl}/venom/voice/transcribe`,
      { audioBase64: WEBM_BYTES.toString("base64") },
    );
    assert.equal(response.status, 503);
    const body = (await response.json()) as { code?: string };
    assert.equal(body.code, "voice_unavailable");
    assert.equal(harness.calls.speechToText.length, 0);
  } finally {
    await harness.close();
  }
});

test("transcribe returns text for a supported container", async () => {
  const harness = await startHarness();
  try {
    const response = await postJson(
      `${harness.baseUrl}/venom/voice/transcribe`,
      { audioBase64: WEBM_BYTES.toString("base64") },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as { text: string };
    assert.equal(body.text, "hello from the mic");
    assert.deepEqual(harness.calls.speechToText, [
      { bytes: WEBM_BYTES.byteLength, format: "webm" },
    ]);
    assert.equal(harness.calls.ensureCompatibleFormat, 0);
  } finally {
    await harness.close();
  }
});

test("transcribe converts unsupported containers before transcription", async () => {
  const harness = await startHarness();
  try {
    const response = await postJson(
      `${harness.baseUrl}/venom/voice/transcribe`,
      { audioBase64: MP4_BYTES.toString("base64") },
    );
    assert.equal(response.status, 200);
    assert.equal(harness.calls.ensureCompatibleFormat, 1);
    assert.deepEqual(harness.calls.speechToText, [
      { bytes: MP4_BYTES.byteLength, format: "wav" },
    ]);
  } finally {
    await harness.close();
  }
});

test("transcribe rejects empty and oversized audio", async () => {
  const harness = await startHarness();
  try {
    const empty = await postJson(
      `${harness.baseUrl}/venom/voice/transcribe`,
      { audioBase64: "" },
    );
    assert.equal(empty.status, 400);

    // 4 MB + 1 byte of decoded audio, encoded as base64. The OpenAPI schema's
    // 5M-char cap rejects it before the route's own decoded-size guard.
    const oversized = Buffer.alloc(4 * 1024 * 1024 + 1, 7).toString("base64");
    const tooBig = await postJson(
      `${harness.baseUrl}/venom/voice/transcribe`,
      { audioBase64: oversized },
    );
    assert.equal(tooBig.status, 400);
    assert.equal(harness.calls.speechToText.length, 0);
  } finally {
    await harness.close();
  }
});

test("transcribe surfaces provider failures as 502", async () => {
  const harness = await startHarness({
    audioModule: {
      async speechToText() {
        throw new Error("upstream exploded");
      },
    },
  });
  try {
    const response = await postJson(
      `${harness.baseUrl}/venom/voice/transcribe`,
      { audioBase64: WEBM_BYTES.toString("base64") },
    );
    assert.equal(response.status, 502);
  } finally {
    await harness.close();
  }
});

test("transcribe degrades to 502 when the audio module cannot load", async () => {
  const harness = await startHarness({ failModuleLoad: true });
  try {
    const response = await postJson(
      `${harness.baseUrl}/venom/voice/transcribe`,
      { audioBase64: WEBM_BYTES.toString("base64") },
    );
    assert.equal(response.status, 502);
  } finally {
    await harness.close();
  }
});

// ── Speak ────────────────────────────────────────────────────────────────────

test("speak rejects unknown presets before touching the provider", async () => {
  const harness = await startHarness();
  try {
    // The schema's enum rejects unknown ids; the route's own resolver is a
    // second layer behind it. Either way: 400, and the provider is untouched.
    const response = await postJson(`${harness.baseUrl}/venom/voice/speak`, {
      text: "hello",
      presetId: "totally-made-up",
    });
    assert.equal(response.status, 400);
    assert.equal(harness.calls.textToSpeech.length, 0);

    const missingText = await postJson(
      `${harness.baseUrl}/venom/voice/speak`,
      { presetId: "sam" },
    );
    assert.equal(missingText.status, 400);
  } finally {
    await harness.close();
  }
});

test("speak answers 503 voice_unavailable when not configured", async () => {
  const harness = await startHarness({ available: false });
  try {
    const response = await postJson(`${harness.baseUrl}/venom/voice/speak`, {
      text: "hello",
      presetId: "sam",
    });
    assert.equal(response.status, 503);
    const body = (await response.json()) as { code?: string };
    assert.equal(body.code, "voice_unavailable");
  } finally {
    await harness.close();
  }
});

test("speak streams format, audio chunks, then done", async () => {
  const harness = await startHarness();
  try {
    const response = await postJson(`${harness.baseUrl}/venom/voice/speak`, {
      text: "Say something nice.",
      presetId: "maya",
    });
    assert.equal(response.status, 200);
    assert.match(
      response.headers.get("content-type") ?? "",
      /text\/event-stream/,
    );
    const events = parseSseEvents(await response.text());

    assert.ok(events.length >= 4, `expected >=4 SSE events, got ${events.length}`);
    const first = JSON.parse(events[0]!) as {
      format?: { encoding: string; sampleRate: number; channels: number };
    };
    assert.deepEqual(first.format, {
      encoding: "pcm16",
      sampleRate: 24_000,
      channels: 1,
    });

    const audioEvents = events
      .filter((event) => event !== "[DONE]")
      .map((event) => JSON.parse(event) as { audio?: string; done?: boolean })
      .filter((event) => typeof event.audio === "string");
    assert.equal(audioEvents.length, 2);
    assert.equal(
      Buffer.from(audioEvents[0]!.audio!, "base64").toString("utf8"),
      "pcm-one",
    );

    const doneEvent = events
      .filter((event) => event !== "[DONE]")
      .map((event) => JSON.parse(event) as { done?: boolean })
      .find((event) => event.done === true);
    assert.ok(doneEvent, "stream ends with a done event");
    assert.equal(events.at(-1), "[DONE]");

    // Named preset → provider voice mapping happens server-side.
    assert.deepEqual(harness.calls.textToSpeech, [
      { text: "Say something nice.", voice: "nova" },
    ]);
  } finally {
    await harness.close();
  }
});

test("speak reports provider failures inside the stream", async () => {
  const harness = await startHarness({
    audioModule: {
      async textToSpeechStream() {
        return (async function* (): AsyncGenerator<string> {
          yield Buffer.from("partial").toString("base64");
          throw new Error("provider dropped mid-stream");
        })();
      },
    },
  });
  try {
    const response = await postJson(`${harness.baseUrl}/venom/voice/speak`, {
      text: "hello",
      presetId: "sam",
    });
    assert.equal(response.status, 200);
    const events = parseSseEvents(await response.text());
    const errorEvent = events
      .filter((event) => event !== "[DONE]")
      .map((event) => JSON.parse(event) as { error?: string })
      .find((event) => typeof event.error === "string");
    assert.ok(errorEvent, "stream carries an error event");
    assert.equal(events.at(-1), "[DONE]");
  } finally {
    await harness.close();
  }
});

test("speak flags empty synthesis instead of silently finishing", async () => {
  const harness = await startHarness({
    audioModule: {
      async textToSpeechStream() {
        return (async function* (): AsyncGenerator<string> {})();
      },
    },
  });
  try {
    const response = await postJson(`${harness.baseUrl}/venom/voice/speak`, {
      text: "hello",
      presetId: "sam",
    });
    const events = parseSseEvents(await response.text());
    const errorEvent = events
      .filter((event) => event !== "[DONE]")
      .map((event) => JSON.parse(event) as { error?: string })
      .find((event) => typeof event.error === "string");
    assert.ok(errorEvent, "empty synthesis is called out");
  } finally {
    await harness.close();
  }
});

// ── Decide (turn-end restraint) ──────────────────────────────────────────────

test("decide requires auth and validates its body", async () => {
  const noAuth = await startHarness({ userId: null });
  try {
    const response = await postJson(`${noAuth.baseUrl}/venom/voice/decide`, {
      transcript: "hello",
    });
    assert.equal(response.status, 401);
  } finally {
    await noAuth.close();
  }

  const harness = await startHarness();
  try {
    const missing = await postJson(
      `${harness.baseUrl}/venom/voice/decide`,
      {},
    );
    assert.equal(missing.status, 400);
    const badTurns = await postJson(`${harness.baseUrl}/venom/voice/decide`, {
      transcript: "hello",
      recentTurns: [{ role: "narrator", content: "hm" }],
    });
    assert.equal(badTurns.status, 400);
  } finally {
    await harness.close();
  }
});

test("a question resolves to respond from heuristics alone", async () => {
  const harness = await startHarness();
  try {
    const response = await postJson(`${harness.baseUrl}/venom/voice/decide`, {
      transcript: "What's left on the board?",
      recentTurns: [],
      talkativeness: "reserved",
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      decisionId: string;
      decision: string;
      windDown: boolean;
      acknowledgment?: string;
    };
    assert.equal(body.decision, "respond");
    assert.equal(body.windDown, false);
    assert.ok(body.decisionId.length > 0, "decision carries an id");
    assert.equal(body.acknowledgment, undefined);
    assert.equal(harness.calls.judged.length, 0, "no judge for clear calls");

    // The decide route waits for the row to land before responding.
    assert.equal(harness.calls.decisionsRecorded.length, 1);
    const recorded = harness.calls.decisionsRecorded[0]!;
    assert.equal(recorded.userId, USER_ID);
    assert.equal(recorded.decision, "respond");
    assert.equal(recorded.source, "heuristic");
    assert.equal(recorded.talkativeness, "reserved");
    assert.equal(recorded.transcript, "What's left on the board?");
    assert.equal(
      (recorded.signals as { interrogative?: boolean }).interrogative,
      true,
    );
  } finally {
    await harness.close();
  }
});

test("the decision row is durable before the response hands out its id", async () => {
  // A slow-but-working store: the decide response must not outrun the
  // insert, or an immediate outcome report could find no row to update.
  const harness = await startHarness({ recordDelayMs: 60 });
  try {
    const response = await postJson(`${harness.baseUrl}/venom/voice/decide`, {
      transcript: "What's the plan for tomorrow?",
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { decisionId: string };
    assert.equal(
      harness.calls.decisionsRecorded.length,
      1,
      "row landed before the response went out",
    );
    assert.equal(harness.calls.decisionsRecorded[0]!.id, body.decisionId);

    // …so an outcome fired the instant the client has the id always lands.
    const outcome = await postJson(
      `${harness.baseUrl}/venom/voice/decision-outcome`,
      { decisionId: body.decisionId, outcome: "reply_completed" },
    );
    assert.deepEqual(await outcome.json(), { recorded: true });
  } finally {
    await harness.close();
  }
});

test("a hung decision store forfeits logging but never delays the reply past its budget", async () => {
  const harness = await startHarness({ recordHangs: true });
  try {
    const startedAt = Date.now();
    const response = await postJson(`${harness.baseUrl}/venom/voice/decide`, {
      transcript: "What's the plan for tomorrow?",
    });
    const elapsed = Date.now() - startedAt;
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      decision: string;
      decisionId?: string;
    };
    assert.equal(body.decision, "respond", "still fails open to responding");
    assert.equal(body.decisionId, undefined, "no unusable id is issued");
    assert.equal(harness.calls.decisionsRecorded.length, 0);
    assert.ok(
      elapsed < VOICE_DECISION_RECORD_BUDGET_MS + 2_000,
      `reply left within the record budget plus slack (took ${elapsed}ms)`,
    );
  } finally {
    await harness.close();
  }
});

test("an insert that outlives the budget issues no id, even though the row lands later", async () => {
  // The nasty case: the store is slow but eventually succeeds. If the id
  // went out anyway, an immediate outcome report would beat the insert and
  // be lost forever. Instead the id is withheld and the turn goes untracked.
  const overBudget = VOICE_DECISION_RECORD_BUDGET_MS + 400;
  const harness = await startHarness({ recordDelayMs: overBudget });
  try {
    const response = await postJson(`${harness.baseUrl}/venom/voice/decide`, {
      transcript: "What's the plan for tomorrow?",
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      decision: string;
      decisionId?: string;
    };
    assert.equal(body.decision, "respond");
    assert.equal(
      body.decisionId,
      undefined,
      "an id the client could race against the insert is never issued",
    );
    assert.equal(
      harness.calls.decisionsRecorded.length,
      0,
      "the row is still in flight when the response leaves",
    );

    // The slow insert still completes — the decision is kept as training
    // data, it just never gets an outcome.
    await delay(overBudget + 200);
    assert.equal(harness.calls.decisionsRecorded.length, 1);
  } finally {
    await harness.close();
  }
});

test("a pure backchannel goes silent without consulting the judge", async () => {
  const harness = await startHarness();
  try {
    const response = await postJson(`${harness.baseUrl}/venom/voice/decide`, {
      transcript: "okay yeah makes sense",
    });
    const body = (await response.json()) as {
      decision: string;
      acknowledgment?: string;
    };
    assert.equal(body.decision, "silent");
    assert.equal(body.acknowledgment, undefined);
    assert.equal(harness.calls.judged.length, 0);
  } finally {
    await harness.close();
  }
});

test("a farewell winds down with a short spoken closer", async () => {
  const harness = await startHarness();
  try {
    const response = await postJson(`${harness.baseUrl}/venom/voice/decide`, {
      transcript: "alright good night",
    });
    const body = (await response.json()) as {
      decision: string;
      windDown: boolean;
      acknowledgment?: string;
    };
    assert.equal(body.decision, "acknowledge");
    assert.equal(body.windDown, true);
    assert.ok(
      typeof body.acknowledgment === "string" &&
        body.acknowledgment.length > 0 &&
        body.acknowledgment.length <= 60,
      "closer is one short line",
    );
  } finally {
    await harness.close();
  }
});

test("ambiguous turns consult the judge and honor its verdict", async () => {
  const harness = await startHarness({
    judgeTurn: async () => ({ decision: "silent", windDown: false }),
  });
  try {
    const response = await postJson(`${harness.baseUrl}/venom/voice/decide`, {
      transcript: "the design still feels a little heavy",
      talkativeness: "balanced",
    });
    const body = (await response.json()) as { decision: string };
    assert.equal(body.decision, "silent");
    assert.equal(harness.calls.judged.length, 1);
    assert.equal(
      harness.calls.judged[0]!.transcript,
      "the design still feels a little heavy",
    );

    await delay(5);
    assert.equal(harness.calls.decisionsRecorded[0]!.source, "model");
  } finally {
    await harness.close();
  }
});

test("a broken or verdict-less judge falls back to respond", async () => {
  const failing = await startHarness({
    judgeTurn: async () => {
      throw new Error("judge exploded");
    },
  });
  try {
    const response = await postJson(`${failing.baseUrl}/venom/voice/decide`, {
      transcript: "the design still feels a little heavy",
    });
    const body = (await response.json()) as { decision: string };
    assert.equal(body.decision, "respond", "failure is never silence");
    await delay(5);
    assert.equal(failing.calls.decisionsRecorded[0]!.source, "fallback");
  } finally {
    await failing.close();
  }

  const verdictless = await startHarness();
  try {
    const response = await postJson(
      `${verdictless.baseUrl}/venom/voice/decide`,
      { transcript: "the design still feels a little heavy" },
    );
    const body = (await response.json()) as { decision: string };
    assert.equal(body.decision, "respond");
  } finally {
    await verdictless.close();
  }
});

test("decide still answers when logging is down or voice is unconfigured", async () => {
  const storeDown = await startHarness({ failDecisionRecord: true });
  try {
    const response = await postJson(`${storeDown.baseUrl}/venom/voice/decide`, {
      transcript: "okay yeah",
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      decision: string;
      decisionId?: string;
    };
    assert.equal(body.decision, "silent");
    assert.equal(
      body.decisionId,
      undefined,
      "no id is issued for a row that never landed",
    );
  } finally {
    await storeDown.close();
  }

  // Unlike transcribe/speak, decide works without the audio integration.
  const unconfigured = await startHarness({ available: false });
  try {
    const response = await postJson(
      `${unconfigured.baseUrl}/venom/voice/decide`,
      { transcript: "what time is it?" },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as { decision: string };
    assert.equal(body.decision, "respond");
  } finally {
    await unconfigured.close();
  }
});

// ── Decision outcomes ────────────────────────────────────────────────────────

test("outcome reports are validated, scoped to the user, and recorded", async () => {
  const harness = await startHarness();
  try {
    const unauthorized = await startHarness({ userId: null });
    try {
      const response = await postJson(
        `${unauthorized.baseUrl}/venom/voice/decision-outcome`,
        { decisionId: "d-1", outcome: "reply_completed" },
      );
      assert.equal(response.status, 401);
    } finally {
      await unauthorized.close();
    }

    const badOutcome = await postJson(
      `${harness.baseUrl}/venom/voice/decision-outcome`,
      { decisionId: "d-1", outcome: "shrugged" },
    );
    assert.equal(badOutcome.status, 400);

    const ok = await postJson(
      `${harness.baseUrl}/venom/voice/decision-outcome`,
      { decisionId: "d-1", outcome: "user_followed_up" },
    );
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { recorded: true });
    assert.deepEqual(harness.calls.outcomesRecorded, [
      { userId: USER_ID, decisionId: "d-1", outcome: "user_followed_up" },
    ]);
  } finally {
    await harness.close();
  }
});

test("unknown decisions report recorded=false; store failures are explicit", async () => {
  const unknown = await startHarness({ outcomeRecorded: false });
  try {
    const response = await postJson(
      `${unknown.baseUrl}/venom/voice/decision-outcome`,
      { decisionId: "never-issued", outcome: "stayed_quiet" },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { recorded: false });
  } finally {
    await unknown.close();
  }

  const broken = await startHarness({ failOutcomeRecord: true });
  try {
    const response = await postJson(
      `${broken.baseUrl}/venom/voice/decision-outcome`,
      { decisionId: "d-2", outcome: "wound_down" },
    );
    assert.equal(response.status, 500);
  } finally {
    await broken.close();
  }
});

test("speak enforces the preset id against the full catalog", async () => {
  const harness = await startHarness();
  try {
    // Every preset resolves; the provider voice never echoes the preset name.
    for (const presetId of [
      "sam",
      "marcus",
      "rowan",
      "elijah",
      "maya",
      "isla",
    ]) {
      const response = await postJson(`${harness.baseUrl}/venom/voice/speak`, {
        text: "check",
        presetId,
      });
      assert.equal(response.status, 200, `preset ${presetId} should speak`);
      await response.text();
    }
    const voices = harness.calls.textToSpeech.map((call) => call.voice);
    assert.deepEqual(voices, [
      "alloy",
      "echo",
      "fable",
      "onyx",
      "nova",
      "shimmer",
    ]);
  } finally {
    await harness.close();
  }
});

// ── Decision evidence reports ────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

/** Exact key set (and order) of one JSONL training line. */
const TRAINING_RECORD_KEYS = [
  "id",
  "createdAt",
  "talkativeness",
  "decision",
  "windDown",
  "source",
  "signals",
  "transcriptPreview",
  "transcriptChars",
  "outcome",
  "outcomeAt",
  "outcomeLatencyMs",
];

function storedDecision(
  overrides: Partial<StoredVoiceDecision> & { id: string },
): StoredVoiceDecision {
  return {
    decision: "silent",
    windDown: false,
    source: "heuristic",
    talkativeness: "balanced",
    transcriptPreview: "okay yeah",
    transcriptChars: 9,
    signals: { backchannel: true },
    outcome: null,
    outcomeAt: null,
    createdAt: new Date(Date.now() - 60_000),
    ...overrides,
  };
}

test("decision reports require auth", async () => {
  const harness = await startHarness({ userId: null });
  try {
    const summary = await fetch(
      `${harness.baseUrl}/venom/voice/decisions/summary`,
    );
    assert.equal(summary.status, 401);
    const exported = await fetch(
      `${harness.baseUrl}/venom/voice/decisions/export`,
    );
    assert.equal(exported.status, 401);
  } finally {
    await harness.close();
  }
});

test("summary aggregates decisions x outcomes x talkativeness", async () => {
  const settledAt = new Date();
  const rows = [
    storedDecision({
      id: "r1",
      outcome: "user_followed_up",
      outcomeAt: settledAt,
    }),
    storedDecision({ id: "r2", outcome: "stayed_quiet", outcomeAt: settledAt }),
    storedDecision({ id: "r3" }),
    storedDecision({
      id: "r4",
      decision: "respond",
      talkativeness: "chatty",
      source: "model",
      outcome: "reply_interrupted",
      outcomeAt: settledAt,
    }),
    storedDecision({
      id: "r5",
      decision: "respond",
      talkativeness: "chatty",
      source: "fallback",
      outcome: "reply_completed",
      outcomeAt: settledAt,
    }),
    storedDecision({
      id: "r6",
      decision: "acknowledge",
      windDown: true,
      outcome: "wound_down",
      outcomeAt: settledAt,
    }),
  ];
  const harness = await startHarness({ decisionRows: rows });
  try {
    const before = Date.now();
    const response = await fetch(
      `${harness.baseUrl}/venom/voice/decisions/summary`,
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, any>;

    assert.equal(body.windowDays, 30);
    assert.equal(body.overall.decisions, 6);
    assert.equal(body.overall.withOutcome, 5);
    assert.equal(body.overall.outcomeCoverage, 0.8333);
    assert.deepEqual(body.overall.decisionCounts, {
      respond: 2,
      acknowledge: 1,
      silent: 3,
    });
    assert.deepEqual(body.overall.sourceCounts, {
      heuristic: 4,
      model: 1,
      fallback: 1,
    });
    assert.equal(body.overall.windDownFlagged, 1);
    assert.deepEqual(body.overall.quietRegret, {
      settled: 2,
      hits: 1,
      rate: 0.5,
    });
    assert.deepEqual(body.overall.spokenInterruption, {
      settled: 2,
      hits: 1,
      rate: 0.5,
    });
    assert.deepEqual(body.overall.windDownClean, {
      settled: 1,
      hits: 1,
      rate: 1,
    });

    assert.deepEqual(
      body.byTalkativeness.map(
        (entry: { talkativeness: string }) => entry.talkativeness,
      ),
      ["chatty", "balanced"],
      "canonical talkativeness order, observed levels only",
    );
    const chatty = body.byTalkativeness[0].rates;
    assert.equal(chatty.decisions, 2);
    assert.deepEqual(chatty.spokenInterruption, {
      settled: 2,
      hits: 1,
      rate: 0.5,
    });
    assert.deepEqual(chatty.quietRegret, { settled: 0, hits: 0, rate: null });
    const balanced = body.byTalkativeness[1].rates;
    assert.equal(balanced.decisions, 4);
    assert.deepEqual(balanced.quietRegret, { settled: 2, hits: 1, rate: 0.5 });
    assert.deepEqual(balanced.windDownClean, { settled: 1, hits: 1, rate: 1 });

    assert.deepEqual(body.cells, [
      {
        talkativeness: "chatty",
        decision: "respond",
        windDown: false,
        source: "model",
        outcome: "reply_interrupted",
        count: 1,
      },
      {
        talkativeness: "chatty",
        decision: "respond",
        windDown: false,
        source: "fallback",
        outcome: "reply_completed",
        count: 1,
      },
      {
        talkativeness: "balanced",
        decision: "acknowledge",
        windDown: true,
        source: "heuristic",
        outcome: "wound_down",
        count: 1,
      },
      {
        talkativeness: "balanced",
        decision: "silent",
        windDown: false,
        source: "heuristic",
        outcome: "user_followed_up",
        count: 1,
      },
      {
        talkativeness: "balanced",
        decision: "silent",
        windDown: false,
        source: "heuristic",
        outcome: "stayed_quiet",
        count: 1,
      },
      {
        talkativeness: "balanced",
        decision: "silent",
        windDown: false,
        source: "heuristic",
        outcome: "pending",
        count: 1,
      },
    ]);

    assert.deepEqual(
      body.thresholds,
      voiceRestraintThresholds(),
      "the summary echoes the thresholds in force",
    );

    // The read hit the caller's own rows over the default 30-day window.
    assert.equal(harness.calls.decisionListRequests.length, 1);
    const request = harness.calls.decisionListRequests[0]!;
    assert.equal(request.userId, USER_ID);
    assert.ok(
      Math.abs(request.since.getTime() - (before - 30 * DAY_MS)) < 10_000,
    );
    assert.equal(body.since, request.since.toISOString());
  } finally {
    await harness.close();
  }
});

test("summary honors and validates the windowDays parameter", async () => {
  const harness = await startHarness();
  try {
    const response = await fetch(
      `${harness.baseUrl}/venom/voice/decisions/summary?windowDays=7`,
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as { windowDays: number };
    assert.equal(body.windowDays, 7);
    const request = harness.calls.decisionListRequests[0]!;
    assert.ok(
      Math.abs(request.since.getTime() - (Date.now() - 7 * DAY_MS)) < 10_000,
    );

    for (const bad of ["0", "91", "2.5", "abc"]) {
      const rejected = await fetch(
        `${harness.baseUrl}/venom/voice/decisions/summary?windowDays=${bad}`,
      );
      assert.equal(rejected.status, 400, `windowDays=${bad} must be rejected`);
    }
    assert.equal(
      harness.calls.decisionListRequests.length,
      1,
      "rejected requests never touch the store",
    );
  } finally {
    await harness.close();
  }
});

test("export streams the caller's rows as training JSONL", async () => {
  const decidedAt = new Date("2026-08-01T12:00:00.000Z");
  const rows = [
    storedDecision({
      id: "e1",
      decision: "respond",
      source: "model",
      talkativeness: "chatty",
      transcriptPreview: "how do I wire the panel safely",
      transcriptChars: 30,
      signals: { wordCount: 7, directQuestion: true },
      outcome: "reply_completed",
      createdAt: decidedAt,
      outcomeAt: new Date(decidedAt.getTime() + 8_000),
    }),
    storedDecision({
      id: "e2",
      createdAt: new Date(decidedAt.getTime() + 60_000),
    }),
  ];
  const harness = await startHarness({ decisionRows: rows });
  try {
    const response = await fetch(
      `${harness.baseUrl}/venom/voice/decisions/export`,
    );
    assert.equal(response.status, 200);
    assert.match(
      response.headers.get("content-type") ?? "",
      /text\/plain/,
    );
    assert.match(
      response.headers.get("content-disposition") ?? "",
      /attachment; filename="venom-voice-decisions-\d{4}-\d{2}-\d{2}\.jsonl"/,
    );

    const body = await response.text();
    assert.ok(body.endsWith("\n"), "JSONL is newline-terminated");
    const lines = body.trimEnd().split("\n");
    assert.equal(lines.length, 2);

    const first = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.deepEqual(Object.keys(first), TRAINING_RECORD_KEYS);
    assert.equal(first.id, "e1");
    assert.equal(first.createdAt, "2026-08-01T12:00:00.000Z");
    assert.equal(first.outcomeLatencyMs, 8000);
    assert.deepEqual(first.signals, { wordCount: 7, directQuestion: true });

    const second = JSON.parse(lines[1]!) as Record<string, unknown>;
    assert.equal(second.outcome, null);
    assert.equal(second.outcomeAt, null);
    assert.equal(second.outcomeLatencyMs, null);

    assert.ok(
      !body.includes(USER_ID),
      "training lines never carry the user id",
    );

    // Default export window is the full retention period.
    const request = harness.calls.decisionListRequests[0]!;
    assert.ok(
      Math.abs(request.since.getTime() - (Date.now() - 90 * DAY_MS)) < 10_000,
    );
  } finally {
    await harness.close();
  }
});

test("export with no rows is an empty file, not an error", async () => {
  const harness = await startHarness();
  try {
    const response = await fetch(
      `${harness.baseUrl}/venom/voice/decisions/export`,
    );
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "");
  } finally {
    await harness.close();
  }
});

test("reports fail loudly when the decision store cannot be read", async () => {
  const harness = await startHarness({ failDecisionList: true });
  try {
    const summary = await fetch(
      `${harness.baseUrl}/venom/voice/decisions/summary`,
    );
    assert.equal(summary.status, 500);
    const summaryBody = (await summary.json()) as { error?: string };
    assert.ok(summaryBody.error, "summary failure is explicit");
    const exported = await fetch(
      `${harness.baseUrl}/venom/voice/decisions/export`,
    );
    assert.equal(exported.status, 500);
  } finally {
    await harness.close();
  }
});

test("summary and export share one report rate limit", async () => {
  const harness = await startHarness();
  try {
    for (let i = 0; i < 30; i += 1) {
      const ok = await fetch(
        `${harness.baseUrl}/venom/voice/decisions/export`,
      );
      assert.equal(ok.status, 200, `request ${i + 1} still within the limit`);
    }
    const limited = await fetch(
      `${harness.baseUrl}/venom/voice/decisions/summary`,
    );
    assert.equal(limited.status, 429);
    assert.ok(limited.headers.get("retry-after"));
  } finally {
    await harness.close();
  }
});
