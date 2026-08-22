/**
 * venom-usage.integration.test.ts — hermetic proof that every AI path
 * writes a usage-ledger event attributed to the signed-in account, and that
 * the personal usage summary reports it in dollars under Venom-branded
 * names only.
 *
 * The suite stands up a mock OpenAI-compatible provider on loopback (both
 * streaming SSE — honoring `stream_options.include_usage` — and plain JSON
 * completions), points the venom router at it via env BEFORE importing the
 * router, and fakes Clerk auth the same way the model-leak suite does. The
 * database is the shared dev database; every row this suite writes carries
 * a run-scoped user id and is deleted afterwards.
 *
 * Run: pnpm --filter @workspace/api-server run test:usage
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import express from "express";
import pino from "pino";
import pinoHttp from "pino-http";
import { and, eq, like, sql } from "drizzle-orm";
import {
  db,
  pool,
  venomHostProfilesTable,
  venomUsageEvents,
} from "@workspace/db";

import {
  buildVenomCatalog,
  resolveProviderModelId,
  VENOM_MODEL_IDS,
  type VenomModelId,
} from "../lib/venom-models";
import {
  computeCostMicros,
  VOICE_FLAT_COST_MICROS,
  VOICE_USAGE_ALIAS,
} from "../lib/venom-usage-pricing";
import {
  insertVenomUsage,
  type RecordVenomUsageInput,
} from "../lib/venom-usage-store";
import type {
  StreamVenomResponseOptions,
  VenomMessage,
  VenomStreamUsage,
} from "../lib/venom-provider-adapters";
import type { DeliberationUsageEvent } from "../lib/venom-deliberation";
import type { PlannedDebateVoice } from "../lib/venom-debate";
import type { VenomVoiceAudioModule } from "./venom-voice";
import type { VoiceDecisionStore } from "../lib/venom-voice-decision-store";

// ─── Mock OpenAI-compatible provider ────────────────────────────────────────

type MockUsage = { prompt_tokens: number; completion_tokens: number } | null;
type MockScenario =
  | { kind: "stream"; chunks: string[]; usage: MockUsage }
  | { kind: "json"; content: string; usage: MockUsage };

/** Consumed FIFO; the default keeps incidental calls from hanging. */
const scenarioQueue: MockScenario[] = [];
const DEFAULT_SCENARIO: MockScenario = {
  kind: "stream",
  chunks: ["Understood."],
  usage: { prompt_tokens: 64, completion_tokens: 8 },
};

function completionFrame(model: string, extra: Record<string, unknown>) {
  return {
    id: "chatcmpl-usage-mock",
    object: "chat.completion.chunk",
    created: 1,
    model,
    ...extra,
  };
}

const mockProvider: Server = createServer((req, res) => {
  let raw = "";
  req.on("data", (piece) => {
    raw += piece;
  });
  req.on("end", () => {
    let body: {
      model?: string;
      stream?: boolean;
      stream_options?: { include_usage?: boolean };
    } = {};
    try {
      body = JSON.parse(raw || "{}") as typeof body;
    } catch {
      // Malformed body: fall through with defaults.
    }
    const scenario = scenarioQueue.shift() ?? DEFAULT_SCENARIO;
    const model = body.model ?? "mock-model";

    if (body.stream === true) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      });
      const frame = (payload: unknown) =>
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      const chunks =
        scenario.kind === "stream" ? scenario.chunks : [scenario.content];
      for (const content of chunks) {
        frame(
          completionFrame(model, {
            choices: [{ index: 0, delta: { content }, finish_reason: null }],
          }),
        );
      }
      frame(
        completionFrame(model, {
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        }),
      );
      // Real OpenAI sends the usage frame last, with empty choices, and only
      // when the caller opted in via stream_options.include_usage.
      if (scenario.usage && body.stream_options?.include_usage === true) {
        frame(
          completionFrame(model, { choices: [], usage: scenario.usage }),
        );
      }
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        id: "chatcmpl-usage-mock",
        object: "chat.completion",
        created: 1,
        model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content:
                scenario.kind === "json"
                  ? scenario.content
                  : scenario.chunks.join(""),
            },
            finish_reason: "stop",
          },
        ],
        ...(scenario.usage ? { usage: scenario.usage } : {}),
      }),
    );
  });
});

// ─── Fake Clerk auth: satisfy getAuth(req) without Clerk env ────────────────

const CLERK_AUTH_BRAND = Symbol.for("@clerk/express.auth");
let activeUserId: string | null = null;

const TEST_RUN_ID = randomUUID().slice(0, 8);
let userSeq = 0;
/**
 * A fresh user per subtest keeps the ledger assertions exact (no events
 * from a previous subtest) and keeps bond absorption deterministic: one
 * message per user stays below the style-profile threshold, so no
 * fire-and-forget provider call fires mid-suite.
 */
function nextTestUser(label: string): string {
  userSeq += 1;
  return `user_usage_${TEST_RUN_ID}_${userSeq}_${label}`;
}

function fakeClerkAuthMiddleware(): express.RequestHandler {
  return (req, _res, next) => {
    const authHandler = () => ({
      tokenType: "session_token",
      userId: activeUserId,
      sessionId: activeUserId ? "sess_usage_guard" : null,
      sessionClaims: null,
      sessionStatus: activeUserId ? "active" : "signed-out",
      actor: null,
      orgId: null,
      orgRole: null,
      orgSlug: null,
      orgPermissions: null,
      factorVerificationAge: null,
      getToken: async () => null,
      has: () => false,
      debug: () => ({}),
    });
    Object.assign(req, {
      auth: Object.assign(authHandler, { [CLERK_AUTH_BRAND]: true }),
    });
    next();
  };
}

// ─── Schema: the tables the exercised routes touch ──────────────────────────

async function ensureUsageSchema(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS venom_sops (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      clerk_user_id text NOT NULL,
      title text NOT NULL,
      lifecycle text NOT NULL DEFAULT 'draft',
      category text NOT NULL,
      tags text[] NOT NULL DEFAULT ARRAY[]::text[],
      provenance text NOT NULL DEFAULT 'manual',
      content jsonb NOT NULL,
      active_revision_id uuid,
      active_revision_number integer,
      sensitive boolean NOT NULL DEFAULT false,
      archived_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS venom_sop_revisions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      sop_id uuid NOT NULL REFERENCES venom_sops(id) ON DELETE CASCADE,
      clerk_user_id text NOT NULL,
      version_number integer NOT NULL,
      title text NOT NULL,
      category text NOT NULL,
      tags text[] NOT NULL DEFAULT ARRAY[]::text[],
      provenance text NOT NULL,
      content jsonb NOT NULL,
      checksum_sha256 text NOT NULL,
      published_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS venom_sop_project_selections (
      clerk_user_id text NOT NULL,
      project_id text NOT NULL,
      sop_id uuid NOT NULL REFERENCES venom_sops(id) ON DELETE CASCADE,
      revision_id uuid NOT NULL REFERENCES venom_sop_revisions(id) ON DELETE CASCADE,
      selected_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT venom_sop_project_selections_pk
        PRIMARY KEY (clerk_user_id, project_id, sop_id)
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS venom_usage_events (
      id text PRIMARY KEY,
      user_id text NOT NULL,
      occurred_at timestamptz NOT NULL DEFAULT now(),
      model_alias text NOT NULL,
      call_kind text NOT NULL,
      prompt_tokens integer NOT NULL,
      output_tokens integer NOT NULL,
      cost_micros integer NOT NULL,
      estimated boolean NOT NULL DEFAULT false,
      workspace_id text
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS venom_usage_events_user_time_idx
      ON venom_usage_events (user_id, occurred_at)
  `);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

type UsageRow = typeof venomUsageEvents.$inferSelect;

/**
 * Ledger writes on the request paths are fire-and-forget by design, so the
 * suite polls briefly instead of asserting immediately after the response.
 */
async function waitForUsageEvents(
  userId: string,
  callKind: string | null,
  minCount: number,
  timeoutMs = 5_000,
): Promise<UsageRow[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await db
      .select()
      .from(venomUsageEvents)
      .where(
        callKind
          ? and(
              eq(venomUsageEvents.userId, userId),
              eq(venomUsageEvents.callKind, callKind),
            )
          : eq(venomUsageEvents.userId, userId),
      );
    if (rows.length >= minCount || Date.now() > deadline) return rows;
    await delay(100);
  }
}

async function postJson(
  url: string,
  body: unknown,
): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ─── The suite ──────────────────────────────────────────────────────────────

test("every AI path writes a usage-ledger event for the asking account", async (t) => {
  mockProvider.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) =>
    mockProvider.once("listening", resolve),
  );
  const mockPort = (mockProvider.address() as AddressInfo).port;

  process.env.AI_INTEGRATIONS_OPENAI_BASE_URL = `http://127.0.0.1:${mockPort}/v1`;
  process.env.AI_INTEGRATIONS_OPENAI_API_KEY = "usage-guard-test-key";
  for (const name of [
    "ANTHROPIC_API_KEY",
    "AI_INTEGRATIONS_ANTHROPIC_BASE_URL",
    "AI_INTEGRATIONS_ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "AI_INTEGRATIONS_GEMINI_BASE_URL",
    "AI_INTEGRATIONS_GEMINI_API_KEY",
    "OPENROUTER_API_KEY",
    "AI_INTEGRATIONS_OPENROUTER_BASE_URL",
    "AI_INTEGRATIONS_OPENROUTER_API_KEY",
  ]) {
    delete process.env[name];
  }
  if (!process.env.SOURCE_ATTESTATION_SECRET && !process.env.SESSION_SECRET) {
    process.env.SOURCE_ATTESTATION_SECRET = "usage-guard-attestation-secret";
  }

  // The router chain constructs the OpenAI client from env at import time,
  // so these modules may only be imported now that env points at the mock.
  const { default: venomRouter } = await import("./venom.js");
  const { runDeliberation, planDeliberationVoices } = await import(
    "../lib/venom-deliberation.js"
  );
  const { runDebate } = await import("../lib/venom-debate.js");
  const { createVenomVoiceRouter } = await import("./venom-voice.js");

  await ensureUsageSchema();

  const app = express();
  app.use(pinoHttp({ logger: pino({ level: "silent" }) }));
  app.use(express.json({ limit: "1mb" }));
  app.use(fakeClerkAuthMiddleware());
  app.use("/api", venomRouter);

  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    await t.test("usage summary requires authentication", async () => {
      activeUserId = null;
      const response = await fetch(`${baseUrl}/api/venom/usage/summary`);
      assert.equal(response.status, 401);
      const body = (await response.json()) as { error: string };
      assert.equal(body.error, "Authentication required");
    });

    await t.test(
      "talk chat with a provider usage frame ledgers native counts",
      async () => {
        const userId = nextTestUser("chat");
        activeUserId = userId;
        scenarioQueue.length = 0;
        scenarioQueue.push({
          kind: "stream",
          chunks: ["Symbiotic ", "answer."],
          usage: { prompt_tokens: 640, completion_tokens: 52 },
        });

        const response = await postJson(`${baseUrl}/api/venom/respond`, {
          projectId: "proj-usage-guard",
          modelId: "venom-gpt",
          messages: [{ role: "user", content: "Hello there, symbiote." }],
        });
        assert.equal(response.status, 200);
        await response.text();

        const rows = await waitForUsageEvents(userId, "chat", 1);
        assert.equal(rows.length, 1, "exactly one chat event");
        const row = rows[0]!;
        assert.equal(row.modelAlias, "venom-gpt");
        assert.equal(row.promptTokens, 640);
        assert.equal(row.outputTokens, 52);
        assert.equal(row.estimated, false);
        // 640 × 1.25 µ$ + 52 × 10 µ$, from the server-private table.
        assert.equal(row.costMicros, 1320);
        assert.equal(row.workspaceId, null);
      },
    );

    await t.test(
      "talk chat without a usage frame ledgers a flagged estimate",
      async () => {
        const userId = nextTestUser("chat-estimate");
        activeUserId = userId;
        scenarioQueue.length = 0;
        scenarioQueue.push({
          kind: "stream",
          chunks: ["Symbiote ", "greeting."],
          usage: null,
        });

        const response = await postJson(`${baseUrl}/api/venom/respond`, {
          projectId: "proj-usage-guard",
          modelId: "venom-gpt",
          messages: [{ role: "user", content: "Hello there, symbiote." }],
        });
        assert.equal(response.status, 200);
        await response.text();

        const rows = await waitForUsageEvents(userId, "chat", 1);
        assert.equal(rows.length, 1);
        const row = rows[0]!;
        assert.equal(row.estimated, true, "no usage frame → flagged estimate");
        // "Symbiote greeting." is 18 chars → ceil(18 / 4) = 5 tokens.
        assert.equal(row.outputTokens, 5);
        assert.ok(row.promptTokens > 0, "prompt estimated from sent chars");
        assert.equal(
          row.costMicros,
          computeCostMicros("venom-gpt", row.promptTokens, row.outputTokens),
        );
      },
    );

    await t.test(
      "verify mode ledgers every voice pass and the synthesis",
      async () => {
        const userId = nextTestUser("verify");
        activeUserId = userId;
        scenarioQueue.length = 0;
        for (let i = 0; i < 4; i += 1) {
          scenarioQueue.push({
            kind: "stream",
            chunks: ["A corner's take."],
            usage: { prompt_tokens: 100, completion_tokens: 20 },
          });
        }

        const response = await postJson(`${baseUrl}/api/venom/respond`, {
          projectId: "proj-usage-guard",
          modelId: "venom-gpt",
          mode: "verify",
          messages: [{ role: "user", content: "Hello there, symbiote." }],
        });
        assert.equal(response.status, 200);
        await response.text();

        const rows = await waitForUsageEvents(userId, null, 4);
        const voicePasses = rows.filter((r) => r.callKind === "verify_voice");
        const syntheses = rows.filter(
          (r) => r.callKind === "verify_synthesis",
        );
        assert.equal(voicePasses.length, 3, "one event per corner");
        assert.equal(syntheses.length, 1, "one synthesis event");
        for (const row of rows) {
          assert.equal(row.modelAlias, "venom-gpt");
          assert.equal(row.promptTokens, 100);
          assert.equal(row.outputTokens, 20);
          assert.equal(row.estimated, false);
          assert.equal(row.costMicros, 325);
        }
      },
    );

    await t.test(
      "knowledge extraction ledgers the initiating account even when the reply is unusable",
      async () => {
        const userId = nextTestUser("extract");
        activeUserId = userId;
        scenarioQueue.length = 0;
        scenarioQueue.push({
          kind: "json",
          content: "this is not json",
          usage: { prompt_tokens: 300, completion_tokens: 80 },
        });

        const response = await postJson(
          `${baseUrl}/api/venom/knowledge/extract`,
          {
            conversation: { id: "conv-usage-1", title: "Usage metering chat" },
            messages: [
              {
                id: "m1",
                role: "user",
                content: "Streaming beats batching for perceived latency.",
              },
            ],
          },
        );
        // The unparseable reply fails the request — but the tokens were
        // bought, so the ledger event must exist anyway.
        assert.equal(response.status, 502);

        const rows = await waitForUsageEvents(userId, "knowledge_extract", 1);
        assert.equal(rows.length, 1);
        const row = rows[0]!;
        assert.equal(row.modelAlias, "venom-gpt");
        assert.equal(row.promptTokens, 300);
        assert.equal(row.outputTokens, 80);
        assert.equal(row.estimated, false);
        assert.equal(row.costMicros, 1175);
        assert.equal(row.workspaceId, null);
      },
    );

    await t.test("note improvement ledgers the caller", async () => {
      const userId = nextTestUser("note");
      activeUserId = userId;
      scenarioQueue.length = 0;
      scenarioQueue.push({
        kind: "json",
        content: "not json either",
        usage: { prompt_tokens: 200, completion_tokens: 40 },
      });

      const response = await postJson(`${baseUrl}/api/venom/notes/improve`, {
        note: "Tighten this note about streaming backpressure.",
      });
      assert.equal(response.status, 502);

      const rows = await waitForUsageEvents(userId, "note_improve", 1);
      assert.equal(rows.length, 1);
      const row = rows[0]!;
      assert.equal(row.modelAlias, "venom-gpt");
      assert.equal(row.promptTokens, 200);
      assert.equal(row.outputTokens, 40);
      assert.equal(row.estimated, false);
      assert.equal(row.costMicros, 650);
    });

    await t.test(
      "usage summary aggregates the ledger in dollars under Venom names",
      async () => {
        const userId = nextTestUser("summary");
        activeUserId = userId;

        // Seed through the store so the summary reads exactly what the
        // request paths write: costs computed from the private table unless
        // a flat voice cost overrides them.
        await insertVenomUsage({
          userId,
          modelAlias: "venom-gpt",
          callKind: "chat",
          promptTokens: 1000,
          outputTokens: 500,
          estimated: false,
          workspaceId: "ws-usage-guard",
        });
        await insertVenomUsage({
          userId,
          modelAlias: "venom-gemini",
          callKind: "knowledge_extract",
          promptTokens: 1000,
          outputTokens: 200,
          estimated: true,
        });
        await insertVenomUsage({
          userId,
          modelAlias: VOICE_USAGE_ALIAS,
          callKind: "voice_speak",
          promptTokens: 0,
          outputTokens: 0,
          estimated: true,
          costMicros: VOICE_FLAT_COST_MICROS.voice_speak,
        });

        const response = await fetch(`${baseUrl}/api/venom/usage/summary`);
        assert.equal(response.status, 200);
        const raw = await response.text();
        const body = JSON.parse(raw) as {
          periodStart: string;
          periodEnd: string;
          totals: {
            costUsd: number;
            requests: number;
            promptTokens: number;
            outputTokens: number;
          };
          hasEstimates: boolean;
          daily: Array<{ date: string; costUsd: number; requests: number }>;
          models: Array<{
            modelId: string;
            modelName: string;
            costUsd: number;
            requests: number;
            promptTokens: number;
            outputTokens: number;
            hasEstimates: boolean;
          }>;
        };

        // Current UTC calendar month.
        const now = new Date();
        const periodStart = Date.UTC(
          now.getUTCFullYear(),
          now.getUTCMonth(),
          1,
        );
        assert.equal(new Date(body.periodStart).getTime(), periodStart);

        // 6250 µ$ (gpt) + 800 µ$ (gemini) + 10000 µ$ (voice) = $0.01705.
        assert.equal(body.totals.costUsd, 0.01705);
        assert.equal(body.totals.requests, 3);
        assert.equal(body.totals.promptTokens, 2000);
        assert.equal(body.totals.outputTokens, 700);
        assert.equal(body.hasEstimates, true);

        // Highest spend first, Venom-branded names only.
        assert.deepEqual(
          body.models.map((m) => [m.modelId, m.modelName]),
          [
            [VOICE_USAGE_ALIAS, "Venom Voice"],
            ["venom-gpt", "Venom GPT"],
            ["venom-gemini", "Venom Gemini"],
          ],
        );
        assert.equal(body.models[0]!.costUsd, 0.01);
        assert.equal(body.models[0]!.hasEstimates, true);
        assert.equal(body.models[1]!.costUsd, 0.00625);
        assert.equal(body.models[1]!.hasEstimates, false);
        assert.equal(body.models[1]!.promptTokens, 1000);
        assert.equal(body.models[1]!.outputTokens, 500);
        assert.equal(body.models[2]!.costUsd, 0.0008);
        assert.equal(body.models[2]!.hasEstimates, true);

        // All three events landed just now, so the daily series has today.
        assert.ok(body.daily.length >= 1);
        assert.equal(
          body.daily.reduce((sum, d) => sum + d.requests, 0),
          3,
        );
        assert.ok(
          Math.abs(
            body.daily.reduce((sum, d) => sum + d.costUsd, 0) -
              body.totals.costUsd,
          ) < 1e-9,
        );

        // The payload never names provider SKUs or micro-dollar internals.
        for (const modelId of VENOM_MODEL_IDS) {
          const sku = resolveProviderModelId(modelId as VenomModelId);
          assert.ok(
            !raw.includes(sku),
            `provider SKU ${sku} must not appear in the summary payload`,
          );
        }
        assert.ok(!raw.toLowerCase().includes("micros"));

        // The workspace context stamped at insert time survives on the row.
        const rows = await waitForUsageEvents(userId, "chat", 1);
        assert.equal(rows[0]!.workspaceId, "ws-usage-guard");
      },
    );

    await t.test(
      "voice endpoints ledger flat audio estimates and judge tokens",
      async () => {
        const voiceUserId = nextTestUser("voice");
        const recorded: RecordVenomUsageInput[] = [];

        const fakeAudioModule: VenomVoiceAudioModule = {
          async speechToText() {
            return "heard you";
          },
          async textToSpeechStream() {
            return (async function* () {
              yield Buffer.from("pcm-audio").toString("base64");
            })();
          },
          detectAudioFormat() {
            return "webm";
          },
          async ensureCompatibleFormat(buffer) {
            return { buffer, format: "wav" as const };
          },
        };
        const fakeDecisionStore: VoiceDecisionStore = {
          record: async () => {},
          recordOutcome: async () => ({ recorded: true }),
          listForUser: async () => [],
        };

        const voiceRouter = createVenomVoiceRouter({
          resolveUserId: () => voiceUserId,
          isAvailable: () => true,
          loadAudioModule: async () => fakeAudioModule,
          judgeTurn: async (input) => {
            input.onUsage?.({
              promptTokens: 111,
              outputTokens: 9,
              estimated: false,
            });
            return { decision: "silent", windDown: false };
          },
          decisionStore: fakeDecisionStore,
          recordUsage: (input) => {
            recorded.push(input);
          },
        });
        const voiceApp = express();
        voiceApp.use(express.json({ limit: "1mb" }));
        voiceApp.use(voiceRouter);
        const voiceServer = createServer(voiceApp);
        voiceServer.listen(0, "127.0.0.1");
        await new Promise<void>((resolve) =>
          voiceServer.once("listening", resolve),
        );
        const voiceBase = `http://127.0.0.1:${
          (voiceServer.address() as AddressInfo).port
        }`;

        try {
          // Transcription: flat per-request estimate, no tokens.
          const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3]);
          const transcribe = await postJson(
            `${voiceBase}/venom/voice/transcribe`,
            { audioBase64: webm.toString("base64") },
          );
          assert.equal(transcribe.status, 200);
          const transcribed = recorded.find(
            (r) => r.callKind === "voice_transcribe",
          );
          assert.ok(transcribed, "transcription was ledgered");
          assert.equal(transcribed.userId, voiceUserId);
          assert.equal(transcribed.modelAlias, VOICE_USAGE_ALIAS);
          assert.equal(transcribed.estimated, true);
          assert.equal(transcribed.promptTokens, 0);
          assert.equal(transcribed.outputTokens, 0);
          assert.equal(
            transcribed.costMicros,
            VOICE_FLAT_COST_MICROS.voice_transcribe,
          );

          // Speech: flat estimate, recorded only because audio was sent.
          const speak = await postJson(`${voiceBase}/venom/voice/speak`, {
            text: "Hello.",
            presetId: "sam",
          });
          assert.equal(speak.status, 200);
          await speak.text();
          const spoke = recorded.find((r) => r.callKind === "voice_speak");
          assert.ok(spoke, "speech was ledgered");
          assert.equal(spoke.modelAlias, VOICE_USAGE_ALIAS);
          assert.equal(spoke.estimated, true);
          assert.equal(
            spoke.costMicros,
            VOICE_FLAT_COST_MICROS.voice_speak,
          );

          // Judge: real token counts against the LLM alias, no flat cost.
          const decide = await postJson(`${voiceBase}/venom/voice/decide`, {
            transcript: "the design still feels a little heavy",
            talkativeness: "balanced",
          });
          assert.equal(decide.status, 200);
          const judged = recorded.find((r) => r.callKind === "voice_judge");
          assert.ok(judged, "judge call was ledgered");
          assert.equal(judged.modelAlias, "venom-gpt");
          assert.equal(judged.promptTokens, 111);
          assert.equal(judged.outputTokens, 9);
          assert.equal(judged.estimated, false);
          assert.equal(judged.costMicros, undefined);
        } finally {
          voiceServer.closeAllConnections();
          await new Promise<void>((resolve) =>
            voiceServer.close(() => resolve()),
          );
        }
      },
    );

    await t.test(
      "deliberation reports voice and synthesis usage to its caller",
      async () => {
        const catalog = buildVenomCatalog();
        const voices = planDeliberationVoices("venom-gpt", catalog);
        const events: DeliberationUsageEvent[] = [];
        const fakeStream = async function* (
          _modelId: VenomModelId,
          _messages: VenomMessage[],
          _signal?: AbortSignal,
          options?: StreamVenomResponseOptions,
        ): AsyncGenerator<string, void, unknown> {
          yield "A concise take.";
          options?.onUsage?.({
            promptTokens: 12,
            outputTokens: 3,
            estimated: false,
          });
        };

        const outcome = await runDeliberation({
          baseMessages: [
            { role: "system", content: "Be brief." },
            { role: "user", content: "Weigh in." },
          ],
          voices,
          synthesisModelId: "venom-gpt",
          allowedCitationIds: new Set<string>(),
          signal: new AbortController().signal,
          emit: () => {},
          streamModel: fakeStream,
          onUsage: (event) => events.push(event),
        });

        assert.ok(outcome.content.length > 0);
        const voiceEvents = events.filter((e) => e.stage === "voice");
        const synthesisEvents = events.filter(
          (e) => e.stage === "synthesis",
        );
        assert.equal(voiceEvents.length, voices.length);
        assert.equal(synthesisEvents.length, 1);
        assert.equal(synthesisEvents[0]!.modelId, "venom-gpt");
        for (const event of events) {
          assert.deepEqual(event.usage, {
            promptTokens: 12,
            outputTokens: 3,
            estimated: false,
          });
        }
      },
    );

    await t.test("debate turns report usage voice by voice", async () => {
      const debateEvents: Array<{
        voiceId: string;
        modelId: VenomModelId;
        usage: VenomStreamUsage;
      }> = [];
      const voices: PlannedDebateVoice[] = [
        {
          id: "corner-gpt",
          name: "Corner GPT",
          modelId: "venom-gpt",
          modelName: "Venom GPT",
          stance: null,
        },
        {
          id: "corner-claude",
          name: "Corner Claude",
          modelId: "venom-claude",
          modelName: "Venom Claude",
          stance: "Argue the opposite.",
        },
      ];
      const fakeStream = async function* (
        _modelId: VenomModelId,
        _messages: VenomMessage[],
        _signal?: AbortSignal,
        options?: StreamVenomResponseOptions,
      ): AsyncGenerator<string, void, unknown> {
        yield "Turn argument.";
        options?.onUsage?.({
          promptTokens: 20,
          outputTokens: 4,
          estimated: true,
        });
      };

      const outcome = await runDebate({
        baseMessages: [
          { role: "system", content: "Debate briefly." },
          { role: "user", content: "Tabs or spaces?" },
        ],
        voices,
        weights: [0.5, 0.5],
        turnPlan: [0, 1],
        allowedCitationIds: new Set<string>(),
        signal: new AbortController().signal,
        emit: () => {},
        streamModel: fakeStream,
        onUsage: (event) => debateEvents.push(event),
      });

      assert.equal(outcome.turns.length, 2);
      assert.deepEqual(
        debateEvents.map((e) => [e.voiceId, e.modelId]),
        [
          ["corner-gpt", "venom-gpt"],
          ["corner-claude", "venom-claude"],
        ],
      );
      for (const event of debateEvents) {
        assert.deepEqual(event.usage, {
          promptTokens: 20,
          outputTokens: 4,
          estimated: true,
        });
      }
    });

    /**
     * Seed a bond sitting past the refresh threshold (enough absorbed
     * messages, no profile yet, cooldown long expired) so the very next
     * absorbed chat message makes the background style-profile refresh due
     * on the live absorb path.
     */
    async function seedDueBond(userId: string): Promise<void> {
      await db.insert(venomHostProfilesTable).values({
        ownerType: "user",
        ownerId: userId,
        absorbedMessageCount: 5,
        absorbedCharCount: 900,
        profiledMessageCount: 0,
        lastRefreshAt: 0,
      });
    }

    await t.test(
      "a chat that makes the bond refresh due meters the background profile call",
      async () => {
        const userId = nextTestUser("bond");
        activeUserId = userId;
        scenarioQueue.length = 0;
        await seedDueBond(userId);
        scenarioQueue.push(
          {
            kind: "stream",
            chunks: ["Bonded ", "reply."],
            usage: { prompt_tokens: 200, completion_tokens: 20 },
          },
          // The due refresh issues a plain JSON completion off the request
          // path; this reply parses into a usable profile.
          {
            kind: "json",
            content: JSON.stringify({ casing: "lowercase", usesEmoji: false }),
            usage: { prompt_tokens: 150, completion_tokens: 30 },
          },
        );

        const response = await postJson(`${baseUrl}/api/venom/respond`, {
          projectId: "proj-usage-guard",
          modelId: "venom-gpt",
          messages: [{ role: "user", content: "we ride together, always" }],
        });
        assert.equal(response.status, 200);
        await response.text();

        const rows = await waitForUsageEvents(userId, "host_profile", 1);
        assert.equal(rows.length, 1, "exactly one host_profile event");
        const row = rows[0]!;
        assert.equal(row.modelAlias, "venom-gpt");
        assert.equal(row.promptTokens, 150);
        assert.equal(row.outputTokens, 30);
        assert.equal(row.estimated, false);
        assert.equal(row.costMicros, computeCostMicros("venom-gpt", 150, 30));
        assert.equal(row.workspaceId, null, "bond upkeep is personal spend");
        // The chat leg itself still ledgered separately.
        const chatRows = await waitForUsageEvents(userId, "chat", 1);
        assert.equal(chatRows.length, 1);
      },
    );

    await t.test(
      "a profile refresh whose reply won't parse still meters the completion",
      async () => {
        const userId = nextTestUser("bondbad");
        activeUserId = userId;
        scenarioQueue.length = 0;
        await seedDueBond(userId);
        scenarioQueue.push(
          {
            kind: "stream",
            chunks: ["Still ", "here."],
            usage: { prompt_tokens: 180, completion_tokens: 16 },
          },
          // The provider billed the refresh but returned garbage: the
          // profile is rejected (refresh_failed) while the spend lands.
          {
            kind: "json",
            content: "definitely not a JSON profile {{{",
            usage: { prompt_tokens: 90, completion_tokens: 12 },
          },
        );

        const response = await postJson(`${baseUrl}/api/venom/respond`, {
          projectId: "proj-usage-guard",
          modelId: "venom-gpt",
          messages: [{ role: "user", content: "carnage was here" }],
        });
        assert.equal(response.status, 200);
        await response.text();

        const rows = await waitForUsageEvents(userId, "host_profile", 1);
        assert.equal(rows.length, 1, "the failed refresh still ledgered");
        const row = rows[0]!;
        assert.equal(row.modelAlias, "venom-gpt");
        assert.equal(row.promptTokens, 90);
        assert.equal(row.outputTokens, 12);
        assert.equal(row.estimated, false);
        assert.equal(row.costMicros, computeCostMicros("venom-gpt", 90, 12));
        // The garbage reply left no profile behind.
        const [bondRow] = await db
          .select({ profile: venomHostProfilesTable.profile })
          .from(venomHostProfilesTable)
          .where(
            and(
              eq(venomHostProfilesTable.ownerType, "user"),
              eq(venomHostProfilesTable.ownerId, userId),
            ),
          );
        assert.equal(bondRow?.profile ?? null, null);
      },
    );

    await t.test(
      "build-package generation reports usage before validation can bail",
      async () => {
        const { generateBuildPackage } = await import(
          "../lib/venom-build-package-generator.js"
        );
        scenarioQueue.length = 0;
        scenarioQueue.push({
          kind: "json",
          content: "not a build package",
          usage: { prompt_tokens: 300, completion_tokens: 45 },
        });

        const captured: VenomStreamUsage[] = [];
        await assert.rejects(
          generateBuildPackage(
            {
              targetType: "website",
              targetName: "Symbiote Landing",
              requirements: "One page.",
              constraints: "None.",
              brandDirection: "Monochrome.",
              sourceReferences: [],
              sopReferences: [],
              sourceContext: [],
              sopContext: [],
              revisionInstruction: null,
              previousPackage: null,
              baselineContext: null,
            },
            new AbortController().signal,
            (usage) => captured.push(usage),
          ),
          /invalid JSON/,
        );
        assert.deepEqual(captured, [
          { promptTokens: 300, outputTokens: 45, estimated: false },
        ]);
      },
    );
  } finally {
    activeUserId = null;
    try {
      await db
        .delete(venomUsageEvents)
        .where(like(venomUsageEvents.userId, `user_usage_${TEST_RUN_ID}%`));
      await db
        .delete(venomHostProfilesTable)
        .where(
          like(venomHostProfilesTable.ownerId, `user_usage_${TEST_RUN_ID}%`),
        );
    } catch {
      // Cleanup is best-effort; the run-scoped ids keep reruns isolated.
    }
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    mockProvider.closeAllConnections();
    await new Promise<void>((resolve) => mockProvider.close(() => resolve()));
    await pool.end();
  }
});
