/**
 * venom-billing.integration.test.ts — subscription billing end to end:
 * plan configuration, webhook state transitions, payer resolution from the
 * space a conversation lives in, allowance enforcement edges, the personal
 * summary's exclusion of workspace-billed spend, and the billing router's
 * personal + workspace endpoints (admin vs member shapes, Stripe-hosted
 * page bootstrap, keyless "not set up" behavior).
 *
 * Stripe never sees network traffic here: the client and the webhook
 * signature verifier both go through test seams. The database is the
 * shared dev database; every row this suite writes carries a run-scoped
 * id and is deleted afterwards.
 *
 * Run: pnpm --filter @workspace/api-server run test:billing
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test, { after } from "node:test";
import express from "express";
import pino from "pino";
import pinoHttp from "pino-http";
import { and, eq, inArray, like, lt } from "drizzle-orm";
import type Stripe from "stripe";
import {
  db,
  pool,
  venomAllowanceReservationsTable,
  venomBillingAccountsTable,
  venomSharedWorkspacesTable,
  venomUsageEvents,
} from "@workspace/db";

import {
  approachingWarnRatio,
  planAllowanceMicros,
  venomPlan,
} from "../lib/venom-billing-plans";
import {
  applyStripeEvent,
  applySubscriptionState,
  billingPeriodFor,
  effectivePersonalPlanId,
  getBillingAccount,
  statusKeepsBenefits,
  workspaceOrgPlanActive,
} from "../lib/venom-billing-store";
import {
  allowanceBlockedBody,
  billingEnforcementActive,
  checkVenomAllowance,
  releaseVenomAllowanceReservation,
  requestBoundMicros,
  resolveVenomPayer,
  sumBilledMicros,
} from "../lib/venom-billing-enforcement";
import {
  overrideStripeWebhookVerifierForTests,
  overrideVenomStripeForTests,
  stripeConfigured,
  type VenomStripeClient,
} from "../lib/venom-stripe";
import {
  BOUND_CHARS_PER_TOKEN,
  computeCostMicros,
  maxCatalogCostMicros,
  PROVIDER_MAX_OUTPUT_TOKENS,
  PROVIDER_MAX_PROMPT_CHARS,
} from "../lib/venom-usage-pricing";
import {
  PromptTooLargeError,
  streamVenomResponse,
} from "../lib/venom-provider-adapters";
import {
  insertVenomUsage,
  loadVenomUsageSummary,
  venomAllowanceLockSql,
} from "../lib/venom-usage-store";
import type { SharedWorkspaceMembership } from "../lib/workspace-membership";
import venomRouter from "./venom";
import {
  createVenomBillingRouter,
  handleStripeWebhook,
} from "./venom-billing-router";

// Billing reads env lazily, so scrub anything the host process might carry
// before the first test runs. This suite always starts keyless.
delete process.env.STRIPE_SECRET_KEY;
delete process.env.STRIPE_WEBHOOK_SECRET;
delete process.env.VENOM_BILLING_ENFORCE;
delete process.env.VENOM_PLAN_FREE_ALLOWANCE_USD;
delete process.env.VENOM_PLAN_PLUS_NAME;
delete process.env.VENOM_BILLING_WARN_RATIO;
// Return-URL allowlisting reads the deployment's own origins; pin them so
// fallback assertions stay deterministic in any environment.
process.env.REPLIT_DOMAINS = "venom-first-party.example";
delete process.env.REPLIT_DEV_DOMAIN;

const RUN = `bill-${randomUUID().slice(0, 8)}`;
const trackedWorkspaceIds: string[] = [];
const trackedScopeIds: string[] = [];

function newWorkspaceId(): string {
  const id = randomUUID();
  trackedWorkspaceIds.push(id);
  trackedScopeIds.push(id);
  return id;
}

function newUserId(tag: string): string {
  const id = `${RUN}-${tag}`;
  trackedScopeIds.push(id);
  return id;
}

const NOW = new Date();
const PERIOD_START = new Date(NOW.getTime() - 5 * 24 * 60 * 60 * 1000);
const PERIOD_END = new Date(NOW.getTime() + 25 * 24 * 60 * 60 * 1000);

/** Seed a billing account row directly (webhook-equivalent state). */
async function seedAccount(input: {
  scopeType: "user" | "workspace";
  scopeId: string;
  planId: "free" | "plus" | "org";
  status: string;
  customerId?: string | null;
  subscriptionId?: string | null;
  periodStart?: Date | null;
  periodEnd?: Date | null;
  cancelAtPeriodEnd?: boolean;
}): Promise<void> {
  await applySubscriptionState({
    scopeType: input.scopeType,
    scopeId: input.scopeId,
    planId: input.planId,
    status: input.status,
    stripeCustomerId: input.customerId ?? null,
    stripeSubscriptionId: input.subscriptionId ?? null,
    currentPeriodStart: input.periodStart ?? PERIOD_START,
    currentPeriodEnd: input.periodEnd ?? PERIOD_END,
    cancelAtPeriodEnd: input.cancelAtPeriodEnd ?? false,
  });
}

async function seedWorkspaceRow(id: string, name: string): Promise<void> {
  await db
    .insert(venomSharedWorkspacesTable)
    .values({ id, name, createdByClerkUserId: `${RUN}-creator` })
    .onConflictDoNothing();
}

async function spend(input: {
  userId: string;
  costMicros: number;
  billedWorkspaceId?: string | null;
  occurredAt?: Date;
}): Promise<void> {
  await insertVenomUsage({
    userId: input.userId,
    modelAlias: "venom-gpt",
    callKind: "chat",
    promptTokens: 10,
    outputTokens: 10,
    estimated: false,
    costMicros: input.costMicros,
    billedWorkspaceId: input.billedWorkspaceId ?? null,
    occurredAt: input.occurredAt ?? NOW,
  });
}

// ─── HTTP harnesses ──────────────────────────────────────────────────────────

type TestServer = { server: Server; base: string };

function listen(app: express.Express): Promise<TestServer> {
  return new Promise((resolve) => {
    const server = createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

function closeServer(handle: TestServer): Promise<void> {
  return new Promise((resolve) => {
    handle.server.closeAllConnections?.();
    handle.server.close(() => resolve());
  });
}

async function call(
  base: string,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

function postJson(payload: unknown, headers?: Record<string, string>) {
  return {
    method: "POST",
    headers: { "content-type": "application/json", ...(headers ?? {}) },
    body: JSON.stringify(payload),
  } satisfies RequestInit;
}

/** Router app with injectable auth + membership seams. */
function makeRouterApp(state: {
  userId: () => string | null;
  memberships: Map<string, SharedWorkspaceMembership>;
}) {
  const app = express();
  app.use(pinoHttp({ logger: pino({ level: "silent" }) }));
  app.use(express.json());
  app.use(
    createVenomBillingRouter({
      resolveUserId: () => state.userId(),
      getMembership: async (workspaceId, userId) =>
        state.memberships.get(`${workspaceId}:${userId}`) ?? null,
    }),
  );
  return listen(app);
}

function makeWebhookApp() {
  const app = express();
  app.post(
    "/venom/billing/webhook",
    express.raw({ type: "application/json" }),
    handleStripeWebhook,
  );
  return listen(app);
}

/** Minimal fake Stripe subscription in the item-period shape. */
function fakeSubscription(input: {
  id: string;
  status: string;
  customer: string;
  metadata: Record<string, string>;
  cancelAtPeriodEnd?: boolean;
  periodStart?: Date;
  periodEnd?: Date;
}): Stripe.Subscription {
  return {
    id: input.id,
    object: "subscription",
    status: input.status,
    customer: input.customer,
    cancel_at_period_end: input.cancelAtPeriodEnd ?? false,
    metadata: input.metadata,
    items: {
      data: [
        {
          current_period_start: Math.floor(
            (input.periodStart ?? PERIOD_START).getTime() / 1000,
          ),
          current_period_end: Math.floor(
            (input.periodEnd ?? PERIOD_END).getTime() / 1000,
          ),
        },
      ],
    },
  } as unknown as Stripe.Subscription;
}

function fakeEvent(type: string, object: unknown): Stripe.Event {
  return {
    id: `evt_${randomUUID().slice(0, 8)}`,
    type,
    data: { object },
  } as unknown as Stripe.Event;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test("plan catalog is env-tunable configuration with safe fallbacks", () => {
  assert.equal(venomPlan("free").allowanceUsd, 5);
  assert.equal(venomPlan("plus").priceUsd, 15);
  assert.equal(venomPlan("org").scope, "workspace");

  process.env.VENOM_PLAN_FREE_ALLOWANCE_USD = "2";
  process.env.VENOM_PLAN_PLUS_NAME = "Symbiote";
  assert.equal(venomPlan("free").allowanceUsd, 2);
  assert.equal(venomPlan("plus").name, "Symbiote");

  // Garbage never becomes a plan: negative and non-numeric fall back.
  process.env.VENOM_PLAN_FREE_ALLOWANCE_USD = "-3";
  assert.equal(venomPlan("free").allowanceUsd, 5);
  process.env.VENOM_PLAN_FREE_ALLOWANCE_USD = "lots";
  assert.equal(venomPlan("free").allowanceUsd, 5);

  assert.equal(approachingWarnRatio(), 0.8);
  process.env.VENOM_BILLING_WARN_RATIO = "0.5";
  assert.equal(approachingWarnRatio(), 0.5);
  process.env.VENOM_BILLING_WARN_RATIO = "1.7";
  assert.equal(approachingWarnRatio(), 0.8);

  delete process.env.VENOM_PLAN_FREE_ALLOWANCE_USD;
  delete process.env.VENOM_PLAN_PLUS_NAME;
  delete process.env.VENOM_BILLING_WARN_RATIO;

  assert.equal(planAllowanceMicros(venomPlan("free")), 5_000_000);
});

test("status and period helpers draw the benefit line correctly", () => {
  for (const status of ["active", "trialing", "past_due"]) {
    assert.equal(statusKeepsBenefits(status), true, status);
  }
  for (const status of ["canceled", "none", "unpaid", "incomplete", "paused"]) {
    assert.equal(statusKeepsBenefits(status), false, status);
  }

  const account = {
    status: "active",
    currentPeriodStart: PERIOD_START,
    currentPeriodEnd: PERIOD_END,
  } as any;
  const live = billingPeriodFor(account, NOW);
  assert.equal(live.source, "stripe");
  assert.equal(live.start.getTime(), PERIOD_START.getTime());

  // A lapsed subscription's stale period must never widen the window.
  const lapsed = billingPeriodFor({ ...account, status: "canceled" }, NOW);
  assert.equal(lapsed.source, "calendar");
  const stale = billingPeriodFor(
    {
      ...account,
      currentPeriodStart: new Date("2020-01-01T00:00:00Z"),
      currentPeriodEnd: new Date("2020-02-01T00:00:00Z"),
    },
    NOW,
  );
  assert.equal(stale.source, "calendar");
  assert.equal(stale.start.getUTCDate(), 1);
});

test("payer resolution follows the space, never the content", async () => {
  const user = newUserId("payer");
  const wsCovered = newWorkspaceId();
  const wsLapsed = newWorkspaceId();
  const wsNone = newWorkspaceId();

  await seedAccount({
    scopeType: "workspace",
    scopeId: wsCovered,
    planId: "org",
    status: "active",
  });
  await seedAccount({
    scopeType: "workspace",
    scopeId: wsLapsed,
    planId: "org",
    status: "canceled",
  });

  assert.equal(
    workspaceOrgPlanActive(await getBillingAccount("workspace", wsCovered)),
    true,
  );
  assert.equal(
    workspaceOrgPlanActive(await getBillingAccount("workspace", wsLapsed)),
    false,
  );

  const personal = await resolveVenomPayer({ userId: user, workspaceId: null });
  assert.deepEqual(personal, { kind: "personal", userId: user });

  const covered = await resolveVenomPayer({
    userId: user,
    workspaceId: wsCovered,
  });
  assert.deepEqual(covered, { kind: "workspace", workspaceId: wsCovered });

  // A lapsed Organization plan silently falls back to personal billing.
  const lapsed = await resolveVenomPayer({
    userId: user,
    workspaceId: wsLapsed,
  });
  assert.deepEqual(lapsed, { kind: "personal", userId: user });

  const uncovered = await resolveVenomPayer({
    userId: user,
    workspaceId: wsNone,
  });
  assert.deepEqual(uncovered, { kind: "personal", userId: user });

  // past_due keeps benefits: a payment hiccup must not instantly re-bill
  // members personally.
  await seedAccount({
    scopeType: "workspace",
    scopeId: wsLapsed,
    planId: "org",
    status: "past_due",
  });
  const pastDue = await resolveVenomPayer({
    userId: user,
    workspaceId: wsLapsed,
  });
  assert.deepEqual(pastDue, { kind: "workspace", workspaceId: wsLapsed });
});

test("usage tagging scopes sums and the personal summary excludes workspace-billed spend", async () => {
  const user = newUserId("summary");
  const wsCovered = newWorkspaceId();
  const wsGhost = newWorkspaceId(); // billed, then "deleted" (never inserted)
  await seedWorkspaceRow(wsCovered, `${RUN} Billing Guild`);

  await spend({ userId: user, costMicros: 1_500_000 });
  await spend({
    userId: user,
    costMicros: 2_000_000,
    billedWorkspaceId: wsCovered,
  });
  await spend({
    userId: user,
    costMicros: 700_000,
    billedWorkspaceId: wsGhost,
  });
  await spend({ userId: newUserId("stranger"), costMicros: 9_000_000 });

  const period = { start: PERIOD_START, end: PERIOD_END, source: "calendar" as const };
  assert.equal(
    await sumBilledMicros({ kind: "personal", userId: user }, period),
    1_500_000,
  );
  assert.equal(
    await sumBilledMicros({ kind: "workspace", workspaceId: wsCovered }, period),
    2_000_000,
  );

  const summary = await loadVenomUsageSummary(user, NOW);
  // Personal view counts only personally-billed spend…
  assert.ok(
    Math.abs(summary.totals.costUsd - 1.5) < 0.005,
    String(summary.totals.costUsd),
  );
  // …and names the workspaces that covered the rest, without figures.
  const coveredIds = summary.coveredByWorkspaces.map((w) => w.id).sort();
  assert.deepEqual(coveredIds, [wsCovered, wsGhost].sort());
  const named = summary.coveredByWorkspaces.find((w) => w.id === wsCovered);
  assert.equal(named?.name, `${RUN} Billing Guild`);
  const ghost = summary.coveredByWorkspaces.find((w) => w.id === wsGhost);
  assert.ok(ghost && ghost.name.length > 0, "deleted workspace still has display text");
  assert.ok(!("costUsd" in (named as object)), "covered entries carry no spend");
});

test("allowance enforcement blocks the right payer with the right message", async (t) => {
  const wsCovered = newWorkspaceId();
  const wsHealthy = newWorkspaceId();
  await seedWorkspaceRow(wsCovered, `${RUN} Spent Guild`);
  await seedAccount({
    scopeType: "workspace",
    scopeId: wsCovered,
    planId: "org",
    status: "active",
  });
  await seedAccount({
    scopeType: "workspace",
    scopeId: wsHealthy,
    planId: "org",
    status: "active",
  });

  const broke = newUserId("broke");
  await spend({ userId: broke, costMicros: 6_000_000 }); // > free $5

  // Keyless and unenforced: payer/tagging still resolve, nothing blocks.
  assert.equal(billingEnforcementActive(), false);
  const unenforced = await checkVenomAllowance({ userId: broke });
  assert.equal(unenforced.allowed, true);
  assert.equal(unenforced.billedWorkspaceId, null);

  process.env.VENOM_BILLING_ENFORCE = "1";
  t.after(() => {
    delete process.env.VENOM_BILLING_ENFORCE;
  });
  assert.equal(billingEnforcementActive(), true);

  // Personal allowance exhausted → personal block code + upgrade nudge.
  const blocked = await checkVenomAllowance({ userId: broke });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.blockedCode, "personal_allowance_exhausted");
  assert.match(blocked.blockedMessage ?? "", /Upgrade/);
  const body = allowanceBlockedBody(blocked);
  assert.equal(body.code, "personal_allowance_exhausted");
  assert.ok(body.error.length > 20);

  // …but the same person keeps working inside an org-covered workspace.
  const rescued = await checkVenomAllowance({
    userId: broke,
    workspaceId: wsHealthy,
  });
  assert.equal(rescued.allowed, true);
  assert.equal(rescued.billedWorkspaceId, wsHealthy);

  // Approaching: past the warn ratio but under the cap.
  const nearly = newUserId("nearly");
  await spend({ userId: nearly, costMicros: 4_200_000 }); // 84% of $5
  const approaching = await checkVenomAllowance({ userId: nearly });
  assert.equal(approaching.allowed, true);
  assert.equal(approaching.approaching, true);

  const fresh = newUserId("fresh");
  const ok = await checkVenomAllowance({ userId: fresh });
  assert.equal(ok.allowed, true);
  assert.equal(ok.approaching, false);

  // ── Reservations: the concurrency-safe hard edge ─────────────────────────
  // Admission holds each request's priced worst case as a database row
  // inside a payer-locked transaction, so two parallel requests — even from
  // parallel server processes, which share nothing but Postgres — cannot
  // both take the same last slice of allowance.
  const BOUND = requestBoundMicros();
  const FREE_ALLOWANCE = planAllowanceMicros(venomPlan("free"));
  const racing = newUserId("racing");
  await spend({ userId: racing, costMicros: FREE_ALLOWANCE - BOUND - 50_000 });
  const admissions = await Promise.all([
    checkVenomAllowance({ userId: racing, reserve: true }),
    checkVenomAllowance({ userId: racing, reserve: true }),
  ]);
  const admitted = admissions.filter((decision) => decision.allowed);
  assert.equal(admitted.length, 1);
  assert.ok(admitted[0]?.reservationId, "admitted request carries its hold");
  assert.equal(
    admissions.filter((decision) => !decision.allowed)[0]?.blockedCode,
    "personal_allowance_exhausted",
  );

  // A failed or aborted request releases its hold, and the same admission
  // passes again — a crash-path release never permanently burns budget.
  await releaseVenomAllowanceReservation(admitted[0]?.reservationId);
  const reAdmitted = await checkVenomAllowance({
    userId: racing,
    reserve: true,
  });
  assert.equal(reAdmitted.allowed, true);

  // Settlement is atomic: the durable usage row replaces the hold in one
  // transaction, so the spend is counted exactly once — never as row AND
  // reservation, never as neither.
  await insertVenomUsage({
    userId: racing,
    modelAlias: "venom-gpt",
    callKind: "chat",
    promptTokens: 10,
    outputTokens: 10,
    estimated: false,
    costMicros: 40_000,
    reservationId: reAdmitted.reservationId,
  });
  const openAfterSettle = await db
    .select({ id: venomAllowanceReservationsTable.id })
    .from(venomAllowanceReservationsTable)
    .where(eq(venomAllowanceReservationsTable.scopeId, racing));
  assert.equal(openAfterSettle.length, 0, "settle consumed the hold");
  const afterSettle = await checkVenomAllowance({
    userId: racing,
    reserve: true,
  });
  assert.equal(afterSettle.allowed, true, "spend counted once, not twice");
  await releaseVenomAllowanceReservation(afterSettle.reservationId);

  // Near-limit large-output guard: a sliver of remaining balance refuses a
  // request whose worst case could stream past the allowance…
  const sliver = newUserId("sliver");
  await spend({ userId: sliver, costMicros: FREE_ALLOWANCE - BOUND + 50_000 });
  const sliverBlocked = await checkVenomAllowance({
    userId: sliver,
    reserve: true,
  });
  assert.equal(sliverBlocked.allowed, false);
  assert.equal(sliverBlocked.blockedCode, "personal_allowance_exhausted");
  // …while the read-only availability check (summaries, composer hint)
  // still reports the not-yet-exhausted display state.
  const sliverDisplay = await checkVenomAllowance({ userId: sliver });
  assert.equal(sliverDisplay.allowed, true);
  assert.equal(sliverDisplay.approaching, true);

  // Crash-leaked holds are reaped by age: a stale row neither blocks the
  // payer forever nor survives the next admission.
  const stale = newUserId("stale");
  await spend({ userId: stale, costMicros: FREE_ALLOWANCE - BOUND - 50_000 });
  await db.insert(venomAllowanceReservationsTable).values({
    scopeType: "user",
    scopeId: stale,
    reservedMicros: BOUND,
    createdAt: new Date(Date.now() - 11 * 60 * 1000),
  });
  const afterReap = await checkVenomAllowance({ userId: stale, reserve: true });
  assert.equal(afterReap.allowed, true, "stale hold no longer counts");
  const staleLeft = await db
    .select({ id: venomAllowanceReservationsTable.id })
    .from(venomAllowanceReservationsTable)
    .where(
      and(
        eq(venomAllowanceReservationsTable.scopeId, stale),
        lt(
          venomAllowanceReservationsTable.createdAt,
          new Date(Date.now() - 10 * 60 * 1000),
        ),
      ),
    );
  assert.equal(staleLeft.length, 0, "reaper deleted the leaked row");

  // Workspace allowance exhausted → workspace-specific code and copy that
  // names the workspace and absolves the member's own plan.
  await spend({
    userId: fresh,
    costMicros: planAllowanceMicros(venomPlan("org")) + 1_000_000,
    billedWorkspaceId: wsCovered,
  });
  const wsBlocked = await checkVenomAllowance({
    userId: fresh,
    workspaceId: wsCovered,
  });
  assert.equal(wsBlocked.allowed, false);
  assert.equal(wsBlocked.blockedCode, "workspace_allowance_exhausted");
  assert.match(wsBlocked.blockedMessage ?? "", new RegExp(`${RUN} Spent Guild`));
  assert.match(wsBlocked.blockedMessage ?? "", /workspace's limit/);
  assert.match(wsBlocked.blockedMessage ?? "", /personal plan is fine/);

  // …while the same member's personal space keeps working.
  const personalStillOk = await checkVenomAllowance({ userId: fresh });
  assert.equal(personalStillOk.allowed, true);
});

test("webhook lifecycle: checkout → active → past_due → canceled, idempotently", async (t) => {
  const handle = await makeWebhookApp();
  t.after(async () => {
    await closeServer(handle);
    overrideStripeWebhookVerifierForTests(null);
    overrideVenomStripeForTests(null);
  });

  const hookUser = newUserId("hook");
  const customer = `cus_${RUN}`;
  const subId = `sub_${RUN}`;
  const subMeta = {
    venomScopeType: "user",
    venomScopeId: hookUser,
    venomPlanId: "plus",
  };

  // Unconfigured (no secret, no verifier): the endpoint refuses politely.
  const unconfigured = await call(
    handle.base,
    "/venom/billing/webhook",
    postJson({ type: "noop" }),
  );
  assert.equal(unconfigured.status, 503);
  assert.equal(unconfigured.body.code, "billing_not_configured");

  // Verifier seam on: signature is the only authentication.
  overrideStripeWebhookVerifierForTests((raw, signature) => {
    assert.ok(Buffer.isBuffer(raw), "webhook body must stay raw bytes");
    if (signature === "bad") throw new Error("bad signature");
    return JSON.parse(raw.toString("utf8")) as Stripe.Event;
  });

  const noSig = await call(
    handle.base,
    "/venom/billing/webhook",
    postJson({ type: "noop" }),
  );
  assert.equal(noSig.status, 400);

  const badSig = await call(
    handle.base,
    "/venom/billing/webhook",
    postJson({ type: "noop" }, { "stripe-signature": "bad" }),
  );
  assert.equal(badSig.status, 400);

  // checkout.session.completed pulls the live subscription via the client
  // seam and lands the full normalized state.
  let retrieved = 0;
  let liveSubscriptionStatus = "active";
  overrideVenomStripeForTests({
    checkout: { sessions: { create: async () => ({ id: "cs", url: "u" }) } },
    billingPortal: { sessions: { create: async () => ({ url: "u" }) } },
    subscriptions: {
      retrieve: async (id) => {
        retrieved += 1;
        assert.equal(id, subId);
        return fakeSubscription({
          id: subId,
          status: liveSubscriptionStatus,
          customer,
          metadata: subMeta,
        });
      },
    },
  });

  const completed = await call(
    handle.base,
    "/venom/billing/webhook",
    postJson(
      fakeEvent("checkout.session.completed", {
        mode: "subscription",
        metadata: subMeta,
        subscription: subId,
        customer,
      }),
      { "stripe-signature": "ok" },
    ),
  );
  assert.equal(completed.status, 200);
  assert.equal(retrieved, 1);

  let account = await getBillingAccount("user", hookUser);
  assert.equal(account?.planId, "plus");
  assert.equal(account?.status, "active");
  assert.equal(account?.stripeCustomerId, customer);
  assert.equal(effectivePersonalPlanId(account), "plus");
  assert.equal(billingPeriodFor(account, NOW).source, "stripe");

  // A payment fails: past_due keeps benefits.
  const failed = await call(
    handle.base,
    "/venom/billing/webhook",
    postJson(fakeEvent("invoice.payment_failed", { customer }), {
      "stripe-signature": "ok",
    }),
  );
  assert.equal(failed.status, 200);
  account = await getBillingAccount("user", hookUser);
  assert.equal(account?.status, "past_due");
  assert.equal(effectivePersonalPlanId(account), "plus");

  // Stripe retries webhooks: replaying an update is a no-op upsert.
  const updateEvent = fakeEvent(
    "customer.subscription.updated",
    fakeSubscription({ id: subId, status: "active", customer, metadata: subMeta }),
  );
  for (let i = 0; i < 2; i += 1) {
    const res = await call(
      handle.base,
      "/venom/billing/webhook",
      postJson(updateEvent, { "stripe-signature": "ok" }),
    );
    assert.equal(res.status, 200);
  }
  const rows = await db
    .select()
    .from(venomBillingAccountsTable)
    .where(like(venomBillingAccountsTable.scopeId, `${hookUser}%`));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.status, "active");

  // Cancellation drops the plan to free…
  liveSubscriptionStatus = "canceled";
  const deleted = await call(
    handle.base,
    "/venom/billing/webhook",
    postJson(
      fakeEvent(
        "customer.subscription.deleted",
        fakeSubscription({
          id: subId,
          status: "canceled",
          customer,
          metadata: subMeta,
        }),
      ),
      { "stripe-signature": "ok" },
    ),
  );
  assert.equal(deleted.status, 200);
  account = await getBillingAccount("user", hookUser);
  assert.equal(account?.status, "canceled");
  assert.equal(effectivePersonalPlanId(account), "free");

  // Stripe can deliver an older active update after a cancellation. The
  // webhook payload is stale; the route must retrieve Stripe's current
  // canceled subscription and never restore Plus benefits.
  const staleActiveAfterCanceled = await call(
    handle.base,
    "/venom/billing/webhook",
    postJson(
      fakeEvent(
        "customer.subscription.updated",
        fakeSubscription({
          id: subId,
          status: "active",
          customer,
          metadata: subMeta,
        }),
      ),
      { "stripe-signature": "ok" },
    ),
  );
  assert.equal(staleActiveAfterCanceled.status, 200);
  account = await getBillingAccount("user", hookUser);
  assert.equal(account?.status, "canceled");
  assert.equal(effectivePersonalPlanId(account), "free");

  // …and a late payment-failed event never resurrects it.
  await call(
    handle.base,
    "/venom/billing/webhook",
    postJson(fakeEvent("invoice.payment_failed", { customer }), {
      "stripe-signature": "ok",
    }),
  );
  account = await getBillingAccount("user", hookUser);
  assert.equal(account?.status, "canceled");

  // Workspace checkout lands an org plan the payer resolver honors.
  const hookWs = newWorkspaceId();
  const wsMeta = {
    venomScopeType: "workspace",
    venomScopeId: hookWs,
    venomPlanId: "org",
  };
  const wsSub = `sub_ws_${RUN}`;
  overrideVenomStripeForTests({
    checkout: { sessions: { create: async () => ({ id: "cs", url: "u" }) } },
    billingPortal: { sessions: { create: async () => ({ url: "u" }) } },
    subscriptions: {
      retrieve: async () =>
        fakeSubscription({
          id: wsSub,
          status: "active",
          customer: `cus_ws_${RUN}`,
          metadata: wsMeta,
        }),
    },
  });
  await call(
    handle.base,
    "/venom/billing/webhook",
    postJson(
      fakeEvent("checkout.session.completed", {
        mode: "subscription",
        metadata: wsMeta,
        subscription: wsSub,
        customer: `cus_ws_${RUN}`,
      }),
      { "stripe-signature": "ok" },
    ),
  );
  assert.equal(
    workspaceOrgPlanActive(await getBillingAccount("workspace", hookWs)),
    true,
  );
});

test("personal billing endpoints: summary, context, and Stripe page bootstrap", async (t) => {
  const user = newUserId("api");
  const wsCovered = newWorkspaceId();
  const wsLapsed = newWorkspaceId();
  await seedWorkspaceRow(wsCovered, `${RUN} Context Guild`);
  await seedAccount({
    scopeType: "workspace",
    scopeId: wsCovered,
    planId: "org",
    status: "active",
  });
  await seedAccount({
    scopeType: "workspace",
    scopeId: wsLapsed,
    planId: "org",
    status: "canceled",
  });

  let currentUser: string | null = user;
  const memberships = new Map<string, SharedWorkspaceMembership>([
    [
      `${wsCovered}:${user}`,
      { workspaceId: wsCovered, workspaceName: `${RUN} Context Guild`, role: "member" },
    ],
    [
      `${wsLapsed}:${user}`,
      { workspaceId: wsLapsed, workspaceName: "Lapsed", role: "member" },
    ],
  ]);
  const handle = await makeRouterApp({
    userId: () => currentUser,
    memberships,
  });
  t.after(async () => {
    await closeServer(handle);
    overrideVenomStripeForTests(null);
  });

  // Unauthenticated → 401.
  currentUser = null;
  assert.equal((await call(handle.base, "/venom/billing/summary")).status, 401);
  currentUser = user;

  // Keyless summary: free plan, graceful "not set up", calendar period.
  let summary = await call(handle.base, "/venom/billing/summary");
  assert.equal(summary.status, 200);
  assert.equal(summary.body.configured, false);
  assert.equal(summary.body.enforced, false);
  assert.equal(summary.body.plan.id, "free");
  assert.equal(summary.body.upgradePlan.id, "plus");
  assert.equal(summary.body.manageable, false);
  assert.equal(summary.body.spentUsd, 0);
  assert.equal(summary.body.state, "ok");
  assert.equal(new Date(summary.body.periodStart).getUTCDate(), 1);

  // Spend appears — but workspace-billed spend does not.
  await spend({ userId: user, costMicros: 4_200_000 });
  await spend({
    userId: user,
    costMicros: 3_000_000,
    billedWorkspaceId: wsCovered,
  });
  summary = await call(handle.base, "/venom/billing/summary");
  assert.ok(Math.abs(summary.body.spentUsd - 4.2) < 0.005);

  process.env.VENOM_BILLING_ENFORCE = "1";
  t.after(() => {
    delete process.env.VENOM_BILLING_ENFORCE;
  });
  summary = await call(handle.base, "/venom/billing/summary");
  assert.equal(summary.body.enforced, true);
  assert.equal(summary.body.state, "approaching");

  // Composer context: personal space bills the personal plan…
  let context = await call(handle.base, "/venom/billing/context");
  assert.equal(context.body.payer, "personal");
  assert.equal(context.body.planName, "Free");
  assert.equal(context.body.state, "approaching");
  assert.equal(typeof context.body.remainingUsd, "number");

  // …an org-covered workspace bills the workspace, with no dollar figures…
  context = await call(
    handle.base,
    `/venom/billing/context?workspaceId=${wsCovered}`,
  );
  assert.equal(context.body.payer, "workspace");
  assert.equal(context.body.workspaceId, wsCovered);
  assert.equal(context.body.workspaceName, `${RUN} Context Guild`);
  assert.equal(context.body.remainingUsd, undefined);

  // …a lapsed org plan falls back to personal…
  context = await call(
    handle.base,
    `/venom/billing/context?workspaceId=${wsLapsed}`,
  );
  assert.equal(context.body.payer, "personal");

  // …and a workspace the caller isn't in stays opaque.
  const strangerWs = newWorkspaceId();
  context = await call(
    handle.base,
    `/venom/billing/context?workspaceId=${strangerWs}`,
  );
  assert.equal(context.status, 403);

  // Keyless checkout/portal: polite 503, nothing else breaks.
  let checkout = await call(
    handle.base,
    "/venom/billing/checkout",
    postJson({}),
  );
  assert.equal(checkout.status, 503);
  assert.equal(checkout.body.code, "billing_not_configured");
  assert.equal(
    (await call(handle.base, "/venom/billing/portal", postJson({}))).status,
    503,
  );

  // Configured: checkout mints a Stripe-hosted page with the right scope.
  const created: Stripe.Checkout.SessionCreateParams[] = [];
  const checkoutOptions: Array<Stripe.RequestOptions | undefined> = [];
  const portals: Stripe.BillingPortal.SessionCreateParams[] = [];
  overrideVenomStripeForTests({
    checkout: {
      sessions: {
        create: async (params, options) => {
          created.push(params);
          checkoutOptions.push(options);
          return { id: "cs_test", url: "https://stripe.test/checkout" };
        },
      },
    },
    billingPortal: {
      sessions: {
        create: async (params) => {
          portals.push(params);
          return { url: "https://stripe.test/portal" };
        },
      },
    },
    subscriptions: { retrieve: async () => fakeSubscription({
      id: "sub_none", status: "active", customer: "cus_none", metadata: {},
    }) },
  });

  // Return addresses are origin-allowlisted: a caller-supplied URL outside
  // the app's own origins cannot aim Stripe's post-payment redirect at a
  // foreign site — it falls back to a first-party origin instead.
  checkout = await call(
    handle.base,
    "/venom/billing/checkout",
    postJson({ returnUrl: "https://app.example/settings" }),
  );
  assert.equal(checkout.status, 200);
  assert.equal(checkout.body.url, "https://stripe.test/checkout");
  const params = created.at(-1)!;
  assert.equal(params.mode, "subscription");
  assert.equal(params.metadata?.venomScopeType, "user");
  assert.equal(params.metadata?.venomScopeId, user);
  assert.equal(params.metadata?.venomPlanId, "plus");
  assert.equal(params.subscription_data?.metadata?.venomPlanId, "plus");
  assert.ok(
    params.success_url?.startsWith("https://venom-first-party.example"),
    "foreign return URL fell back to a first-party origin",
  );
  assert.ok(!params.success_url?.includes("app.example"));
  assert.equal(
    params.line_items?.[0]?.price_data?.unit_amount,
    venomPlan("plus").priceUsd * 100,
  );
  assert.equal(
    checkoutOptions.at(-1)?.idempotencyKey,
    `venom-checkout-v1:user:${user}:plus`,
  );

  // …while a first-party return URL is honored verbatim, path and query
  // included.
  checkout = await call(
    handle.base,
    "/venom/billing/checkout",
    postJson({
      returnUrl: "https://venom-first-party.example/settings?tab=billing",
    }),
  );
  assert.equal(checkout.status, 200);
  assert.ok(
    created
      .at(-1)!
      .success_url?.startsWith(
        "https://venom-first-party.example/settings?tab=billing",
      ),
  );

  // Two simultaneous checkout clicks carry the same payer-plan key. Stripe
  // consequently returns one Checkout Session instead of subscriptions that
  // race ahead of the webhook mirror.
  const concurrentUser = newUserId("checkout-race");
  currentUser = concurrentUser;
  const checkoutCallStart = checkoutOptions.length;
  const [firstConcurrent, secondConcurrent] = await Promise.all([
    call(
      handle.base,
      "/venom/billing/checkout",
      postJson({ returnUrl: "https://app.example/settings" }),
    ),
    call(
      handle.base,
      "/venom/billing/checkout",
      postJson({ returnUrl: "https://app.example/settings" }),
    ),
  ]);
  assert.equal(firstConcurrent.status, 200);
  assert.equal(secondConcurrent.status, 200);
  assert.equal(firstConcurrent.body.url, secondConcurrent.body.url);
  assert.deepEqual(
    checkoutOptions
      .slice(checkoutCallStart)
      .map((options) => options?.idempotencyKey),
    [
      `venom-checkout-v1:user:${concurrentUser}:plus`,
      `venom-checkout-v1:user:${concurrentUser}:plus`,
    ],
  );
  currentUser = user;

  // No body URL and an arbitrary request Origin: headers are
  // caller-controlled and never join the allowlist, so the return address
  // falls back to the deployment's own origin.
  checkout = await call(handle.base, "/venom/billing/checkout", {
    ...postJson({}),
    headers: {
      "content-type": "application/json",
      origin: "https://origin.example",
    },
  });
  assert.equal(checkout.status, 200);
  assert.ok(
    created
      .at(-1)!
      .success_url?.startsWith("https://venom-first-party.example"),
    "a request Origin header never becomes a Stripe return address",
  );
  assert.ok(!created.at(-1)!.success_url?.includes("origin.example"));

  // Owner-configured extra origins are the only way to widen the list,
  // and they honor provided URLs exactly like first-party ones.
  process.env.VENOM_BILLING_RETURN_ORIGINS = "https://local-dev.example:5173";
  try {
    checkout = await call(
      handle.base,
      "/venom/billing/checkout",
      postJson({ returnUrl: "https://local-dev.example:5173/billing/done" }),
    );
    assert.equal(checkout.status, 200);
    assert.ok(
      created
        .at(-1)!
        .success_url?.startsWith("https://local-dev.example:5173/billing/done"),
    );
  } finally {
    delete process.env.VENOM_BILLING_RETURN_ORIGINS;
  }

  // Unknown plan ids are rejected; org is not a personal plan.
  assert.equal(
    (
      await call(
        handle.base,
        "/venom/billing/checkout",
        postJson({ planId: "org" }),
      )
    ).status,
    400,
  );

  // Already on the paid plan → 409 points at Manage instead.
  await seedAccount({
    scopeType: "user",
    scopeId: user,
    planId: "plus",
    status: "active",
    customerId: `cus_api_${RUN}`,
  });
  checkout = await call(handle.base, "/venom/billing/checkout", postJson({}));
  assert.equal(checkout.status, 409);
  assert.equal(checkout.body.code, "already_subscribed");

  // Portal requires an existing customer…
  const portal = await call(handle.base, "/venom/billing/portal", postJson({}));
  assert.equal(portal.status, 200);
  assert.equal(portals.at(-1)?.customer, `cus_api_${RUN}`);

  // …and a user who never bought anything gets a clear 409.
  currentUser = newUserId("api-fresh");
  const noPortal = await call(
    handle.base,
    "/venom/billing/portal",
    postJson({}),
  );
  assert.equal(noPortal.status, 409);
  assert.equal(noPortal.body.code, "not_subscribed");
});

test("workspace billing endpoints: member shapes, admin money, gated actions", async (t) => {
  const admin = newUserId("wsadmin");
  const member = newUserId("wsmember");
  const outsider = newUserId("wsout");
  const ws = newWorkspaceId();
  const wsBare = newWorkspaceId();
  await seedWorkspaceRow(ws, `${RUN} Admin Guild`);
  await seedWorkspaceRow(wsBare, `${RUN} Bare Guild`);
  await seedAccount({
    scopeType: "workspace",
    scopeId: ws,
    planId: "org",
    status: "active",
    customerId: `cus_ws_admin_${RUN}`,
  });
  await spend({ userId: member, costMicros: 10_000_000, billedWorkspaceId: ws });

  let currentUser: string | null = admin;
  const memberships = new Map<string, SharedWorkspaceMembership>([
    [`${ws}:${admin}`, { workspaceId: ws, workspaceName: `${RUN} Admin Guild`, role: "admin" }],
    [`${ws}:${member}`, { workspaceId: ws, workspaceName: `${RUN} Admin Guild`, role: "member" }],
    [`${wsBare}:${admin}`, { workspaceId: wsBare, workspaceName: `${RUN} Bare Guild`, role: "admin" }],
    [`${wsBare}:${member}`, { workspaceId: wsBare, workspaceName: `${RUN} Bare Guild`, role: "member" }],
  ]);
  const handle = await makeRouterApp({
    userId: () => currentUser,
    memberships,
  });
  t.after(async () => {
    await closeServer(handle);
    overrideVenomStripeForTests(null);
  });

  // Admin sees the money; the covered flag and figures line up.
  let res = await call(handle.base, `/venom/workspaces/${ws}/billing`);
  assert.equal(res.status, 200);
  assert.equal(res.body.covered, true);
  assert.equal(res.body.role, "admin");
  assert.ok(Math.abs(res.body.spentUsd - 10) < 0.005);
  assert.equal(res.body.plan.id, "org");
  assert.equal(res.body.status, "active");
  assert.equal(res.body.manageable, false); // keyless: manage needs Stripe

  // Member: covered yes/no and plan name only — never dollars.
  currentUser = member;
  res = await call(handle.base, `/venom/workspaces/${ws}/billing`);
  assert.equal(res.status, 200);
  assert.equal(res.body.covered, true);
  assert.equal(res.body.role, "member");
  assert.ok(!("spentUsd" in res.body), "members never see workspace spend");
  assert.ok(!("plan" in res.body));
  assert.ok(!("status" in res.body));

  // Outsiders and malformed ids get the same opaque refusal.
  currentUser = outsider;
  assert.equal(
    (await call(handle.base, `/venom/workspaces/${ws}/billing`)).status,
    403,
  );
  currentUser = admin;
  assert.equal(
    (await call(handle.base, "/venom/workspaces/not-a-uuid/billing")).status,
    403,
  );

  // Actions: members can't buy or manage.
  currentUser = member;
  assert.equal(
    (
      await call(
        handle.base,
        `/venom/workspaces/${wsBare}/billing/checkout`,
        postJson({}),
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call(
        handle.base,
        `/venom/workspaces/${ws}/billing/portal`,
        postJson({}),
      )
    ).status,
    403,
  );

  // Admin, keyless → graceful 503.
  currentUser = admin;
  assert.equal(
    (
      await call(
        handle.base,
        `/venom/workspaces/${wsBare}/billing/checkout`,
        postJson({}),
      )
    ).status,
    503,
  );

  // Configured: buying an uncovered workspace works and carries the scope.
  const created: Stripe.Checkout.SessionCreateParams[] = [];
  const checkoutOptions: Array<Stripe.RequestOptions | undefined> = [];
  const portals: Stripe.BillingPortal.SessionCreateParams[] = [];
  overrideVenomStripeForTests({
    checkout: {
      sessions: {
        create: async (params, options) => {
          created.push(params);
          checkoutOptions.push(options);
          return { id: "cs_ws", url: "https://stripe.test/ws-checkout" };
        },
      },
    },
    billingPortal: {
      sessions: {
        create: async (params) => {
          portals.push(params);
          return { url: "https://stripe.test/ws-portal" };
        },
      },
    },
    subscriptions: { retrieve: async () => fakeSubscription({
      id: "sub_none", status: "active", customer: "cus_none", metadata: {},
    }) },
  });

  res = await call(
    handle.base,
    `/venom/workspaces/${wsBare}/billing/checkout`,
    postJson({ returnUrl: "https://app.example/workspaces" }),
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.url, "https://stripe.test/ws-checkout");
  const wsParams = created.at(-1)!;
  assert.equal(wsParams.metadata?.venomScopeType, "workspace");
  assert.equal(wsParams.metadata?.venomScopeId, wsBare);
  assert.equal(wsParams.metadata?.venomPlanId, "org");
  assert.match(
    String(wsParams.line_items?.[0]?.price_data?.product_data?.name),
    /Bare Guild/,
  );
  assert.equal(
    checkoutOptions.at(-1)?.idempotencyKey,
    `venom-checkout-v1:workspace:${wsBare}:org`,
  );

  const workspaceCheckoutStart = checkoutOptions.length;
  const [firstWorkspaceCheckout, secondWorkspaceCheckout] = await Promise.all([
    call(
      handle.base,
      `/venom/workspaces/${wsBare}/billing/checkout`,
      postJson({ returnUrl: "https://app.example/workspaces" }),
    ),
    call(
      handle.base,
      `/venom/workspaces/${wsBare}/billing/checkout`,
      postJson({ returnUrl: "https://app.example/workspaces" }),
    ),
  ]);
  assert.equal(firstWorkspaceCheckout.status, 200);
  assert.equal(secondWorkspaceCheckout.status, 200);
  assert.equal(firstWorkspaceCheckout.body.url, secondWorkspaceCheckout.body.url);
  assert.deepEqual(
    checkoutOptions
      .slice(workspaceCheckoutStart)
      .map((options) => options?.idempotencyKey),
    [
      `venom-checkout-v1:workspace:${wsBare}:org`,
      `venom-checkout-v1:workspace:${wsBare}:org`,
    ],
  );

  // A workspace already on the plan can't buy it twice.
  res = await call(
    handle.base,
    `/venom/workspaces/${ws}/billing/checkout`,
    postJson({}),
  );
  assert.equal(res.status, 409);

  // Manage: the covered workspace has a customer id → portal opens…
  res = await call(
    handle.base,
    `/venom/workspaces/${ws}/billing/portal`,
    postJson({}),
  );
  assert.equal(res.status, 200);
  assert.equal(portals.at(-1)?.customer, `cus_ws_admin_${RUN}`);

  // …the bare one has nothing to manage.
  res = await call(
    handle.base,
    `/venom/workspaces/${wsBare}/billing/portal`,
    postJson({}),
  );
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "not_subscribed");

  // With Stripe configured the admin view flips manageable on.
  res = await call(handle.base, `/venom/workspaces/${ws}/billing`);
  assert.equal(res.body.manageable, true);
  assert.equal(res.body.configured, true);
});

// ─── Concurrency and early-exit reservation hygiene ─────────────────────────

/**
 * Full venom-router app with a branded Clerk auth handler, for driving the
 * real /venom/respond route end to end. Symbol.for keeps the brand
 * identical to the one @clerk/express's getAuth() checks for.
 */
const clerkAuthBrand = Symbol.for("@clerk/express.auth");
function makeVenomApp(state: { userId: () => string | null }) {
  const app = express();
  app.use(pinoHttp({ logger: pino({ level: "silent" }) }));
  app.use(express.json({ limit: "5mb" }));
  app.use((req, _res, next) => {
    const handler = Object.assign(
      () => ({ userId: state.userId(), tokenType: "session_token" }),
      { [clerkAuthBrand]: true },
    );
    Object.assign(req, { auth: handler });
    next();
  });
  app.use(venomRouter);
  return listen(app);
}

test("settlement serializes with admission under the payer lock", async (t) => {
  process.env.VENOM_BILLING_ENFORCE = "1";
  t.after(() => {
    delete process.env.VENOM_BILLING_ENFORCE;
  });

  const user = newUserId("settle-lock");
  const BOUND = requestBoundMicros();
  const FREE_ALLOWANCE = planAllowanceMicros(venomPlan("free"));
  // Numbers that separate correct from broken interleaving: the open hold
  // and its settled cost each individually block a worst-case admission,
  // while an empty ledger would admit one. If admission could read spend
  // before a settlement commits and holds after it commits — the cost
  // vanishing from both sums — it would wrongly admit here.
  const cost = FREE_ALLOWANCE - Math.floor(BOUND / 2);
  const reservationId = randomUUID();
  await db.insert(venomAllowanceReservationsTable).values({
    id: reservationId,
    scopeType: "user",
    scopeId: user,
    reservedMicros: cost,
    createdAt: new Date(),
  });

  // Hold the payer lock externally, queue BOTH a settlement and an
  // admission behind it, then let go: whichever order they land in, the
  // admission must see the money as either spend or hold, and refuse.
  let lockHeld!: () => void;
  const lockHeldGate = new Promise<void>((resolve) => (lockHeld = resolve));
  let releaseHold!: () => void;
  const holdGate = new Promise<void>((resolve) => (releaseHold = resolve));
  const holder = db.transaction(async (tx) => {
    await tx.execute(venomAllowanceLockSql("user", user));
    lockHeld();
    await holdGate;
  });
  await lockHeldGate;

  const settlement = insertVenomUsage({
    userId: user,
    modelAlias: "venom-gpt",
    callKind: "chat",
    promptTokens: 10,
    outputTokens: 10,
    estimated: false,
    costMicros: cost,
    reservationId,
  });
  const admission = checkVenomAllowance({ userId: user, reserve: true });
  const first = await Promise.race([
    settlement.then(() => "settled" as const),
    admission.then(() => "admitted" as const),
    new Promise<"waiting">((resolve) =>
      setTimeout(() => resolve("waiting"), 400),
    ),
  ]);
  assert.equal(
    first,
    "waiting",
    "both settlement and admission queue behind the held payer lock",
  );

  releaseHold();
  await holder;
  await settlement;
  const decision = await admission;
  assert.equal(decision.allowed, false);
  assert.equal(decision.blockedCode, "personal_allowance_exhausted");

  // The cost landed exactly once: the hold became a single spend row.
  const holds = await db
    .select({ id: venomAllowanceReservationsTable.id })
    .from(venomAllowanceReservationsTable)
    .where(eq(venomAllowanceReservationsTable.scopeId, user));
  assert.equal(holds.length, 0);
  const spendRows = await db
    .select({ id: venomUsageEvents.id })
    .from(venomUsageEvents)
    .where(eq(venomUsageEvents.userId, user));
  assert.equal(spendRows.length, 1);
});

test("a pre-stream chat failure frees the admission hold via response close", async (t) => {
  process.env.VENOM_BILLING_ENFORCE = "1";
  t.after(() => {
    delete process.env.VENOM_BILLING_ENFORCE;
  });

  const user = newUserId("early-exit");
  const BOUND = requestBoundMicros();
  const FREE_ALLOWANCE = planAllowanceMicros(venomPlan("free"));
  // Close enough to the cap that a leaked hold would block the follow-up
  // admission below — the assertion that catches a stranded reservation.
  await spend({ userId: user, costMicros: FREE_ALLOWANCE - BOUND - 50_000 });

  const venomHandle = await makeVenomApp({ userId: () => user });
  t.after(() => closeServer(venomHandle));

  // Passes schema validation, then fails snapshot authorization AFTER the
  // billing gate reserved: duplicate snapshot ids 400 long before the
  // streaming section and its cleanup exist.
  const snapshot = {
    id: "src-a1",
    context: "context block",
    citations: [
      {
        id: "cit-1",
        provider: "github",
        kind: "repository",
        title: "Example repo",
        url: "https://github.com/example/repo",
        excerpt: "excerpt text",
        reference: null,
      },
    ],
    attestation: `v1.${"a".repeat(20)}.${"0".repeat(64)}.${"A".repeat(43)}`,
  };
  const res = await call(
    venomHandle.base,
    "/venom/respond",
    postJson({
      projectId: "proj-early-exit",
      messages: [{ role: "user", content: "hello" }],
      sourceSnapshots: [snapshot, { ...snapshot }],
    }),
  );
  assert.equal(res.status, 400);
  assert.equal(res.body?.error, "Invalid connected source snapshots");

  // The close hook releases asynchronously; wait for the hold to clear.
  const deadline = Date.now() + 3_000;
  let open = -1;
  while (Date.now() < deadline) {
    const rows = await db
      .select({ id: venomAllowanceReservationsTable.id })
      .from(venomAllowanceReservationsTable)
      .where(eq(venomAllowanceReservationsTable.scopeId, user));
    open = rows.length;
    if (open === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(open, 0, "early exit released the admission hold");

  // And the allowance is genuinely free again: a fresh worst-case
  // admission fits, which a stranded hold would have pushed past the cap.
  const again = await checkVenomAllowance({ userId: user, reserve: true });
  assert.equal(again.allowed, true);
  await releaseVenomAllowanceReservation(again.reservationId);
});

after(async () => {
  overrideVenomStripeForTests(null);
  overrideStripeWebhookVerifierForTests(null);
  delete process.env.VENOM_BILLING_ENFORCE;
  await db
    .delete(venomUsageEvents)
    .where(like(venomUsageEvents.userId, `${RUN}%`));
  // Reservation holds this suite admitted (or seeded) are keyed by the same
  // run-scoped user/workspace ids.
  await db
    .delete(venomAllowanceReservationsTable)
    .where(like(venomAllowanceReservationsTable.scopeId, `${RUN}%`));
  if (trackedWorkspaceIds.length > 0) {
    await db
      .delete(venomAllowanceReservationsTable)
      .where(
        inArray(venomAllowanceReservationsTable.scopeId, trackedWorkspaceIds),
      );
  }
  if (trackedScopeIds.length > 0) {
    await db
      .delete(venomBillingAccountsTable)
      .where(inArray(venomBillingAccountsTable.scopeId, trackedScopeIds));
  }
  if (trackedWorkspaceIds.length > 0) {
    await db
      .delete(venomSharedWorkspacesTable)
      .where(inArray(venomSharedWorkspacesTable.id, trackedWorkspaceIds));
  }
  await pool.end();
});

// ── Priced admission bounds ──────────────────────────────────────────────────

test("the admission bound prices the ceilings dispatch actually enforces", async () => {
  const savedOverride = process.env.VENOM_BILLING_REQUEST_BOUND_MICROS;
  delete process.env.VENOM_BILLING_REQUEST_BOUND_MICROS;
  try {
    const promptBoundTokens = Math.ceil(
      PROVIDER_MAX_PROMPT_CHARS / BOUND_CHARS_PER_TOKEN,
    );
    assert.equal(
      requestBoundMicros(),
      maxCatalogCostMicros(promptBoundTokens, PROVIDER_MAX_OUTPUT_TOKENS),
      "default bound = enforced prompt + output ceilings at the priciest catalog rate",
    );
    for (const alias of [
      "venom-gpt",
      "venom-claude",
      "venom-gemini",
      "venom-grok",
    ]) {
      assert.ok(
        requestBoundMicros() >=
          computeCostMicros(alias, promptBoundTokens, PROVIDER_MAX_OUTPUT_TOKENS),
        `no permitted ${alias} request can settle above its reservation`,
      );
    }
    process.env.VENOM_BILLING_REQUEST_BOUND_MICROS = "987654";
    assert.equal(requestBoundMicros(), 987_654, "owner tuning still wins");
  } finally {
    if (savedOverride === undefined) {
      delete process.env.VENOM_BILLING_REQUEST_BOUND_MICROS;
    } else {
      process.env.VENOM_BILLING_REQUEST_BOUND_MICROS = savedOverride;
    }
  }
});

test("dispatch refuses prompts larger than the ceiling the bound prices", async () => {
  const oversized = "x".repeat(PROVIDER_MAX_PROMPT_CHARS + 1);
  await assert.rejects(
    (async () => {
      for await (const _token of streamVenomResponse("venom-claude", [
        { role: "user", content: oversized },
      ])) {
        break;
      }
    })(),
    (error: unknown) => error instanceof PromptTooLargeError,
    "an over-ceiling prompt must never reach a provider",
  );
});
