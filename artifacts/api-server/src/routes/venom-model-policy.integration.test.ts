/**
 * Account-level model selection policy over the real Venom respond route.
 *
 * The policy lives server-side in the synced workspace snapshot, so it must
 * override whatever model the request names — on every device, in every
 * mode. This suite proves at the HTTP boundary:
 *
 * - auto-cheapest: the SSE metadata event anchors on the cheapest healthy
 *   model even though the request asked for the priciest, and announces the
 *   takeover (`selection.policy`).
 * - a billing-dead account on the cheapest model switches the very next
 *   request to the next-cheapest — no user action, no restart.
 * - auto-max-power: the most capable healthy model carries the work.
 * - manual (and absent policy): byte-identical to today — the request's own
 *   model streams and no `selection` field appears.
 * - verify under auto: explicit per-voice picks are set aside (a pairing
 *   that manual rejects with a 400 streams fine) and the planned roster
 *   still never seats opposing voices on one provider.
 *
 * Provider env points at dead-end loopback URLs: availability is env-derived
 * and only the pre-stream metadata event is asserted, so no mock provider is
 * required.
 *
 * Run: pnpm --filter @workspace/api-server run test:model-policy
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
import {
  reportVenomModelAccountHealth,
  resetVenomModelAccountHealthForTests,
} from "../lib/venom-models.js";

// ─── Fake Clerk auth: satisfy getAuth(req) without Clerk env ────────────────

const CLERK_AUTH_BRAND = Symbol.for("@clerk/express.auth");
let activeUserId: string | null = null;

const TEST_RUN_ID = randomUUID().slice(0, 8);
let userSeq = 0;
/** A fresh user per subtest keeps bond absorption below its trigger floor. */
function nextTestUser(): string {
  userSeq += 1;
  return `user_model_policy_${TEST_RUN_ID}_${userSeq}`;
}

function fakeClerkAuthMiddleware(): express.RequestHandler {
  return (req, _res, next) => {
    const authHandler = () => ({
      tokenType: "session_token",
      userId: activeUserId,
      sessionId: activeUserId ? "sess_model_policy" : null,
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

// ─── Minimal schema: workspace snapshots + the respond route's SOP reads ───

async function ensureSchema(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS venom_workspaces (
      clerk_user_id text PRIMARY KEY,
      state jsonb NOT NULL,
      revision integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
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

/** Store a snapshot whose modelPreferences carry the given policy. */
async function seedWorkspacePolicy(
  userId: string,
  selectionPolicy: string | null,
): Promise<void> {
  const state = {
    schemaVersion: 1,
    modelPreferences: {
      enabledModelIds: ["venom-gpt", "venom-claude"],
      defaultModelId: "venom-gpt",
      activeModelId: "venom-gpt",
      ...(selectionPolicy ? { selectionPolicy } : {}),
      updatedAt: Date.now(),
    },
  };
  await db.execute(sql`
    INSERT INTO venom_workspaces (clerk_user_id, state, revision)
    VALUES (${userId}, ${JSON.stringify(state)}::jsonb, 1)
    ON CONFLICT (clerk_user_id)
    DO UPDATE SET state = EXCLUDED.state, updated_at = now()
  `);
}

// ─── The suite ──────────────────────────────────────────────────────────────

test("the selection policy resolves server-side on the respond route", async (t) => {
  // Three providers configured (dead-end loopback URLs — availability is
  // env-derived and only pre-stream metadata is asserted); OpenRouter
  // stripped so the catalog is deterministic: venom-gpt, venom-claude and
  // venom-gemini available, venom-grok not. Cost ranks make auto-cheapest
  // anchor on venom-gemini; capability ranks make auto-max-power anchor on
  // venom-gpt.
  process.env.AI_INTEGRATIONS_OPENAI_BASE_URL = "http://127.0.0.1:9/v1";
  process.env.AI_INTEGRATIONS_OPENAI_API_KEY = "model-policy-test-key";
  process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL = "http://127.0.0.1:9/v1";
  process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY = "model-policy-test-key";
  process.env.AI_INTEGRATIONS_GEMINI_BASE_URL = "http://127.0.0.1:9/v1";
  process.env.AI_INTEGRATIONS_GEMINI_API_KEY = "model-policy-test-key";
  for (const name of [
    "GEMINI_API_KEY",
    "OPENROUTER_API_KEY",
    "AI_INTEGRATIONS_OPENROUTER_BASE_URL",
    "AI_INTEGRATIONS_OPENROUTER_API_KEY",
  ]) {
    delete process.env[name];
  }
  if (!process.env.SOURCE_ATTESTATION_SECRET && !process.env.SESSION_SECRET) {
    process.env.SOURCE_ATTESTATION_SECRET = "model-policy-attestation-secret";
  }

  // The router chain reads provider env at import time.
  const { default: venomRouter } = await import("./venom.js");

  await ensureSchema();
  resetVenomModelAccountHealthForTests();

  const app = express();
  app.use(
    pinoHttp({
      logger: createApiLogger({
        level: "silent",
        destination: { write() {} },
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
      projectId: "model-policy-project",
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

  /** The pre-stream metadata event: the first one naming the model. */
  function startEvent(raw: string): Record<string, unknown> {
    const event = parseSseEvents(raw).find((entry) => "modelId" in entry);
    assert.ok(event, "the stream opens with the metadata event");
    return event;
  }

  try {
    await t.test(
      "auto-cheapest overrides the request's model and announces itself",
      async () => {
        activeUserId = nextTestUser();
        await seedWorkspacePolicy(activeUserId, "auto-cheapest");
        // The request asks for the priciest model; the policy wins.
        const { status, text } = await postRespond(respondBody({}));
        assert.equal(status, 200);
        const event = startEvent(text);
        assert.equal(event.modelId, "venom-gemini");
        assert.deepEqual(event.selection, { policy: "auto-cheapest" });
      },
    );

    await t.test(
      "a billing-dead cheapest account switches the very next request",
      async () => {
        activeUserId = nextTestUser();
        await seedWorkspacePolicy(activeUserId, "auto-cheapest");
        reportVenomModelAccountHealth("venom-gemini", "unfunded");
        try {
          // No user action between requests: the policy replans per request,
          // so the pick moves to the next-cheapest healthy model (venom-grok
          // is unconfigured here, so venom-claude).
          const { status, text } = await postRespond(respondBody({}));
          assert.equal(status, 200);
          const event = startEvent(text);
          assert.equal(event.modelId, "venom-claude");
          assert.deepEqual(event.selection, { policy: "auto-cheapest" });
        } finally {
          resetVenomModelAccountHealthForTests();
        }
      },
    );

    await t.test(
      "auto-max-power anchors on the most capable model",
      async () => {
        activeUserId = nextTestUser();
        await seedWorkspacePolicy(activeUserId, "auto-max-power");
        const { status, text } = await postRespond(
          respondBody({ modelId: "venom-gemini" }),
        );
        assert.equal(status, 200);
        const event = startEvent(text);
        assert.equal(event.modelId, "venom-gpt");
        assert.deepEqual(event.selection, { policy: "auto-max-power" });
      },
    );

    await t.test(
      "manual keeps the request's model and adds no selection field",
      async () => {
        activeUserId = nextTestUser();
        await seedWorkspacePolicy(activeUserId, "manual");
        const { status, text } = await postRespond(
          respondBody({ modelId: "venom-claude" }),
        );
        assert.equal(status, 200);
        const event = startEvent(text);
        assert.equal(event.modelId, "venom-claude");
        assert.equal("selection" in event, false);
      },
    );

    await t.test(
      "no workspace snapshot at all behaves as manual",
      async () => {
        activeUserId = nextTestUser();
        const { status, text } = await postRespond(
          respondBody({ modelId: "venom-claude" }),
        );
        assert.equal(status, 200);
        const event = startEvent(text);
        assert.equal(event.modelId, "venom-claude");
        assert.equal("selection" in event, false);
      },
    );

    await t.test(
      "verify under auto sets explicit picks aside and keeps providers distinct",
      async () => {
        activeUserId = nextTestUser();
        await seedWorkspacePolicy(activeUserId, "auto-cheapest");
        // Manual mode rejects this same-model pairing with a 400 before any
        // stream; under an auto policy the picks are set aside instead.
        const { status, text } = await postRespond(
          respondBody({
            mode: "verify",
            voiceModels: [
              { voiceId: "direct", modelId: "venom-gpt" },
              { voiceId: "skeptic", modelId: "venom-gpt" },
            ],
          }),
        );
        assert.equal(status, 200);
        const event = startEvent(text) as {
          modelId?: string;
          selection?: unknown;
          deliberation?: {
            voices?: Array<{ voiceId: string; modelId: string }>;
          };
        };
        assert.equal(event.modelId, "venom-gemini");
        assert.deepEqual(event.selection, { policy: "auto-cheapest" });
        const voices = event.deliberation?.voices ?? [];
        assert.ok(voices.length >= 2, "the roster is planned");
        const byVoice = new Map(
          voices.map((voice) => [voice.voiceId, voice.modelId]),
        );
        // The anchor follows the policy, not the ignored explicit picks.
        assert.equal(byVoice.get("direct"), "venom-gemini");
        // Opposing voices still never share a provider.
        assert.notEqual(byVoice.get("skeptic"), byVoice.get("direct"));
      },
    );
  } finally {
    activeUserId = null;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await pool.end();
  }
});
