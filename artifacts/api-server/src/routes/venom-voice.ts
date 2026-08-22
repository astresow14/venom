/**
 * venom-voice.ts — authenticated voice endpoints for hands-free voice chat.
 *
 * All audio runs through the OpenAI audio integration module. Raw audio is
 * transient: request audio is decoded in memory, transcribed, and discarded.
 * Recordings are never persisted and never logged.
 *
 * Endpoints:
 *  - GET  /venom/voice/catalog          → named voice presets (+ availability)
 *  - POST /venom/voice/transcribe       → one utterance of audio → text
 *  - POST /venom/voice/speak            → text → SSE stream of base64 PCM16 chunks
 *  - POST /venom/voice/decide           → respond / acknowledge / stay silent
 *  - POST /venom/voice/decision-outcome → what actually happened next
 *  - GET  /venom/voice/decisions/summary → decisions × outcomes × talkativeness evidence
 *  - GET  /venom/voice/decisions/export  → the same log as JSONL training data
 *
 * When the OpenAI integration env vars are absent, voice endpoints answer
 * 503 with code "voice_unavailable" so clients can fall back to text chat.
 * The decide endpoint is the exception: it works from heuristics alone when
 * the model judge is unavailable, and any internal failure yields "respond"
 * — restraint must never swallow a real request. Typed chat never calls it.
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { getAuth } from "@clerk/express";
import {
  DecideVenomVoiceTurnBody,
  ExportVenomVoiceDecisionsQueryParams,
  GetVenomVoiceDecisionSummaryQueryParams,
  ReportVenomVoiceDecisionOutcomeBody,
  SpeakVenomVoiceBody,
  TranscribeVenomVoiceBody,
} from "@workspace/api-zod";
import {
  buildVenomVoiceCatalog,
  isVenomVoiceAvailable,
  resolveProviderVoice,
  resolveVenomVoicePresetId,
  InvalidVenomVoiceError,
} from "../lib/venom-voices";
import {
  decideFromHeuristics,
  extractVoiceTurnSignals,
  normalizeTalkativeness,
  parseJudgeVerdict,
  pickAcknowledgment,
  VOICE_JUDGE_SYSTEM_PROMPT,
  type VoiceJudgeInput,
  type VoiceJudgeVerdict,
} from "../lib/venom-voice-restraint";
import type {
  VoiceDecisionOutcome,
  VoiceDecisionStore,
} from "../lib/venom-voice-decision-store";
import {
  summarizeVoiceDecisions,
  voiceDecisionExportJsonl,
} from "../lib/venom-voice-decision-report";
import {
  usageFromCompletion,
  VOICE_FLAT_COST_MICROS,
  VOICE_USAGE_ALIAS,
} from "../lib/venom-usage-pricing";
import type { RecordVenomUsageInput } from "../lib/venom-usage-store";

/** Subset of the audio module the routes rely on (injectable for tests). */
export type VenomVoiceAudioModule = {
  speechToText(
    audioBuffer: Buffer,
    format?: "wav" | "mp3" | "webm",
  ): Promise<string>;
  textToSpeechStream(
    text: string,
    voice?: "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer",
  ): Promise<AsyncIterable<string>>;
  detectAudioFormat(
    buffer: Buffer,
  ): "wav" | "mp3" | "webm" | "mp4" | "ogg" | "unknown";
  ensureCompatibleFormat(
    audioBuffer: Buffer,
  ): Promise<{ buffer: Buffer; format: "wav" | "mp3" }>;
};

export type VenomVoiceRouterOptions = {
  /** Lazy loader for the audio module; overridden in tests. */
  loadAudioModule?: () => Promise<VenomVoiceAudioModule>;
  /** Availability probe; overridden in tests. */
  isAvailable?: () => boolean;
  /** Auth resolver; overridden in tests. */
  resolveUserId?: (req: Request) => string | null;
  /**
   * Lightweight model judgment for ambiguous turns; overridden in tests.
   * Resolving null (or throwing, or timing out) falls back to "respond".
   */
  judgeTurn?: (input: VoiceJudgeInput) => Promise<VoiceJudgeVerdict | null>;
  /** Decision/outcome persistence; overridden in tests. */
  decisionStore?: VoiceDecisionStore;
  /** Usage-ledger sink; overridden in tests. Must never throw. */
  recordUsage?: (input: RecordVenomUsageInput) => void;
};

const TRANSCRIBE_RATE_LIMIT_WINDOW_MS = 60_000;
const TRANSCRIBE_RATE_LIMIT_MAX = 30;
const SPEAK_RATE_LIMIT_WINDOW_MS = 60_000;
const SPEAK_RATE_LIMIT_MAX = 120;
const DECIDE_RATE_LIMIT_WINDOW_MS = 60_000;
const DECIDE_RATE_LIMIT_MAX = 40;
const OUTCOME_RATE_LIMIT_WINDOW_MS = 60_000;
const OUTCOME_RATE_LIMIT_MAX = 80;
const REPORT_RATE_LIMIT_WINDOW_MS = 60_000;
const REPORT_RATE_LIMIT_MAX = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Hard cap on decoded utterance audio (bytes). ~4 MB ≈ >60s of opus. */
const MAX_DECODED_AUDIO_BYTES = 4 * 1024 * 1024;
const SPEAK_TIMEOUT_MS = 60_000;
const TRANSCRIBE_TIMEOUT_MS = 45_000;
/** The judge is an optimization, never a bottleneck: short leash. */
const JUDGE_TIMEOUT_MS = 3_000;
/** How long the decide route waits for the decision row to become durable. */
export const VOICE_DECISION_RECORD_BUDGET_MS = 750;

type RateLimitRecord = { count: number; resetAt: number };

function createRateLimiter(windowMs: number, max: number) {
  const slots = new Map<string, RateLimitRecord>();
  return {
    take(userId: string): { ok: true } | { ok: false; retryAfterSeconds: number } {
      const now = Date.now();
      const current = slots.get(userId);
      if (!current || current.resetAt <= now) {
        slots.set(userId, { count: 1, resetAt: now + windowMs });
        if (slots.size > 2_000) {
          for (const [key, limit] of slots) {
            if (limit.resetAt <= now) slots.delete(key);
          }
        }
        return { ok: true };
      }
      if (current.count >= max) {
        return {
          ok: false,
          retryAfterSeconds: Math.max(
            1,
            Math.ceil((current.resetAt - now) / 1000),
          ),
        };
      }
      current.count += 1;
      return { ok: true };
    },
  };
}

function voiceUnavailableBody() {
  return {
    error:
      "Voice is not configured. The OpenAI audio integration is missing, so voice chat is unavailable — text chat still works.",
    code: "voice_unavailable",
  };
}

/** Race a promise against a timeout without leaking the timer. */
async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createVenomVoiceRouter(
  options: VenomVoiceRouterOptions = {},
): IRouter {
  const router: IRouter = Router();

  const isAvailable = options.isAvailable ?? isVenomVoiceAvailable;
  const resolveUserId =
    options.resolveUserId ?? ((req: Request) => getAuth(req).userId ?? null);

  // The audio module throws at import time when the integration env vars are
  // absent, so it must only ever be imported lazily, after an availability
  // check — and an import failure still degrades to "voice unavailable".
  let audioModulePromise: Promise<VenomVoiceAudioModule> | null = null;
  const loadAudioModule =
    options.loadAudioModule ??
    (() => {
      if (!audioModulePromise) {
        audioModulePromise = import(
          "@workspace/integrations-openai-ai-server/audio"
        ).then((mod) => mod as unknown as VenomVoiceAudioModule);
        // A failed import must not be cached forever (env could be fixed
        // between requests in dev), so clear the memo on rejection.
        audioModulePromise.catch(() => {
          audioModulePromise = null;
        });
      }
      return audioModulePromise;
    });

  const transcribeLimiter = createRateLimiter(
    TRANSCRIBE_RATE_LIMIT_WINDOW_MS,
    TRANSCRIBE_RATE_LIMIT_MAX,
  );
  const speakLimiter = createRateLimiter(
    SPEAK_RATE_LIMIT_WINDOW_MS,
    SPEAK_RATE_LIMIT_MAX,
  );
  const decideLimiter = createRateLimiter(
    DECIDE_RATE_LIMIT_WINDOW_MS,
    DECIDE_RATE_LIMIT_MAX,
  );
  const outcomeLimiter = createRateLimiter(
    OUTCOME_RATE_LIMIT_WINDOW_MS,
    OUTCOME_RATE_LIMIT_MAX,
  );
  const reportLimiter = createRateLimiter(
    REPORT_RATE_LIMIT_WINDOW_MS,
    REPORT_RATE_LIMIT_MAX,
  );

  // Decision persistence is loaded lazily for the same reason as the audio
  // module: its import pulls in the database client, which route tests and
  // db-less environments must never be forced through. A missing store
  // degrades to "decide but don't log" — never to a failed decision.
  let decisionStorePromise: Promise<VoiceDecisionStore> | null = null;
  const loadDecisionStore = (): Promise<VoiceDecisionStore> => {
    if (options.decisionStore) return Promise.resolve(options.decisionStore);
    if (!decisionStorePromise) {
      decisionStorePromise = import("../lib/venom-voice-decision-store").then(
        (mod) => mod.voiceDecisionStore,
      );
      decisionStorePromise.catch(() => {
        decisionStorePromise = null;
      });
    }
    return decisionStorePromise;
  };

  // Usage metering shares the decision store's lazy-import rule: pulling the
  // ledger in eagerly would drag the database client into db-less tests. A
  // failed import degrades to "serve but don't meter" — never to a failure.
  const recordUsage =
    options.recordUsage ??
    ((input: RecordVenomUsageInput): void => {
      import("../lib/venom-usage-store")
        .then((mod) => mod.recordVenomUsage(input))
        .catch(() => {
          // Metering must never break a voice request.
        });
    });

  // Default judge: one cheap JSON completion with a short leash. Anything
  // that isn't a clean verdict — env missing, timeout, malformed reply —
  // resolves to null and the caller falls back toward responding.
  const judgeTurn =
    options.judgeTurn ??
    (async (input: VoiceJudgeInput): Promise<VoiceJudgeVerdict | null> => {
      if (!isAvailable()) return null;
      const { openai } = await import(
        "@workspace/integrations-openai-ai-server"
      );
      const recent = input.recentTurns
        .slice(-6)
        .map((turn) => `${turn.role}: ${turn.content.slice(0, 400)}`)
        .join("\n");
      const completion = await openai.chat.completions.create({
        model: "gpt-5.6-terra",
        max_completion_tokens: 500,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: VOICE_JUDGE_SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              recent.length > 0 ? `Recent turns:\n${recent}` : "No prior turns.",
              `The user just said: "${input.transcript.slice(0, 600)}"`,
              `Talkativeness preference: ${input.talkativeness}.`,
            ].join("\n\n"),
          },
        ],
      });
      const content = completion.choices[0]?.message?.content;
      // The tokens are spent whether or not the verdict parses.
      try {
        input.onUsage?.(
          usageFromCompletion(completion.usage, {
            promptChars:
              VOICE_JUDGE_SYSTEM_PROMPT.length +
              recent.length +
              Math.min(input.transcript.length, 600),
            outputChars: content?.length ?? 0,
          }),
        );
      } catch {
        // Metering must never break a decision.
      }
      return content ? parseJudgeVerdict(content) : null;
    });

  // ── Catalog ────────────────────────────────────────────────────────────────

  router.get("/venom/voice/catalog", (req, res): void => {
    const userId = resolveUserId(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    // Reflect the injected availability probe (tests) while defaulting to the
    // shared env-based check inside buildVenomVoiceCatalog.
    const available = isAvailable();
    res.json(
      buildVenomVoiceCatalog().map((preset) => ({
        ...preset,
        available,
        availabilityText: available ? "Ready" : "Voice is not configured",
      })),
    );
  });

  // ── Transcription ─────────────────────────────────────────────────────────

  router.post(
    "/venom/voice/transcribe",
    async (req, res): Promise<void> => {
      const userId = resolveUserId(req);
      if (!userId) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      const rate = transcribeLimiter.take(userId);
      if (!rate.ok) {
        res.setHeader("Retry-After", rate.retryAfterSeconds);
        res.status(429).json({
          error: "Too many voice requests. Give it a moment.",
        });
        return;
      }

      const parsed = TranscribeVenomVoiceBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid transcription request" });
        return;
      }

      if (!isAvailable()) {
        res.status(503).json(voiceUnavailableBody());
        return;
      }

      // Decode transiently. The buffer lives only for this request; it is
      // never written to storage and never logged.
      let audio: Buffer;
      try {
        audio = Buffer.from(parsed.data.audioBase64, "base64");
      } catch {
        res.status(400).json({ error: "Audio is not valid base64" });
        return;
      }
      if (audio.byteLength === 0) {
        res.status(400).json({ error: "Audio is empty" });
        return;
      }
      if (audio.byteLength > MAX_DECODED_AUDIO_BYTES) {
        res.status(400).json({ error: "Audio is too long for one turn" });
        return;
      }

      try {
        const audioModule = await loadAudioModule();
        const detected = audioModule.detectAudioFormat(audio);
        let text: string;
        if (
          detected === "wav" ||
          detected === "mp3" ||
          detected === "webm"
        ) {
          text = await withTimeout(
            audioModule.speechToText(audio, detected),
            TRANSCRIBE_TIMEOUT_MS,
            "Transcription",
          );
        } else {
          // Safari/iOS containers (mp4/ogg/unknown) go through ffmpeg → wav.
          const compatible = await audioModule.ensureCompatibleFormat(audio);
          text = await withTimeout(
            audioModule.speechToText(compatible.buffer, compatible.format),
            TRANSCRIBE_TIMEOUT_MS,
            "Transcription",
          );
        }
        // Audio legs are metered as a flat per-request estimate: providers
        // bill transcription by the minute, and Venom deliberately does not
        // track audio duration. Tokens stay zero; the flat cost carries it.
        recordUsage({
          userId,
          modelAlias: VOICE_USAGE_ALIAS,
          callKind: "voice_transcribe",
          promptTokens: 0,
          outputTokens: 0,
          estimated: true,
          costMicros: VOICE_FLAT_COST_MICROS.voice_transcribe,
        });
        res.json({ text: (text ?? "").slice(0, 8000) });
      } catch (error) {
        // Never include audio payloads in logs — size only.
        console.error(
          `Venom voice transcription failed (${audio.byteLength} bytes in):`,
          error instanceof Error ? error.message : error,
        );
        res.status(502).json({
          error: "Venom couldn't hear that. Try speaking again.",
        });
      }
    },
  );

  // ── Speech (SSE stream of PCM16 chunks) ───────────────────────────────────

  router.post("/venom/voice/speak", async (req, res): Promise<void> => {
    const userId = resolveUserId(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const rate = speakLimiter.take(userId);
    if (!rate.ok) {
      res.setHeader("Retry-After", rate.retryAfterSeconds);
      res.status(429).json({
        error: "Too many voice requests. Give it a moment.",
      });
      return;
    }

    const parsed = SpeakVenomVoiceBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid speech request" });
      return;
    }

    let providerVoice: ReturnType<typeof resolveProviderVoice>;
    try {
      providerVoice = resolveProviderVoice(
        resolveVenomVoicePresetId(parsed.data.presetId),
      );
    } catch (error) {
      if (error instanceof InvalidVenomVoiceError) {
        res.status(400).json({ error: "Unknown voice preset" });
        return;
      }
      throw error;
    }

    if (!isAvailable()) {
      res.status(503).json(voiceUnavailableBody());
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    // PCM16 from gpt-audio is 24 kHz mono, 16-bit little-endian.
    res.write(
      `data: ${JSON.stringify({
        format: { encoding: "pcm16", sampleRate: 24_000, channels: 1 },
      })}\n\n`,
    );

    let disconnected = false;
    const onClose = () => {
      disconnected = true;
    };
    res.once("close", onClose);

    const startedAt = Date.now();
    let sentAudio = false;
    try {
      const audioModule = await loadAudioModule();
      const stream = await withTimeout(
        audioModule.textToSpeechStream(parsed.data.text, providerVoice),
        SPEAK_TIMEOUT_MS,
        "Speech synthesis",
      );
      for await (const chunk of stream) {
        if (disconnected || res.writableEnded) break;
        if (Date.now() - startedAt > SPEAK_TIMEOUT_MS) {
          throw new Error("Speech synthesis timed out");
        }
        if (typeof chunk === "string" && chunk.length > 0) {
          sentAudio = true;
          res.write(`data: ${JSON.stringify({ audio: chunk })}\n\n`);
        }
      }
      if (sentAudio) {
        // Flat per-request estimate, same reasoning as transcription: TTS is
        // billed by audio length, which Venom does not measure. Recorded only
        // when synthesis actually produced audio — including partial streams
        // cut by a disconnect, which were still paid for.
        recordUsage({
          userId,
          modelAlias: VOICE_USAGE_ALIAS,
          callKind: "voice_speak",
          promptTokens: 0,
          outputTokens: 0,
          estimated: true,
          costMicros: VOICE_FLAT_COST_MICROS.voice_speak,
        });
      }
      if (!disconnected && !res.writableEnded) {
        if (!sentAudio) {
          res.write(
            `data: ${JSON.stringify({
              error: "No audio was produced for this reply.",
            })}\n\n`,
          );
        }
        res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
        res.write("data: [DONE]\n\n");
      }
    } catch (error) {
      console.error(
        "Venom voice speech synthesis failed:",
        error instanceof Error ? error.message : error,
      );
      if (!disconnected && !res.writableEnded) {
        res.write(
          `data: ${JSON.stringify({
            error: "Venom lost its voice for a moment. Try again.",
          })}\n\n`,
        );
        res.write("data: [DONE]\n\n");
      }
    } finally {
      res.off("close", onClose);
      if (!res.writableEnded) res.end();
    }
  });

  // ── Turn-end restraint decision ────────────────────────────────────────────

  router.post("/venom/voice/decide", async (req, res): Promise<void> => {
    const userId = resolveUserId(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const rate = decideLimiter.take(userId);
    if (!rate.ok) {
      res.setHeader("Retry-After", rate.retryAfterSeconds);
      res.status(429).json({
        error: "Too many voice requests. Give it a moment.",
      });
      return;
    }

    const parsed = DecideVenomVoiceTurnBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid decision request" });
      return;
    }

    const transcript = parsed.data.transcript;
    const recentTurns = parsed.data.recentTurns ?? [];
    const talkativeness = normalizeTalkativeness(parsed.data.talkativeness);

    const startedAt = Date.now();
    const signals = extractVoiceTurnSignals(transcript, recentTurns);
    const heuristic = decideFromHeuristics(signals, talkativeness);

    let decision = heuristic.decision;
    let windDown = heuristic.windDown;
    let source: "heuristic" | "model" | "fallback" = "heuristic";

    let judgeMs: number | null = null;
    if (!heuristic.confident) {
      // Ambiguous turn: give the lightweight judge one short-leashed shot.
      const judgeStartedAt = Date.now();
      let verdict: VoiceJudgeVerdict | null = null;
      try {
        verdict = await withTimeout(
          judgeTurn({
            transcript,
            recentTurns,
            talkativeness,
            heuristicDecision: heuristic.decision,
            onUsage: (usage) =>
              recordUsage({
                userId,
                modelAlias: "venom-gpt",
                callKind: "voice_judge",
                promptTokens: usage.promptTokens,
                outputTokens: usage.outputTokens,
                estimated: usage.estimated,
              }),
          }),
          JUDGE_TIMEOUT_MS,
          "Voice turn judgment",
        );
      } catch (error) {
        console.error(
          "Venom voice judge failed:",
          error instanceof Error ? error.message : error,
        );
      }
      judgeMs = Date.now() - judgeStartedAt;
      if (verdict) {
        decision = verdict.decision;
        // A full reply followed by an auto-close would feel broken; wind-down
        // only rides quiet decisions.
        windDown = verdict.decision === "respond" ? false : verdict.windDown;
        source = "model";
      } else {
        // Unresolved uncertainty always errs toward answering.
        decision = "respond";
        windDown = false;
        source = "fallback";
      }
    }

    // Belt-and-braces: a question or direct request can never be swallowed,
    // no matter what the judge said.
    if (
      (signals.interrogative ||
        signals.directAddress ||
        signals.imperative ||
        signals.answeringBotQuestion) &&
      !signals.farewell &&
      decision !== "respond"
    ) {
      decision = "respond";
      windDown = false;
    }

    const decisionId = randomUUID();
    const acknowledgment =
      decision === "acknowledge"
        ? pickAcknowledgment(signals, windDown, transcript, decisionId)
        : undefined;

    // The decisionId is handed out only once its row is provably durable:
    // clients report outcomes only for ids they received, so an outcome can
    // never race past its own row — not even when a slow insert eventually
    // succeeds after the budget. Slow or broken stores still get an answer
    // (fail open); the turn simply goes untracked.
    const durable = await Promise.race([
      loadDecisionStore()
        .then((store) =>
          store.record({
            id: decisionId,
            userId,
            decision,
            windDown,
            source,
            talkativeness,
            transcript,
            signals: { ...signals, heuristicDecision: heuristic.decision },
          }),
        )
        .then(() => true)
        .catch((error) => {
          console.error(
            "Venom voice decision logging failed:",
            error instanceof Error ? error.message : error,
          );
          return false;
        }),
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(
          () => resolve(false),
          VOICE_DECISION_RECORD_BUDGET_MS,
        );
        timer.unref?.();
      }),
    ]);

    // One compact line per spoken turn: this route sits in the gap before
    // Venom starts talking, so its p50/p95 must be measurable from logs
    // alone. Timings and enums only — never transcript content.
    console.info(
      `Venom voice decide: source=${source} decision=${decision} windDown=${windDown} durable=${durable} totalMs=${Date.now() - startedAt}${
        judgeMs === null ? "" : ` judgeMs=${judgeMs}`
      }`,
    );

    res.json({
      ...(durable ? { decisionId } : {}),
      decision,
      windDown,
      ...(acknowledgment ? { acknowledgment } : {}),
    });
  });

  // ── Decision outcome capture ───────────────────────────────────────────────

  router.post(
    "/venom/voice/decision-outcome",
    async (req, res): Promise<void> => {
      const userId = resolveUserId(req);
      if (!userId) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      const rate = outcomeLimiter.take(userId);
      if (!rate.ok) {
        res.setHeader("Retry-After", rate.retryAfterSeconds);
        res.status(429).json({
          error: "Too many voice requests. Give it a moment.",
        });
        return;
      }

      const parsed = ReportVenomVoiceDecisionOutcomeBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid outcome report" });
        return;
      }

      try {
        const store = await loadDecisionStore();
        const result = await store.recordOutcome(
          userId,
          parsed.data.decisionId,
          parsed.data.outcome as VoiceDecisionOutcome,
        );
        res.json({ recorded: result.recorded });
      } catch (error) {
        console.error(
          "Venom voice outcome recording failed:",
          error instanceof Error ? error.message : error,
        );
        res.status(500).json({ error: "The outcome could not be recorded." });
      }
    },
  );

  // ── Decision evidence: summary report ─────────────────────────────────────
  // Unlike decide/outcome, these two read paths fail loudly: an evidence
  // report served from a broken store would quietly tune thresholds on
  // nothing, so a store failure is a 500, never an empty 200.

  router.get(
    "/venom/voice/decisions/summary",
    async (req, res): Promise<void> => {
      const userId = resolveUserId(req);
      if (!userId) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      const rate = reportLimiter.take(userId);
      if (!rate.ok) {
        res.setHeader("Retry-After", rate.retryAfterSeconds);
        res.status(429).json({
          error: "Too many voice requests. Give it a moment.",
        });
        return;
      }

      const parsed = GetVenomVoiceDecisionSummaryQueryParams.safeParse(
        req.query,
      );
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid report request" });
        return;
      }
      const windowDays = parsed.data.windowDays ?? 30;
      const since = new Date(Date.now() - windowDays * DAY_MS);

      try {
        const store = await loadDecisionStore();
        const rows = await store.listForUser(userId, since);
        res.json(summarizeVoiceDecisions(rows, { windowDays, since }));
      } catch (error) {
        console.error(
          "Venom voice decision summary failed:",
          error instanceof Error ? error.message : error,
        );
        res.status(500).json({ error: "The decision log could not be read." });
      }
    },
  );

  // ── Decision evidence: JSONL training export ─────────────────────────────

  router.get(
    "/venom/voice/decisions/export",
    async (req, res): Promise<void> => {
      const userId = resolveUserId(req);
      if (!userId) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      const rate = reportLimiter.take(userId);
      if (!rate.ok) {
        res.setHeader("Retry-After", rate.retryAfterSeconds);
        res.status(429).json({
          error: "Too many voice requests. Give it a moment.",
        });
        return;
      }

      const parsed = ExportVenomVoiceDecisionsQueryParams.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid export request" });
        return;
      }
      const windowDays = parsed.data.windowDays ?? 90;
      const since = new Date(Date.now() - windowDays * DAY_MS);

      try {
        const store = await loadDecisionStore();
        const rows = await store.listForUser(userId, since);
        // text/plain (not application/x-ndjson): the generated clients parse
        // text/* bodies into the string the OpenAPI contract promises; an
        // unrecognized media type would surface as a mistyped Blob instead.
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="venom-voice-decisions-${new Date()
            .toISOString()
            .slice(0, 10)}.jsonl"`,
        );
        res.send(voiceDecisionExportJsonl(rows));
      } catch (error) {
        console.error(
          "Venom voice decision export failed:",
          error instanceof Error ? error.message : error,
        );
        res.status(500).json({ error: "The decision log could not be read." });
      }
    },
  );

  return router;
}

const router: IRouter = createVenomVoiceRouter();

export default router;
