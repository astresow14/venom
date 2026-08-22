/**
 * Integration tests for the whitelabeled app AI gateway + owner controls.
 *
 * Uses an injected fake provider stream — never touches real model
 * providers. Covers:
 * - Credential auth: uniform 401s for missing/garbage/revoked tokens
 * - Non-stream completions with exact ledger metering and cost math
 * - SSE streaming: role/content/final frames, [DONE], streamed-usage rows
 * - Partial streams and provider billing errors (sanitized provider_account)
 * - Pause, owner cap, and safety cap — three distinct machine-readable codes
 * - Concurrency safety: parallel calls cannot stack past a cap (spend
 *   reservations), settlement participates in the spend lock so it cannot
 *   split a gate's aggregate reads, parallel rotations leave exactly one
 *   active credential, provider secret delivery is serialized with the
 *   credential lifecycle (a delayed stale delivery is skipped), and leaked
 *   reservations are reaped instead of wedging the app
 * - Per-credential rate limits answering 429
 * - Owner routes: overview, settings validation, rotate (with and without
 *   immediate provider delivery), revoke, cross-owner scoping
 * - Leak checks: no provider SKUs or credential secrets in any payload
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  db,
  venomAiLedgerEntriesTable,
  venomAppAiCredentialsTable,
  venomAppAiReservationsTable,
  venomPortfolioAppsTable,
  venomProvisioningRunsTable,
  type VenomAiLedgerEntry,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import express from "express";
import gatewayRouter, {
  overrideAppAiGatewayStreamForTests,
  resetAppAiGatewayRateLimitsForTests,
} from "./venom-app-ai-gateway.js";
import ownerRouter, {
  overrideVenomAppAiUserIdResolverForTests,
} from "./venom-app-ai.js";
import {
  deliverAppAiCredentialSerialized,
  insertAppAiLedgerEntry,
  lockAppScope,
  mintAppAiCredential,
  reserveAppAiSpend,
  revokeAppAiCredential,
  settleAppAiSpend,
  upsertAppAiSettings,
} from "../lib/venom-app-ai-store.js";
import {
  PROVIDER_ACCOUNT_ERROR_MESSAGE,
  ProviderError,
  type VenomMessage,
  type VenomStreamUsage,
} from "../lib/venom-provider-adapters.js";
import {
  reportVenomModelAccountHealth,
  resetVenomModelAccountHealthForTests,
} from "../lib/venom-models.js";
import {
  overrideProvisioningProviderForTests,
  type ProvisioningProvider,
} from "../lib/venom-provisioning-provider.js";
import { microsToUsd } from "../lib/venom-usage-pricing.js";

// Provider model SKUs and secret shapes that must NEVER appear in any
// gateway or owner payload.
const FORBIDDEN_STRINGS = [
  "gpt-5.6-terra",
  "claude-sonnet-4-6",
  "gemini-3-flash-preview",
  "x-ai/grok-4.6",
  "sk-INJECTED",
];
const SECRET_PATTERN = /vak_[0-9a-f]{40}/;

type TestResponse = {
  status: number;
  body: any;
  text: string;
  headers: Headers;
};

function assertStatus(response: TestResponse, expected: number): void {
  assert.equal(
    response.status,
    expected,
    `Expected HTTP ${expected}; received ${response.status}: ${response.text}`,
  );
}

/** data: frames of an SSE body, JSON-parsed except the [DONE] sentinel. */
function sseFrames(text: string): Array<any | "[DONE]"> {
  return text
    .split("\n\n")
    .filter((block) => block.startsWith("data: "))
    .map((block) => {
      const payload = block.slice("data: ".length);
      return payload === "[DONE]" ? "[DONE]" : JSON.parse(payload);
    });
}

test("app AI gateway: credentials, metering, caps, and owner controls", async () => {
  // The catalog only offers configured models; pin the OpenAI pair so
  // venom-gpt is available no matter which secrets this environment holds.
  // The fake stream guarantees no real call ever leaves the process.
  process.env.AI_INTEGRATIONS_OPENAI_BASE_URL ||= "https://dead-end.invalid";
  process.env.AI_INTEGRATIONS_OPENAI_API_KEY ||= "test-placeholder";

  const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
  const ownerA = `app-ai-a-${suffix}`;
  const ownerB = `app-ai-b-${suffix}`;

  let activeOwner: string | null = ownerA;
  const restoreAuth = overrideVenomAppAiUserIdResolverForTests(
    () => activeOwner,
  );

  let restoreStream: () => void = () => {};
  const streamCalls: Array<{ modelId: string; messages: VenomMessage[] }> = [];
  const setStream = (
    fn: (options?: { onUsage?: (usage: VenomStreamUsage) => void }) => {
      chunks: string[];
      usage: VenomStreamUsage | null;
      error?: unknown;
    },
  ): void => {
    restoreStream();
    restoreStream = overrideAppAiGatewayStreamForTests(
      async function* (modelId, messages, _signal, options) {
        streamCalls.push({ modelId, messages });
        const plan = fn(options);
        try {
          for (const chunk of plan.chunks) yield chunk;
          if (plan.error) throw plan.error;
        } finally {
          if (plan.usage) options?.onUsage?.(plan.usage);
        }
      },
    );
  };
  const setSimpleStream = (
    chunks: string[],
    usage: VenomStreamUsage | null,
    error?: unknown,
  ): void => setStream(() => ({ chunks, usage, error }));

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.log = {
      info: () => {},
      warn: () => {},
      error: () => {},
    } as unknown as typeof req.log;
    next();
  });
  app.use("/api/app-gateway", gatewayRouter);
  app.use("/api", ownerRouter);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const allPayloads: string[] = [];
  const request = async (
    path: string,
    options: RequestInit = {},
  ): Promise<TestResponse> => {
    const resp = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers: { "content-type": "application/json", ...options.headers },
    });
    const text = await resp.text();
    allPayloads.push(text);
    let body: any = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    return { status: resp.status, body, text, headers: resp.headers };
  };
  const chat = (
    token: string | null,
    payload: unknown,
  ): Promise<TestResponse> =>
    request("/api/app-gateway/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify(payload),
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });

  const ledgerFor = async (appId: string): Promise<VenomAiLedgerEntry[]> =>
    db
      .select()
      .from(venomAiLedgerEntriesTable)
      .where(eq(venomAiLedgerEntriesTable.appId, appId))
      .orderBy(venomAiLedgerEntriesTable.occurredAt);
  const waitForLedger = async (
    appId: string,
    count: number,
  ): Promise<VenomAiLedgerEntry[]> => {
    for (let i = 0; i < 60; i += 1) {
      const rows = await ledgerFor(appId);
      if (rows.length >= count) return rows;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`ledger for ${appId} never reached ${count} rows`);
  };

  const createApp = async (owner: string, name: string): Promise<string> => {
    const [row] = await db
      .insert(venomPortfolioAppsTable)
      .values({
        clerkUserId: owner,
        name,
        purpose: "AI gateway test app",
        brand: "Test",
        status: "ready",
        detectedStack: [],
        sourceType: "none",
        currentSourceVersion: 0,
      })
      .returning();
    return row.id;
  };

  let restoreProvider: (() => void) | null = null;
  const appIds: string[] = [];
  let provisioningRunId: string | null = null;

  try {
    // ── Setup: two apps for owner A, one for owner B ─────────────────────────
    const appA1 = await createApp(ownerA, "AI App One");
    const appA2 = await createApp(ownerA, "AI App Two");
    const appB1 = await createApp(ownerB, "Foreign AI App");
    appIds.push(appA1, appA2, appB1);

    const mintedA1 = await mintAppAiCredential(ownerA, appA1);
    const mintedA2 = await mintAppAiCredential(ownerA, appA2);
    await mintAppAiCredential(ownerB, appB1);
    const tokenA1 = mintedA1.secret;
    const tokenA2 = mintedA2.secret;
    assert.match(tokenA1, /^vak_[0-9a-f]{40}$/);
    assert.equal(mintedA1.credential.displayPrefix, tokenA1.slice(0, 12));

    setSimpleStream(["ok"], { promptTokens: 10, outputTokens: 10, estimated: false });

    // ── Uniform authentication failures ──────────────────────────────────────
    for (const header of [
      null,
      "vak_deadbeef",
      `vak_${"0".repeat(40)}`,
      "not-even-close",
      tokenA1.toUpperCase(),
    ]) {
      const resp = await request("/api/app-gateway/v1/models", {
        headers: header ? { authorization: `Bearer ${header}` } : {},
      });
      assertStatus(resp, 401);
      assert.equal(resp.body.error.code, "invalid_credential");
      assert.equal(resp.body.error.type, "authentication_error");
    }

    // ── Models list: aliases only ────────────────────────────────────────────
    const models = await request("/api/app-gateway/v1/models", {
      headers: { authorization: `Bearer ${tokenA1}` },
    });
    assertStatus(models, 200);
    const modelIds = models.body.data.map((m: { id: string }) => m.id);
    assert.deepEqual(
      [...modelIds].sort(),
      ["venom-claude", "venom-gemini", "venom-gpt", "venom-grok"],
    );

    // ── Non-stream completion: exact metering and cost math ──────────────────
    setSimpleStream(
      ["Hello ", "world"],
      { promptTokens: 1000, outputTokens: 500, estimated: false },
    );
    const completion = await chat(tokenA1, {
      model: "venom-gpt",
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "Say hello" },
      ],
      temperature: 0.7,
    });
    assertStatus(completion, 200);
    assert.match(completion.body.id, /^chatcmpl-/);
    assert.equal(completion.body.object, "chat.completion");
    assert.equal(completion.body.model, "venom-gpt");
    assert.equal(completion.body.choices[0].message.content, "Hello world");
    assert.equal(completion.body.choices[0].finish_reason, "stop");
    assert.deepEqual(completion.body.usage, {
      prompt_tokens: 1000,
      completion_tokens: 500,
      total_tokens: 1500,
    });
    const lastCall = streamCalls.at(-1);
    assert.equal(lastCall?.modelId, "venom-gpt");
    assert.equal(lastCall?.messages.length, 2);
    assert.equal(lastCall?.messages[0].role, "system");

    const [firstRow] = await waitForLedger(appA1, 1);
    assert.equal(firstRow.clerkUserId, ownerA);
    assert.equal(firstRow.credentialId, mintedA1.credential.id);
    assert.equal(firstRow.callKind, "chat_completion");
    assert.equal(firstRow.modelAlias, "venom-gpt");
    assert.equal(firstRow.promptTokens, 1000);
    assert.equal(firstRow.outputTokens, 500);
    assert.equal(firstRow.estimated, false);
    // venom-gpt prices at 1.25/10 micro-dollars per prompt/output token.
    assert.equal(firstRow.costMicros, 1000 * 1.25 + 500 * 10);

    // lastUsedAt is stamped fire-and-forget on authenticated use.
    let lastUsedSeen = false;
    for (let i = 0; i < 40 && !lastUsedSeen; i += 1) {
      const [row] = await db
        .select()
        .from(venomAppAiCredentialsTable)
        .where(eq(venomAppAiCredentialsTable.id, mintedA1.credential.id));
      lastUsedSeen = row.lastUsedAt !== null;
      if (!lastUsedSeen) await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(lastUsedSeen, "lastUsedAt must be stamped after gateway use");

    // ── Invalid requests ─────────────────────────────────────────────────────
    const badModel = await chat(tokenA1, {
      model: "gpt-4",
      messages: [{ role: "user", content: "hi" }],
    });
    assertStatus(badModel, 400);
    assert.equal(badModel.body.error.code, "invalid_model");
    // Provider SKUs are refused exactly like any unknown model.
    const skuModel = await chat(tokenA1, {
      model: "gpt-5.6-terra",
      messages: [{ role: "user", content: "hi" }],
    });
    assertStatus(skuModel, 400);
    assert.equal(skuModel.body.error.code, "invalid_model");
    const noMessages = await chat(tokenA1, { model: "venom-gpt", messages: [] });
    assertStatus(noMessages, 400);
    assert.equal(noMessages.body.error.code, "invalid_request");
    const badRole = await chat(tokenA1, {
      model: "venom-gpt",
      messages: [{ role: "tool", content: "hi" }],
    });
    assertStatus(badRole, 400);
    assert.equal(badRole.body.error.code, "invalid_request");

    // ── Streaming: frames, [DONE], and streamed-usage metering ───────────────
    setSimpleStream(
      ["He", "llo"],
      { promptTokens: 12, outputTokens: 34, estimated: false },
    );
    const streamResp = await chat(tokenA1, {
      model: "venom-gpt",
      messages: [{ role: "user", content: "stream it" }],
      stream: true,
    });
    assertStatus(streamResp, 200);
    assert.match(streamResp.headers.get("content-type") ?? "", /text\/event-stream/);
    const frames = sseFrames(streamResp.text);
    assert.equal(frames.at(-1), "[DONE]");
    const structured = frames.filter((f): f is any => f !== "[DONE]");
    assert.equal(structured[0].object, "chat.completion.chunk");
    assert.equal(structured[0].choices[0].delta.role, "assistant");
    const contentJoined = structured
      .map((f) => f.choices?.[0]?.delta?.content ?? "")
      .join("");
    assert.equal(contentJoined, "Hello");
    const finalFrame = structured.at(-1);
    assert.equal(finalFrame.choices[0].finish_reason, "stop");
    assert.deepEqual(finalFrame.usage, {
      prompt_tokens: 12,
      completion_tokens: 34,
      total_tokens: 46,
    });
    const rowsAfterStream = await waitForLedger(appA1, 2);
    const streamRow = rowsAfterStream.find((r) => r.promptTokens === 12);
    assert.ok(streamRow);
    assert.equal(streamRow.outputTokens, 34);
    assert.equal(streamRow.costMicros, Math.round(12 * 1.25 + 34 * 10));

    // ── Mid-stream provider billing failure: sanitized frame, partial meter ──
    setSimpleStream(
      ["Hi"],
      { promptTokens: 5, outputTokens: 2, estimated: true },
      new ProviderError(
        "upstream rejected key sk-INJECTED for model gpt-5.6-terra",
        402,
        false,
        "account_billing",
      ),
    );
    const brokenStream = await chat(tokenA1, {
      model: "venom-gpt",
      messages: [{ role: "user", content: "will break" }],
      stream: true,
    });
    assertStatus(brokenStream, 200);
    const brokenFrames = sseFrames(brokenStream.text);
    assert.equal(brokenFrames.at(-1), "[DONE]");
    const errorFrame = brokenFrames.find(
      (f): f is any => f !== "[DONE]" && f.error,
    );
    assert.ok(errorFrame, "mid-stream failure must emit an error frame");
    assert.equal(errorFrame.error.code, "provider_account");
    assert.equal(errorFrame.error.message, PROVIDER_ACCOUNT_ERROR_MESSAGE);
    assert.equal(errorFrame.error.retryable, false);
    const rowsAfterBreak = await waitForLedger(appA1, 3);
    const partialRow = rowsAfterBreak.find((r) => r.promptTokens === 5);
    assert.ok(partialRow, "partial streams must still be metered");
    assert.equal(partialRow.estimated, true);

    // ── Pre-stream billing failure (non-stream): sanitized 502 ──────────────
    setSimpleStream(
      [],
      null,
      new ProviderError("quota exceeded", 402, false, "account_billing"),
    );
    const billingFail = await chat(tokenA1, {
      model: "venom-gpt",
      messages: [{ role: "user", content: "hi" }],
    });
    assertStatus(billingFail, 502);
    assert.equal(billingFail.body.error.code, "provider_account");
    assert.equal(billingFail.body.error.message, PROVIDER_ACCOUNT_ERROR_MESSAGE);
    assert.equal(billingFail.body.error.retryable, false);
    assert.equal((await ledgerFor(appA1)).length, 3, "no tokens, no ledger row");

    // ── Known-unfunded account: fail fast without a provider call ───────────
    setSimpleStream(["ok"], { promptTokens: 10, outputTokens: 10, estimated: false });
    reportVenomModelAccountHealth("venom-gpt", "unfunded");
    const callsBefore = streamCalls.length;
    const unfunded = await chat(tokenA1, {
      model: "venom-gpt",
      messages: [{ role: "user", content: "hi" }],
    });
    assertStatus(unfunded, 502);
    assert.equal(unfunded.body.error.code, "provider_account");
    assert.equal(streamCalls.length, callsBefore, "unfunded must not call the provider");
    resetVenomModelAccountHealthForTests();

    // Push A1's month spend over one cent so the tiny caps below bind
    // (8000 prompt tokens at 1.25 micro-dollars each = $0.01).
    setSimpleStream(["big"], {
      promptTokens: 8000,
      outputTokens: 0,
      estimated: false,
    });
    const bigSpend = await chat(tokenA1, {
      model: "venom-gpt",
      messages: [{ role: "user", content: "big" }],
    });
    assertStatus(bigSpend, 200);
    await waitForLedger(appA1, 4);

    // ── Pause: distinct code, scoped to the paused app only ─────────────────
    const pauseResp = await request(`/api/venom/apps/${appA1}/ai/settings`, {
      method: "PUT",
      body: JSON.stringify({ paused: true, monthlyCapUsd: null }),
    });
    assertStatus(pauseResp, 200);
    assert.equal(pauseResp.body.paused, true);
    const pausedCall = await chat(tokenA1, {
      model: "venom-gpt",
      messages: [{ role: "user", content: "hi" }],
    });
    assertStatus(pausedCall, 403);
    assert.equal(pausedCall.body.error.code, "app_ai_paused");
    const siblingCall = await chat(tokenA2, {
      model: "venom-gpt",
      messages: [{ role: "user", content: "hi" }],
    });
    assertStatus(siblingCall, 200);
    await waitForLedger(appA2, 1);
    const unpause = await request(`/api/venom/apps/${appA1}/ai/settings`, {
      method: "PUT",
      body: JSON.stringify({ paused: false, monthlyCapUsd: null }),
    });
    assertStatus(unpause, 200);

    // ── Owner cap: distinct code; binds before the safety cap ───────────────
    const capResp = await request(`/api/venom/apps/${appA1}/ai/settings`, {
      method: "PUT",
      body: JSON.stringify({ paused: false, monthlyCapUsd: 0.01 }),
    });
    assertStatus(capResp, 200);
    assert.equal(capResp.body.monthlyCapUsd, 0.01);
    process.env.VENOM_APP_AI_SAFETY_CAP_USD = "0.001";
    const capped = await chat(tokenA1, {
      model: "venom-gpt",
      messages: [{ role: "user", content: "hi" }],
    });
    assertStatus(capped, 402);
    assert.equal(capped.body.error.code, "app_ai_cap_reached");
    assert.equal(capped.body.error.type, "quota_exceeded");

    // ── Safety cap: applies when the owner set no cap ────────────────────────
    const uncap = await request(`/api/venom/apps/${appA1}/ai/settings`, {
      method: "PUT",
      body: JSON.stringify({ paused: false, monthlyCapUsd: null }),
    });
    assertStatus(uncap, 200);
    const safetyCapped = await chat(tokenA1, {
      model: "venom-gpt",
      messages: [{ role: "user", content: "hi" }],
    });
    assertStatus(safetyCapped, 402);
    assert.equal(safetyCapped.body.error.code, "app_ai_safety_cap_reached");
    delete process.env.VENOM_APP_AI_SAFETY_CAP_USD;
    const backUnderCap = await chat(tokenA1, {
      model: "venom-gpt",
      messages: [{ role: "user", content: "hi" }],
    });
    assertStatus(backUnderCap, 200);
    await waitForLedger(appA1, 5);

    // ── Per-credential rate limit: 429 with Retry-After ─────────────────────
    process.env.VENOM_APP_AI_RATE_LIMIT_PER_MINUTE = "2";
    resetAppAiGatewayRateLimitsForTests();
    const rl1 = await chat(tokenA2, {
      model: "venom-gpt",
      messages: [{ role: "user", content: "1" }],
    });
    assertStatus(rl1, 200);
    const rl2 = await chat(tokenA2, {
      model: "venom-gpt",
      messages: [{ role: "user", content: "2" }],
    });
    assertStatus(rl2, 200);
    const rl3 = await chat(tokenA2, {
      model: "venom-gpt",
      messages: [{ role: "user", content: "3" }],
    });
    assertStatus(rl3, 429);
    assert.equal(rl3.body.error.code, "rate_limited");
    assert.ok(Number(rl3.headers.get("retry-after")) >= 1);
    // A different credential has its own bucket.
    const otherBucket = await chat(tokenA1, {
      model: "venom-gpt",
      messages: [{ role: "user", content: "4" }],
    });
    assertStatus(otherBucket, 200);
    delete process.env.VENOM_APP_AI_RATE_LIMIT_PER_MINUTE;
    resetAppAiGatewayRateLimitsForTests();

    // ── Owner overview: ledger-backed usage, dollars only ────────────────────
    const rowsA1 = await waitForLedger(appA1, 6);
    const rowsA2 = await waitForLedger(appA2, 3);
    const sum = (rows: VenomAiLedgerEntry[]): number =>
      rows.reduce((total, row) => total + row.costMicros, 0);
    const overview = await request(`/api/venom/apps/${appA1}/ai`);
    assertStatus(overview, 200);
    assert.equal(overview.body.appId, appA1);
    assert.equal(overview.body.paused, false);
    assert.equal(overview.body.monthlyCapUsd, null);
    assert.equal(overview.body.safetyCapUsd, 25);
    assert.equal(overview.body.usage.requests, rowsA1.length);
    assert.equal(overview.body.usage.costUsd, microsToUsd(sum(rowsA1)));
    assert.equal(
      overview.body.usage.promptTokens,
      rowsA1.reduce((t, r) => t + r.promptTokens, 0),
    );
    assert.equal(overview.body.usage.hasEstimates, true);
    assert.equal(overview.body.usage.models[0].modelId, "venom-gpt");
    assert.notEqual(overview.body.usage.models[0].modelName, "");
    assert.equal(
      overview.body.ownerMonthUsd,
      microsToUsd(sum(rowsA1) + sum(rowsA2)),
    );
    assert.equal(overview.body.credential.displayPrefix, tokenA1.slice(0, 12));
    assert.equal(overview.body.credential.delivered, false);

    // Scoping: a foreign owner sees 404, never the data.
    activeOwner = ownerB;
    assertStatus(await request(`/api/venom/apps/${appA1}/ai`), 404);
    assertStatus(await request(`/api/venom/apps/${appB1}/ai`), 200);
    activeOwner = null;
    assertStatus(await request(`/api/venom/apps/${appA1}/ai`), 401);
    activeOwner = ownerA;

    // Settings validation.
    for (const bad of [
      { paused: false, monthlyCapUsd: 0 },
      { paused: false, monthlyCapUsd: -3 },
      { paused: false, monthlyCapUsd: 250000 },
      { monthlyCapUsd: 5 },
      { paused: "yes", monthlyCapUsd: 5 },
    ]) {
      const resp = await request(`/api/venom/apps/${appA1}/ai/settings`, {
        method: "PUT",
        body: JSON.stringify(bad),
      });
      assertStatus(resp, 400);
    }

    // ── Rotate without a provider project: pending delivery, old token dead ──
    const rotateA1 = await request(
      `/api/venom/apps/${appA1}/ai/credential/rotate`,
      { method: "POST" },
    );
    assertStatus(rotateA1, 200);
    assert.notEqual(
      rotateA1.body.credential.displayPrefix,
      tokenA1.slice(0, 12),
    );
    assert.equal(rotateA1.body.credential.delivered, false);
    const oldToken = await chat(tokenA1, {
      model: "venom-gpt",
      messages: [{ role: "user", content: "hi" }],
    });
    assertStatus(oldToken, 401);
    const activeA1 = await db
      .select()
      .from(venomAppAiCredentialsTable)
      .where(eq(venomAppAiCredentialsTable.appId, appA1));
    assert.equal(activeA1.filter((c) => c.status === "active").length, 1);

    // ── Rotate with immediate provider delivery ──────────────────────────────
    const [provRun] = await db
      .insert(venomProvisioningRunsTable)
      .values({
        clerkUserId: ownerA,
        buildRunId: randomUUID(),
        approvedRevisionId: randomUUID(),
        appId: appA2,
        idempotencyKey: `app_ai_${suffix}`,
        targetName: "AI App Two",
        status: "candidate_ready",
        providerProjectId: "proj-ai-rotate",
      })
      .returning();
    provisioningRunId = provRun.id;

    const deliveries: Array<{
      providerProjectId: string;
      envVars: Record<string, string>;
    }> = [];
    restoreProvider = overrideProvisioningProviderForTests({
      deliverRuntimeCredentials: async (opts: {
        providerProjectId: string;
        credentials: { envVars: Record<string, string> };
      }) => {
        deliveries.push({
          providerProjectId: opts.providerProjectId,
          envVars: opts.credentials.envVars,
        });
      },
    } as unknown as ProvisioningProvider);

    const rotateA2 = await request(
      `/api/venom/apps/${appA2}/ai/credential/rotate`,
      { method: "POST" },
    );
    assertStatus(rotateA2, 200);
    assert.equal(rotateA2.body.credential.delivered, true);
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].providerProjectId, "proj-ai-rotate");
    const deliveredKey = deliveries[0].envVars.VENOM_AI_GATEWAY_KEY;
    assert.match(deliveredKey, /^vak_[0-9a-f]{40}$/);
    assert.ok(
      deliveries[0].envVars.VENOM_AI_GATEWAY_URL.endsWith("/api/app-gateway/v1"),
    );
    assert.equal(
      rotateA2.body.credential.displayPrefix,
      deliveredKey.slice(0, 12),
    );
    // The delivered secret is live at the gateway...
    const deliveredCall = await chat(deliveredKey, {
      model: "venom-gpt",
      messages: [{ role: "user", content: "hi" }],
    });
    assertStatus(deliveredCall, 200);
    // ...and the pre-rotation token is dead.
    const oldA2 = await chat(tokenA2, {
      model: "venom-gpt",
      messages: [{ role: "user", content: "hi" }],
    });
    assertStatus(oldA2, 401);

    // ── Revoke: server-side kill switch ──────────────────────────────────────
    const revokeA2 = await request(
      `/api/venom/apps/${appA2}/ai/credential/revoke`,
      { method: "POST" },
    );
    assertStatus(revokeA2, 200);
    assert.equal(revokeA2.body.credential, null);
    const revokedCall = await chat(deliveredKey, {
      model: "venom-gpt",
      messages: [{ role: "user", content: "hi" }],
    });
    assertStatus(revokedCall, 401);
    // Idempotent.
    assertStatus(
      await request(`/api/venom/apps/${appA2}/ai/credential/revoke`, {
        method: "POST",
      }),
      200,
    );

    // ── Leak sweep: every payload this test ever received ───────────────────
    for (const payload of allPayloads) {
      for (const forbidden of FORBIDDEN_STRINGS) {
        assert.equal(
          payload.includes(forbidden),
          false,
          `provider identifier "${forbidden}" leaked into a payload`,
        );
      }
      assert.equal(
        SECRET_PATTERN.test(payload),
        false,
        "a credential secret leaked into a payload",
      );
    }
  } finally {
    restoreStream();
    restoreProvider?.();
    restoreAuth();
    resetVenomModelAccountHealthForTests();
    resetAppAiGatewayRateLimitsForTests();
    delete process.env.VENOM_APP_AI_SAFETY_CAP_USD;
    delete process.env.VENOM_APP_AI_RATE_LIMIT_PER_MINUTE;
    server.close();
    if (appIds.length > 0) {
      await db
        .delete(venomAiLedgerEntriesTable)
        .where(inArray(venomAiLedgerEntriesTable.appId, appIds));
      await db
        .delete(venomPortfolioAppsTable)
        .where(inArray(venomPortfolioAppsTable.id, appIds));
    }
    if (provisioningRunId) {
      await db
        .delete(venomProvisioningRunsTable)
        .where(eq(venomProvisioningRunsTable.id, provisioningRunId));
    }
  }
});

test("app AI credential rotation is serialized: concurrent mints leave one active credential", async () => {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
  const owner = `app-ai-race-${suffix}`;
  const [appRow] = await db
    .insert(venomPortfolioAppsTable)
    .values({
      clerkUserId: owner,
      name: "Race App",
      purpose: "Credential race test",
      brand: "Test",
      status: "ready",
      detectedStack: [],
      sourceType: "none",
      currentSourceVersion: 0,
    })
    .returning();
  try {
    const minted = await Promise.all([
      mintAppAiCredential(owner, appRow.id),
      mintAppAiCredential(owner, appRow.id),
      mintAppAiCredential(owner, appRow.id),
    ]);
    const rows = await db
      .select()
      .from(venomAppAiCredentialsTable)
      .where(eq(venomAppAiCredentialsTable.appId, appRow.id));
    assert.equal(rows.length, 3, "every racing mint must complete");
    const active = rows.filter((row) => row.status === "active");
    assert.equal(active.length, 1, "exactly one credential may stay active");
    // The survivor is one of the minted results, so its plaintext was
    // actually returned to a caller (not a half-committed orphan).
    assert.ok(minted.some((m) => m.credential.id === active[0]!.id));
  } finally {
    await db
      .delete(venomPortfolioAppsTable)
      .where(eq(venomPortfolioAppsTable.id, appRow.id));
  }
});

test("app AI spend gate is concurrency-safe: parallel calls cannot stack past the cap", async () => {
  process.env.AI_INTEGRATIONS_OPENAI_BASE_URL ||= "https://dead-end.invalid";
  process.env.AI_INTEGRATIONS_OPENAI_API_KEY ||= "test-placeholder";
  const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
  const owner = `app-ai-conc-${suffix}`;
  const [appRow] = await db
    .insert(venomPortfolioAppsTable)
    .values({
      clerkUserId: owner,
      name: "Concurrency App",
      purpose: "Cap race test",
      brand: "Test",
      status: "ready",
      detectedStack: [],
      sourceType: "none",
      currentSourceVersion: 0,
    })
    .returning();
  const appId = appRow.id;

  let providerCalls = 0;
  const restoreStream = overrideAppAiGatewayStreamForTests(
    async function* (_modelId, _messages, _signal, options) {
      providerCalls += 1;
      // Slow stream keeps both requests in flight together, so the second
      // gate decision happens while the first call is still unsettled.
      await new Promise((resolve) => setTimeout(resolve, 300));
      yield "ok";
      options?.onUsage?.({ promptTokens: 100, outputTokens: 10, estimated: false });
    },
  );

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.log = {
      info: () => {},
      warn: () => {},
      error: () => {},
    } as unknown as typeof req.log;
    next();
  });
  app.use("/api/app-gateway", gatewayRouter);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    const minted = await mintAppAiCredential(owner, appId);
    // The cap fits exactly one default-ceiling priced reservation (~$0.041:
    // prompt bound + 4096 output tokens at venom-gpt rates): the first
    // admitted call's open reservation must make the second refuse BEFORE
    // any provider dispatch, even though nothing has settled yet. Under a
    // read-spend-then-call gate both would have passed.
    await upsertAppAiSettings(owner, appId, {
      monthlyCapMicros: 50_000,
      paused: false,
    });
    const call = async (): Promise<{ status: number; body: any }> => {
      const resp = await fetch(
        `${baseUrl}/api/app-gateway/v1/chat/completions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${minted.secret}`,
          },
          body: JSON.stringify({
            model: "venom-gpt",
            messages: [{ role: "user", content: "hi" }],
          }),
        },
      );
      const text = await resp.text();
      return { status: resp.status, body: text ? JSON.parse(text) : null };
    };
    const [first, second] = await Promise.all([call(), call()]);
    assert.deepEqual(
      [first.status, second.status].sort((a, b) => a - b),
      [200, 402],
      "exactly one of two parallel calls may pass a one-reservation cap",
    );
    const refused = first.status === 402 ? first : second;
    assert.equal(refused.body.error.code, "app_ai_cap_reached");
    assert.equal(
      providerCalls,
      1,
      "the refused call must never reach the provider",
    );

    // Settlement releases the reservation in the same transaction that
    // writes the ledger row: eventually zero open reservations, one row.
    let open: Array<{ id: string }> = [];
    for (let i = 0; i < 60; i += 1) {
      open = await db
        .select({ id: venomAppAiReservationsTable.id })
        .from(venomAppAiReservationsTable)
        .where(eq(venomAppAiReservationsTable.appId, appId));
      if (open.length === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(open.length, 0, "settlement must release the reservation");
    const rows = await db
      .select()
      .from(venomAiLedgerEntriesTable)
      .where(eq(venomAiLedgerEntriesTable.appId, appId));
    assert.equal(rows.length, 1, "exactly the admitted call is metered");
    assert.equal(rows[0]!.costMicros, Math.round(100 * 1.25 + 10 * 10));
  } finally {
    restoreStream();
    server.close();
    await db
      .delete(venomAiLedgerEntriesTable)
      .where(eq(venomAiLedgerEntriesTable.appId, appId));
    await db
      .delete(venomPortfolioAppsTable)
      .where(eq(venomPortfolioAppsTable.id, appId));
  }
});

test("app AI reservations are priced per request: bounded calls fit where unbounded ones are refused", async () => {
  process.env.AI_INTEGRATIONS_OPENAI_BASE_URL ||= "https://dead-end.invalid";
  process.env.AI_INTEGRATIONS_OPENAI_API_KEY ||= "test-placeholder";
  const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
  const owner = `app-ai-bound-${suffix}`;
  const [appRow] = await db
    .insert(venomPortfolioAppsTable)
    .values({
      clerkUserId: owner,
      name: "Priced Bound App",
      purpose: "Reservation pricing test",
      brand: "Test",
      status: "ready",
      detectedStack: [],
      sourceType: "none",
      currentSourceVersion: 0,
    })
    .returning();
  const appId = appRow.id;

  let providerCalls = 0;
  const ceilings: Array<number | undefined> = [];
  const restoreStream = overrideAppAiGatewayStreamForTests(
    async function* (_modelId, _messages, _signal, options) {
      providerCalls += 1;
      ceilings.push(options?.maxOutputTokens);
      yield "ok";
      options?.onUsage?.({ promptTokens: 100, outputTokens: 10, estimated: false });
    },
  );

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.log = {
      info: () => {},
      warn: () => {},
      error: () => {},
    } as unknown as typeof req.log;
    next();
  });
  app.use("/api/app-gateway", gatewayRouter);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    const minted = await mintAppAiCredential(owner, appId);
    const chatWith = async (
      body: Record<string, unknown>,
    ): Promise<{ status: number; body: any }> => {
      const resp = await fetch(
        `${baseUrl}/api/app-gateway/v1/chat/completions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${minted.secret}`,
          },
          body: JSON.stringify(body),
        },
      );
      const text = await resp.text();
      return { status: resp.status, body: text ? JSON.parse(text) : null };
    };
    const waitForLedgerRows = async (expected: number): Promise<void> => {
      let count = 0;
      for (let i = 0; i < 60; i += 1) {
        const rows = await db
          .select({ id: venomAiLedgerEntriesTable.id })
          .from(venomAiLedgerEntriesTable)
          .where(eq(venomAiLedgerEntriesTable.appId, appId));
        count = rows.length;
        if (count >= expected) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(count, expected);
    };

    // Capless call: the default output ceiling reaches the provider.
    const free = await chatWith({
      model: "venom-gpt",
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(free.status, 200);
    await waitForLedgerRows(1); // settled: 225 micros
    assert.deepEqual(ceilings, [4096]);

    // $0.01 cap: an unbounded request's priced bound (~$0.041) cannot fit
    // the headroom — refused up front, before any provider dispatch.
    await upsertAppAiSettings(owner, appId, {
      monthlyCapMicros: 10_000,
      paused: false,
    });
    const unbounded = await chatWith({
      model: "venom-gpt",
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(unbounded.status, 402);
    assert.equal(unbounded.body.error.code, "app_ai_cap_reached");
    assert.equal(
      providerCalls,
      1,
      "a refused request must never reach the provider",
    );

    // The same request bounded by max_tokens fits, and the requested
    // ceiling — not the default — is what reaches the provider.
    const bounded = await chatWith({
      model: "venom-gpt",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 50,
    });
    assert.equal(bounded.status, 200);
    await waitForLedgerRows(2); // settled: 450 micros
    assert.deepEqual(ceilings, [4096, 50]);

    // Near-cap: remaining headroom must cover the WHOLE bound. With 450
    // settled under a 1600 cap the floored bound (1000) fits exactly once:
    // 450+1000 ≤ 1600 admits, then 675+1000 > 1600 refuses.
    await upsertAppAiSettings(owner, appId, {
      monthlyCapMicros: 1_600,
      paused: false,
    });
    const nearFit = await chatWith({
      model: "venom-gpt",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 50,
    });
    assert.equal(nearFit.status, 200);
    await waitForLedgerRows(3); // settled: 675 micros
    const overflow = await chatWith({
      model: "venom-gpt",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 50,
    });
    assert.equal(overflow.status, 402);
    assert.equal(overflow.body.error.code, "app_ai_cap_reached");

    // Oversized ceilings are rejected as invalid, never silently clamped.
    const oversized = await chatWith({
      model: "venom-gpt",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 9000,
    });
    assert.equal(oversized.status, 400);
    assert.equal(oversized.body.error.code, "invalid_request");
    assert.equal(providerCalls, 3);
  } finally {
    restoreStream();
    server.close();
    await db
      .delete(venomAiLedgerEntriesTable)
      .where(eq(venomAiLedgerEntriesTable.appId, appId));
    await db
      .delete(venomPortfolioAppsTable)
      .where(eq(venomPortfolioAppsTable.id, appId));
  }
});

test("credential revoke serializes with rotation: the revoked credential dies in every interleaving", async () => {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
  const owner = `app-ai-revoke-${suffix}`;
  const [appRow] = await db
    .insert(venomPortfolioAppsTable)
    .values({
      clerkUserId: owner,
      name: "Revoke Race App",
      purpose: "Revoke/rotate serialization test",
      brand: "Test",
      status: "ready",
      detectedStack: [],
      sourceType: "none",
      currentSourceVersion: 0,
    })
    .returning();
  try {
    for (let round = 0; round < 6; round += 1) {
      const baseline = await mintAppAiCredential(owner, appRow.id);
      const [, rotated] = await Promise.all([
        revokeAppAiCredential(owner, appRow.id),
        mintAppAiCredential(owner, appRow.id),
      ]);
      const rows = await db
        .select()
        .from(venomAppAiCredentialsTable)
        .where(eq(venomAppAiCredentialsTable.appId, appRow.id));
      const baselineRow = rows.find((row) => row.id === baseline.credential.id);
      // Whichever order the lock granted, the credential that was active
      // when the owner pressed revoke must never survive: either revoke
      // killed it directly, or the rotation's revoke-then-mint retired it
      // before the revoke ran against the rotation's replacement.
      assert.equal(baselineRow?.status, "revoked");
      const active = rows.filter((row) => row.status === "active");
      assert.ok(active.length <= 1, "two live credentials must be impossible");
      if (active.length === 1) {
        assert.equal(
          active[0]!.id,
          rotated.credential.id,
          "only the racing rotation's credential may survive",
        );
      }
    }
  } finally {
    await db
      .delete(venomPortfolioAppsTable)
      .where(eq(venomPortfolioAppsTable.id, appRow.id));
  }
});

test("leaked app AI reservations are reaped; live ones still bind the cap", async () => {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
  const owner = `app-ai-stale-${suffix}`;
  const [appRow] = await db
    .insert(venomPortfolioAppsTable)
    .values({
      clerkUserId: owner,
      name: "Stale Reservation App",
      purpose: "Reservation reap test",
      brand: "Test",
      status: "ready",
      detectedStack: [],
      sourceType: "none",
      currentSourceVersion: 0,
    })
    .returning();
  try {
    await upsertAppAiSettings(owner, appRow.id, {
      monthlyCapMicros: 50_000,
      paused: false,
    });
    // A reservation aged past the reap threshold (crashed process, failed
    // settlement) would consume the whole cap if it still counted.
    const [stale] = await db
      .insert(venomAppAiReservationsTable)
      .values({
        appId: appRow.id,
        clerkUserId: owner,
        amountMicros: 50_000,
        createdAt: new Date(Date.now() - 11 * 60 * 1000),
      })
      .returning();
    const gate = await reserveAppAiSpend(owner, appRow.id, 50_000);
    assert.ok(gate.allowed, "a leaked reservation must not wedge the app");
    const open = await db
      .select()
      .from(venomAppAiReservationsTable)
      .where(eq(venomAppAiReservationsTable.appId, appRow.id));
    assert.equal(open.length, 1, "the stale reservation is reaped");
    assert.notEqual(open[0]!.id, stale!.id);
    // A LIVE reservation does bind: the same cap now refuses admission.
    const blocked = await reserveAppAiSpend(owner, appRow.id, 50_000);
    assert.ok(
      !blocked.allowed && blocked.code === "app_ai_cap_reached",
      "a live reservation must count against the cap",
    );
    await settleAppAiSpend(appRow.id, gate.reservationId, null);
    const afterSettle = await db
      .select()
      .from(venomAppAiReservationsTable)
      .where(eq(venomAppAiReservationsTable.appId, appRow.id));
    assert.equal(afterSettle.length, 0);
  } finally {
    await db
      .delete(venomPortfolioAppsTable)
      .where(eq(venomPortfolioAppsTable.id, appRow.id));
  }
});

test("app AI ledger insert clamps and prices unknown aliases at zero", async () => {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
  const owner = `app-ai-clamp-${suffix}`;
  const [app] = await db
    .insert(venomPortfolioAppsTable)
    .values({
      clerkUserId: owner,
      name: "Clamp App",
      purpose: "Ledger clamp test",
      brand: "Test",
      status: "ready",
      detectedStack: [],
      sourceType: "none",
      currentSourceVersion: 0,
    })
    .returning();
  try {
    await insertAppAiLedgerEntry({
      userId: owner,
      appId: app.id,
      credentialId: randomUUID(),
      modelAlias: "venom-gpt",
      promptTokens: -5,
      outputTokens: 10.6,
      estimated: true,
    });
    const [row] = await db
      .select()
      .from(venomAiLedgerEntriesTable)
      .where(eq(venomAiLedgerEntriesTable.appId, app.id));
    assert.equal(row.promptTokens, 0);
    assert.equal(row.outputTokens, 11);
    assert.equal(row.costMicros, Math.round(11 * 10));
    assert.equal(row.estimated, true);
  } finally {
    await db
      .delete(venomAiLedgerEntriesTable)
      .where(eq(venomAiLedgerEntriesTable.appId, app.id));
    await db
      .delete(venomPortfolioAppsTable)
      .where(eq(venomPortfolioAppsTable.id, app.id));
  }
});

test("settlement participates in the spend lock: a held gate cannot be split by a settling call", async () => {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
  const owner = `app-ai-fence-${suffix}`;
  const [appRow] = await db
    .insert(venomPortfolioAppsTable)
    .values({
      clerkUserId: owner,
      name: "Settlement Fence App",
      purpose: "Settlement lock fence test",
      brand: "Test",
      status: "ready",
      detectedStack: [],
      sourceType: "none",
      currentSourceVersion: 0,
    })
    .returning();
  try {
    const gate = await reserveAppAiSpend(owner, appRow.id, 1_000);
    assert.ok(gate.allowed);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let lockAcquired!: () => void;
    const acquired = new Promise<void>((resolve) => {
      lockAcquired = resolve;
    });
    const holding = db.transaction(async (tx) => {
      await lockAppScope(tx, "spend", appRow.id);
      lockAcquired();
      await held;
    });
    await acquired;
    // Fire the settlement while another transaction holds the spend lock —
    // exactly the position a gate is in between its two aggregate reads. An
    // unlocked settlement would land here and desync what the gate counts.
    const settling = settleAppAiSpend(appRow.id, gate.reservationId, {
      userId: owner,
      appId: appRow.id,
      credentialId: randomUUID(),
      modelAlias: "venom-gpt",
      promptTokens: 100,
      outputTokens: 10,
      estimated: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    const midReservations = await db
      .select()
      .from(venomAppAiReservationsTable)
      .where(eq(venomAppAiReservationsTable.appId, appRow.id));
    assert.equal(
      midReservations.length,
      1,
      "settlement must wait for the spend lock before touching the reservation",
    );
    const midLedger = await db
      .select()
      .from(venomAiLedgerEntriesTable)
      .where(eq(venomAiLedgerEntriesTable.appId, appRow.id));
    assert.equal(
      midLedger.length,
      0,
      "no ledger row may appear while the spend lock is held elsewhere",
    );
    release();
    await holding;
    await settling;
    const afterReservations = await db
      .select()
      .from(venomAppAiReservationsTable)
      .where(eq(venomAppAiReservationsTable.appId, appRow.id));
    assert.equal(afterReservations.length, 0);
    const afterLedger = await db
      .select()
      .from(venomAiLedgerEntriesTable)
      .where(eq(venomAiLedgerEntriesTable.appId, appRow.id));
    assert.equal(afterLedger.length, 1, "the settlement applies once the lock frees");
  } finally {
    await db
      .delete(venomPortfolioAppsTable)
      .where(eq(venomPortfolioAppsTable.id, appRow.id));
  }
});

test("adversarial gate/settle interleaving never admits spend past the cap", async () => {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
  const owner = `app-ai-adversarial-${suffix}`;
  const [appRow] = await db
    .insert(venomPortfolioAppsTable)
    .values({
      clerkUserId: owner,
      name: "Adversarial Cap App",
      purpose: "Gate/settle interleaving test",
      brand: "Test",
      status: "ready",
      detectedStack: [],
      sourceType: "none",
      currentSourceVersion: 0,
    })
    .returning();
  try {
    // Cap fits exactly three 1000-micro calls; settled cost equals the
    // reservation (100 output tokens x 10 micro-dollars), so headroom never
    // regrows and any split-read admission would push the total past the cap.
    await upsertAppAiSettings(owner, appRow.id, {
      monthlyCapMicros: 3_000,
      paused: false,
    });
    let admitted = 0;
    const worker = async (): Promise<void> => {
      for (let i = 0; i < 3; i += 1) {
        const gate = await reserveAppAiSpend(owner, appRow.id, 1_000);
        if (gate.allowed) {
          admitted += 1;
          await settleAppAiSpend(appRow.id, gate.reservationId, {
            userId: owner,
            appId: appRow.id,
            credentialId: randomUUID(),
            modelAlias: "venom-gpt",
            promptTokens: 0,
            outputTokens: 100,
            estimated: false,
          });
        }
      }
    };
    await Promise.all(Array.from({ length: 6 }, () => worker()));
    const rows = await db
      .select()
      .from(venomAiLedgerEntriesTable)
      .where(eq(venomAiLedgerEntriesTable.appId, appRow.id));
    const total = rows.reduce((sum, row) => sum + row.costMicros, 0);
    assert.equal(rows.length, admitted, "every admitted call settles exactly one row");
    assert.ok(
      total <= 3_000,
      `settled spend ${total} must never exceed the 3000-micro cap`,
    );
    assert.equal(rows.length, 3, "the cap admits exactly cap/bound calls");
    const openReservations = await db
      .select()
      .from(venomAppAiReservationsTable)
      .where(eq(venomAppAiReservationsTable.appId, appRow.id));
    assert.equal(openReservations.length, 0);
  } finally {
    await db
      .delete(venomPortfolioAppsTable)
      .where(eq(venomPortfolioAppsTable.id, appRow.id));
  }
});

test("delayed credential delivery cannot supersede the newer active key", async () => {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
  const owner = `app-ai-delivery-${suffix}`;
  const [appRow] = await db
    .insert(venomPortfolioAppsTable)
    .values({
      clerkUserId: owner,
      name: "Delivery Order App",
      purpose: "Serialized delivery test",
      brand: "Test",
      status: "ready",
      detectedStack: [],
      sourceType: "none",
      currentSourceVersion: 0,
    })
    .returning();
  try {
    const first = await mintAppAiCredential(owner, appRow.id);
    const writes: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let deliveryStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      deliveryStarted = resolve;
    });
    // In-flight delivery of the current credential holds the lifecycle lock.
    const deliveringFirst = deliverAppAiCredentialSerialized(
      appRow.id,
      first.credential.id,
      "proj-fence",
      async () => {
        deliveryStarted();
        await firstGate;
        writes.push("first");
      },
    );
    await started;
    let rotationSettled = false;
    const rotating = mintAppAiCredential(owner, appRow.id).then((minted) => {
      rotationSettled = true;
      return minted;
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(
      rotationSettled,
      false,
      "a rotation must wait for the in-flight delivery to finish",
    );
    releaseFirst();
    assert.deepEqual(await deliveringFirst, { delivered: true });
    const second = await rotating;
    // The old credential's delivery arriving AFTER the rotation must skip:
    // its credential is superseded, and writing it would hand the deployed
    // app a revoked key.
    const stale = await deliverAppAiCredentialSerialized(
      appRow.id,
      first.credential.id,
      "proj-fence",
      async () => {
        writes.push("stale-first");
      },
    );
    assert.deepEqual(stale, { delivered: false, reason: "superseded" });
    const current = await deliverAppAiCredentialSerialized(
      appRow.id,
      second.credential.id,
      "proj-fence",
      async () => {
        writes.push("second");
      },
    );
    assert.deepEqual(current, { delivered: true });
    assert.deepEqual(
      writes,
      ["first", "second"],
      "the provider's last secret write always belongs to the newest credential",
    );
    const credentials = await db
      .select()
      .from(venomAppAiCredentialsTable)
      .where(eq(venomAppAiCredentialsTable.appId, appRow.id));
    const active = credentials.find((row) => row.status === "active");
    assert.equal(active?.id, second.credential.id);
    assert.ok(active?.deliveredAt, "the delivered stamp rides the guarded write");
    assert.equal(active?.deliveredProviderProjectId, "proj-fence");
  } finally {
    await db
      .delete(venomPortfolioAppsTable)
      .where(eq(venomPortfolioAppsTable.id, appRow.id));
  }
});
