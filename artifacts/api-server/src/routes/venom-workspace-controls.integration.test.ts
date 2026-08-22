/**
 * venom-workspace-controls.integration.test.ts — workspace admin spend and
 * model controls, end to end against the real database:
 *
 * - Admin-only reads and writes: the usage summary and AI-controls
 *   endpoints refuse members with `workspace_admin_required` and everyone
 *   else with `workspace_access_denied`, and losing membership evicts
 *   access exactly like every other workspace API.
 * - The usage summary counts ONLY workspace-billed spend: a member's
 *   personal-space usage never appears in any admin payload, while spend
 *   from since-departed members still counts toward the workspace total.
 * - Member cap semantics: workspace default, per-member override, explicit
 *   uncap (override with null), zero as a deliberate block, and the
 *   404-on-non-member guard for override writes.
 * - Enforcement precedence via the single allowance gate: the workspace
 *   allowance wall wins over the member cap, the three block codes are
 *   distinct, caps bind only workspace-billed requests (personal space is
 *   untouched), admissions stamp their reservation with the asking member,
 *   and keyless/unenforced deployments stand down.
 * - The respond route's server-side model lock: a forced policy beats the
 *   member's own manual pick, tier locks shrink the catalog, an
 *   out-of-tier manual pick clamps to the cheapest allowed model and
 *   announces `managed`, workspaces without a live org plan are never
 *   touched, and a capped member is refused with the workspace-specific
 *   402 while their personal space keeps working.
 *
 * Providers point at dead-end loopback URLs: availability is env-derived
 * and only pre-stream metadata (or the block itself) is asserted, so no
 * mock provider is needed. Every row carries a run-scoped id and is
 * deleted afterwards.
 *
 * Run: pnpm --filter @workspace/api-server run test:workspace-controls
 */

// The venom router chain reads provider env at import time, so pin it
// before the dynamic `import("./venom.js")` below. Catalog under this env:
// venom-gemini ($, cheapest), venom-claude ($$), venom-gpt ($$$, most
// capable); venom-grok stays unconfigured/unavailable.
process.env.AI_INTEGRATIONS_OPENAI_BASE_URL = "http://127.0.0.1:9/v1";
process.env.AI_INTEGRATIONS_OPENAI_API_KEY = "ws-controls-test-key";
process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL = "http://127.0.0.1:9/v1";
process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY = "ws-controls-test-key";
process.env.AI_INTEGRATIONS_GEMINI_BASE_URL = "http://127.0.0.1:9/v1";
process.env.AI_INTEGRATIONS_GEMINI_API_KEY = "ws-controls-test-key";
for (const name of [
  "GEMINI_API_KEY",
  "OPENROUTER_API_KEY",
  "AI_INTEGRATIONS_OPENROUTER_BASE_URL",
  "AI_INTEGRATIONS_OPENROUTER_API_KEY",
]) {
  delete process.env[name];
}
// Billing reads env lazily; this suite decides per-test when enforcement
// is on. Scrub anything the host process carries.
delete process.env.VENOM_BILLING_ENFORCE;
delete process.env.VENOM_BILLING_WARN_RATIO;
delete process.env.STRIPE_SECRET_KEY;
delete process.env.STRIPE_WEBHOOK_SECRET;
delete process.env.VENOM_PLAN_FREE_ALLOWANCE_USD;
if (!process.env.SOURCE_ATTESTATION_SECRET && !process.env.SESSION_SECRET) {
  process.env.SOURCE_ATTESTATION_SECRET = "ws-controls-attestation-secret";
}

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import express from "express";
import pinoHttp from "pino-http";
import { eq, inArray, sql, and } from "drizzle-orm";
import {
  db,
  pool,
  venomAllowanceReservationsTable,
  venomBillingAccountsTable,
  venomSharedWorkspaceMembersTable,
  venomSharedWorkspacesTable,
  venomUsageEvents,
  venomWorkspaceAiControlsTable,
  venomWorkspaceMemberAiControlsTable,
} from "@workspace/db";

import { createApiLogger } from "../lib/logger.js";
import {
  allowanceBlockedBody,
  checkVenomAllowance,
  releaseVenomAllowanceReservation,
} from "../lib/venom-billing-enforcement.js";
import {
  approachingWarnRatio,
  planAllowanceMicros,
  venomPlan,
} from "../lib/venom-billing-plans.js";
import { applySubscriptionState } from "../lib/venom-billing-store.js";
import { insertVenomUsage } from "../lib/venom-usage-store.js";
import router, {
  overrideSharedWorkspaceUserDirectoryForTests,
  overrideSharedWorkspaceUserIdResolverForTests,
} from "./venom-shared-workspaces.js";

const RUN = `wsctl-${randomUUID().slice(0, 8)}`;
const trackedWorkspaceIds: string[] = [];
const trackedUserIds: string[] = [];

function newUserId(tag: string): string {
  const id = `${RUN}-${tag}`;
  trackedUserIds.push(id);
  return id;
}

function newWorkspaceId(): string {
  const id = randomUUID();
  trackedWorkspaceIds.push(id);
  return id;
}

const NOW = new Date();
const PERIOD_START = new Date(NOW.getTime() - 5 * 24 * 60 * 60 * 1000);
const PERIOD_END = new Date(NOW.getTime() + 25 * 24 * 60 * 60 * 1000);

// ─── Schema safety net (the dev database already carries all of this) ──────

async function ensureSchema(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS venom_shared_workspaces (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      created_by_clerk_user_id text NOT NULL,
      allow_sensitive_export boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS venom_shared_workspace_members (
      workspace_id uuid NOT NULL
        REFERENCES venom_shared_workspaces(id) ON DELETE CASCADE,
      clerk_user_id text NOT NULL,
      role text NOT NULL DEFAULT 'member',
      added_by_clerk_user_id text NOT NULL,
      added_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT venom_shared_workspace_members_pk
        PRIMARY KEY (workspace_id, clerk_user_id)
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS venom_workspace_ai_controls (
      workspace_id uuid PRIMARY KEY
        REFERENCES venom_shared_workspaces(id) ON DELETE CASCADE,
      default_member_cap_micros bigint,
      forced_selection_policy text,
      allowed_cost_tiers text[],
      updated_by_clerk_user_id text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS venom_workspace_member_ai_controls (
      workspace_id uuid NOT NULL
        REFERENCES venom_shared_workspaces(id) ON DELETE CASCADE,
      clerk_user_id text NOT NULL,
      cap_micros bigint,
      updated_by_clerk_user_id text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT venom_workspace_member_ai_controls_pk
        PRIMARY KEY (workspace_id, clerk_user_id)
    )
  `);
  // The respond route reads the caller's synced snapshot and SOP context.
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
}

// ─── Seed helpers ───────────────────────────────────────────────────────────

async function seedWorkspaceRow(id: string, name: string): Promise<void> {
  await db
    .insert(venomSharedWorkspacesTable)
    .values({ id, name, createdByClerkUserId: `${RUN}-creator` })
    .onConflictDoNothing();
}

async function seedOrgAccount(workspaceId: string): Promise<void> {
  await applySubscriptionState({
    scopeType: "workspace",
    scopeId: workspaceId,
    planId: "org",
    status: "active",
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    currentPeriodStart: PERIOD_START,
    currentPeriodEnd: PERIOD_END,
    cancelAtPeriodEnd: false,
  });
}

async function seedMembership(
  workspaceId: string,
  clerkUserId: string,
  role: "admin" | "member",
): Promise<void> {
  await db
    .insert(venomSharedWorkspaceMembersTable)
    .values({
      workspaceId,
      clerkUserId,
      role,
      addedByClerkUserId: `${RUN}-creator`,
    })
    .onConflictDoNothing();
}

async function spend(input: {
  userId: string;
  costMicros: number;
  billedWorkspaceId?: string | null;
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
    occurredAt: NOW,
  });
}

// ─── HTTP plumbing ──────────────────────────────────────────────────────────

type TestResponse = { status: number; body: any };

function assertStatus(response: TestResponse, expected: number): void {
  assert.equal(
    response.status,
    expected,
    `Expected HTTP ${expected}; received ${response.status}: ${JSON.stringify(response.body)}`,
  );
}

function makeRequester(baseUrl: string) {
  return async function request(
    path: string,
    options: RequestInit = {},
  ): Promise<TestResponse> {
    const response = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers: { "content-type": "application/json", ...options.headers },
    });
    const rawBody = await response.text();
    let body: unknown = null;
    if (rawBody) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = { rawBody: rawBody.slice(0, 2_000) };
      }
    }
    return { status: response.status, body };
  };
}

test.after(async () => {
  try {
    if (trackedUserIds.length > 0) {
      await db
        .delete(venomUsageEvents)
        .where(inArray(venomUsageEvents.userId, trackedUserIds));
      await db
        .delete(venomAllowanceReservationsTable)
        .where(inArray(venomAllowanceReservationsTable.scopeId, trackedUserIds));
      await db
        .delete(venomBillingAccountsTable)
        .where(inArray(venomBillingAccountsTable.scopeId, trackedUserIds));
      await db.execute(
        sql`DELETE FROM venom_workspaces WHERE clerk_user_id LIKE ${RUN + "%"}`,
      );
    }
    if (trackedWorkspaceIds.length > 0) {
      await db
        .delete(venomUsageEvents)
        .where(inArray(venomUsageEvents.billedWorkspaceId, trackedWorkspaceIds));
      await db
        .delete(venomAllowanceReservationsTable)
        .where(
          inArray(venomAllowanceReservationsTable.scopeId, trackedWorkspaceIds),
        );
      await db
        .delete(venomBillingAccountsTable)
        .where(inArray(venomBillingAccountsTable.scopeId, trackedWorkspaceIds));
      // Controls and memberships cascade with the workspace rows.
      await db
        .delete(venomSharedWorkspacesTable)
        .where(inArray(venomSharedWorkspacesTable.id, trackedWorkspaceIds));
    }
  } finally {
    await pool.end();
  }
});

// ─── 1. Admin endpoints: authorization, usage privacy, cap semantics ───────

test("admin usage and controls endpoints gate on role and never expose personal spend", async () => {
  await ensureSchema();
  const admin = newUserId("admin");
  const member = newUserId("member");
  const outsider = newUserId("outsider");
  const departed = newUserId("departed");

  const knownAccounts = new Map<string, string | null>([
    [admin, "Ada Admin"],
    [member, "Mo Member"],
    [outsider, "Olly Outsider"],
  ]);
  let activeUserId = admin;
  const restoreAuth = overrideSharedWorkspaceUserIdResolverForTests(
    () => activeUserId,
  );
  const restoreDirectory = overrideSharedWorkspaceUserDirectoryForTests({
    async getUser(userId) {
      if (!knownAccounts.has(userId)) return null;
      return { id: userId, name: knownAccounts.get(userId) ?? null };
    },
    async getUsers(userIds) {
      const names = new Map<string, string | null>();
      for (const userId of userIds) {
        if (knownAccounts.has(userId)) {
          names.set(userId, knownAccounts.get(userId) ?? null);
        }
      }
      return names;
    },
  });

  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    request.log = {
      info: () => {},
      warn: () => {},
      error: () => {},
    } as unknown as typeof request.log;
    next();
  });
  app.use(router);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as AddressInfo;
  const request = makeRequester(`http://127.0.0.1:${address.port}`);

  try {
    const created = await request("/venom/workspaces", {
      method: "POST",
      body: JSON.stringify({ name: `${RUN} Controls Guild` }),
    });
    assertStatus(created, 201);
    const ws: string = created.body.id;
    trackedWorkspaceIds.push(ws);
    const addMember = await request(`/venom/workspaces/${ws}/members`, {
      method: "POST",
      body: JSON.stringify({ userId: member }),
    });
    assert.ok(
      addMember.status === 200 || addMember.status === 201,
      `add member failed: ${addMember.status} ${JSON.stringify(addMember.body)}`,
    );
    await seedOrgAccount(ws);

    // Workspace-billed spend for two current members and one departed
    // account — plus personal-space spend that must never surface.
    await spend({ userId: member, costMicros: 2_500_000, billedWorkspaceId: ws });
    await spend({ userId: admin, costMicros: 1_000_000, billedWorkspaceId: ws });
    await spend({ userId: departed, costMicros: 750_000, billedWorkspaceId: ws });
    await spend({ userId: member, costMicros: 9_990_000 }); // personal space

    // --- Role gates: members get admin_required, outsiders access_denied
    const controlsPaths: Array<[string, string, string | undefined]> = [
      ["GET", `/venom/workspaces/${ws}/usage`, undefined],
      ["GET", `/venom/workspaces/${ws}/ai-controls`, undefined],
      [
        "PUT",
        `/venom/workspaces/${ws}/ai-controls`,
        JSON.stringify({
          defaultMemberCapUsd: 5,
          forcedSelectionPolicy: null,
          allowedCostTiers: null,
        }),
      ],
      [
        "PUT",
        `/venom/workspaces/${ws}/ai-controls/members/${member}`,
        JSON.stringify({ capUsd: 1 }),
      ],
      [
        "DELETE",
        `/venom/workspaces/${ws}/ai-controls/members/${member}`,
        undefined,
      ],
    ];
    activeUserId = member;
    for (const [method, path, body] of controlsPaths) {
      const denied = await request(path, { method, body });
      assertStatus(denied, 403);
      assert.equal(
        denied.body.code,
        "workspace_admin_required",
        `member on ${method} ${path}`,
      );
    }
    activeUserId = outsider;
    for (const [method, path, body] of controlsPaths) {
      const denied = await request(path, { method, body });
      assertStatus(denied, 403);
      assert.equal(
        denied.body.code,
        "workspace_access_denied",
        `outsider on ${method} ${path}`,
      );
    }

    // --- Admin usage summary: workspace-billed only, departed included
    activeUserId = admin;
    const usage = await request(`/venom/workspaces/${ws}/usage`);
    assertStatus(usage, 200);
    assert.equal(usage.body.covered, true);
    assert.equal(usage.body.totalUsd, 4.25); // 2.5 + 1.0 + 0.75 (departed)
    assert.equal(
      usage.body.allowanceUsd,
      Math.round(planAllowanceMicros(venomPlan("org")) / 10_000) / 100,
    );
    assert.equal(usage.body.members.length, 2);
    const [top, second] = usage.body.members;
    assert.equal(top.clerkUserId, member); // sorted by spend, descending
    assert.equal(top.name, "Mo Member");
    assert.equal(top.role, "member");
    assert.equal(top.spentUsd, 2.5); // personal 9.99 nowhere in sight
    assert.equal(top.capUsd, null);
    assert.equal(top.capState, "ok");
    assert.equal("capSource" in top, false);
    assert.equal(second.clerkUserId, admin);
    assert.equal(second.spentUsd, 1);
    // The privacy line: no admin payload may carry personal-space figures.
    assert.ok(!JSON.stringify(usage.body).includes("9.99"));

    // --- Controls document: defaults, writes, normalization, validation
    const blank = await request(`/venom/workspaces/${ws}/ai-controls`);
    assertStatus(blank, 200);
    assert.deepEqual(blank.body, {
      defaultMemberCapUsd: null,
      forcedSelectionPolicy: null,
      allowedCostTiers: null,
      memberOverrides: [],
    });

    const saved = await request(`/venom/workspaces/${ws}/ai-controls`, {
      method: "PUT",
      body: JSON.stringify({
        defaultMemberCapUsd: 2,
        forcedSelectionPolicy: "auto-cheapest",
        allowedCostTiers: ["$", "$$"],
      }),
    });
    assertStatus(saved, 200);
    assert.equal(saved.body.defaultMemberCapUsd, 2);
    assert.equal(saved.body.forcedSelectionPolicy, "auto-cheapest");
    assert.deepEqual(saved.body.allowedCostTiers, ["$", "$$"]);

    // Allowing every tier is the same as no tier lock at all.
    const fullSet = await request(`/venom/workspaces/${ws}/ai-controls`, {
      method: "PUT",
      body: JSON.stringify({
        defaultMemberCapUsd: 2,
        forcedSelectionPolicy: null,
        allowedCostTiers: ["$$", "$", "$$$"],
      }),
    });
    assertStatus(fullSet, 200);
    assert.equal(fullSet.body.allowedCostTiers, null);

    for (const bad of [
      { defaultMemberCapUsd: -1, forcedSelectionPolicy: null, allowedCostTiers: null },
      { defaultMemberCapUsd: 2_000_000, forcedSelectionPolicy: null, allowedCostTiers: null },
      { defaultMemberCapUsd: null, forcedSelectionPolicy: "manual", allowedCostTiers: null },
      { defaultMemberCapUsd: null, forcedSelectionPolicy: null, allowedCostTiers: [] },
      { defaultMemberCapUsd: null, forcedSelectionPolicy: null, allowedCostTiers: ["$$$$"] },
    ]) {
      const rejected = await request(`/venom/workspaces/${ws}/ai-controls`, {
        method: "PUT",
        body: JSON.stringify(bad),
      });
      assertStatus(rejected, 400);
    }

    // --- Per-member overrides: set, explicit uncap, clear, non-member 404
    const overrideSet = await request(
      `/venom/workspaces/${ws}/ai-controls/members/${member}`,
      { method: "PUT", body: JSON.stringify({ capUsd: 1 }) },
    );
    assertStatus(overrideSet, 200);
    assert.deepEqual(
      overrideSet.body.memberOverrides.map((entry: any) => ({
        clerkUserId: entry.clerkUserId,
        capUsd: entry.capUsd,
      })),
      [{ clerkUserId: member, capUsd: 1 }],
    );

    let rows = (await request(`/venom/workspaces/${ws}/usage`)).body.members;
    assert.equal(rows[0].capUsd, 1);
    assert.equal(rows[0].capSource, "override");
    assert.equal(rows[0].capState, "exhausted"); // 2.5 spent ≥ 1 cap
    assert.equal(rows[1].capUsd, 2);
    assert.equal(rows[1].capSource, "default");
    assert.equal(rows[1].capState, "ok"); // 1.0 < 2 × warn ratio

    // A tighter default pushes the admin over the approach threshold.
    const tighter = await request(`/venom/workspaces/${ws}/ai-controls`, {
      method: "PUT",
      body: JSON.stringify({
        defaultMemberCapUsd: 1.2,
        forcedSelectionPolicy: null,
        allowedCostTiers: null,
      }),
    });
    assertStatus(tighter, 200);
    rows = (await request(`/venom/workspaces/${ws}/usage`)).body.members;
    assert.equal(rows[1].capUsd, 1.2);
    assert.equal(rows[1].capState, "approaching"); // 1.0 ≥ 1.2 × 0.8

    // Explicit uncap: the override row exists, the cap does not.
    const uncapped = await request(
      `/venom/workspaces/${ws}/ai-controls/members/${member}`,
      { method: "PUT", body: JSON.stringify({ capUsd: null }) },
    );
    assertStatus(uncapped, 200);
    rows = (await request(`/venom/workspaces/${ws}/usage`)).body.members;
    assert.equal(rows[0].capUsd, null);
    assert.equal(rows[0].capSource, "override");
    assert.equal(rows[0].capState, "ok");

    // Clearing the override returns the member to the workspace default.
    const cleared = await request(
      `/venom/workspaces/${ws}/ai-controls/members/${member}`,
      { method: "DELETE" },
    );
    assertStatus(cleared, 200);
    assert.deepEqual(cleared.body.memberOverrides, []);
    rows = (await request(`/venom/workspaces/${ws}/usage`)).body.members;
    assert.equal(rows[0].capUsd, 1.2);
    assert.equal(rows[0].capSource, "default");
    assert.equal(rows[0].capState, "exhausted"); // 2.5 ≥ 1.2

    // Overrides bind to current members only.
    const notMember = await request(
      `/venom/workspaces/${ws}/ai-controls/members/${outsider}`,
      { method: "PUT", body: JSON.stringify({ capUsd: 1 }) },
    );
    assertStatus(notMember, 404);
    const badCap = await request(
      `/venom/workspaces/${ws}/ai-controls/members/${member}`,
      { method: "PUT", body: JSON.stringify({ capUsd: -5 }) },
    );
    assertStatus(badCap, 400);

    // --- Removal: the list follows membership, the total follows the ledger
    const removed = await request(
      `/venom/workspaces/${ws}/members/${member}`,
      { method: "DELETE" },
    );
    assert.ok(
      removed.status === 200 || removed.status === 204,
      `remove member failed: ${removed.status} ${JSON.stringify(removed.body)}`,
    );
    const afterRemoval = await request(`/venom/workspaces/${ws}/usage`);
    assertStatus(afterRemoval, 200);
    assert.equal(afterRemoval.body.members.length, 1);
    assert.equal(afterRemoval.body.members[0].clerkUserId, admin);
    assert.equal(afterRemoval.body.totalUsd, 4.25); // ledger keeps the past

    // The evicted member is now just another outsider.
    activeUserId = member;
    const evicted = await request(`/venom/workspaces/${ws}/ai-controls`);
    assertStatus(evicted, 403);
    assert.equal(evicted.body.code, "workspace_access_denied");
  } finally {
    server.close();
    restoreAuth();
    restoreDirectory();
  }
});

// ─── 2. Enforcement precedence at the single allowance gate ────────────────

test("member caps bind workspace-billed requests under allowance precedence", async () => {
  await ensureSchema();
  const ws = newWorkspaceId();
  await seedWorkspaceRow(ws, `${RUN} Enforce Guild`);
  await seedOrgAccount(ws);
  await db.insert(venomWorkspaceAiControlsTable).values({
    workspaceId: ws,
    defaultMemberCapMicros: 1_000_000, // $1 default member cap
    forcedSelectionPolicy: null,
    allowedCostTiers: null,
    updatedByClerkUserId: `${RUN}-enfadmin`,
  });

  const capped = newUserId("capped");
  const uncapped = newUserId("uncapped");
  const zeroed = newUserId("zeroed");
  process.env.VENOM_BILLING_ENFORCE = "1";
  try {
    // Fresh member: comfortably under the default cap.
    let decision = await checkVenomAllowance({ userId: capped, workspaceId: ws });
    assert.equal(decision.payer.kind, "workspace");
    assert.equal(decision.billedWorkspaceId, ws);
    assert.equal(decision.allowed, true);
    assert.equal(decision.memberCapState, "ok");

    // Past the warn ratio: still served, but flagged approaching.
    await spend({ userId: capped, costMicros: 850_000, billedWorkspaceId: ws });
    decision = await checkVenomAllowance({ userId: capped, workspaceId: ws });
    assert.equal(decision.allowed, true);
    assert.equal(decision.memberCapState, "approaching");
    assert.equal(decision.approaching, true);
    assert.ok(0.85 >= approachingWarnRatio()); // the fixture sits in the band

    // Over the cap: blocked with the member-cap code and workspace-specific
    // copy — clearly an admin-set limit, not a personal allowance.
    await spend({ userId: capped, costMicros: 200_000, billedWorkspaceId: ws });
    const memberCapBlock = await checkVenomAllowance({
      userId: capped,
      workspaceId: ws,
    });
    assert.equal(memberCapBlock.allowed, false);
    assert.equal(memberCapBlock.blockedCode, "workspace_member_cap_reached");
    assert.equal(memberCapBlock.memberCapState, "exhausted");
    const memberCapBody = allowanceBlockedBody(memberCapBlock);
    assert.equal(memberCapBody.code, "workspace_member_cap_reached");
    assert.ok(memberCapBody.error.includes(`${RUN} Enforce Guild`));
    assert.ok(memberCapBody.error.toLowerCase().includes("personal"));

    // The same member's personal space is untouched by the workspace cap.
    const personal = await checkVenomAllowance({ userId: capped });
    assert.equal(personal.allowed, true);
    assert.equal(personal.billedWorkspaceId, null);
    assert.equal(personal.memberCapState, undefined);

    // An explicitly-uncapped override outruns the workspace default…
    await db.insert(venomWorkspaceMemberAiControlsTable).values({
      workspaceId: ws,
      clerkUserId: uncapped,
      capMicros: null,
      updatedByClerkUserId: `${RUN}-enfadmin`,
    });
    await spend({ userId: uncapped, costMicros: 3_000_000, billedWorkspaceId: ws });
    decision = await checkVenomAllowance({ userId: uncapped, workspaceId: ws });
    assert.equal(decision.allowed, true);
    assert.equal(decision.memberCapState, undefined);

    // …and admissions stamp their reservation with the asking member.
    const reserved = await checkVenomAllowance({
      userId: uncapped,
      workspaceId: ws,
      reserve: true,
    });
    assert.equal(reserved.allowed, true);
    assert.ok(reserved.reservationId);
    const reservationRows = await db
      .select({
        reservedFor: venomAllowanceReservationsTable.reservedForClerkUserId,
      })
      .from(venomAllowanceReservationsTable)
      .where(eq(venomAllowanceReservationsTable.id, reserved.reservationId!));
    assert.equal(reservationRows.length, 1);
    assert.equal(reservationRows[0].reservedFor, uncapped);
    await releaseVenomAllowanceReservation(reserved.reservationId!);

    // A zero override is a deliberate block before the first cent.
    await db.insert(venomWorkspaceMemberAiControlsTable).values({
      workspaceId: ws,
      clerkUserId: zeroed,
      capMicros: 0,
      updatedByClerkUserId: `${RUN}-enfadmin`,
    });
    const zeroBlock = await checkVenomAllowance({ userId: zeroed, workspaceId: ws });
    assert.equal(zeroBlock.allowed, false);
    assert.equal(zeroBlock.blockedCode, "workspace_member_cap_reached");

    // Precedence: once the workspace allowance itself is gone, that wall
    // answers — even for a member who is also over their cap.
    await spend({
      userId: newUserId("burner"),
      costMicros: planAllowanceMicros(venomPlan("org")),
      billedWorkspaceId: ws,
    });
    const allowanceBlock = await checkVenomAllowance({
      userId: capped,
      workspaceId: ws,
    });
    assert.equal(allowanceBlock.allowed, false);
    assert.equal(allowanceBlock.blockedCode, "workspace_allowance_exhausted");
    const allowanceBody = allowanceBlockedBody(allowanceBlock);
    assert.notEqual(allowanceBody.error, memberCapBody.error);

    // And the personal wall keeps its own, third message.
    const personalUser = newUserId("pers");
    await spend({
      userId: personalUser,
      costMicros: planAllowanceMicros(venomPlan("free")),
    });
    const personalBlock = await checkVenomAllowance({ userId: personalUser });
    assert.equal(personalBlock.allowed, false);
    assert.equal(personalBlock.blockedCode, "personal_allowance_exhausted");
    assert.equal(
      new Set([
        memberCapBody.code,
        allowanceBody.code,
        allowanceBlockedBody(personalBlock).code,
      ]).size,
      3,
    );
  } finally {
    delete process.env.VENOM_BILLING_ENFORCE;
  }

  // Keyless/unenforced deployments stand down entirely.
  const standDown = await checkVenomAllowance({ userId: capped, workspaceId: ws });
  assert.equal(standDown.allowed, true);
  assert.equal(standDown.memberCapState, undefined);
  assert.equal(standDown.reservationId, undefined);
});

// ─── 3. The respond route under a workspace model lock ─────────────────────

const CLERK_AUTH_BRAND = Symbol.for("@clerk/express.auth");
let activeRespondUserId: string | null = null;

function fakeClerkAuthMiddleware(): express.RequestHandler {
  return (req, _res, next) => {
    const authHandler = () => ({
      tokenType: "session_token",
      userId: activeRespondUserId,
      sessionId: activeRespondUserId ? "sess_ws_controls" : null,
      sessionClaims: null,
      sessionStatus: activeRespondUserId ? "active" : "signed-out",
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

/** Store a snapshot whose modelPreferences carry a manual selection. */
async function seedManualSnapshot(userId: string): Promise<void> {
  const state = {
    schemaVersion: 1,
    modelPreferences: {
      enabledModelIds: ["venom-gpt", "venom-claude"],
      defaultModelId: "venom-gpt",
      activeModelId: "venom-gpt",
      selectionPolicy: "manual",
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

async function setControls(
  workspaceId: string,
  values: {
    forcedSelectionPolicy: "auto-cheapest" | "auto-max-power" | null;
    allowedCostTiers: string[] | null;
  },
): Promise<void> {
  await db
    .insert(venomWorkspaceAiControlsTable)
    .values({
      workspaceId,
      defaultMemberCapMicros: null,
      forcedSelectionPolicy: values.forcedSelectionPolicy,
      allowedCostTiers: values.allowedCostTiers,
      updatedByClerkUserId: `${RUN}-lockadmin`,
    })
    .onConflictDoUpdate({
      target: venomWorkspaceAiControlsTable.workspaceId,
      set: {
        forcedSelectionPolicy: values.forcedSelectionPolicy,
        allowedCostTiers: values.allowedCostTiers,
      },
    });
}

test("the respond route enforces workspace model locks server-side", async (t) => {
  const { default: venomRouter } = await import("./venom.js");
  await ensureSchema();

  const app = express();
  app.use(
    pinoHttp({
      logger: createApiLogger({ level: "silent", destination: { write() {} } }),
    }),
  );
  app.use(express.json({ limit: "1mb" }));
  app.use(fakeClerkAuthMiddleware());
  app.use("/api", venomRouter);
  const server = await new Promise<http.Server>((resolve) => {
    const created = app.listen(0, "127.0.0.1", () => resolve(created));
  });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const user = newUserId("locked");
  const ws = newWorkspaceId();
  const wsBare = newWorkspaceId();
  await seedWorkspaceRow(ws, `${RUN} Locked Guild`);
  await seedWorkspaceRow(wsBare, `${RUN} Bare Guild`);
  await seedOrgAccount(ws); // wsBare deliberately has no org plan
  await seedMembership(ws, user, "member");
  await seedMembership(wsBare, user, "member");
  await seedManualSnapshot(user);
  activeRespondUserId = user;

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
      projectId: "ws-controls-project",
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

  function startEvent(raw: string): Record<string, unknown> {
    const event = parseSseEvents(raw).find((entry) => "modelId" in entry);
    assert.ok(event, "the stream opens with the metadata event");
    return event;
  }

  try {
    await t.test("personal-space requests are never touched", async () => {
      const { status, text } = await postRespond(respondBody({}));
      assert.equal(status, 200);
      const event = startEvent(text);
      assert.equal(event.modelId, "venom-gpt");
      assert.equal("selection" in event, false);
    });

    await t.test("a forced policy beats the member's manual pick", async () => {
      await setControls(ws, {
        forcedSelectionPolicy: "auto-cheapest",
        allowedCostTiers: null,
      });
      const { status, text } = await postRespond(
        respondBody({ workspaceId: ws }),
      );
      assert.equal(status, 200);
      const event = startEvent(text);
      assert.equal(event.modelId, "venom-gemini");
      assert.deepEqual(event.selection, {
        policy: "auto-cheapest",
        managed: true,
      });
    });

    await t.test("an in-tier manual pick streams unmanaged", async () => {
      await setControls(ws, {
        forcedSelectionPolicy: null,
        allowedCostTiers: ["$$", "$$$"],
      });
      const { status, text } = await postRespond(
        respondBody({ workspaceId: ws, modelId: "venom-claude" }),
      );
      assert.equal(status, 200);
      const event = startEvent(text);
      assert.equal(event.modelId, "venom-claude");
      assert.equal("selection" in event, false);
    });

    await t.test("an out-of-tier manual pick clamps and says so", async () => {
      await setControls(ws, {
        forcedSelectionPolicy: null,
        allowedCostTiers: ["$"],
      });
      const { status, text } = await postRespond(
        respondBody({ workspaceId: ws, modelId: "venom-gpt" }),
      );
      assert.equal(status, 200);
      const event = startEvent(text);
      assert.equal(event.modelId, "venom-gemini"); // cheapest allowed model
      assert.deepEqual(event.selection, { policy: "manual", managed: true });
    });

    await t.test("forced policy and tier lock compose", async () => {
      await setControls(ws, {
        forcedSelectionPolicy: "auto-max-power",
        allowedCostTiers: ["$", "$$"],
      });
      const { status, text } = await postRespond(
        respondBody({ workspaceId: ws }),
      );
      assert.equal(status, 200);
      const event = startEvent(text);
      // venom-gpt ($$$) is locked out; venom-claude is the most capable
      // model left standing (venom-grok is unconfigured here).
      assert.equal(event.modelId, "venom-claude");
      assert.deepEqual(event.selection, {
        policy: "auto-max-power",
        managed: true,
      });
    });

    await t.test("a workspace without a live org plan never locks", async () => {
      await setControls(wsBare, {
        forcedSelectionPolicy: "auto-cheapest",
        allowedCostTiers: ["$"],
      });
      const { status, text } = await postRespond(
        respondBody({ workspaceId: wsBare, modelId: "venom-claude" }),
      );
      assert.equal(status, 200);
      const event = startEvent(text);
      assert.equal(event.modelId, "venom-claude");
      assert.equal("selection" in event, false);
    });

    await t.test("non-members cannot ride a workspace context", async () => {
      activeRespondUserId = newUserId("stranger");
      try {
        const { status, text } = await postRespond(
          respondBody({ workspaceId: ws }),
        );
        assert.equal(status, 403);
        assert.equal(JSON.parse(text).code, "workspace_access_denied");
      } finally {
        activeRespondUserId = user;
      }
    });

    await t.test(
      "a capped member is refused in the workspace, not in personal space",
      async () => {
        await db.insert(venomWorkspaceMemberAiControlsTable).values({
          workspaceId: ws,
          clerkUserId: user,
          capMicros: 0,
          updatedByClerkUserId: `${RUN}-lockadmin`,
        });
        process.env.VENOM_BILLING_ENFORCE = "1";
        try {
          const blocked = await postRespond(respondBody({ workspaceId: ws }));
          assert.equal(blocked.status, 402);
          const body = JSON.parse(blocked.text);
          assert.equal(body.code, "workspace_member_cap_reached");
          assert.ok(body.error.includes(`${RUN} Locked Guild`));

          const personal = await postRespond(respondBody({}));
          assert.equal(personal.status, 200);
          const event = startEvent(personal.text);
          assert.equal(event.modelId, "venom-gpt");
        } finally {
          delete process.env.VENOM_BILLING_ENFORCE;
          await db
            .delete(venomWorkspaceMemberAiControlsTable)
            .where(
              and(
                eq(venomWorkspaceMemberAiControlsTable.workspaceId, ws),
                eq(venomWorkspaceMemberAiControlsTable.clerkUserId, user),
              ),
            );
        }
      },
    );
  } finally {
    server.close();
  }
});
