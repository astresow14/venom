/**
 * Comprehensive integration tests for the venom provisioning backend.
 *
 * Uses an injected fake provider — never touches a real deployment system.
 * Tests cover:
 * - Missing/expired/unconfigured capability → blocked run
 * - Cross-account access isolation
 * - Dangerous/injected inputs rejection
 * - Duplicate commands / idempotency
 * - Partial failures, timeouts, build failures
 * - Retry after failed/blocked/cancelled
 * - Secret redaction and client error safety
 * - Successful candidate run end-to-end
 * - Separate publish flow
 * - Failed publish preserving healthy deployment
 * - Rollback (supported and unsupported)
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  db,
  venomBuildPackageRevisionsTable,
  venomBuildRunsTable,
  venomCandidateReleasesTable,
  venomPortfolioAppsTable,
  venomPortfolioSourceVersionsTable,
  venomProvisioningEventsTable,
  venomProvisioningRunsTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import express from "express";
import router, {
  overrideProvisioningSchedulerForTests,
  overrideProvisioningSourceDownloadSignerForTests,
  overrideProvisioningUserIdResolverForTests,
  processProvisioningRunForTests,
  reconcileProvisioningQueueForTests,
} from "./venom-provisioning.js";
import {
  overrideProvisioningProviderForTests,
  sanitizeLaunchUrl,
  sanitizeProviderId,
  withProviderTimeout,
} from "../lib/venom-provisioning-provider.js";
import type {
  ProvisioningProvider,
  ProvisioningCapabilitySummary,
  ProviderProjectResult,
  ProviderBuildResult,
  ProviderBuildStatus,
  ProviderTestResult,
  ProviderCandidateResult,
  ProviderPublishResult,
  ProviderRollbackResult,
  ProvisioningPermissionSummary,
} from "../lib/venom-provisioning-provider.js";
import {
  ProvisioningCapabilityUnavailableError,
  ProvisioningProviderError,
  ProvisioningTimeoutError,
} from "../lib/venom-provisioning-provider.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

type TestResponse = { status: number; body: any };

function assertStatus(response: TestResponse, expected: number): void {
  assert.equal(
    response.status,
    expected,
    `Expected HTTP ${expected}; received ${response.status}: ${JSON.stringify(response.body)}`,
  );
}

// ─── Fake provider factory ────────────────────────────────────────────────────

type FakeProviderConfig = {
  capabilityHealth?: ProvisioningCapabilitySummary["health"];
  projectIdToReturn?: string;
  buildIdToReturn?: string;
  buildStatusToReturn?: ProviderBuildStatus["status"];
  testPassResult?: boolean;
  candidateIdToReturn?: string;
  candidateLaunchUrl?: string;
  rollbackSupportedResult?: boolean;
  publishHealthyResult?: boolean;
  publishError?: Error;
  rollbackHealthyResult?: boolean;
  rollbackError?: Error;
  getBuildStatusError?: Error;
  handOffError?: Error;
  createProjectError?: Error;
  deniedIntegrations?: string[];
  publishDelayMs?: number;
  rollbackDelayMs?: number;
  startBuildWaitForAbort?: boolean;
  onCreateProject?: () => void;
  onHandoff?: (handoff: unknown) => void;
  onPublish?: () => void;
  onRollback?: () => void;
  onCancel?: () => void;
  permissionSummary?: ProvisioningPermissionSummary;
};

function makeFakeProvider(config: FakeProviderConfig = {}): ProvisioningProvider {
  return {
    async checkCapability() {
      const health = config.capabilityHealth ?? "healthy";
      return {
        health,
        summary:
          health === "healthy"
            ? "Test provider healthy"
            : "Test provider unavailable",
        recoveryGuidance:
          health !== "healthy" ? "Configure the test provider" : null,
        supportedTargetTypes: health === "healthy" ? ["app", "website"] : [],
        rollbackSupported: config.rollbackSupportedResult ?? false,
        publishSupported: health === "healthy",
      };
    },
    async validatePermissions(
      requestedIntegrations: string[],
    ): Promise<ProvisioningPermissionSummary> {
      if (config.permissionSummary) return config.permissionSummary;
      const deniedSet = new Set(config.deniedIntegrations ?? []);
      return {
        allowed: requestedIntegrations.filter((item) => !deniedSet.has(item)),
        denied: requestedIntegrations
          .filter((item) => deniedSet.has(item))
          .map((integration) => ({
            integration,
            reason: "Managed capability is missing the required scope",
          })),
      };
    },
    async createOrLinkProject(opts): Promise<ProviderProjectResult> {
      config.onCreateProject?.();
      if (config.createProjectError) throw config.createProjectError;
      return {
        providerProjectId: config.projectIdToReturn ?? `fake-project-${opts.targetName}`,
        created: true,
      };
    },
    async handOffPackage(opts): Promise<void> {
      config.onHandoff?.(opts.handoff);
      if (config.handOffError) throw config.handOffError;
    },
    async startBuild(opts): Promise<ProviderBuildResult> {
      if (config.startBuildWaitForAbort) {
        await new Promise<void>((_resolve, reject) => {
          const rejectCancelled = (): void => {
            const error = new Error("Cancelled");
            error.name = "AbortError";
            reject(error);
          };
          if (opts.signal?.aborted) {
            rejectCancelled();
            return;
          }
          opts.signal?.addEventListener("abort", rejectCancelled, { once: true });
        });
      }
      return {
        providerBuildId: config.buildIdToReturn ?? "fake-build-001",
        status: "started",
      };
    },
    async getBuildStatus(): Promise<ProviderBuildStatus> {
      if (config.getBuildStatusError) throw config.getBuildStatusError;
      return {
        providerBuildId: config.buildIdToReturn ?? "fake-build-001",
        status: config.buildStatusToReturn ?? "success",
        progress: 100,
        message: "Build completed",
      };
    },
    async runTests(): Promise<ProviderTestResult> {
      const passed = config.testPassResult ?? true;
      return {
        passed,
        message: passed ? "All tests passed" : "Tests failed",
      };
    },
    async createCandidate(): Promise<ProviderCandidateResult> {
      return {
        providerCandidateId:
          config.candidateIdToReturn ?? "fake-candidate-001",
        launchUrl:
          config.candidateLaunchUrl ?? "https://example.com/preview",
        rollbackSupported: config.rollbackSupportedResult ?? false,
      };
    },
    async getCandidateStatus() {
      return {
        healthy: config.publishHealthyResult ?? true,
        launchUrl: config.candidateLaunchUrl ?? "https://example.com/preview",
      };
    },
    async publishCandidate(): Promise<ProviderPublishResult> {
      config.onPublish?.();
      if (config.publishDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, config.publishDelayMs));
      }
      if (config.publishError) throw config.publishError;
      return {
        providerReleaseId: "fake-release-001",
        launchUrl: "https://example.com/live",
        healthy: config.publishHealthyResult ?? true,
      };
    },
    async cancelOperation() {
      config.onCancel?.();
    },
    async rollback(): Promise<ProviderRollbackResult> {
      config.onRollback?.();
      if (config.rollbackDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, config.rollbackDelayMs));
      }
      if (config.rollbackError) throw config.rollbackError;
      return {
        providerReleaseId: "fake-rollback-release-001",
        launchUrl: "https://example.com/live-rb",
        healthy: config.rollbackHealthyResult ?? true,
      };
    },
  };
}

// ─── DB setup helpers ─────────────────────────────────────────────────────────

async function createApprovedBuildRun(
  userId: string,
  targetType: "app" | "website" | "brand" = "app",
  appId?: string,
  sourceVersionId?: string,
) {
  const [run] = await db
    .insert(venomBuildRunsTable)
    .values({
      clerkUserId: userId,
      idempotencyKey: randomUUID().replaceAll("-", "_"),
      targetType,
      targetName: "Test App",
      requirements: "Build a test app",
      constraints: "",
      brandDirection: "",
      sopRevisionIds: [],
      status: "ready_for_provisioning",
      progress: 100,
      currentRevisionNumber: 1,
      appId: appId ?? null,
      sourceVersionId: sourceVersionId ?? null,
    })
    .returning();

  const packageData = {
    formatVersion: 1 as const,
    targetType: targetType as "app",
    title: "Test App",
    productBrief: {
      summary: "A test app",
      audience: ["Testers"],
      outcomes: ["Working app"],
    },
    functionalScope: ["Core functionality"],
    brandDirection: [],
    contentRequirements: [],
    serviceFlowRequirements: [],
    sourceReferences: [],
    sopReferences: [],
    dataNeeds: [],
    integrationNeeds: [],
    permissionRequests: [],
    acceptanceChecks: ["App loads"],
    launchConstraints: ["Human approval required"],
  };

  const [revision] = await db
    .insert(venomBuildPackageRevisionsTable)
    .values({
      runId: run.id,
      clerkUserId: userId,
      revisionNumber: 1,
      reason: "Initial package",
      package: packageData,
      checksumSha256: "a".repeat(64),
      approvedAt: new Date(),
      approvedBy: userId,
    })
    .returning();

  await db
    .update(venomBuildRunsTable)
    .set({ approvedRevisionId: revision.id })
    .where(eq(venomBuildRunsTable.id, run.id));

  const [updated] = await db
    .select()
    .from(venomBuildRunsTable)
    .where(eq(venomBuildRunsTable.id, run.id));

  return { run: updated, revision };
}

test("provider boundary rejects unsafe launch values and bounds timeouts", async () => {
  assert.equal(sanitizeLaunchUrl("javascript:alert(1)"), null);
  assert.equal(sanitizeLaunchUrl("data:text/html,unsafe"), null);
  assert.equal(sanitizeLaunchUrl("/relative"), null);
  assert.equal(sanitizeLaunchUrl("https://user:pass@example.com"), null);
  assert.equal(
    sanitizeLaunchUrl("https://example.com/app"),
    "https://example.com/app",
  );
  assert.equal(sanitizeProviderId("x".repeat(121)), null);
  assert.equal(sanitizeProviderId("provider\nid"), null);

  await assert.rejects(
    withProviderTimeout("test-timeout", 5, async (signal) => {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          },
          { once: true },
        );
      });
    }),
    ProvisioningTimeoutError,
  );
});

// ─── Main test suite ──────────────────────────────────────────────────────────

test("provisioning routes: comprehensive backend coverage", async () => {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
  const ownerA = `prov-test-a-${suffix}`;
  const ownerB = `prov-test-b-${suffix}`;

  let activeUserId = ownerA;
  const capturedLogs: unknown[] = [];
  const scheduled: Array<{ userId: string; runId: string }> = [];

  const restoreAuth = overrideProvisioningUserIdResolverForTests(
    () => activeUserId,
  );
  const restoreScheduler = overrideProvisioningSchedulerForTests(
    (userId, runId) => scheduled.push({ userId, runId }),
  );

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.log = {
      info: (...args: unknown[]) => capturedLogs.push(args),
      warn: (...args: unknown[]) => capturedLogs.push(args),
      error: (...args: unknown[]) => capturedLogs.push(args),
    } as unknown as typeof req.log;
    next();
  });
  app.use(router);

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  async function request(
    path: string,
    options: RequestInit = {},
  ): Promise<TestResponse> {
    const resp = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers: {
        "content-type": "application/json",
        ...options.headers,
      },
    });
    const raw = await resp.text();
    let body: unknown = null;
    if (raw) {
      try { body = JSON.parse(raw); } catch { body = raw; }
    }
    return { status: resp.status, body };
  }

  // Track created run IDs for cleanup
  const createdRunIds: string[] = [];
  const createdBuildRunIds: string[] = [];

  try {
    // ── Test 1: Unauthenticated requests are rejected ────────────────────────
    activeUserId = "";
    assertStatus(await request("/venom/provisioning/capability"), 401);
    assertStatus(await request("/venom/provisioning/runs"), 401);
    activeUserId = ownerA;

    // ── Test 2: Capability endpoint returns health ───────────────────────────
    const restoreUnconfigured = overrideProvisioningProviderForTests(
      makeFakeProvider({ capabilityHealth: "unconfigured" }),
    );
    const capResp = await request("/venom/provisioning/capability");
    assertStatus(capResp, 200);
    assert.equal(capResp.body.health, "unconfigured");
    assert.ok(capResp.body.recoveryGuidance);
    restoreUnconfigured();

    // ── Test 3: Capability healthy ────────────────────────────────────────────
    const restoreHealthy = overrideProvisioningProviderForTests(
      makeFakeProvider({ capabilityHealth: "healthy" }),
    );
    const capHealthy = await request("/venom/provisioning/capability");
    assertStatus(capHealthy, 200);
    assert.equal(capHealthy.body.health, "healthy");
    restoreHealthy();

    // ── Test 4: Rejected — unapproved build run ───────────────────────────────
    const [unapprovedRun] = await db
      .insert(venomBuildRunsTable)
      .values({
        clerkUserId: ownerA,
        idempotencyKey: randomUUID().replaceAll("-", "_"),
        targetType: "app",
        targetName: "Not Approved",
        requirements: "test",
        constraints: "",
        brandDirection: "",
        sopRevisionIds: [],
        status: "review_required",
        progress: 100,
        currentRevisionNumber: 1,
      })
      .returning();
    createdBuildRunIds.push(unapprovedRun.id);

    const rejectedResp = await request(
      `/venom/build-runs/${unapprovedRun.id}/provision`,
      {
        method: "POST",
        body: JSON.stringify({
          approvedRevisionId: randomUUID(),
          idempotencyKey: randomUUID().replaceAll("-", "_"),
          targetName: "Not Approved",
          requestedIntegrations: [],
          deploymentIntent: "create_candidate",
        }),
      },
    );
    assertStatus(rejectedResp, 400);

    // ── Test 5: Rejected — dangerous integration strings ─────────────────────
    const { run: approvedRun } = await createApprovedBuildRun(ownerA);
    createdBuildRunIds.push(approvedRun.id);

    const dangerousResp = await request(
      `/venom/build-runs/${approvedRun.id}/provision`,
      {
        method: "POST",
        body: JSON.stringify({
          approvedRevisionId: approvedRun.approvedRevisionId,
          idempotencyKey: randomUUID().replaceAll("-", "_"),
          targetName: approvedRun.targetName,
          requestedIntegrations: ["my-api-token"],
          deploymentIntent: "create_candidate",
        }),
      },
    );
    assertStatus(dangerousResp, 400);
    assert.match(dangerousResp.body.error, /credential/i);

    // ── Test 6: Rejected — wrong deployment intent ────────────────────────────
    const badIntentResp = await request(
      `/venom/build-runs/${approvedRun.id}/provision`,
      {
        method: "POST",
        body: JSON.stringify({
          approvedRevisionId: approvedRun.approvedRevisionId,
          idempotencyKey: randomUUID().replaceAll("-", "_"),
          targetName: approvedRun.targetName,
          requestedIntegrations: [],
          deploymentIntent: "deploy_now",
        }),
      },
    );
    assertStatus(badIntentResp, 400);

    // ── Test 7: Rejected — target name mismatch ───────────────────────────────
    const mismatchResp = await request(
      `/venom/build-runs/${approvedRun.id}/provision`,
      {
        method: "POST",
        body: JSON.stringify({
          approvedRevisionId: approvedRun.approvedRevisionId,
          idempotencyKey: randomUUID().replaceAll("-", "_"),
          targetName: "WRONG NAME",
          requestedIntegrations: [],
          deploymentIntent: "create_candidate",
        }),
      },
    );
    assertStatus(mismatchResp, 400);
    assert.match(mismatchResp.body.error, /targetName/i);

    // ── Test 8: Cross-account access rejected ────────────────────────────────
    const { run: bRun } = await createApprovedBuildRun(ownerB);
    createdBuildRunIds.push(bRun.id);

    // ownerA cannot provision ownerB's run
    const crossResp = await request(
      `/venom/build-runs/${bRun.id}/provision`,
      {
        method: "POST",
        body: JSON.stringify({
          approvedRevisionId: bRun.approvedRevisionId,
          idempotencyKey: randomUUID().replaceAll("-", "_"),
          targetName: bRun.targetName,
          requestedIntegrations: [],
          deploymentIntent: "create_candidate",
        }),
      },
    );
    assertStatus(crossResp, 404);

    // ── Test 9: Create provisioning run successfully ──────────────────────────
    const restoreProvider = overrideProvisioningProviderForTests(
      makeFakeProvider({ capabilityHealth: "healthy" }),
    );

    const ikey1 = `prov-${randomUUID().replaceAll("-", "_").slice(0, 20)}`;
    const createResp = await request(
      `/venom/build-runs/${approvedRun.id}/provision`,
      {
        method: "POST",
        body: JSON.stringify({
          approvedRevisionId: approvedRun.approvedRevisionId,
          idempotencyKey: ikey1,
          targetName: approvedRun.targetName,
          requestedIntegrations: [],
          deploymentIntent: "create_candidate",
        }),
      },
    );
    assertStatus(createResp, 201);
    assert.equal(createResp.body.status, "queued");
    assert.equal(createResp.body.buildRunId, approvedRun.id);
    assert.ok(scheduled.some((s) => s.runId === createResp.body.id));
    const runId1 = createResp.body.id;
    createdRunIds.push(runId1);

    restoreProvider();

    // ── Test 10: Idempotency — same key returns same run ─────────────────────
    const restoreP2 = overrideProvisioningProviderForTests(
      makeFakeProvider({ capabilityHealth: "healthy" }),
    );
    const dupResp = await request(
      `/venom/build-runs/${approvedRun.id}/provision`,
      {
        method: "POST",
        body: JSON.stringify({
          approvedRevisionId: approvedRun.approvedRevisionId,
          idempotencyKey: ikey1,
          targetName: approvedRun.targetName,
          requestedIntegrations: [],
          deploymentIntent: "create_candidate",
        }),
      },
    );
    assertStatus(dupResp, 201);
    assert.equal(dupResp.body.id, runId1);
    restoreP2();

    // ── Test 11: Idempotency key conflict (different build run) ──────────────
    const { run: anotherRun } = await createApprovedBuildRun(ownerA);
    createdBuildRunIds.push(anotherRun.id);
    const conflictResp = await request(
      `/venom/build-runs/${anotherRun.id}/provision`,
      {
        method: "POST",
        body: JSON.stringify({
          approvedRevisionId: anotherRun.approvedRevisionId,
          idempotencyKey: ikey1, // same key, different build run
          targetName: anotherRun.targetName,
          requestedIntegrations: [],
          deploymentIntent: "create_candidate",
        }),
      },
    );
    assertStatus(conflictResp, 409);

    // ── Test 12: Capability unavailable → blocked run ─────────────────────────
    const { run: blockedBuildRun } = await createApprovedBuildRun(ownerA);
    createdBuildRunIds.push(blockedBuildRun.id);

    const restoreUnconfigured2 = overrideProvisioningProviderForTests(
      makeFakeProvider({ capabilityHealth: "unconfigured" }),
    );
    const ikey2 = `prov-${randomUUID().replaceAll("-", "_").slice(0, 20)}`;
    const blockedCreate = await request(
      `/venom/build-runs/${blockedBuildRun.id}/provision`,
      {
        method: "POST",
        body: JSON.stringify({
          approvedRevisionId: blockedBuildRun.approvedRevisionId,
          idempotencyKey: ikey2,
          targetName: blockedBuildRun.targetName,
          requestedIntegrations: [],
          deploymentIntent: "create_candidate",
        }),
      },
    );
    assertStatus(blockedCreate, 201);
    const blockedRunId = blockedCreate.body.id;
    createdRunIds.push(blockedRunId);

    // Process it — should become blocked
    await processProvisioningRunForTests(ownerA, blockedRunId);
    restoreUnconfigured2();

    const blockedDetail = await request(`/venom/provisioning/runs/${blockedRunId}`);
    assertStatus(blockedDetail, 200);
    assert.equal(blockedDetail.body.status, "blocked");
    assert.ok(blockedDetail.body.blockedReason);

    // ── Test 13: Retry blocked run ────────────────────────────────────────────
    const restoreRetryProvider = overrideProvisioningProviderForTests(
      makeFakeProvider({ capabilityHealth: "healthy" }),
    );
    const retryResp = await request(
      `/venom/provisioning/runs/${blockedRunId}/retry`,
      { method: "POST" },
    );
    assertStatus(retryResp, 202);
    assert.equal(retryResp.body.status, "queued");
    assert.equal(retryResp.body.attempt, 2);

    // Process it — should now succeed to candidate_ready
    await processProvisioningRunForTests(ownerA, blockedRunId);
    restoreRetryProvider();

    const retriedDetail = await request(`/venom/provisioning/runs/${blockedRunId}`);
    assertStatus(retriedDetail, 200);
    assert.equal(retriedDetail.body.status, "candidate_ready");

    // ── Test 14: Successful end-to-end provisioning to candidate_ready ────────
    const { run: successBuildRun } = await createApprovedBuildRun(ownerA);
    createdBuildRunIds.push(successBuildRun.id);

    const restoreSuccess = overrideProvisioningProviderForTests(
      makeFakeProvider({
        capabilityHealth: "healthy",
        projectIdToReturn: "proj-success-001",
        buildIdToReturn: "build-success-001",
        candidateIdToReturn: "candidate-success-001",
        candidateLaunchUrl: "https://example.com/preview-success",
        rollbackSupportedResult: true,
      }),
    );
    const ikeySuccess = `prov-${randomUUID().replaceAll("-", "_").slice(0, 20)}`;
    const successCreate = await request(
      `/venom/build-runs/${successBuildRun.id}/provision`,
      {
        method: "POST",
        body: JSON.stringify({
          approvedRevisionId: successBuildRun.approvedRevisionId,
          idempotencyKey: ikeySuccess,
          targetName: successBuildRun.targetName,
          requestedIntegrations: [],
          deploymentIntent: "create_candidate",
        }),
      },
    );
    assertStatus(successCreate, 201);
    const successRunId = successCreate.body.id;
    createdRunIds.push(successRunId);

    // Process end-to-end
    await processProvisioningRunForTests(ownerA, successRunId);
    restoreSuccess();

    const successDetail = await request(`/venom/provisioning/runs/${successRunId}`);
    assertStatus(successDetail, 200);
    assert.equal(successDetail.body.status, "candidate_ready");
    assert.equal(successDetail.body.providerProjectId, "proj-success-001");
    assert.equal(successDetail.body.providerCandidateId, "candidate-success-001");
    assert.ok(successDetail.body.events.length > 0);
    assert.ok(successDetail.body.releases.length === 1);
    assert.equal(successDetail.body.releases[0].status, "candidate");
    assert.equal(
      successDetail.body.releases[0].launchUrl,
      "https://example.com/preview-success",
    );
    assert.ok(successDetail.body.releases[0].rollbackSupported);
    const successReleaseId = successDetail.body.releases[0].id;

    // ── Test 15: List provisioning runs ──────────────────────────────────────
    const listResp = await request("/venom/provisioning/runs");
    assertStatus(listResp, 200);
    assert.ok(Array.isArray(listResp.body));
    assert.ok(listResp.body.some((r: any) => r.id === successRunId));

    // List by buildRunId
    const listByBuildRun = await request(
      `/venom/provisioning/runs?buildRunId=${successBuildRun.id}`,
    );
    assertStatus(listByBuildRun, 200);
    assert.ok(listByBuildRun.body.some((r: any) => r.id === successRunId));

    // ── Test 16: Cross-account get rejected ──────────────────────────────────
    activeUserId = ownerB;
    assertStatus(
      await request(`/venom/provisioning/runs/${successRunId}`),
      404,
    );
    activeUserId = ownerA;

    // ── Test 17: Publish — successful ────────────────────────────────────────
    let publishCalls = 0;
    const restorePublish = overrideProvisioningProviderForTests(
      makeFakeProvider({
        capabilityHealth: "healthy",
        publishHealthyResult: true,
        rollbackSupportedResult: true,
        publishDelayMs: 60,
        onPublish: () => {
          publishCalls += 1;
        },
      }),
    );
    const publishKey = randomUUID().replaceAll("-", "_").slice(0, 20);
    const publishRequest = (): Promise<TestResponse> =>
      request(`/venom/provisioning/runs/${successRunId}/publish`, {
        method: "POST",
        body: JSON.stringify({
          candidateReleaseId: successReleaseId,
          idempotencyKey: publishKey,
          confirmTargetName: successBuildRun.targetName,
        }),
      });
    const concurrentPublish = await Promise.all([
      publishRequest(),
      publishRequest(),
    ]);
    assert.deepEqual(
      concurrentPublish.map((response) => response.status).sort(),
      [200, 409],
      "only one concurrent duplicate publish may reserve the provider call",
    );
    const publishResp = concurrentPublish.find(
      (response) => response.status === 200,
    )!;
    assertStatus(publishResp, 200);
    assert.equal(publishResp.body.status, "published");
    assert.equal(publishCalls, 1);

    const publishReplay = await publishRequest();
    assertStatus(publishReplay, 200);
    assert.equal(publishReplay.body.status, "published");
    assert.equal(publishCalls, 1, "completed replay must not call provider again");
    restorePublish();

    // Verify release is published
    const [publishedRelease] = await db
      .select()
      .from(venomCandidateReleasesTable)
      .where(eq(venomCandidateReleasesTable.id, successReleaseId));
    assert.equal(publishedRelease.status, "published");
    assert.equal(publishedRelease.launchUrl, "https://example.com/live");
    assert.ok(publishedRelease.publishedAt);

    // ── Test 18: Failed publish preserves healthy deployment ─────────────────
    const { run: failPubBuildRun } = await createApprovedBuildRun(
      ownerA,
      "app",
      publishedRelease.appId!,
    );
    createdBuildRunIds.push(failPubBuildRun.id);

    const restoreFailPub = overrideProvisioningProviderForTests(
      makeFakeProvider({
        capabilityHealth: "healthy",
        candidateIdToReturn: "candidate-failpub-001",
        publishHealthyResult: false,
      }),
    );
    const ikeyFailPub = `prov-${randomUUID().replaceAll("-", "_").slice(0, 20)}`;
    const failPubCreate = await request(
      `/venom/build-runs/${failPubBuildRun.id}/provision`,
      {
        method: "POST",
        body: JSON.stringify({
          approvedRevisionId: failPubBuildRun.approvedRevisionId,
          idempotencyKey: ikeyFailPub,
          targetName: failPubBuildRun.targetName,
          requestedIntegrations: [],
          deploymentIntent: "create_candidate",
        }),
      },
    );
    assertStatus(failPubCreate, 201);
    const failPubRunId = failPubCreate.body.id;
    createdRunIds.push(failPubRunId);

    await processProvisioningRunForTests(ownerA, failPubRunId);
    const failPubRunDetail = await request(`/venom/provisioning/runs/${failPubRunId}`);
    assert.equal(failPubRunDetail.body.status, "candidate_ready");
    const failPubReleaseId = failPubRunDetail.body.releases[0]?.id;
    assert.ok(failPubReleaseId);

    const failPublishKey = randomUUID().replaceAll("-", "_").slice(0, 20);
    const failPubResp = await request(
      `/venom/provisioning/runs/${failPubRunId}/publish`,
      {
        method: "POST",
        body: JSON.stringify({
          candidateReleaseId: failPubReleaseId,
          idempotencyKey: failPublishKey,
          confirmTargetName: failPubBuildRun.targetName,
        }),
      },
    );
    assertStatus(failPubResp, 200);
    // Run should be back to candidate_ready (not published) — healthy deployment preserved
    assert.equal(failPubResp.body.status, "candidate_ready");
    restoreFailPub();

    // The previously published release for the same app must remain published.
    const [stillPublished] = await db
      .select()
      .from(venomCandidateReleasesTable)
      .where(eq(venomCandidateReleasesTable.id, successReleaseId));
    assert.equal(stillPublished.status, "published");

    // Retry the failed publish with the same operation key after the provider
    // recovers. This must publish the existing candidate and supersede the
    // previous healthy release without creating another candidate.
    const restoreRecoveredPublish = overrideProvisioningProviderForTests(
      makeFakeProvider({
        capabilityHealth: "healthy",
        publishHealthyResult: true,
        rollbackSupportedResult: true,
      }),
    );
    const recoveredPublish = await request(
      `/venom/provisioning/runs/${failPubRunId}/publish`,
      {
        method: "POST",
        body: JSON.stringify({
          candidateReleaseId: failPubReleaseId,
          idempotencyKey: failPublishKey,
          confirmTargetName: failPubBuildRun.targetName,
        }),
      },
    );
    assertStatus(recoveredPublish, 200);
    assert.equal(recoveredPublish.body.status, "published");
    restoreRecoveredPublish();

    const [nowSuperseded] = await db
      .select()
      .from(venomCandidateReleasesTable)
      .where(eq(venomCandidateReleasesTable.id, successReleaseId));
    assert.equal(nowSuperseded.status, "superseded");

    // ── Test 19: Rollback — supported ────────────────────────────────────────
    let rollbackCalls = 0;
    const restoreRollback = overrideProvisioningProviderForTests(
      makeFakeProvider({
        capabilityHealth: "healthy",
        rollbackSupportedResult: true,
        rollbackHealthyResult: true,
        rollbackDelayMs: 60,
        onRollback: () => {
          rollbackCalls += 1;
        },
      }),
    );

    // The previously healthy release is now eligible for rollback.
    await db
      .update(venomCandidateReleasesTable)
      .set({
        providerReleaseId: "fake-release-001",
        rollbackSupported: true,
      })
      .where(eq(venomCandidateReleasesTable.id, successReleaseId));

    const rollbackKey = randomUUID().replaceAll("-", "_").slice(0, 20);
    const rollbackRequest = (): Promise<TestResponse> =>
      request(`/venom/provisioning/releases/${successReleaseId}/rollback`, {
        method: "POST",
        body: JSON.stringify({
          idempotencyKey: rollbackKey,
          confirmTargetName: successBuildRun.targetName,
        }),
      });
    const concurrentRollback = await Promise.all([
      rollbackRequest(),
      rollbackRequest(),
    ]);
    assert.deepEqual(
      concurrentRollback.map((response) => response.status).sort(),
      [200, 409],
      "only one concurrent duplicate rollback may reserve the provider call",
    );
    const rollbackResp = concurrentRollback.find(
      (response) => response.status === 200,
    )!;
    assertStatus(rollbackResp, 200);
    assert.equal(rollbackResp.body.status, "published");
    assert.ok(rollbackResp.body.rolledBackAt);
    assert.equal(rollbackCalls, 1);

    const rollbackReplay = await rollbackRequest();
    assertStatus(rollbackReplay, 200);
    assert.equal(rollbackReplay.body.status, "published");
    assert.equal(rollbackCalls, 1, "completed replay must not call provider again");
    const [supersededAfterRollback] = await db
      .select()
      .from(venomCandidateReleasesTable)
      .where(eq(venomCandidateReleasesTable.id, failPubReleaseId));
    assert.equal(supersededAfterRollback.status, "superseded");
    restoreRollback();

    // ── Test 20: Rollback — not supported ────────────────────────────────────
    // Set rollbackSupported = false
    await db
      .update(venomCandidateReleasesTable)
      .set({ rollbackSupported: false })
      .where(eq(venomCandidateReleasesTable.id, successReleaseId));

    const noRollbackResp = await request(
      `/venom/provisioning/releases/${successReleaseId}/rollback`,
      {
        method: "POST",
        body: JSON.stringify({
          idempotencyKey: randomUUID().replaceAll("-", "_").slice(0, 20),
          confirmTargetName: successBuildRun.targetName,
        }),
      },
    );
    assertStatus(noRollbackResp, 409);
    assert.match(noRollbackResp.body.error, /not supported/i);

    // ── Test 21: Rollback target name mismatch ───────────────────────────────
    await db
      .update(venomCandidateReleasesTable)
      .set({ rollbackSupported: true })
      .where(eq(venomCandidateReleasesTable.id, successReleaseId));

    const rollbackMismatch = await request(
      `/venom/provisioning/releases/${successReleaseId}/rollback`,
      {
        method: "POST",
        body: JSON.stringify({
          idempotencyKey: randomUUID().replaceAll("-", "_").slice(0, 20),
          confirmTargetName: "WRONG TARGET",
        }),
      },
    );
    assertStatus(rollbackMismatch, 400);
    assert.match(rollbackMismatch.body.error, /confirmTargetName/i);

    // ── Test 22: Cancellation ─────────────────────────────────────────────────
    const { run: cancelBuildRun } = await createApprovedBuildRun(ownerA);
    createdBuildRunIds.push(cancelBuildRun.id);

    const ikeyCan = `prov-${randomUUID().replaceAll("-", "_").slice(0, 20)}`;
    const canCreate = await request(
      `/venom/build-runs/${cancelBuildRun.id}/provision`,
      {
        method: "POST",
        body: JSON.stringify({
          approvedRevisionId: cancelBuildRun.approvedRevisionId,
          idempotencyKey: ikeyCan,
          targetName: cancelBuildRun.targetName,
          requestedIntegrations: [],
          deploymentIntent: "create_candidate",
        }),
      },
    );
    assertStatus(canCreate, 201);
    const cancelRunId = canCreate.body.id;
    createdRunIds.push(cancelRunId);

    const cancelResp = await request(
      `/venom/provisioning/runs/${cancelRunId}/cancel`,
      {
        method: "POST",
        body: JSON.stringify({ reason: "Cancelled by test" }),
      },
    );
    assertStatus(cancelResp, 200);
    assert.ok(
      cancelResp.body.status === "cancelled" ||
        cancelResp.body.cancelRequested === true,
    );

    // Cannot cancel already cancelled
    if (cancelResp.body.status === "cancelled") {
      const doubleCancel = await request(
        `/venom/provisioning/runs/${cancelRunId}/cancel`,
        {
          method: "POST",
          body: JSON.stringify({ reason: "Double cancel" }),
        },
      );
      assertStatus(doubleCancel, 409);
    }

    // Active cancellation aborts an in-flight provider call and durably records
    // cancelled instead of misclassifying the AbortError as a failure.
    const { run: activeCancelBuildRun } = await createApprovedBuildRun(ownerA);
    createdBuildRunIds.push(activeCancelBuildRun.id);
    let providerCancelCalls = 0;
    const restoreActiveCancel = overrideProvisioningProviderForTests(
      makeFakeProvider({
        capabilityHealth: "healthy",
        startBuildWaitForAbort: true,
        onCancel: () => {
          providerCancelCalls += 1;
        },
      }),
    );
    const activeCancelCreate = await request(
      `/venom/build-runs/${activeCancelBuildRun.id}/provision`,
      {
        method: "POST",
        body: JSON.stringify({
          approvedRevisionId: activeCancelBuildRun.approvedRevisionId,
          idempotencyKey: randomUUID().replaceAll("-", "_").slice(0, 20),
          targetName: activeCancelBuildRun.targetName,
          requestedIntegrations: [],
          deploymentIntent: "create_candidate",
        }),
      },
    );
    assertStatus(activeCancelCreate, 201);
    const activeCancelRunId = activeCancelCreate.body.id;
    createdRunIds.push(activeCancelRunId);
    const activeWorker = processProvisioningRunForTests(
      ownerA,
      activeCancelRunId,
    );
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const [row] = await db
        .select({ status: venomProvisioningRunsTable.status })
        .from(venomProvisioningRunsTable)
        .where(eq(venomProvisioningRunsTable.id, activeCancelRunId));
      if (row?.status === "building") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const activeCancelResponse = await request(
      `/venom/provisioning/runs/${activeCancelRunId}/cancel`,
      {
        method: "POST",
        body: JSON.stringify({ reason: "Cancel active provider call" }),
      },
    );
    assertStatus(activeCancelResponse, 200);
    await activeWorker;
    const activeCancelDetail = await request(
      `/venom/provisioning/runs/${activeCancelRunId}`,
    );
    assertStatus(activeCancelDetail, 200);
    assert.equal(activeCancelDetail.body.status, "cancelled");
    assert.equal(activeCancelDetail.body.cancelRequested, false);
    assert.ok(
      activeCancelDetail.body.events.some(
        (event: { eventType: string }) => event.eventType === "cancelled",
      ),
    );
    assert.equal(providerCancelCalls, 1);
    restoreActiveCancel();

    // ── Test 23: Build failure → failed run, retryable ───────────────────────
    const { run: failBuildRun } = await createApprovedBuildRun(ownerA);
    createdBuildRunIds.push(failBuildRun.id);

    const restoreFail = overrideProvisioningProviderForTests(
      makeFakeProvider({
        capabilityHealth: "healthy",
        getBuildStatusError: new ProvisioningProviderError(
          "Build failed",
          "build_failed",
          true,
        ),
      }),
    );
    const ikeyFail = `prov-${randomUUID().replaceAll("-", "_").slice(0, 20)}`;
    const failCreate = await request(
      `/venom/build-runs/${failBuildRun.id}/provision`,
      {
        method: "POST",
        body: JSON.stringify({
          approvedRevisionId: failBuildRun.approvedRevisionId,
          idempotencyKey: ikeyFail,
          targetName: failBuildRun.targetName,
          requestedIntegrations: [],
          deploymentIntent: "create_candidate",
        }),
      },
    );
    assertStatus(failCreate, 201);
    const failRunId = failCreate.body.id;
    createdRunIds.push(failRunId);

    await processProvisioningRunForTests(ownerA, failRunId);
    restoreFail();

    const failDetail = await request(`/venom/provisioning/runs/${failRunId}`);
    assertStatus(failDetail, 200);
    assert.equal(failDetail.body.status, "failed");
    assert.ok(failDetail.body.failureCode);

    // Retry failed run
    const restoreRetry2 = overrideProvisioningProviderForTests(
      makeFakeProvider({ capabilityHealth: "healthy" }),
    );
    const retry2Resp = await request(
      `/venom/provisioning/runs/${failRunId}/retry`,
      { method: "POST" },
    );
    assertStatus(retry2Resp, 202);
    assert.equal(retry2Resp.body.attempt, 2);
    restoreRetry2();

    // ── Test 24: Non-app/website target type rejected ─────────────────────────
    const { run: brandRun } = await createApprovedBuildRun(ownerA, "brand");
    createdBuildRunIds.push(brandRun.id);

    const brandResp = await request(
      `/venom/build-runs/${brandRun.id}/provision`,
      {
        method: "POST",
        body: JSON.stringify({
          approvedRevisionId: brandRun.approvedRevisionId,
          idempotencyKey: randomUUID().replaceAll("-", "_").slice(0, 20),
          targetName: brandRun.targetName,
          requestedIntegrations: [],
          deploymentIntent: "create_candidate",
        }),
      },
    );
    assertStatus(brandResp, 400);
    assert.match(brandResp.body.error, /not supported/i);

    // ── Test 25: Worker reconciliation picks up queued runs ───────────────────
    const { run: reconBuildRun } = await createApprovedBuildRun(ownerA);
    createdBuildRunIds.push(reconBuildRun.id);

    const [queuedProv] = await db
      .insert(venomProvisioningRunsTable)
      .values({
        clerkUserId: ownerA,
        buildRunId: reconBuildRun.id,
        approvedRevisionId: reconBuildRun.approvedRevisionId!,
        idempotencyKey: randomUUID().replaceAll("-", "_"),
        targetName: reconBuildRun.targetName,
        deploymentIntent: "create_candidate",
        requestedIntegrations: [],
        status: "queued",
        progress: 0,
      })
      .returning();
    createdRunIds.push(queuedProv.id);

    scheduled.length = 0;
    await reconcileProvisioningQueueForTests();
    assert.ok(scheduled.some((s) => s.runId === queuedProv.id));

    // ── Test 26: Secret redaction — no sensitive data in logs ────────────────
    const logStr = JSON.stringify(capturedLogs);
    // Should not log any secret-like strings
    assert.ok(!logStr.includes("fake-api-key"));
    assert.ok(!logStr.includes("bearer_token"));

    // ── Test 27: Client-safe errors — no internal provider detail ────────────
    const restoreFailClosed = overrideProvisioningProviderForTests({
      checkCapability: async () => ({
        health: "healthy" as const,
        summary: "ok",
        recoveryGuidance: null,
        supportedTargetTypes: ["app" as const, "website" as const],
        rollbackSupported: false,
        publishSupported: true,
      }),
      validatePermissions: async (integrations) => ({
        allowed: integrations,
        denied: [],
      }),
      createOrLinkProject: async () => {
        throw new Error(
          "INTERNAL_SECRET_KEY=abc123 should not appear in client response",
        );
      },
      handOffPackage: async () => {},
      startBuild: async () => ({ providerBuildId: "x", status: "started" as const }),
      getBuildStatus: async () => ({
        providerBuildId: "x",
        status: "success" as const,
        progress: 100,
        message: "ok",
      }),
      runTests: async () => ({ passed: true, message: "ok" }),
      createCandidate: async () => ({
        providerCandidateId: "c",
        launchUrl: null,
        rollbackSupported: false,
      }),
      getCandidateStatus: async () => ({ healthy: true, launchUrl: null }),
      publishCandidate: async () => ({
        providerReleaseId: "r",
        launchUrl: "https://x.com",
        healthy: true,
      }),
      cancelOperation: async () => {},
      rollback: async () => ({
        providerReleaseId: "r",
        launchUrl: "https://x.com",
        healthy: true,
      }),
    });

    const { run: internalErrBuildRun } = await createApprovedBuildRun(ownerA);
    createdBuildRunIds.push(internalErrBuildRun.id);
    const ikeyInternal = `prov-${randomUUID().replaceAll("-", "_").slice(0, 20)}`;
    const internalCreate = await request(
      `/venom/build-runs/${internalErrBuildRun.id}/provision`,
      {
        method: "POST",
        body: JSON.stringify({
          approvedRevisionId: internalErrBuildRun.approvedRevisionId,
          idempotencyKey: ikeyInternal,
          targetName: internalErrBuildRun.targetName,
          requestedIntegrations: [],
          deploymentIntent: "create_candidate",
        }),
      },
    );
    assertStatus(internalCreate, 201);
    const internalRunId = internalCreate.body.id;
    createdRunIds.push(internalRunId);

    await processProvisioningRunForTests(ownerA, internalRunId);
    restoreFailClosed();

    const internalRunDetail = await request(`/venom/provisioning/runs/${internalRunId}`);
    assertStatus(internalRunDetail, 200);
    assert.equal(internalRunDetail.body.status, "failed");

    // Verify INTERNAL_SECRET_KEY never appears in any client-facing response
    const detailStr = JSON.stringify(internalRunDetail.body);
    assert.ok(
      !detailStr.includes("INTERNAL_SECRET_KEY"),
      "Internal error details must not appear in client responses",
    );

    // ── Test 28: Publish with wrong target name confirmation ──────────────────
    // Use a fresh candidate_ready run so we can test the target mismatch check
    const { run: mismatchBuildRun } = await createApprovedBuildRun(ownerA);
    createdBuildRunIds.push(mismatchBuildRun.id);
    const restoreMismatch = overrideProvisioningProviderForTests(
      makeFakeProvider({ capabilityHealth: "healthy" }),
    );
    const ikeyMismatch = `prov-${randomUUID().replaceAll("-", "_").slice(0, 20)}`;
    const mismatchCreate = await request(
      `/venom/build-runs/${mismatchBuildRun.id}/provision`,
      {
        method: "POST",
        body: JSON.stringify({
          approvedRevisionId: mismatchBuildRun.approvedRevisionId,
          idempotencyKey: ikeyMismatch,
          targetName: mismatchBuildRun.targetName,
          requestedIntegrations: [],
          deploymentIntent: "create_candidate",
        }),
      },
    );
    assertStatus(mismatchCreate, 201);
    const mismatchRunId = mismatchCreate.body.id;
    createdRunIds.push(mismatchRunId);
    await processProvisioningRunForTests(ownerA, mismatchRunId);
    restoreMismatch();

    const mismatchDetail = await request(`/venom/provisioning/runs/${mismatchRunId}`);
    assert.equal(mismatchDetail.body.status, "candidate_ready");
    const mismatchReleaseId = mismatchDetail.body.releases[0]?.id;

    const publishWrongName = await request(
      `/venom/provisioning/runs/${mismatchRunId}/publish`,
      {
        method: "POST",
        body: JSON.stringify({
          candidateReleaseId: mismatchReleaseId,
          idempotencyKey: randomUUID().replaceAll("-", "_").slice(0, 20),
          confirmTargetName: "WRONG TARGET",
        }),
      },
    );
    assertStatus(publishWrongName, 400);
    assert.match(publishWrongName.body.error, /confirmTargetName/i);

    // ── Test 29: Cannot retry more than MAX_ATTEMPTS times ───────────────────
    // Set attempt to MAX on a failed run
    await db
      .update(venomProvisioningRunsTable)
      .set({ attempt: 5, status: "failed" })
      .where(eq(venomProvisioningRunsTable.id, failRunId));

    const maxRetryResp = await request(
      `/venom/provisioning/runs/${failRunId}/retry`,
      { method: "POST" },
    );
    assertStatus(maxRetryResp, 409);

    // ── Test 30: Unsupported permission requests rejected in approved package ─
    const [runWithPerms] = await db
      .insert(venomBuildRunsTable)
      .values({
        clerkUserId: ownerA,
        idempotencyKey: randomUUID().replaceAll("-", "_"),
        targetType: "app",
        targetName: "Perms Test",
        requirements: "test",
        constraints: "",
        brandDirection: "",
        sopRevisionIds: [],
        status: "ready_for_provisioning",
        progress: 100,
        currentRevisionNumber: 1,
      })
      .returning();
    createdBuildRunIds.push(runWithPerms.id);

    const badPermsPackage = {
      formatVersion: 1 as const,
      targetType: "app" as const,
      title: "Perms Test",
      productBrief: { summary: "test", audience: [], outcomes: [] },
      functionalScope: [],
      brandDirection: [],
      contentRequirements: [],
      serviceFlowRequirements: [],
      sourceReferences: [],
      sopReferences: [],
      dataNeeds: [],
      integrationNeeds: [],
      permissionRequests: [
        { capability: "admin", reason: "Need full access", required: true },
      ],
      acceptanceChecks: ["ok"],
      launchConstraints: ["ok"],
    };
    const [permsRevision] = await db
      .insert(venomBuildPackageRevisionsTable)
      .values({
        runId: runWithPerms.id,
        clerkUserId: ownerA,
        revisionNumber: 1,
        reason: "Perms test",
        package: badPermsPackage,
        checksumSha256: "b".repeat(64),
        approvedAt: new Date(),
        approvedBy: ownerA,
      })
      .returning();
    await db
      .update(venomBuildRunsTable)
      .set({ approvedRevisionId: permsRevision.id })
      .where(eq(venomBuildRunsTable.id, runWithPerms.id));

    const badPermsResp = await request(
      `/venom/build-runs/${runWithPerms.id}/provision`,
      {
        method: "POST",
        body: JSON.stringify({
          approvedRevisionId: permsRevision.id,
          idempotencyKey: randomUUID().replaceAll("-", "_").slice(0, 20),
          targetName: "Perms Test",
          requestedIntegrations: [],
          deploymentIntent: "create_candidate",
        }),
      },
    );
    assertStatus(badPermsResp, 400);
    assert.match(badPermsResp.body.error, /permission/i);

    // ── Test 31: Missing provider scope blocks before resource creation ───────
    const { run: scopedBuildRun, revision: scopedRevision } =
      await createApprovedBuildRun(ownerA);
    createdBuildRunIds.push(scopedBuildRun.id);
    await db
      .update(venomBuildPackageRevisionsTable)
      .set({
        package: {
          ...scopedRevision.package,
          integrationNeeds: ["github"],
        },
      })
      .where(eq(venomBuildPackageRevisionsTable.id, scopedRevision.id));
    let scopeProjectCalls = 0;
    const restoreMissingScope = overrideProvisioningProviderForTests(
      makeFakeProvider({
        capabilityHealth: "healthy",
        deniedIntegrations: ["github"],
        onCreateProject: () => {
          scopeProjectCalls += 1;
        },
      }),
    );
    const scopedCreate = await request(
      `/venom/build-runs/${scopedBuildRun.id}/provision`,
      {
        method: "POST",
        body: JSON.stringify({
          approvedRevisionId: scopedBuildRun.approvedRevisionId,
          idempotencyKey: randomUUID().replaceAll("-", "_").slice(0, 20),
          targetName: scopedBuildRun.targetName,
          requestedIntegrations: ["github"],
          deploymentIntent: "create_candidate",
        }),
      },
    );
    assertStatus(scopedCreate, 201);
    createdRunIds.push(scopedCreate.body.id);
    await processProvisioningRunForTests(ownerA, scopedCreate.body.id);
    const scopedDetail = await request(
      `/venom/provisioning/runs/${scopedCreate.body.id}`,
    );
    assertStatus(scopedDetail, 200);
    assert.equal(scopedDetail.body.status, "blocked");
    assert.match(scopedDetail.body.blockedReason, /github/i);
    assert.equal(scopeProjectCalls, 0);
    restoreMissingScope();

    // ── Test 32: A foreign app fails before any provider side effect ──────────
    const [foreignApp] = await db
      .insert(venomPortfolioAppsTable)
      .values({
        clerkUserId: ownerB,
        name: "Foreign App",
        purpose: "Ownership isolation",
        brand: "Test",
        status: "ready",
        detectedStack: [],
        sourceType: "none",
        currentSourceVersion: 0,
      })
      .returning();
    const { run: foreignAppBuildRun } = await createApprovedBuildRun(
      ownerA,
      "app",
      foreignApp.id,
    );
    createdBuildRunIds.push(foreignAppBuildRun.id);
    let foreignProjectCalls = 0;
    const restoreForeignApp = overrideProvisioningProviderForTests(
      makeFakeProvider({
        capabilityHealth: "healthy",
        onCreateProject: () => {
          foreignProjectCalls += 1;
        },
      }),
    );
    const foreignCreate = await request(
      `/venom/build-runs/${foreignAppBuildRun.id}/provision`,
      {
        method: "POST",
        body: JSON.stringify({
          approvedRevisionId: foreignAppBuildRun.approvedRevisionId,
          idempotencyKey: randomUUID().replaceAll("-", "_").slice(0, 20),
          targetName: foreignAppBuildRun.targetName,
          requestedIntegrations: [],
          deploymentIntent: "create_candidate",
        }),
      },
    );
    assertStatus(foreignCreate, 201);
    createdRunIds.push(foreignCreate.body.id);
    await processProvisioningRunForTests(ownerA, foreignCreate.body.id);
    const foreignDetail = await request(
      `/venom/provisioning/runs/${foreignCreate.body.id}`,
    );
    assertStatus(foreignDetail, 200);
    assert.equal(foreignDetail.body.status, "failed");
    assert.equal(foreignDetail.body.failureCode, "app_ownership_error");
    assert.equal(foreignProjectCalls, 0);
    restoreForeignApp();

    // ── Test 33: Exact source pin uses only a transient signed URL ─────────────
    const [sourceApp] = await db
      .insert(venomPortfolioAppsTable)
      .values({
        clerkUserId: ownerA,
        name: "Pinned Source App",
        purpose: "Source handoff verification",
        brand: "Test",
        status: "ready",
        detectedStack: ["typescript"],
        sourceType: "zip",
        currentSourceVersion: 1,
      })
      .returning();
    const sourceChecksum = "c".repeat(64);
    const sourceObjectPath = `/objects/venom-portfolio/packages/${sourceApp.id}/source.zip`;
    const [sourceVersion] = await db
      .insert(venomPortfolioSourceVersionsTable)
      .values({
        appId: sourceApp.id,
        clerkUserId: ownerA,
        versionNumber: 1,
        sourceType: "zip",
        packageObjectPath: sourceObjectPath,
        archiveFilename: "source.zip",
        archiveBytes: 128,
        checksumSha256: sourceChecksum,
        manifest: {
          formatVersion: 1,
          rootKind: "single-project",
          totalEntries: 1,
          safeFileCount: 1,
          excludedSensitiveFileCount: 0,
          files: ["src/index.ts"],
          projectFiles: ["package.json"],
          detectedStack: ["typescript"],
        },
      })
      .returning();
    const { run: sourceBuildRun, revision: sourceRevision } =
      await createApprovedBuildRun(
        ownerA,
        "app",
        sourceApp.id,
        sourceVersion.id,
      );
    createdBuildRunIds.push(sourceBuildRun.id);
    await db
      .update(venomBuildPackageRevisionsTable)
      .set({
        package: {
          ...sourceRevision.package,
          sourceReferences: [
            {
              appId: sourceApp.id,
              appName: sourceApp.name,
              sourceVersionId: sourceVersion.id,
              versionNumber: sourceVersion.versionNumber,
              checksumSha256: sourceChecksum,
            },
          ],
        },
      })
      .where(eq(venomBuildPackageRevisionsTable.id, sourceRevision.id));
    const signedDownloadUrl =
      "https://signed.example/source.zip?short_lived_signature=test";
    let signedPath: string | null = null;
    let capturedHandoff: any = null;
    const restoreSigner = overrideProvisioningSourceDownloadSignerForTests(
      async (objectPath) => {
        signedPath = objectPath;
        return signedDownloadUrl;
      },
    );
    const restoreSourceProvider = overrideProvisioningProviderForTests(
      makeFakeProvider({
        capabilityHealth: "healthy",
        candidateIdToReturn: "candidate-source-pin",
        onHandoff: (handoff) => {
          capturedHandoff = handoff;
        },
      }),
    );
    const sourceCreate = await request(
      `/venom/build-runs/${sourceBuildRun.id}/provision`,
      {
        method: "POST",
        body: JSON.stringify({
          approvedRevisionId: sourceBuildRun.approvedRevisionId,
          idempotencyKey: randomUUID().replaceAll("-", "_").slice(0, 20),
          targetName: sourceBuildRun.targetName,
          requestedIntegrations: [],
          deploymentIntent: "create_candidate",
        }),
      },
    );
    assertStatus(sourceCreate, 201);
    createdRunIds.push(sourceCreate.body.id);
    await processProvisioningRunForTests(ownerA, sourceCreate.body.id);
    restoreSourceProvider();
    restoreSigner();
    const sourceDetail = await request(
      `/venom/provisioning/runs/${sourceCreate.body.id}`,
    );
    assertStatus(sourceDetail, 200);
    assert.equal(sourceDetail.body.status, "candidate_ready");
    assert.equal(signedPath, sourceObjectPath);
    assert.equal(
      capturedHandoff?.sourceRef?.sourceVersionId,
      sourceVersion.id,
    );
    assert.equal(capturedHandoff?.sourceRef?.checksumSha256, sourceChecksum);
    assert.equal(capturedHandoff?.sourceRef?.downloadUrl, signedDownloadUrl);
    assert.equal("objectPath" in capturedHandoff.sourceRef, false);
    assert.equal("packageObjectPath" in capturedHandoff.sourceRef, false);
    assert.equal(
      JSON.stringify(capturedHandoff).includes(sourceObjectPath),
      false,
      "managed object path must never leave the API server",
    );

    const createSharedAppCandidate = async (
      candidateId: string,
    ): Promise<{
      buildRun: Awaited<ReturnType<typeof createApprovedBuildRun>>["run"];
      provisioningRunId: string;
      releaseId: string;
    }> => {
      const { run: buildRun } = await createApprovedBuildRun(
        ownerA,
        "app",
        successDetail.body.appId,
      );
      createdBuildRunIds.push(buildRun.id);
      const restoreCandidateProvider = overrideProvisioningProviderForTests(
        makeFakeProvider({
          capabilityHealth: "healthy",
          candidateIdToReturn: candidateId,
        }),
      );
      const createResponse = await request(
        `/venom/build-runs/${buildRun.id}/provision`,
        {
          method: "POST",
          body: JSON.stringify({
            approvedRevisionId: buildRun.approvedRevisionId,
            idempotencyKey: randomUUID().replaceAll("-", "_").slice(0, 20),
            targetName: buildRun.targetName,
            requestedIntegrations: [],
            deploymentIntent: "create_candidate",
          }),
        },
      );
      assertStatus(createResponse, 201);
      const provisioningRunId = createResponse.body.id;
      createdRunIds.push(provisioningRunId);
      await processProvisioningRunForTests(ownerA, provisioningRunId);
      restoreCandidateProvider();
      const detail = await request(
        `/venom/provisioning/runs/${provisioningRunId}`,
      );
      assertStatus(detail, 200);
      assert.equal(detail.body.status, "candidate_ready");
      return {
        buildRun,
        provisioningRunId,
        releaseId: detail.body.releases[0].id,
      };
    };

    // ── Test 34: Different candidate publishes serialize per app ──────────────
    const sharedCandidateA = await createSharedAppCandidate("candidate-app-a");
    const sharedCandidateB = await createSharedAppCandidate("candidate-app-b");
    let appPublishCalls = 0;
    const restoreAppPublish = overrideProvisioningProviderForTests(
      makeFakeProvider({
        capabilityHealth: "healthy",
        publishDelayMs: 80,
        publishHealthyResult: true,
        onPublish: () => {
          appPublishCalls += 1;
        },
      }),
    );
    const publishSharedCandidate = (
      candidate: typeof sharedCandidateA,
    ): Promise<TestResponse> =>
      request(
        `/venom/provisioning/runs/${candidate.provisioningRunId}/publish`,
        {
          method: "POST",
          body: JSON.stringify({
            candidateReleaseId: candidate.releaseId,
            idempotencyKey: randomUUID().replaceAll("-", "_").slice(0, 20),
            confirmTargetName: candidate.buildRun.targetName,
          }),
        },
      );
    const differentReleasePublishResponses = await Promise.all([
      publishSharedCandidate(sharedCandidateA),
      publishSharedCandidate(sharedCandidateB),
    ]);
    assert.deepEqual(
      differentReleasePublishResponses
        .map((response) => response.status)
        .sort(),
      [200, 409],
    );
    assert.equal(
      appPublishCalls,
      1,
      "only one different-release publish may reach the provider per app",
    );
    restoreAppPublish();

    // ── Test 35: Publish and rollback share the same app mutation lease ────────
    const sharedCandidateC = await createSharedAppCandidate("candidate-app-c");
    let deploymentMutationCalls = 0;
    const restoreMixedMutation = overrideProvisioningProviderForTests(
      makeFakeProvider({
        capabilityHealth: "healthy",
        publishDelayMs: 80,
        rollbackDelayMs: 80,
        publishHealthyResult: true,
        rollbackHealthyResult: true,
        rollbackSupportedResult: true,
        onPublish: () => {
          deploymentMutationCalls += 1;
        },
        onRollback: () => {
          deploymentMutationCalls += 1;
        },
      }),
    );
    const mixedMutationResponses = await Promise.all([
      request(
        `/venom/provisioning/runs/${sharedCandidateC.provisioningRunId}/publish`,
        {
          method: "POST",
          body: JSON.stringify({
            candidateReleaseId: sharedCandidateC.releaseId,
            idempotencyKey: randomUUID().replaceAll("-", "_").slice(0, 20),
            confirmTargetName: sharedCandidateC.buildRun.targetName,
          }),
        },
      ),
      request(
        `/venom/provisioning/releases/${successReleaseId}/rollback`,
        {
          method: "POST",
          body: JSON.stringify({
            idempotencyKey: randomUUID().replaceAll("-", "_").slice(0, 20),
            confirmTargetName: successBuildRun.targetName,
          }),
        },
      ),
    ]);
    assert.deepEqual(
      mixedMutationResponses.map((response) => response.status).sort(),
      [200, 409],
    );
    assert.equal(
      deploymentMutationCalls,
      1,
      "publish and rollback must not reach the provider concurrently for one app",
    );
    restoreMixedMutation();

    // ── Test 36: Provider permission identifiers never reach durable output ───
    const { run: maliciousPermissionBuildRun } =
      await createApprovedBuildRun(ownerA);
    createdBuildRunIds.push(maliciousPermissionBuildRun.id);
    const providerSecretText =
      "https://gateway.internal/callback?token=provider-secret-value";
    let maliciousPermissionProjectCalls = 0;
    const restoreMaliciousPermissions = overrideProvisioningProviderForTests(
      makeFakeProvider({
        capabilityHealth: "healthy",
        permissionSummary: {
          allowed: [],
          denied: [
            {
              integration: providerSecretText,
              reason: "provider-private-reason",
            },
          ],
        },
        onCreateProject: () => {
          maliciousPermissionProjectCalls += 1;
        },
      }),
    );
    const maliciousPermissionCreate = await request(
      `/venom/build-runs/${maliciousPermissionBuildRun.id}/provision`,
      {
        method: "POST",
        body: JSON.stringify({
          approvedRevisionId:
            maliciousPermissionBuildRun.approvedRevisionId,
          idempotencyKey: randomUUID().replaceAll("-", "_").slice(0, 20),
          targetName: maliciousPermissionBuildRun.targetName,
          requestedIntegrations: [],
          deploymentIntent: "create_candidate",
        }),
      },
    );
    assertStatus(maliciousPermissionCreate, 201);
    createdRunIds.push(maliciousPermissionCreate.body.id);
    await processProvisioningRunForTests(
      ownerA,
      maliciousPermissionCreate.body.id,
    );
    const maliciousPermissionDetail = await request(
      `/venom/provisioning/runs/${maliciousPermissionCreate.body.id}`,
    );
    assertStatus(maliciousPermissionDetail, 200);
    assert.equal(maliciousPermissionDetail.body.status, "blocked");
    assert.equal(
      maliciousPermissionDetail.body.blockedReason,
      "Managed capability permission validation failed",
    );
    const maliciousPermissionJson = JSON.stringify(
      maliciousPermissionDetail.body,
    );
    assert.equal(maliciousPermissionJson.includes(providerSecretText), false);
    assert.equal(
      maliciousPermissionJson.includes("provider-private-reason"),
      false,
    );
    assert.equal(maliciousPermissionProjectCalls, 0);
    restoreMaliciousPermissions();
  } finally {
    server.close();
    restoreAuth();
    restoreScheduler();

    // Cleanup
    if (createdRunIds.length > 0) {
      await db
        .delete(venomCandidateReleasesTable)
        .where(
          inArray(venomCandidateReleasesTable.provisioningRunId, createdRunIds),
        );
      await db
        .delete(venomProvisioningEventsTable)
        .where(
          inArray(
            venomProvisioningEventsTable.provisioningRunId,
            createdRunIds,
          ),
        );
      await db
        .delete(venomProvisioningRunsTable)
        .where(inArray(venomProvisioningRunsTable.id, createdRunIds));
    }
    if (createdBuildRunIds.length > 0) {
      await db
        .delete(venomBuildPackageRevisionsTable)
        .where(
          inArray(
            venomBuildPackageRevisionsTable.runId,
            createdBuildRunIds,
          ),
        );
      await db
        .delete(venomBuildRunsTable)
        .where(inArray(venomBuildRunsTable.id, createdBuildRunIds));
    }
    await db
      .delete(venomBuildRunsTable)
      .where(
        inArray(venomBuildRunsTable.clerkUserId, [ownerA, ownerB]),
      );
    await db
      .delete(venomPortfolioAppsTable)
      .where(
        inArray(venomPortfolioAppsTable.clerkUserId, [ownerA, ownerB]),
      );
  }
});
