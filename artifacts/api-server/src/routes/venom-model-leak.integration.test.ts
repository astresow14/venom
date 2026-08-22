/**
 * Provider model-ID leak guard for the Venom API surface.
 *
 * Venom's packaging promise (see replit.md): the raw provider model IDs
 * behind venom-gpt / venom-claude / venom-gemini / venom-grok stay
 * server-side forever — clients only ever see Venom-branded aliases and
 * curated copy. This suite enforces that promise mechanically instead of by
 * convention:
 *
 * - The forbidden list is derived live from the private mapping
 *   (`resolveProviderModelId` over `VENOM_MODEL_IDS`), so a future
 *   server-side model swap in venom-models.ts stays guarded without anyone
 *   editing this file.
 * - The model catalog endpoint and the streaming chat endpoint are
 *   exercised over real HTTP — success paths plus every distinct error
 *   surface (401 auth, 400 validation, 502 unconfigured provider,
 *   mid-stream provider failure, billing-dead provider account) — against a
 *   mock provider that behaves adversarially: like real providers, it
 *   echoes the raw model ID in stream metadata and error bodies.
 * - Every surface the server emits is scanned: response bodies, SSE events,
 *   error payloads, and the full pino log output (captured through the
 *   production logger factory, redaction rules included).
 *
 * A failure here means a raw provider SKU reached a client-visible surface
 * or a log line — the packaging promise broke, not the test.
 *
 * Run: pnpm --filter @workspace/api-server run test:model-leak
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import express from "express";
import pinoHttp from "pino-http";

import { createApiLogger } from "../lib/logger.js";
import {
  resetVenomModelAccountHealthForTests,
  resolveProviderModelId,
  VENOM_MODEL_IDS,
} from "../lib/venom-models.js";

// ─── Forbidden strings: the private mapping, resolved live ──────────────────

const SECRET_SKUS: readonly string[] = [...VENOM_MODEL_IDS].map((id) =>
  resolveProviderModelId(id),
);

/** Failure messages must not print the secret either. */
function maskSku(sku: string): string {
  return `${sku.slice(0, 3)}…(${sku.length} chars)`;
}

function findSkuLeaks(text: string): string[] {
  // JSON serializers may escape "/" as "\/"; normalize before matching.
  const normalized = text.replace(/\\\//g, "/").toLowerCase();
  return SECRET_SKUS.filter((sku) =>
    normalized.includes(sku.toLowerCase()),
  ).map(maskSku);
}

/** Every scanned surface, kept for a final end-of-suite sweep. */
const scannedSurfaces: Array<{ context: string; text: string }> = [];

function assertNoProviderSku(text: string, context: string): void {
  scannedSurfaces.push({ context, text });
  assert.deepEqual(
    findSkuLeaks(text),
    [],
    `raw provider model ID leaked in ${context}`,
  );
}

// ─── Mock provider: adversarial OpenAI-compatible upstream ──────────────────

type ProviderScenario =
  | { kind: "stream"; chunks: string[] }
  | { kind: "http_error"; status: number; body: unknown };

let providerScenario: ProviderScenario = { kind: "stream", chunks: [] };
const providerCalls: Array<{ url: string; model: unknown }> = [];

const mockProvider = http.createServer((req, res) => {
  let raw = "";
  req.setEncoding("utf8");
  req.on("data", (piece: string) => {
    raw += piece;
  });
  req.on("end", () => {
    let body: { model?: unknown } = {};
    try {
      body = JSON.parse(raw) as { model?: unknown };
    } catch {
      // keep {}
    }
    providerCalls.push({ url: req.url ?? "", model: body.model });

    if (providerScenario.kind === "http_error") {
      res.writeHead(providerScenario.status, {
        "content-type": "application/json",
      });
      res.end(JSON.stringify(providerScenario.body));
      return;
    }

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });
    const chunk = (delta: object, finish: string | null) =>
      `data: ${JSON.stringify({
        id: "chatcmpl-leak-guard",
        object: "chat.completion.chunk",
        created: 0,
        // Real providers echo the raw model ID on every stream chunk; the
        // server must consume it without letting it reach the client.
        model: typeof body.model === "string" ? body.model : "",
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`;
    for (const piece of providerScenario.chunks) {
      res.write(chunk({ content: piece }, null));
    }
    res.write(chunk({}, "stop"));
    res.write("data: [DONE]\n\n");
    res.end();
  });
});

// ─── Fake Clerk auth: satisfy getAuth(req) without Clerk env ────────────────

const CLERK_AUTH_BRAND = Symbol.for("@clerk/express.auth");
let activeUserId: string | null = null;

const TEST_RUN_ID = randomUUID().slice(0, 8);
let userSeq = 0;
/**
 * A fresh user per chat subtest keeps bond absorption deterministic: one
 * message per user stays below PROFILE_MIN_MESSAGES, so the fire-and-forget
 * absorb path never triggers a style-profile provider call mid-suite.
 */
function nextTestUser(): string {
  userSeq += 1;
  return `user_leak_guard_${TEST_RUN_ID}_${userSeq}`;
}

function fakeClerkAuthMiddleware(): express.RequestHandler {
  return (req, _res, next) => {
    const authHandler = () => ({
      tokenType: "session_token",
      userId: activeUserId,
      sessionId: activeUserId ? "sess_leak_guard" : null,
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

// ─── Log capture through the production logger factory ─────────────────────

const logLines: string[] = [];
const captureLogger = createApiLogger({
  level: "info",
  destination: {
    write(line: string) {
      logLines.push(line);
    },
  },
});

// ─── Minimal schema for the respond route's SOP read path ──────────────────

async function ensureLeakGuardSchema(): Promise<void> {
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
}

// ─── The suite ──────────────────────────────────────────────────────────────

test("raw provider model IDs never leak from the Venom API surface", async (t) => {
  // Point the OpenAI integration at the local adversarial mock and strip
  // every other provider credential so availability is deterministic:
  // venom-gpt is configured, the other three are not.
  await new Promise<void>((resolve) => {
    mockProvider.listen(0, "127.0.0.1", resolve);
  });
  const mockPort = (mockProvider.address() as AddressInfo).port;
  process.env.AI_INTEGRATIONS_OPENAI_BASE_URL = `http://127.0.0.1:${mockPort}/v1`;
  process.env.AI_INTEGRATIONS_OPENAI_API_KEY = "leak-guard-test-key";
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
    process.env.SOURCE_ATTESTATION_SECRET = "leak-guard-attestation-secret";
  }

  // The router chain constructs the OpenAI client from env at import time,
  // so it may only be imported now that env points at the mock. Same for
  // the provider-adapters module's exported copy constants.
  const { default: venomRouter } = await import("./venom.js");
  const { PROVIDER_ACCOUNT_ERROR_MESSAGE } = await import(
    "../lib/venom-provider-adapters.js"
  );

  await ensureLeakGuardSchema();
  resetVenomModelAccountHealthForTests();

  const app = express();
  app.use(
    pinoHttp({
      logger: captureLogger,
      // Mirror app.ts so the captured lines match production shape.
      serializers: {
        req(req) {
          return {
            id: req.id,
            method: req.method,
            url: req.url?.split("?")[0],
          };
        },
        res(res) {
          return {
            statusCode: res.statusCode,
          };
        },
      },
    }),
  );
  app.use(express.json({ limit: "1mb" }));
  app.use(fakeClerkAuthMiddleware());
  app.use("/api", venomRouter);

  const server = await new Promise<http.Server>((resolve) => {
    const created = app.listen(0, "127.0.0.1", () => resolve(created));
  });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  async function apiRequest(
    context: string,
    path: string,
    init?: RequestInit,
  ): Promise<{ status: number; contentType: string; text: string }> {
    const response = await fetch(`${baseUrl}${path}`, init);
    const text = await response.text();
    assertNoProviderSku(text, `${context} response body`);
    return {
      status: response.status,
      contentType: response.headers.get("content-type") ?? "",
      text,
    };
  }

  function postRespond(context: string, body: Record<string, unknown>) {
    return apiRequest(context, "/api/venom/respond", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  function respondBody(modelId: string): Record<string, unknown> {
    return {
      projectId: "leak-guard-project",
      modelId,
      // Wording deliberately avoids the file-intent gate (no file nouns or
      // authoring verbs), so no classifier model call is triggered.
      messages: [{ role: "user", content: "Hello there, symbiote." }],
    };
  }

  function parseSseEvents(raw: string): Array<Record<string, unknown>> {
    return raw
      .split("\n\n")
      .filter((block) => block.startsWith("data: "))
      .map(
        (block) =>
          JSON.parse(block.slice("data: ".length)) as Record<string, unknown>,
      );
  }

  let catalogBaseline: Array<Record<string, unknown>> = [];

  try {
    await t.test("guard self-test: the scanner sees the private mapping", () => {
      assert.equal(SECRET_SKUS.length, VENOM_MODEL_IDS.size);
      assert.ok(SECRET_SKUS.length >= 4, "expected all four venom models");
      for (const sku of SECRET_SKUS) {
        assert.ok(sku.length >= 4, "SKU list must hold real provider IDs");
        assert.ok(
          !sku.startsWith("venom-"),
          "the private mapping must not be venom aliases",
        );
        assert.equal(
          findSkuLeaks(`{"model":"${sku}"}`).length,
          1,
          "scanner must flag a seeded SKU",
        );
        // JSON-escaped slashes (e.g. "x-ai\/…") must not defeat the scan.
        assert.equal(
          findSkuLeaks(JSON.stringify({ model: sku }).replace(/\//g, "\\/"))
            .length,
          1,
          "scanner must flag a JSON-escaped SKU",
        );
      }
    });

    await t.test("catalog success: only venom aliases and curated copy", async () => {
      activeUserId = nextTestUser();
      const { status, text } = await apiRequest(
        "catalog success",
        "/api/venom/models",
      );
      assert.equal(status, 200);
      catalogBaseline = JSON.parse(text) as Array<Record<string, unknown>>;
      assert.equal(catalogBaseline.length, VENOM_MODEL_IDS.size);
      for (const entry of catalogBaseline) {
        assert.match(String(entry.id), /^venom-/);
        assert.match(String(entry.name), /^Venom /);
      }
      const gpt = catalogBaseline.find((entry) => entry.id === "venom-gpt");
      assert.ok(gpt, "venom-gpt entry present");
      assert.equal(
        gpt.available,
        true,
        "mock env must make venom-gpt available — otherwise the chat paths below test nothing",
      );
      const claude = catalogBaseline.find(
        (entry) => entry.id === "venom-claude",
      );
      assert.equal(
        claude?.available,
        false,
        "anthropic env removed → venom-claude drives the unconfigured 502 path below",
      );
    });

    await t.test("catalog unauthorized: error payload stays curated", async () => {
      activeUserId = null;
      const { status, text } = await apiRequest(
        "catalog unauthorized",
        "/api/venom/models",
      );
      assert.equal(status, 401);
      assert.deepEqual(JSON.parse(text), { error: "Unauthorized" });
    });

    await t.test("chat stream success: venom-branded events only", async () => {
      activeUserId = nextTestUser();
      providerScenario = { kind: "stream", chunks: ["Symbiote ", "greeting."] };
      const callsBefore = providerCalls.length;
      const { status, contentType, text } = await postRespond(
        "chat success",
        respondBody("venom-gpt"),
      );
      assert.equal(status, 200);
      assert.match(contentType, /^text\/event-stream/);
      const events = parseSseEvents(text);
      assert.equal(events[0]?.modelId, "venom-gpt");
      assert.match(String(events[0]?.modelName), /^Venom /);
      const content = events
        .filter((event) => typeof event.content === "string")
        .map((event) => event.content)
        .join("");
      assert.equal(content, "Symbiote greeting.");
      assert.deepEqual(events[events.length - 1], { done: true });

      // The guard only means something if the secret really crossed the
      // server on this path: the upstream call must carry the raw SKU.
      assert.equal(providerCalls.length, callsBefore + 1);
      assert.equal(
        providerCalls[providerCalls.length - 1]?.model,
        resolveProviderModelId("venom-gpt"),
        "server must translate the venom alias to the raw provider ID upstream",
      );
    });

    await t.test(
      "chat stream provider error: upstream copy echoing the SKU is sanitized",
      async () => {
        activeUserId = nextTestUser();
        const rawSku = resolveProviderModelId("venom-gpt");
        providerScenario = {
          kind: "http_error",
          status: 404,
          body: {
            error: {
              message: `The model \`${rawSku}\` does not exist or you do not have access to it.`,
              type: "invalid_request_error",
              param: "model",
              code: "model_not_found",
            },
          },
        };
        const callsBefore = providerCalls.length;
        const { status, contentType, text } = await postRespond(
          "chat provider error",
          respondBody("venom-gpt"),
        );
        // Headers were already streaming when the provider failed.
        assert.equal(status, 200);
        assert.match(contentType, /^text\/event-stream/);
        const events = parseSseEvents(text);
        const errorEvent = events.find(
          (event) => typeof event.error === "string",
        );
        assert.ok(errorEvent, "stream must surface an error event");
        assert.equal(errorEvent.code, "provider_error");
        assert.equal(
          errorEvent.error,
          "The selected model could not complete this response.",
        );
        assert.equal(
          providerCalls.length,
          callsBefore + 1,
          "404 is not retryable — exactly one provider call",
        );
      },
    );

    await t.test(
      "chat stream billing failure: account trouble surfaces without the SKU",
      async () => {
        activeUserId = nextTestUser();
        const rawSku = resolveProviderModelId("venom-gpt");
        providerScenario = {
          kind: "http_error",
          status: 400,
          body: {
            error: {
              message: `Your credit balance is too low to access ${rawSku}. Please go to Plans & Billing to upgrade or purchase credits.`,
              type: "invalid_request_error",
              code: "insufficient_quota",
            },
          },
        };
        const { status, text } = await postRespond(
          "chat billing error",
          respondBody("venom-gpt"),
        );
        assert.equal(status, 200);
        const events = parseSseEvents(text);
        const errorEvent = events.find(
          (event) => typeof event.error === "string",
        );
        assert.ok(errorEvent, "stream must surface an error event");
        assert.equal(errorEvent.code, "provider_account");
        assert.equal(errorEvent.error, PROVIDER_ACCOUNT_ERROR_MESSAGE);
        assert.equal(errorEvent.retryable, false);

        // The billing failure flips the in-process account-health overlay;
        // the degraded catalog copy must stay curated too.
        const { status: catalogStatus, text: catalogText } = await apiRequest(
          "catalog after billing failure",
          "/api/venom/models",
        );
        assert.equal(catalogStatus, 200);
        const degraded = JSON.parse(catalogText) as Array<
          Record<string, unknown>
        >;
        const gpt = degraded.find((entry) => entry.id === "venom-gpt");
        const baselineGpt = catalogBaseline.find(
          (entry) => entry.id === "venom-gpt",
        );
        assert.ok(gpt, "venom-gpt entry still present");
        assert.notDeepEqual(
          gpt,
          baselineGpt,
          "billing failure must be visible in catalog copy (curated, never raw)",
        );
        resetVenomModelAccountHealthForTests();
      },
    );

    await t.test(
      "chat unconfigured model: pre-stream 502 payload stays curated",
      async () => {
        activeUserId = nextTestUser();
        const { status, text } = await postRespond(
          "chat unavailable model",
          respondBody("venom-claude"),
        );
        assert.equal(status, 502);
        const body = JSON.parse(text) as Record<string, unknown>;
        assert.equal(body.code, "provider_unavailable");
        assert.equal(body.error, "The selected model is not available right now.");
      },
    );

    await t.test("chat invalid model id: 400 payload stays curated", async () => {
      activeUserId = nextTestUser();
      const { status, text } = await postRespond(
        "chat invalid model",
        respondBody("gpt-4o"),
      );
      assert.equal(status, 400);
      assert.deepEqual(JSON.parse(text), { error: "Invalid chat request" });
    });

    await t.test(
      "server logs from every exercised path stay free of provider SKUs",
      async () => {
        // Response-completion and fire-and-forget bond logs land async.
        await delay(200);
        assert.ok(
          logLines.length > 0,
          "log capture must be wired — otherwise this half of the guard is dead",
        );
        const combined = logLines.join("");
        for (const marker of [
          "Venom respond completed",
          "Venom provider returned an error",
          "Venom provider account cannot cover replies",
          "Venom provider unavailable",
          "Invalid Venom chat request",
        ]) {
          assert.ok(
            combined.includes(marker),
            `expected the exercised paths to have logged "${marker}"`,
          );
        }
        assertNoProviderSku(combined, "captured server logs");

        // Belt and braces: re-sweep every surface now that everything has
        // settled, so a late-written line cannot slip past a per-test scan.
        for (const surface of scannedSurfaces) {
          assert.deepEqual(
            findSkuLeaks(surface.text),
            [],
            `raw provider model ID leaked in ${surface.context}`,
          );
        }
      },
    );
  } finally {
    server.close();
    server.closeAllConnections();
    mockProvider.close();
    mockProvider.closeAllConnections();
    try {
      await db.execute(
        sql`DELETE FROM venom_host_profiles WHERE owner_id LIKE ${"user_leak_guard_%"}`,
      );
    } catch {
      // Table may not exist on a fresh database; absorption already warned.
    }
    await pool.end();
  }
});
