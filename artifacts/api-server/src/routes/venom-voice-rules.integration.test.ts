/**
 * Voice-assignment rules over the real Venom respond route.
 *
 * A model can't argue itself: opposing voices must sit on different LLM
 * providers. The planners enforce this from catalog provider metadata (unit
 * tested next to them); this suite proves the rule holds at the HTTP
 * boundary — where the mobile app and direct API callers land — and that
 * valid picks flow through request parsing into the planned roster:
 *
 * - verify: explicit First take + Skeptic on the same model → 400 with the
 *   stable argue-itself message, before any provider call.
 * - debate: a duplicated participant corner (via blend ids) → 400.
 * - verify: valid distinct picks reach the SSE metadata roster verbatim.
 *
 * Provider env points at dead-end loopback URLs: availability is env-derived,
 * the 400s reject before any upstream call, and the happy path only needs the
 * pre-stream metadata event, so no mock provider is required.
 *
 * Run: pnpm --filter @workspace/api-server run test:voice-rules
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import express from "express";
import pinoHttp from "pino-http";

import { createApiLogger } from "../lib/logger.js";
import { resetVenomModelAccountHealthForTests } from "../lib/venom-models.js";

// ─── Fake Clerk auth: satisfy getAuth(req) without Clerk env ────────────────

const CLERK_AUTH_BRAND = Symbol.for("@clerk/express.auth");
let activeUserId: string | null = null;

const TEST_RUN_ID = randomUUID().slice(0, 8);
let userSeq = 0;
/** A fresh user per subtest keeps bond absorption below its trigger floor. */
function nextTestUser(): string {
  userSeq += 1;
  return `user_voice_rules_${TEST_RUN_ID}_${userSeq}`;
}

function fakeClerkAuthMiddleware(): express.RequestHandler {
  return (req, _res, next) => {
    const authHandler = () => ({
      tokenType: "session_token",
      userId: activeUserId,
      sessionId: activeUserId ? "sess_voice_rules" : null,
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

// ─── Minimal schema for the respond route's SOP read path ──────────────────

async function ensureSopSchema(): Promise<void> {
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

test("the argue-itself rule holds at the respond route boundary", async (t) => {
  // Two providers configured (dead-end loopback URLs — availability is
  // env-derived and nothing below needs a live upstream); the other two
  // stripped so the catalog is deterministic: venom-gpt (openai) and
  // venom-claude (anthropic) available, venom-gemini / venom-grok not.
  process.env.AI_INTEGRATIONS_OPENAI_BASE_URL = "http://127.0.0.1:9/v1";
  process.env.AI_INTEGRATIONS_OPENAI_API_KEY = "voice-rules-test-key";
  process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL = "http://127.0.0.1:9/v1";
  process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY = "voice-rules-test-key";
  for (const name of [
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
    process.env.SOURCE_ATTESTATION_SECRET = "voice-rules-attestation-secret";
  }

  // The router chain reads provider env at import time.
  const { default: venomRouter } = await import("./venom.js");

  await ensureSopSchema();
  resetVenomModelAccountHealthForTests();

  const logSink: string[] = [];
  const app = express();
  app.use(
    pinoHttp({
      logger: createApiLogger({
        level: "info",
        destination: {
          write(line: string) {
            logSink.push(line);
          },
        },
      }),
    }),
  );
  app.use(express.json({ limit: "1mb" }));
  app.use(fakeClerkAuthMiddleware());
  app.use("/api", venomRouter);

  const server = await new Promise<http.Server>((resolve) => {
    const created = app.listen(0, "127.0.0.1", () => resolve(created));
  });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  async function postRespond(
    body: Record<string, unknown>,
  ): Promise<{ status: number; text: string }> {
    const response = await fetch(`${baseUrl}/api/venom/respond`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, text: await response.text() };
  }

  /** Wording avoids the file-intent gate, so no classifier call triggers. */
  function respondBody(extra: Record<string, unknown>): Record<string, unknown> {
    return {
      projectId: "voice-rules-project",
      modelId: "venom-gpt",
      messages: [{ role: "user", content: "Hello there, symbiote." }],
      ...extra,
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

  try {
    await t.test("verify: the same model on both sides is a 400, not a stream", async () => {
      activeUserId = nextTestUser();
      const { status, text } = await postRespond(
        respondBody({
          mode: "verify",
          voiceModels: [
            { voiceId: "direct", modelId: "venom-gpt" },
            { voiceId: "skeptic", modelId: "venom-gpt" },
          ],
        }),
      );
      assert.equal(status, 400);
      const body = JSON.parse(text) as { error?: string };
      assert.match(
        body.error ?? "",
        /Venom GPT can't argue itself — pick a different model for Skeptic\./,
      );
    });

    await t.test("debate: a duplicated participant corner is a 400", async () => {
      activeUserId = nextTestUser();
      const { status, text } = await postRespond(
        respondBody({
          mode: "debate",
          blend: [
            { id: "venom-gpt", weight: 0.4 },
            { id: "venom-gpt", weight: 0.3 },
            { id: "venom-claude", weight: 0.3 },
          ],
        }),
      );
      assert.equal(status, 400);
      const body = JSON.parse(text) as { error?: string };
      assert.match(body.error ?? "", /Venom GPT can't argue itself/);
    });

    await t.test("verify: valid distinct picks reach the planned roster", async () => {
      activeUserId = nextTestUser();
      const { status, text } = await postRespond(
        respondBody({
          mode: "verify",
          voiceModels: [
            { voiceId: "direct", modelId: "venom-gpt" },
            { voiceId: "skeptic", modelId: "venom-claude" },
          ],
        }),
      );
      // The opening metadata event (with the planned roster) streams before
      // any provider call; the dead-end upstream only fails the takes
      // afterwards.
      assert.equal(status, 200);
      const events = parseSseEvents(text);
      const metadata = events.find((event) => "deliberation" in event) as
        | { deliberation?: { voices?: Array<{ voiceId: string; modelId: string }> } }
        | undefined;
      assert.ok(metadata?.deliberation?.voices, "metadata event carries the roster");
      const roster = metadata.deliberation.voices!.map((voice) => [
        voice.voiceId,
        voice.modelId,
      ]);
      assert.deepEqual(roster, [
        ["direct", "venom-gpt"],
        ["skeptic", "venom-claude"],
        // Only two providers are usable, so neutral Evidence shares the
        // anchor — the sanctioned few-providers fallback.
        ["evidence", "venom-gpt"],
      ]);
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await pool.end();
  }
});
