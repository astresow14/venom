import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  db,
  venomAllowanceReservationsTable,
  venomBuildPackageRevisionsTable,
  venomBuildRunsTable,
  venomPortfolioAppsTable,
  venomPortfolioSourceVersionsTable,
  venomUsageEvents,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import express from "express";
import { requestBoundMicros } from "../lib/venom-billing-enforcement.js";
import { planAllowanceMicros, venomPlan } from "../lib/venom-billing-plans.js";
import { insertVenomUsage } from "../lib/venom-usage-store.js";
import router, {
  overrideVenomBuildRunGeneratorForTests,
  overrideVenomBuildRunSchedulerForTests,
  overrideVenomBuildRunUserIdResolverForTests,
  processVenomBuildRunForTests,
  reconcileVenomBuildRunQueueForTests,
} from "./venom-build-runs.js";

type TestResponse = {
  status: number;
  body: any;
};

function assertStatus(response: TestResponse, expected: number): void {
  assert.equal(
    response.status,
    expected,
    `Expected HTTP ${expected}; received ${response.status}: ${JSON.stringify(response.body)}`,
  );
}

test("build run routes isolate accounts and keep approvals immutable", async () => {
  const suffix = randomUUID();
  const ownerA = `build-route-a-${suffix}`;
  const ownerB = `build-route-b-${suffix}`;
  const marker = `private-build-requirement-${suffix}`;
  let activeUserId = ownerA;
  const capturedLogs: unknown[] = [];
  const restoreAuth = overrideVenomBuildRunUserIdResolverForTests(
    () => activeUserId,
  );
  const scheduled: string[] = [];
  const restoreScheduler = overrideVenomBuildRunSchedulerForTests(
    (_userId, runId) => scheduled.push(runId),
  );
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    request.log = {
      info: (...args: unknown[]) => capturedLogs.push(args),
      warn: (...args: unknown[]) => capturedLogs.push(args),
      error: (...args: unknown[]) => capturedLogs.push(args),
    } as unknown as typeof request.log;
    next();
  });
  app.use(router);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  async function request(
    path: string,
    options: RequestInit = {},
  ): Promise<TestResponse> {
    const response = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers: {
        "content-type": "application/json",
        ...options.headers,
      },
    });
    const rawBody = await response.text();
    let body: unknown = null;
    if (rawBody) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = rawBody;
      }
    }
    return { status: response.status, body };
  }

  try {
    const [foreignApp] = await db
      .insert(venomPortfolioAppsTable)
      .values({
        clerkUserId: ownerB,
        name: "Foreign source",
        purpose: "Must remain isolated",
        brand: "Private",
        currentSourceVersion: 1,
      })
      .returning();
    const [foreignVersion] = await db
      .insert(venomPortfolioSourceVersionsTable)
      .values({
        appId: foreignApp.id,
        clerkUserId: ownerB,
        versionNumber: 1,
        sourceType: "zip",
        packageObjectPath: `test/${suffix}.zip`,
        archiveFilename: "source.zip",
        archiveBytes: 128,
        checksumSha256: "a".repeat(64),
        manifest: {
          formatVersion: 1,
          rootKind: "single-project",
          totalEntries: 1,
          safeFileCount: 1,
          excludedSensitiveFileCount: 0,
          files: ["README.md"],
          projectFiles: ["README.md"],
          detectedStack: [],
        },
      })
      .returning();

    const idempotencyKey = randomUUID().replaceAll("-", "_");
    const createBody = {
      targetType: "website",
      targetName: "Reviewable launch",
      requirements: marker,
      constraints: "Do not deploy.",
      brandDirection: "Quiet and direct.",
      appId: null,
      sourceVersionId: null,
      projectId: null,
      sopRevisionIds: [],
      idempotencyKey,
    };
    const created = await request("/venom/build-runs", {
      method: "POST",
      body: JSON.stringify(createBody),
    });
    assertStatus(created, 201);
    assert.equal(created.body.status, "queued");
    assert.equal(scheduled.at(-1), created.body.id);

    const duplicate = await request("/venom/build-runs", {
      method: "POST",
      body: JSON.stringify(createBody),
    });
    assertStatus(duplicate, 201);
    assert.equal(duplicate.body.id, created.body.id);

    const idempotencyConflict = await request("/venom/build-runs", {
      method: "POST",
      body: JSON.stringify({ ...createBody, targetName: "Different target" }),
    });
    assertStatus(idempotencyConflict, 409);

    const foreignReference = await request("/venom/build-runs", {
      method: "POST",
      body: JSON.stringify({
        ...createBody,
        idempotencyKey: randomUUID().replaceAll("-", "_"),
        appId: foreignApp.id,
        sourceVersionId: foreignVersion.id,
      }),
    });
    assertStatus(foreignReference, 400);

    const [ownedSourceApp] = await db
      .insert(venomPortfolioAppsTable)
      .values({
        clerkUserId: ownerA,
        name: "Pinned source",
        purpose: "Verify immutable source references",
        brand: "Reference",
        currentSourceVersion: 1,
      })
      .returning();
    const [ownedSourceVersion] = await db
      .insert(venomPortfolioSourceVersionsTable)
      .values({
        appId: ownedSourceApp.id,
        clerkUserId: ownerA,
        versionNumber: 1,
        sourceType: "zip",
        packageObjectPath: `test/${suffix}-owned.zip`,
        archiveFilename: "owned-source.zip",
        archiveBytes: 256,
        checksumSha256: "c".repeat(64),
        manifest: {
          formatVersion: 1,
          rootKind: "single-project",
          totalEntries: 1,
          safeFileCount: 1,
          excludedSensitiveFileCount: 0,
          files: ["package.json"],
          projectFiles: ["package.json"],
          detectedStack: ["TypeScript"],
        },
      })
      .returning();
    const pinnedRun = await request("/venom/build-runs", {
      method: "POST",
      body: JSON.stringify({
        ...createBody,
        idempotencyKey: randomUUID().replaceAll("-", "_"),
        targetName: "Pinned source deletion test",
        appId: ownedSourceApp.id,
        sourceVersionId: ownedSourceVersion.id,
      }),
    });
    assertStatus(pinnedRun, 201);
    await db
      .delete(venomPortfolioAppsTable)
      .where(eq(venomPortfolioAppsTable.id, ownedSourceApp.id));
    const [preservedPin] = await db
      .select()
      .from(venomBuildRunsTable)
      .where(eq(venomBuildRunsTable.id, pinnedRun.body.id));
    assert.equal(preservedPin.appId, ownedSourceApp.id);
    assert.equal(preservedPin.sourceVersionId, ownedSourceVersion.id);
    await processVenomBuildRunForTests(ownerA, pinnedRun.body.id);
    const failedPinnedRun = await request(
      `/venom/build-runs/${pinnedRun.body.id}`,
    );
    assertStatus(failedPinnedRun, 200);
    assert.equal(failedPinnedRun.body.status, "failed");
    assert.equal(
      failedPinnedRun.body.failureCode,
      "pinned_reference_unavailable",
    );
    assert.equal(failedPinnedRun.body.request.appId, ownedSourceApp.id);
    assert.equal(
      failedPinnedRun.body.request.sourceVersionId,
      ownedSourceVersion.id,
    );

    const cancelled = await request(
      `/venom/build-runs/${created.body.id}/cancel`,
      {
        method: "POST",
        body: JSON.stringify({ reason: "Changed direction" }),
      },
    );
    assertStatus(cancelled, 200);
    assert.equal(cancelled.body.status, "cancelled");

    const retried = await request(
      `/venom/build-runs/${created.body.id}/retry`,
      { method: "POST" },
    );
    assertStatus(retried, 202);
    assert.equal(retried.body.status, "queued");
    assert.equal(retried.body.attempt, 2);
    assert.equal(retried.body.request.requirements, marker);

    await request(`/venom/build-runs/${created.body.id}/cancel`, {
      method: "POST",
      body: JSON.stringify({ reason: "End retry test" }),
    });

    const [reviewRun] = await db
      .insert(venomBuildRunsTable)
      .values({
        clerkUserId: ownerA,
        idempotencyKey: randomUUID().replaceAll("-", "_"),
        targetType: "brand",
        targetName: "Immutable identity",
        requirements: "Define a distinct identity.",
        constraints: "No publishing.",
        brandDirection: "High contrast.",
        sopRevisionIds: [],
        status: "review_required",
        progress: 100,
        currentRevisionNumber: 1,
      })
      .returning();
    const packageData = {
      formatVersion: 1 as const,
      targetType: "brand" as const,
      title: "Immutable identity",
      productBrief: {
        summary: "A reviewed brand definition.",
        audience: ["Product team"],
        outcomes: ["A coherent identity"],
      },
      functionalScope: ["Define naming and messaging"],
      brandDirection: ["High contrast"],
      contentRequirements: [],
      serviceFlowRequirements: [],
      sourceReferences: [],
      sopReferences: [],
      dataNeeds: [],
      integrationNeeds: [],
      permissionRequests: [
        {
          capability: "Publish brand assets",
          reason: "Only after a separate launch review",
          required: false,
        },
      ],
      acceptanceChecks: ["Identity is internally consistent"],
      launchConstraints: [
        "Human approval is required before any provisioning or external action.",
      ],
    };
    const [revision] = await db
      .insert(venomBuildPackageRevisionsTable)
      .values({
        runId: reviewRun.id,
        clerkUserId: ownerA,
        revisionNumber: 1,
        reason: "Initial generated package",
        package: packageData,
        checksumSha256: "b".repeat(64),
      })
      .returning();

    activeUserId = ownerB;
    assertStatus(await request(`/venom/build-runs/${reviewRun.id}`), 404);
    assertStatus(
      await request(`/venom/build-runs/${reviewRun.id}/approve`, {
        method: "POST",
        body: JSON.stringify({ revisionId: revision.id }),
      }),
      404,
    );

    activeUserId = ownerA;
    const jsonExport = await request(
      `/venom/build-runs/${reviewRun.id}/export/json`,
    );
    assertStatus(jsonExport, 200);
    assert.deepEqual(jsonExport.body, packageData);
    const markdownExport = await request(
      `/venom/build-runs/${reviewRun.id}/export/markdown`,
    );
    assertStatus(markdownExport, 200);
    assert.match(markdownExport.body, /# Immutable identity/);
    assert.match(markdownExport.body, /Human approval is required/);

    const approved = await request(
      `/venom/build-runs/${reviewRun.id}/approve`,
      {
        method: "POST",
        body: JSON.stringify({ revisionId: revision.id }),
      },
    );
    assertStatus(approved, 200);
    assert.equal(approved.body.status, "ready_for_provisioning");
    assert.equal(approved.body.approvedRevisionId, revision.id);
    assert.ok(
      approved.body.events.some(
        (event: { eventType: string }) =>
          event.eventType === "ready_for_provisioning",
      ),
    );

    assertStatus(
      await request(`/venom/build-runs/${reviewRun.id}/approve`, {
        method: "POST",
        body: JSON.stringify({ revisionId: revision.id }),
      }),
      409,
    );
    assertStatus(
      await request(`/venom/build-runs/${reviewRun.id}/reject`, {
        method: "POST",
        body: JSON.stringify({ reason: "Too late" }),
      }),
      409,
    );
    assertStatus(
      await request(`/venom/build-runs/${reviewRun.id}/revise`, {
        method: "POST",
        body: JSON.stringify({ instruction: "Mutate approved package" }),
      }),
      409,
    );

    const [immutableRevision] = await db
      .select()
      .from(venomBuildPackageRevisionsTable)
      .where(
        and(
          eq(venomBuildPackageRevisionsTable.id, revision.id),
          eq(venomBuildPackageRevisionsTable.clerkUserId, ownerA),
        ),
      );
    assert.deepEqual(immutableRevision.package, packageData);
    assert.equal(immutableRevision.approvedBy, ownerA);
    assert.ok(immutableRevision.approvedAt);

    const [capacityActive] = await db
      .insert(venomBuildRunsTable)
      .values({
        clerkUserId: ownerA,
        idempotencyKey: randomUUID().replaceAll("-", "_"),
        targetType: "app",
        targetName: "Capacity active retry",
        requirements: "Hold one active slot.",
        constraints: "",
        brandDirection: "",
        sopRevisionIds: [],
        status: "preparing",
        progress: 20,
      })
      .returning();
    const retryCandidates = await db
      .insert(venomBuildRunsTable)
      .values([
        {
          clerkUserId: ownerA,
          idempotencyKey: randomUUID().replaceAll("-", "_"),
          targetType: "app",
          targetName: "Retry race one",
          requirements: "Retry safely.",
          constraints: "",
          brandDirection: "",
          sopRevisionIds: [],
          status: "failed",
          progress: 100,
        },
        {
          clerkUserId: ownerA,
          idempotencyKey: randomUUID().replaceAll("-", "_"),
          targetType: "website",
          targetName: "Retry race two",
          requirements: "Retry safely.",
          constraints: "",
          brandDirection: "",
          sopRevisionIds: [],
          status: "failed",
          progress: 100,
        },
      ])
      .returning();
    const retryRaceResponses = await Promise.all(
      retryCandidates.map((candidate) =>
        request(`/venom/build-runs/${candidate.id}/retry`, { method: "POST" }),
      ),
    );
    assert.deepEqual(
      retryRaceResponses.map((response) => response.status).sort(),
      [202, 409],
    );
    await db
      .update(venomBuildRunsTable)
      .set({ status: "cancelled", progress: 100 })
      .where(
        inArray(venomBuildRunsTable.id, [
          capacityActive.id,
          ...retryCandidates.map((candidate) => candidate.id),
        ]),
      );

    const [revisionCapacityActive] = await db
      .insert(venomBuildRunsTable)
      .values({
        clerkUserId: ownerA,
        idempotencyKey: randomUUID().replaceAll("-", "_"),
        targetType: "app",
        targetName: "Capacity active revision",
        requirements: "Hold one active slot.",
        constraints: "",
        brandDirection: "",
        sopRevisionIds: [],
        status: "preparing",
        progress: 20,
      })
      .returning();
    const revisionCandidates = await db
      .insert(venomBuildRunsTable)
      .values([
        {
          clerkUserId: ownerA,
          idempotencyKey: randomUUID().replaceAll("-", "_"),
          targetType: "brand",
          targetName: "Revision race one",
          requirements: "Revise safely.",
          constraints: "",
          brandDirection: "",
          sopRevisionIds: [],
          status: "review_required",
          progress: 100,
          currentRevisionNumber: 1,
        },
        {
          clerkUserId: ownerA,
          idempotencyKey: randomUUID().replaceAll("-", "_"),
          targetType: "customer_service_flow",
          targetName: "Revision race two",
          requirements: "Revise safely.",
          constraints: "",
          brandDirection: "",
          sopRevisionIds: [],
          status: "review_required",
          progress: 100,
          currentRevisionNumber: 1,
        },
      ])
      .returning();
    const revisionRaceResponses = await Promise.all(
      revisionCandidates.map((candidate) =>
        request(`/venom/build-runs/${candidate.id}/revise`, {
          method: "POST",
          body: JSON.stringify({ instruction: "Add one acceptance check." }),
        }),
      ),
    );
    assert.deepEqual(
      revisionRaceResponses.map((response) => response.status).sort(),
      [202, 409],
    );
    await db
      .update(venomBuildRunsTable)
      .set({ status: "cancelled", progress: 100 })
      .where(
        inArray(venomBuildRunsTable.id, [
          revisionCapacityActive.id,
          ...revisionCandidates.map((candidate) => candidate.id),
        ]),
      );

    const [recoveredQueuedRun] = await db
      .insert(venomBuildRunsTable)
      .values({
        clerkUserId: ownerA,
        idempotencyKey: randomUUID().replaceAll("-", "_"),
        targetType: "website",
        targetName: "Restart recovery",
        requirements: "Resume this durable queued request.",
        constraints: "",
        brandDirection: "",
        sopRevisionIds: [],
        status: "queued",
        progress: 0,
      })
      .returning();
    scheduled.length = 0;
    // Rescue only claims rows older than the grace period. Run reconcile on a
    // future clock so this fresh fixture qualifies inside this invocation
    // only — backdating createdAt instead would expose the row to the live
    // dev server's reconcile loop on the shared database.
    await reconcileVenomBuildRunQueueForTests(Date.now() + 3 * 60_000);
    assert.ok(scheduled.includes(recoveredQueuedRun.id));

    assert.ok(!JSON.stringify(capturedLogs).includes(marker));
  } finally {
    server.close();
    restoreAuth();
    restoreScheduler();
    await db
      .delete(venomBuildRunsTable)
      .where(inArray(venomBuildRunsTable.clerkUserId, [ownerA, ownerB]));
    await db
      .delete(venomPortfolioAppsTable)
      .where(inArray(venomPortfolioAppsTable.clerkUserId, [ownerA, ownerB]));
  }
});

test("build-run admission holds outlive the response and settle or release in the worker", async () => {
  process.env.VENOM_BILLING_ENFORCE = "1";
  const suffix = randomUUID();
  const owner = `build-billing-${suffix}`;
  const restoreAuth = overrideVenomBuildRunUserIdResolverForTests(() => owner);
  const scheduled: string[] = [];
  const restoreScheduler = overrideVenomBuildRunSchedulerForTests(
    (_userId, runId) => scheduled.push(runId),
  );
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
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  async function request(
    path: string,
    options: RequestInit = {},
  ): Promise<TestResponse> {
    const response = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers: {
        "content-type": "application/json",
        ...options.headers,
      },
    });
    const rawBody = await response.text();
    let body: unknown = null;
    if (rawBody) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = rawBody;
      }
    }
    return { status: response.status, body };
  }

  const holds = () =>
    db
      .select({ id: venomAllowanceReservationsTable.id })
      .from(venomAllowanceReservationsTable)
      .where(eq(venomAllowanceReservationsTable.scopeId, owner));
  const waitForHolds = async (expected: number, label: string) => {
    const deadline = Date.now() + 4_000;
    while ((await holds()).length !== expected && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal((await holds()).length, expected, label);
  };
  const createBody = (name: string) => ({
    targetType: "website",
    targetName: name,
    requirements: `Billing hold coverage ${suffix}`,
    constraints: "Do not deploy.",
    brandDirection: "Quiet and direct.",
    appId: null,
    sourceVersionId: null,
    projectId: null,
    sopRevisionIds: [],
    idempotencyKey: randomUUID().replaceAll("-", "_"),
  });
  // The generator override only installs under NODE_ENV=test; this suite
  // runs in production mode, so flip the flag just around the install.
  const installGenerator = (
    generator: Parameters<typeof overrideVenomBuildRunGeneratorForTests>[0],
  ) => {
    const priorNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";
    try {
      return overrideVenomBuildRunGeneratorForTests(generator);
    } finally {
      if (priorNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = priorNodeEnv;
    }
  };

  try {
    // Leave room for exactly one worst-case admission: a leaked hold — or
    // a queued run whose pending cost stopped counting — flips the
    // assertions below.
    await insertVenomUsage({
      userId: owner,
      modelAlias: "venom-gpt",
      callKind: "chat",
      promptTokens: 1,
      outputTokens: 1,
      estimated: false,
      costMicros:
        planAllowanceMicros(venomPlan("free")) - requestBoundMicros() - 50_000,
    });

    const created = await request("/venom/build-runs", {
      method: "POST",
      body: JSON.stringify(createBody("Billing hold run")),
    });
    assertStatus(created, 201);
    assert.equal(
      (await holds()).length,
      1,
      "the admission hold outlives the finished create response",
    );

    // While the queued run's cost is pending, a second worst-case run must
    // not fit — exactly the over-admission a close-time release allowed.
    const second = await request("/venom/build-runs", {
      method: "POST",
      body: JSON.stringify(createBody("Second run while pending")),
    });
    assertStatus(second, 402);
    assert.equal(second.body.code, "personal_allowance_exhausted");

    // The worker settles the hold into the run's first ledgered usage
    // event even when generation fails afterwards.
    let restoreGenerator = installGenerator(
      async (_input, _signal, onUsage) => {
        onUsage?.({ promptTokens: 10, outputTokens: 10, estimated: false });
        throw new Error("halt after spending");
      },
    );
    try {
      await processVenomBuildRunForTests(owner, created.body.id);
    } finally {
      restoreGenerator();
    }
    await waitForHolds(0, "the first ledgered usage event settled the hold");
    const settled = await db
      .select({ id: venomUsageEvents.id })
      .from(venomUsageEvents)
      .where(
        and(
          eq(venomUsageEvents.userId, owner),
          eq(venomUsageEvents.callKind, "build_package"),
        ),
      );
    assert.equal(settled.length, 1);

    // A run that ends without any ledgered usage releases its hold
    // instead of stranding it against the allowance.
    const third = await request("/venom/build-runs", {
      method: "POST",
      body: JSON.stringify(createBody("Release path run")),
    });
    assertStatus(third, 201);
    assert.equal((await holds()).length, 1);
    restoreGenerator = installGenerator(async () => {
      throw new Error("failed before any spend");
    });
    try {
      await processVenomBuildRunForTests(owner, third.body.id);
    } finally {
      restoreGenerator();
    }
    await waitForHolds(0, "a spend-free failure released the hold");
    const failed = await request(`/venom/build-runs/${third.body.id}`);
    assertStatus(failed, 200);
    assert.equal(failed.body.status, "failed");
  } finally {
    delete process.env.VENOM_BILLING_ENFORCE;
    server.close();
    restoreAuth();
    restoreScheduler();
    await db
      .delete(venomBuildRunsTable)
      .where(eq(venomBuildRunsTable.clerkUserId, owner));
    await db
      .delete(venomUsageEvents)
      .where(eq(venomUsageEvents.userId, owner));
    await db
      .delete(venomAllowanceReservationsTable)
      .where(eq(venomAllowanceReservationsTable.scopeId, owner));
  }
});