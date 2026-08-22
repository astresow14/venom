/**
 * Venom provisioning routes and worker.
 *
 * Security invariants:
 * - Every operation bound to Clerk user ownership.
 * - Approved immutable revision + source ownership/checksum reverified at start.
 * - Rejected: unapproved packages, non-app/website target types, injected
 *   permissions, credential-like integrations, mismatched target confirmations.
 * - Advisory locks for duplicate safety.
 * - Blocked runs persisted without creating provider resources.
 * - Provider calls receive immutable package data and a transient signed source
 *   download URL; managed object paths never leave the server.
 * - No credentials, tokens, or secrets logged or returned to clients.
 * - Failed publish preserves existing primary link.
 * - Rollback only promotes provider-confirmed healthy releases.
 */

import { getAuth } from "@clerk/express";
import {
  deliverAppAiCredentialSerialized,
  prepareAppAiCredentialForHandoff,
  type RuntimeCredentialPreparation,
} from "../lib/venom-app-ai-store";
import {
  CancelProvisioningRunBody,
  CancelProvisioningRunParams,
  CancelProvisioningRunResponse,
  GetProvisioningCapabilityResponse,
  GetProvisioningRunParams,
  GetProvisioningRunResponse,
  ListProvisioningRunsQueryParams,
  ListProvisioningRunsResponse,
  ProvisionBuildRunBody,
  ProvisionBuildRunParams,
  ProvisionBuildRunResponse,
  PublishProvisioningCandidateBody,
  PublishProvisioningCandidateParams,
  PublishProvisioningCandidateResponse,
  RetryProvisioningRunParams,
  RetryProvisioningRunResponse,
  RollbackProvisioningReleaseBody,
  RollbackProvisioningReleaseParams,
  RollbackProvisioningReleaseResponse,
} from "@workspace/api-zod";
import {
  db,
  venomBuildPackageRevisionsTable,
  venomBuildRunsTable,
  venomCandidateReleasesTable,
  venomPortfolioAppIterationsTable,
  venomPortfolioAppsTable,
  venomPortfolioDeploymentLinksTable,
  venomPortfolioSourceVersionsTable,
  venomProvisioningEventsTable,
  venomProvisioningRunsTable,
  type VenomCandidateRelease,
  type VenomProvisioningRun,
} from "@workspace/db";
import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import { Router, type IRouter, type Request } from "express";
import { logger } from "../lib/logger";
import { createSourceArchiveDownloadUrl } from "../lib/portfolio-storage";
import {
  ProvisioningCapabilityUnavailableError,
  ProvisioningProviderError,
  ProvisioningTimeoutError,
  getProvisioningProvider,
  hasDangerousIntegrationStrings,
  hasUnsupportedPermissionRequests,
  sanitizeLaunchUrl,
  withProviderTimeout,
} from "../lib/venom-provisioning-provider";

const router: IRouter = Router();

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_ATTEMPTS = 5;
const STAGE_TIMEOUT_MS = 60_000;
/** Overall deadline for the build-polling loop (not per-poll timeout). */
const BUILD_POLL_DEADLINE_MS = 20 * 60_000; // 20 minutes
const STALE_HEARTBEAT_AFTER_MS = 5 * 60_000;
const WORKER_RECONCILE_INTERVAL_MS = 15_000;
// Reconciliation exists to rescue orphaned queued work (e.g. after a server
// restart), not to double-schedule runs that were just created: fresh runs are
// already scheduled in-process at creation time. The grace period also keeps a
// worker in one process (the dev server) from claiming rows another process
// (an integration test sharing the same database) created moments ago.
const QUEUE_RESCUE_MIN_AGE_MS = 2 * 60_000;

// Active worker controllers keyed by provisioningRunId
const activeProvisioningControllers = new Map<string, AbortController>();

let workerTimer: ReturnType<typeof setInterval> | null = null;
let signSourceArchiveForProvisioning = createSourceArchiveDownloadUrl;

// ─── Auth override (test injection) ──────────────────────────────────────────

let resolveProvisioningUserId = (request: Request): string | null =>
  getAuth(request).userId;

export function overrideProvisioningUserIdResolverForTests(
  resolver: (request: Request) => string | null,
): () => void {
  const previous = resolveProvisioningUserId;
  resolveProvisioningUserId = resolver;
  return () => {
    resolveProvisioningUserId = previous;
  };
}

function userIdFor(request: Request): string | null {
  return resolveProvisioningUserId(request);
}

// ─── Schedule override (test injection) ───────────────────────────────────────

function scheduleProvisioningRun(userId: string, runId: string): void {
  setImmediate(() => {
    void processProvisioningRun(userId, runId);
  });
}

let scheduleProvisioningRunEffect = scheduleProvisioningRun;

export function overrideProvisioningSchedulerForTests(
  scheduler: (userId: string, runId: string) => void,
): () => void {
  const previous = scheduleProvisioningRunEffect;
  scheduleProvisioningRunEffect = scheduler;
  return () => {
    scheduleProvisioningRunEffect = previous;
  };
}

export function overrideProvisioningSourceDownloadSignerForTests(
  signer: (objectPath: string) => Promise<string>,
): () => void {
  const previous = signSourceArchiveForProvisioning;
  signSourceArchiveForProvisioning = signer;
  return () => {
    signSourceArchiveForProvisioning = previous;
  };
}

// ─── Payload helpers ──────────────────────────────────────────────────────────

function runSummaryPayload(run: VenomProvisioningRun) {
  return {
    id: run.id,
    buildRunId: run.buildRunId,
    approvedRevisionId: run.approvedRevisionId,
    appId: run.appId,
    targetName: run.targetName,
    status: run.status,
    stage: run.stage,
    progress: run.progress,
    attempt: run.attempt,
    providerProjectId: run.providerProjectId,
    providerCandidateId: run.providerCandidateId,
    failureCode: run.failureCode,
    failureMessage: run.failureMessage,
    blockedReason: run.blockedReason,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

function releasePayload(release: VenomCandidateRelease) {
  return {
    id: release.id,
    provisioningRunId: release.provisioningRunId,
    buildRunId: release.buildRunId,
    approvedRevisionId: release.approvedRevisionId,
    appId: release.appId,
    targetName: release.targetName,
    providerProjectId: release.providerProjectId,
    providerCandidateId: release.providerCandidateId,
    providerReleaseId: release.providerReleaseId,
    launchUrl: release.launchUrl,
    status: release.status,
    rollbackSupported: release.rollbackSupported,
    publishIdempotencyKey: release.publishIdempotencyKey,
    rollbackIdempotencyKey: release.rollbackIdempotencyKey,
    publishedAt: release.publishedAt,
    rolledBackAt: release.rolledBackAt,
    createdAt: release.createdAt,
    updatedAt: release.updatedAt,
  };
}

async function runPayload(run: VenomProvisioningRun) {
  const [events, releases] = await Promise.all([
    db
      .select()
      .from(venomProvisioningEventsTable)
      .where(
        and(
          eq(venomProvisioningEventsTable.provisioningRunId, run.id),
          eq(venomProvisioningEventsTable.clerkUserId, run.clerkUserId),
        ),
      )
      .orderBy(desc(venomProvisioningEventsTable.createdAt))
      .limit(200),
    db
      .select()
      .from(venomCandidateReleasesTable)
      .where(
        and(
          eq(venomCandidateReleasesTable.provisioningRunId, run.id),
          eq(venomCandidateReleasesTable.clerkUserId, run.clerkUserId),
        ),
      )
      .orderBy(desc(venomCandidateReleasesTable.createdAt))
      .limit(50),
  ]);
  return {
    ...runSummaryPayload(run),
    events: events.map((e) => ({
      id: e.id,
      eventType: e.eventType,
      status: e.status,
      stage: e.stage,
      progress: e.progress,
      message: e.message,
      createdAt: e.createdAt,
    })),
    releases: releases.map(releasePayload),
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    cancelRequested: run.cancelRequested,
  };
}

// ─── Ownership helpers ────────────────────────────────────────────────────────

async function ownedRun(userId: string, runId: string) {
  const [run] = await db
    .select()
    .from(venomProvisioningRunsTable)
    .where(
      and(
        eq(venomProvisioningRunsTable.id, runId),
        eq(venomProvisioningRunsTable.clerkUserId, userId),
      ),
    )
    .limit(1);
  return run;
}

// ─── Event helper ─────────────────────────────────────────────────────────────

async function addProvEvent(
  run: Pick<VenomProvisioningRun, "id" | "clerkUserId">,
  eventType: string,
  status: string,
  stage: string | null,
  progress: number,
  message: string,
): Promise<void> {
  await db.insert(venomProvisioningEventsTable).values({
    provisioningRunId: run.id,
    clerkUserId: run.clerkUserId,
    eventType: eventType as never,
    status: status as never,
    stage: stage as never,
    progress,
    message,
  });
}

// ─── Heartbeat ────────────────────────────────────────────────────────────────

async function heartbeat(runId: string, clerkUserId: string): Promise<void> {
  await db
    .update(venomProvisioningRunsTable)
    .set({ heartbeatAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(venomProvisioningRunsTable.id, runId),
        eq(venomProvisioningRunsTable.clerkUserId, clerkUserId),
      ),
    );
}

// ─── Worker: process a single run ────────────────────────────────────────────

async function processProvisioningRun(
  userId: string,
  runId: string,
): Promise<void> {
  const startedAtMs = Date.now();

  // Claim the run (queued → checking_capability)
  const [run] = await db
    .update(venomProvisioningRunsTable)
    .set({
      status: "checking_capability",
      stage: "capability_check",
      progress: 5,
      startedAt: new Date(),
      heartbeatAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(venomProvisioningRunsTable.id, runId),
        eq(venomProvisioningRunsTable.clerkUserId, userId),
        eq(venomProvisioningRunsTable.status, "queued"),
      ),
    )
    .returning();
  if (!run) return;

  await addProvEvent(
    run,
    "queued",
    "checking_capability",
    "capability_check",
    5,
    "Checking provisioning provider capability.",
  );

  const controller = new AbortController();
  activeProvisioningControllers.set(run.id, controller);

  try {
    const provider = getProvisioningProvider();

    // Helper: persist a blocked run WITHOUT creating any provider resources.
    const blockRun = async (reason: string): Promise<void> => {
      await db
        .update(venomProvisioningRunsTable)
        .set({
          status: "blocked",
          stage: "capability_check",
          progress: 0,
          blockedReason: reason,
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(venomProvisioningRunsTable.id, run.id),
            eq(venomProvisioningRunsTable.clerkUserId, userId),
          ),
        );
      await addProvEvent(run, "blocked", "blocked", "capability_check", 0, reason);
    };

    // Stage 1: Check capability
    const capability = await provider.checkCapability();
    await heartbeat(run.id, userId);

    // Missing / expired / unhealthy capability → blocked (not failed), with the
    // package preserved and zero provider resources created.
    if (
      capability.health === "unavailable" ||
      capability.health === "unconfigured"
    ) {
      await blockRun(capability.recoveryGuidance ?? capability.summary);
      return;
    }

    // Re-verify approved revision and source ownership
    const [buildRun] = await db
      .select()
      .from(venomBuildRunsTable)
      .where(
        and(
          eq(venomBuildRunsTable.id, run.buildRunId),
          eq(venomBuildRunsTable.clerkUserId, userId),
        ),
      )
      .limit(1);

    if (
      !buildRun ||
      buildRun.status !== "ready_for_provisioning" ||
      buildRun.approvedRevisionId !== run.approvedRevisionId
    ) {
      throw new ProvisioningProviderError(
        "Approved revision is no longer valid",
        "invalid_approved_revision",
        false,
      );
    }

    const [revision] = await db
      .select()
      .from(venomBuildPackageRevisionsTable)
      .where(
        and(
          eq(venomBuildPackageRevisionsTable.id, run.approvedRevisionId),
          eq(venomBuildPackageRevisionsTable.runId, run.buildRunId),
          eq(venomBuildPackageRevisionsTable.clerkUserId, userId),
        ),
      )
      .limit(1);

    if (!revision || !revision.approvedAt) {
      throw new ProvisioningProviderError(
        "Approved revision not found or not approved",
        "revision_not_approved",
        false,
      );
    }

    // Verify target type is one Venom supports at all.
    const targetType = buildRun.targetType;
    if (targetType !== "app" && targetType !== "website") {
      throw new ProvisioningProviderError(
        `Target type '${targetType}' is not supported for provisioning`,
        "unsupported_target_type",
        false,
      );
    }

    // The provider must explicitly support this target type BEFORE any provider
    // resource is created. A degraded provider is only usable when it still
    // reports support for this target type; otherwise block (not fail).
    if (!capability.supportedTargetTypes.includes(targetType)) {
      await blockRun(
        capability.recoveryGuidance ??
          `Provisioning is currently unavailable for '${targetType}' targets. ${capability.summary}`,
      );
      return;
    }
    if (capability.health === "degraded") {
      // Usable only because support is explicitly reported above; permissions
      // are validated below before any resource creation.
      await addProvEvent(
        run,
        "capability_checked",
        "checking_capability",
        "capability_check",
        8,
        "Provider capability is degraded but supports this target; continuing with validation.",
      );
    }

    await addProvEvent(
      run,
      "capability_checked",
      "creating_project",
      "capability_check",
      10,
      "Provider capability verified.",
    );

    // Enforce requestedIntegrations exactly matches revision.package.integrationNeeds
    // (order-insensitive, deduped) — prevents drift between approved package and request.
    const packageIntegrationNeeds: string[] = Array.from(
      new Set(revision.package.integrationNeeds ?? []),
    ).sort();
    const requestedSorted = Array.from(new Set(run.requestedIntegrations ?? [])).sort();
    const integrationMismatch =
      packageIntegrationNeeds.length !== requestedSorted.length ||
      packageIntegrationNeeds.some((v, i) => v !== requestedSorted[i]);

    if (integrationMismatch) {
      throw new ProvisioningProviderError(
        "Requested integrations do not match the approved package integration needs",
        "integration_needs_mismatch",
        false,
      );
    }

    // Validate permissions with provider before any resource creation.
    // Denied integrations → persist a blocked run; no provider resources created.
    const permSummary = await provider.validatePermissions(requestedSorted);
    const requestedSet = new Set(requestedSorted);
    const providerPermissionNames = [
      ...permSummary.allowed,
      ...permSummary.denied.map((item) => item.integration),
    ];
    const invalidProviderPermissionOutput = providerPermissionNames.some(
      (name) => !requestedSet.has(name),
    );
    const allowedByProvider = new Set(permSummary.allowed);
    const deniedByProvider = new Set(
      permSummary.denied.map((item) => item.integration),
    );
    const deniedNames = requestedSorted.filter(
      (name) => deniedByProvider.has(name) || !allowedByProvider.has(name),
    );
    if (invalidProviderPermissionOutput || deniedNames.length > 0) {
      const safeReason = invalidProviderPermissionOutput
        ? "Managed capability permission validation failed"
        : `Integrations not permitted: ${deniedNames.join(", ")}`;
      await db
        .update(venomProvisioningRunsTable)
        .set({
          status: "blocked",
          stage: "capability_check",
          progress: 0,
          blockedReason: safeReason,
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(venomProvisioningRunsTable.id, run.id),
            eq(venomProvisioningRunsTable.clerkUserId, userId),
          ),
        );
      await addProvEvent(
        run,
        "blocked",
        "blocked",
        "capability_check",
        0,
        `Provisioning blocked: ${safeReason}.`,
      );
      return;
    }

    // ── Verify app ownership BEFORE any provider resource creation ──────────
    // When the run pins an existing app, the app must be owned by this user.
    // A missing/foreign app fails closed here, before any project/build call.
    // Runs without a pinned app register a new app later at candidate stage.
    if (run.appId) {
      const [ownedApp] = await db
        .select({ id: venomPortfolioAppsTable.id })
        .from(venomPortfolioAppsTable)
        .where(
          and(
            eq(venomPortfolioAppsTable.id, run.appId),
            eq(venomPortfolioAppsTable.clerkUserId, userId),
          ),
        )
        .limit(1);
      if (!ownedApp) {
        throw new ProvisioningProviderError(
          "Provisioning cannot proceed: associated app is not accessible",
          "app_ownership_error",
          false,
        );
      }
    }

    // ── Source pinning (fail closed before provider calls) ──────────────────
    // The approved package's source references and the run's sourceVersionId
    // must agree exactly. If the run pins a source version, the package must
    // reference exactly that appId/versionNumber/checksum. If it pins none,
    // the package must reference no source.
    const packageSourceRefs = revision.package.sourceReferences ?? [];

    // objectPath is resolved but NEVER persisted or logged; a transient signed
    // download URL is generated only for the outbound provider handoff.
    let sourceObjectPath: string | null = null;
    let sourceRef: {
      appId: string;
      sourceVersionId: string;
      versionNumber: number;
      checksumSha256: string;
      archiveFilename: string;
      archiveBytes: number;
      sourceType: string;
    } | null = null;

    if (run.sourceVersionId) {
      if (packageSourceRefs.length !== 1) {
        throw new ProvisioningProviderError(
          "Approved package must reference exactly the pinned source version",
          "source_reference_mismatch",
          false,
        );
      }
      const [sourceVersion] = await db
        .select()
        .from(venomPortfolioSourceVersionsTable)
        .where(
          and(
            eq(venomPortfolioSourceVersionsTable.id, run.sourceVersionId),
            eq(venomPortfolioSourceVersionsTable.clerkUserId, userId),
          ),
        )
        .limit(1);

      if (!sourceVersion) {
        throw new ProvisioningProviderError(
          "Source version is no longer available",
          "source_version_unavailable",
          false,
        );
      }

      // The approved package must reference exactly this pinned source.
      const packageSourceRef = packageSourceRefs.find(
        (ref) => ref.sourceVersionId === run.sourceVersionId,
      );
      if (!packageSourceRef) {
        throw new ProvisioningProviderError(
          "Approved package does not reference the pinned source version",
          "source_reference_missing",
          false,
        );
      }
      if (
        packageSourceRef.appId !== sourceVersion.appId ||
        packageSourceRef.versionNumber !== sourceVersion.versionNumber ||
        packageSourceRef.checksumSha256 !== sourceVersion.checksumSha256 ||
        (run.appId != null && sourceVersion.appId !== run.appId)
      ) {
        throw new ProvisioningProviderError(
          "Source version does not match the approved package reference",
          "source_reference_mismatch",
          false,
        );
      }

      sourceObjectPath = sourceVersion.packageObjectPath;
      sourceRef = {
        appId: sourceVersion.appId,
        sourceVersionId: sourceVersion.id,
        versionNumber: sourceVersion.versionNumber,
        checksumSha256: sourceVersion.checksumSha256,
        archiveFilename: sourceVersion.archiveFilename,
        archiveBytes: sourceVersion.archiveBytes,
        sourceType: sourceVersion.sourceType,
      };
    } else if (packageSourceRefs.length > 0) {
      // No pinned source version, but the package references one → mismatch.
      throw new ProvisioningProviderError(
        "Approved package references a source version but none is pinned",
        "source_reference_unexpected",
        false,
      );
    }

    // Check cancellation — persist durable cancelled state (no provider
    // resources exist yet at this stage).
    if (controller.signal.aborted || (await ownedRun(userId, run.id))?.cancelRequested) {
      await handleCancellation(
        { id: run.id, clerkUserId: userId, providerProjectId: null, providerBuildId: null },
        "Cancelled before project setup.",
      );
      return;
    }

    // Stage 2: Create/link project
    await db
      .update(venomProvisioningRunsTable)
      .set({
        status: "creating_project",
        stage: "project_setup",
        progress: 20,
        updatedAt: new Date(),
      })
      .where(eq(venomProvisioningRunsTable.id, run.id));

    // Stable per-attempt operation key: reuse the persisted one so a resumed
    // run does not create duplicate provider resources; initialize it once.
    const operationKey =
      run.buildAttemptKey ?? `${run.id}:attempt-${run.attempt}`;
    if (!run.buildAttemptKey) {
      await db
        .update(venomProvisioningRunsTable)
        .set({ buildAttemptKey: operationKey, updatedAt: new Date() })
        .where(eq(venomProvisioningRunsTable.id, run.id));
    }

    const projectResult = await withProviderTimeout(
      "project_setup",
      STAGE_TIMEOUT_MS,
      (signal) =>
        provider.createOrLinkProject({
          ownerId: userId,
          targetName: run.targetName,
          targetType,
          // Reuse a persisted project id on resume — idempotent create/link.
          existingProviderProjectId: run.providerProjectId ?? undefined,
          provisioningRunId: run.id,
          idempotencyKey: `${operationKey}:project`,
          signal,
        }),
      controller.signal,
    );

    await db
      .update(venomProvisioningRunsTable)
      .set({
        providerProjectId: projectResult.providerProjectId,
        updatedAt: new Date(),
      })
      .where(eq(venomProvisioningRunsTable.id, run.id));
    await heartbeat(run.id, userId);

    await addProvEvent(
      run,
      projectResult.created ? "project_created" : "project_linked",
      "handing_off",
      "project_setup",
      30,
      projectResult.created
        ? "Provider project created."
        : "Provider project linked.",
    );

    // Check cancellation — providerProjectId now exists, pass it so
    // cancelOperation can be attempted.
    if (controller.signal.aborted || (await ownedRun(userId, run.id))?.cancelRequested) {
      await handleCancellation(
        {
          id: run.id,
          clerkUserId: userId,
          providerProjectId: projectResult.providerProjectId,
          providerBuildId: null,
        },
        "Cancelled before source handoff.",
      );
      return;
    }

    // Stage 3: Hand off approved package + source object reference
    await db
      .update(venomProvisioningRunsTable)
      .set({
        status: "handing_off",
        stage: "source_handoff",
        progress: 40,
        updatedAt: new Date(),
      })
      .where(eq(venomProvisioningRunsTable.id, run.id));

    // Generate a short-lived signed GET URL immediately before handoff so the
    // trusted gateway can download + checksum-verify the source. The signed
    // URL and the managed objectPath are transient: never persisted, returned,
    // or logged — they exist only inside the outbound provider call below.
    // If signing fails we throw before any build starts; retry stays safe.
    let handoffSourceRef:
      | (typeof sourceRef & { downloadUrl: string })
      | null = null;
    if (sourceRef && sourceObjectPath) {
      let downloadUrl: string;
      try {
        downloadUrl = await signSourceArchiveForProvisioning(sourceObjectPath);
      } catch {
        throw new ProvisioningProviderError(
          "Unable to prepare source for handoff. Retry this run.",
          "source_handoff_signing_failed",
          true,
        );
      }
      handoffSourceRef = { ...sourceRef, downloadUrl };
    }

    // Whitelabeled AI: decide whether this handoff needs a fresh gateway
    // credential for the app. Only possible when the run already knows its
    // app (an iteration); first-time provisioning delivers right after the
    // app record is created at candidate stage. The secret never rides the
    // package itself — delivery happens AFTER the handoff, serialized with
    // the credential lifecycle, so a rotation racing this run cannot end up
    // with its fresh key overwritten by this run's stale one. The env map
    // carries the live secret — transient, never stored or logged. A re-run
    // whose credential already reached THIS project prepares nothing.
    let runtimeCredentialPrep: RuntimeCredentialPreparation | null = null;
    if (run.appId) {
      runtimeCredentialPrep = await prepareAppAiCredentialForHandoff(
        userId,
        run.appId,
        projectResult.providerProjectId,
      );
    }

    await withProviderTimeout(
      "source_handoff",
      STAGE_TIMEOUT_MS,
      (signal) =>
        provider.handOffPackage({
          providerProjectId: projectResult.providerProjectId,
          handoff: {
            buildRunId: run.buildRunId,
            provisioningRunId: run.id,
            approvedRevisionId: run.approvedRevisionId,
            packageChecksumSha256: revision.checksumSha256,
            // Full approved package object — trusted server-to-server.
            // NEVER stored on DB records or included in log lines.
            approvedPackage: revision.package,
            targetType,
            targetName: run.targetName,
            // Transient signed download URL + exact source pins. No objectPath.
            sourceRef: handoffSourceRef,
            // Never carries the gateway secret: credentials are delivered
            // separately below, serialized with the credential lifecycle.
            runtimeCredentials: null,
          },
          signal,
        }),
      controller.signal,
    );
    if (runtimeCredentialPrep && run.appId) {
      // Deliver the freshly minted gateway credential now that the package
      // handoff succeeded. The provider write runs under the per-app
      // credential lock and is skipped when a concurrent rotation superseded
      // this credential (the rotation's own delivery then owns the provider
      // secret). Failure is non-fatal: the credential stays undelivered, so
      // the next handoff re-mints and ships a fresh one.
      try {
        await deliverAppAiCredentialSerialized(
          run.appId,
          runtimeCredentialPrep.credentialId,
          projectResult.providerProjectId,
          async () => {
            await provider.deliverRuntimeCredentials({
              providerProjectId: projectResult.providerProjectId,
              credentials: { envVars: runtimeCredentialPrep.envVars },
              signal: controller.signal,
            });
          },
        );
      } catch {
        // Never log the caught error: this path handles a live secret.
        logger.warn(
          {
            operation: "venom_provisioning_ai_credential_deferred",
            runId: run.id,
            appId: run.appId,
          },
          "App AI credential delivery deferred to next provisioning handoff",
        );
      }
    }
    await heartbeat(run.id, userId);

    await addProvEvent(
      run,
      "source_handed_off",
      "building",
      "source_handoff",
      45,
      "Approved package handed off to provider.",
    );

    // Stage 4: Build
    await db
      .update(venomProvisioningRunsTable)
      .set({
        status: "building",
        stage: "build",
        progress: 50,
        updatedAt: new Date(),
      })
      .where(eq(venomProvisioningRunsTable.id, run.id));

    // startBuild is idempotent by the stable operation key, so a resumed run
    // returns the existing build rather than starting another.
    const buildResult = await withProviderTimeout(
      "build",
      STAGE_TIMEOUT_MS,
      (signal) =>
        provider.startBuild({
          providerProjectId: projectResult.providerProjectId,
          buildRunId: run.buildRunId,
          provisioningRunId: run.id,
          idempotencyKey: `${operationKey}:build`,
          signal,
        }),
      controller.signal,
    );

    await db
      .update(venomProvisioningRunsTable)
      .set({
        providerBuildId: buildResult.providerBuildId,
        updatedAt: new Date(),
      })
      .where(eq(venomProvisioningRunsTable.id, run.id));

    await addProvEvent(
      run,
      "build_started",
      "building",
      "build",
      55,
      "Provider build started.",
    );

    // Poll build status
    let buildStatus = await withProviderTimeout(
      "build_poll",
      STAGE_TIMEOUT_MS,
      (signal) =>
        provider.getBuildStatus({
          providerProjectId: projectResult.providerProjectId,
          providerBuildId: buildResult.providerBuildId,
          signal,
        }),
      controller.signal,
    );

    // Bounded build polling — overall deadline prevents infinite polling.
    const buildPollDeadlineMs = Date.now() + BUILD_POLL_DEADLINE_MS;
    while (
      buildStatus.status === "pending" ||
      buildStatus.status === "building"
    ) {
      if (controller.signal.aborted || (await ownedRun(userId, run.id))?.cancelRequested) {
        await handleCancellation(
          {
            id: run.id,
            clerkUserId: userId,
            providerProjectId: projectResult.providerProjectId,
            providerBuildId: buildResult.providerBuildId,
          },
          "Cancelled during build.",
        );
        return;
      }
      if (Date.now() >= buildPollDeadlineMs) {
        throw new ProvisioningProviderError(
          "Build exceeded maximum allowed time. Retry this run.",
          "build_timeout",
          true,
        );
      }
      await heartbeat(run.id, userId);
      await new Promise((r) => setTimeout(r, 3000));
      buildStatus = await withProviderTimeout(
        "build_poll",
        STAGE_TIMEOUT_MS,
        (signal) =>
          provider.getBuildStatus({
            providerProjectId: projectResult.providerProjectId,
            providerBuildId: buildResult.providerBuildId,
            signal,
          }),
        controller.signal,
      );
    }

    if (buildStatus.status !== "success") {
      throw new ProvisioningProviderError(
        buildStatus.message || "Build failed",
        "build_failed",
        true,
      );
    }

    await addProvEvent(
      run,
      "build_complete",
      "testing",
      "build",
      65,
      "Build completed successfully.",
    );

    // Stage 5: Test
    await db
      .update(venomProvisioningRunsTable)
      .set({
        status: "testing",
        stage: "test",
        progress: 70,
        updatedAt: new Date(),
      })
      .where(eq(venomProvisioningRunsTable.id, run.id));

    await addProvEvent(
      run,
      "test_started",
      "testing",
      "test",
      70,
      "Running acceptance tests.",
    );

    if (controller.signal.aborted || (await ownedRun(userId, run.id))?.cancelRequested) {
      await handleCancellation(
        {
          id: run.id,
          clerkUserId: userId,
          providerProjectId: projectResult.providerProjectId,
          providerBuildId: buildResult.providerBuildId,
        },
        "Cancelled before tests.",
      );
      return;
    }

    const testResult = await withProviderTimeout(
      "test",
      STAGE_TIMEOUT_MS,
      (signal) =>
        provider.runTests({
          providerProjectId: projectResult.providerProjectId,
          providerBuildId: buildResult.providerBuildId,
          signal,
        }),
      controller.signal,
    );
    await heartbeat(run.id, userId);

    if (!testResult.passed) {
      throw new ProvisioningProviderError(
        testResult.message || "Acceptance tests failed",
        "tests_failed",
        true,
      );
    }

    await addProvEvent(
      run,
      "test_complete",
      "testing",
      "test",
      80,
      "Acceptance tests passed.",
    );

    // Stage 6: Create candidate
    await db
      .update(venomProvisioningRunsTable)
      .set({
        status: "testing",
        stage: "candidate",
        progress: 90,
        updatedAt: new Date(),
      })
      .where(eq(venomProvisioningRunsTable.id, run.id));

    // createCandidate is idempotent by (provisioningRunId, providerBuildId).
    const candidateResult = await withProviderTimeout(
      "candidate",
      STAGE_TIMEOUT_MS,
      (signal) =>
        provider.createCandidate({
          providerProjectId: projectResult.providerProjectId,
          providerBuildId: buildResult.providerBuildId,
          provisioningRunId: run.id,
          idempotencyKey: `${operationKey}:candidate`,
          signal,
        }),
      controller.signal,
    );
    await heartbeat(run.id, userId);

    // Resolve or create the portfolio app record.
    // When buildRun.appId is null, register a new Venom portfolio app from
    // the approved package summary/brand. When it exists, verify ownership.
    let resolvedAppId = run.appId;
    if (!resolvedAppId) {
      // Create a new app record from the approved package metadata
      const appName = (revision.package as { title?: string }).title ??
        run.targetName;
      const appBrand = run.targetName;
      const appPurpose =
        (revision.package as { productBrief?: { summary?: string } })
          .productBrief?.summary ?? `Provisioned app: ${run.targetName}`;
      const [createdApp] = await db
        .insert(venomPortfolioAppsTable)
        .values({
          clerkUserId: userId,
          name: appName.slice(0, 120),
          purpose: appPurpose.slice(0, 1000),
          brand: appBrand.slice(0, 120),
          status: "ready" as const,
          detectedStack: [],
          sourceType: "none" as const,
          currentSourceVersion: 0,
        })
        .returning();
      resolvedAppId = createdApp.id;
      // Link the build run to the app
      await db
        .update(venomBuildRunsTable)
        .set({ appId: resolvedAppId, updatedAt: new Date() })
        .where(eq(venomBuildRunsTable.id, run.buildRunId));
      // Store appId on the provisioning run
      await db
        .update(venomProvisioningRunsTable)
        .set({ appId: resolvedAppId, updatedAt: new Date() })
        .where(eq(venomProvisioningRunsTable.id, run.id));
      logger.info(
        {
          operation: "venom_provisioning_app_created",
          runId: run.id,
          appId: resolvedAppId,
        },
        "Portfolio app created for provisioning run",
      );
      // First provisioning of a brand-new app: the package handoff ran
      // before this app record existed, so mint its AI gateway credential
      // now and deliver it straight into the project's secret storage.
      // Failure is non-fatal — the app is fine without AI for the moment,
      // the credential stays undelivered, and the next handoff ships it.
      try {
        const credentialPrep = await prepareAppAiCredentialForHandoff(
          userId,
          resolvedAppId,
          projectResult.providerProjectId,
        );
        if (credentialPrep) {
          await deliverAppAiCredentialSerialized(
            resolvedAppId,
            credentialPrep.credentialId,
            projectResult.providerProjectId,
            async () => {
              await provider.deliverRuntimeCredentials({
                providerProjectId: projectResult.providerProjectId,
                credentials: { envVars: credentialPrep.envVars },
                signal: controller.signal,
              });
            },
          );
        }
      } catch {
        // Never log the caught error: this path handles a live secret.
        logger.warn(
          {
            operation: "venom_provisioning_ai_credential_deferred",
            runId: run.id,
            appId: resolvedAppId,
          },
          "App AI credential delivery deferred to next provisioning handoff",
        );
      }
    } else {
      // Verify existing app is owned by this user
      const [existingApp] = await db
        .select()
        .from(venomPortfolioAppsTable)
        .where(
          and(
            eq(venomPortfolioAppsTable.id, resolvedAppId),
            eq(venomPortfolioAppsTable.clerkUserId, userId),
          ),
        )
        .limit(1);
      if (!existingApp) {
        throw new ProvisioningProviderError(
          "Provisioning cannot proceed: associated app is not accessible",
          "app_ownership_error",
          false,
        );
      }
    }

    // Create candidate release record. targetName is pinned so app-wide
    // history controls can require the exact target for this release. Guarded
    // against a duplicate insert on an idempotent candidate-stage resume.
    const [existingRelease] = await db
      .select({ id: venomCandidateReleasesTable.id })
      .from(venomCandidateReleasesTable)
      .where(
        and(
          eq(venomCandidateReleasesTable.provisioningRunId, run.id),
          eq(venomCandidateReleasesTable.clerkUserId, userId),
          eq(
            venomCandidateReleasesTable.providerCandidateId,
            candidateResult.providerCandidateId,
          ),
        ),
      )
      .limit(1);
    const candidateLaunchUrl = sanitizeLaunchUrl(candidateResult.launchUrl);
    if (!existingRelease) {
      await db.insert(venomCandidateReleasesTable).values({
        clerkUserId: userId,
        provisioningRunId: run.id,
        buildRunId: run.buildRunId,
        approvedRevisionId: run.approvedRevisionId,
        appId: resolvedAppId,
        sourceVersionId: run.sourceVersionId,
        targetName: run.targetName,
        providerProjectId: projectResult.providerProjectId,
        providerCandidateId: candidateResult.providerCandidateId,
        launchUrl: candidateLaunchUrl,
        rollbackSupported: candidateResult.rollbackSupported,
        status: "candidate",
      });
    }

    await db
      .update(venomProvisioningRunsTable)
      .set({
        providerCandidateId: candidateResult.providerCandidateId,
        appId: resolvedAppId,
        status: "candidate_ready",
        stage: "candidate",
        progress: 100,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(venomProvisioningRunsTable.id, run.id));

    await addProvEvent(
      run,
      "candidate_ready",
      "candidate_ready",
      "candidate",
      100,
      "Candidate release ready. Publish separately when ready.",
    );

    logger.info(
      {
        operation: "venom_provisioning_complete",
        runId: run.id,
        buildRunId: run.buildRunId,
        durationMs: Date.now() - startedAtMs,
      },
      "Provisioning run completed: candidate ready",
    );
  } catch (err) {
    // An explicit cancellation must never be recorded as a failure. This is
    // detected either from the abort controller (in-process cancel), an
    // AbortError surfaced by withProviderTimeout, or a durable cancelRequested
    // flag set by the cancel route (survives process restarts).
    const freshRun = await ownedRun(userId, run.id);
    if (freshRun?.status === "cancelled") return;
    const isAbort =
      controller.signal.aborted ||
      (err instanceof Error && err.name === "AbortError");
    if (isAbort || freshRun?.cancelRequested) {
      // Finalize durable cancelled state; call provider cancel best-effort with
      // the latest known provider refs. handleCancellation is idempotent.
      await handleCancellation(
        {
          id: run.id,
          clerkUserId: userId,
          providerProjectId:
            freshRun?.providerProjectId ?? run.providerProjectId ?? null,
          providerBuildId:
            freshRun?.providerBuildId ?? run.providerBuildId ?? null,
        },
        "Provisioning run cancelled.",
      );
      return;
    }

    const timedOut = err instanceof ProvisioningTimeoutError;
    const unavailable = err instanceof ProvisioningCapabilityUnavailableError;
    const provErr = err instanceof ProvisioningProviderError;

    const failureCode = timedOut
      ? "provisioning_timeout"
      : unavailable
        ? "capability_unavailable"
        : provErr
          ? err.code
          : "provisioning_failed";

    const failureMessage = timedOut
      ? `Provisioning timed out at stage: ${(err as ProvisioningTimeoutError).stage}`
      : unavailable
        ? "No managed provisioning provider is available"
        : provErr
          ? err.clientMessage
          : "Provisioning failed. Retry this run.";

    const retryable =
      timedOut || unavailable || (provErr && (err as ProvisioningProviderError).retryable);

    await db
      .update(venomProvisioningRunsTable)
      .set({
        status: "failed",
        progress: 100,
        failureCode,
        failureMessage,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(venomProvisioningRunsTable.id, run.id),
          eq(venomProvisioningRunsTable.clerkUserId, userId),
          inArray(venomProvisioningRunsTable.status, [
            "checking_capability",
            "creating_project",
            "handing_off",
            "building",
            "testing",
          ]),
        ),
      );

    await addProvEvent(
      run,
      "failed",
      "failed",
      null,
      100,
      retryable
        ? `${failureMessage} This run is safe to retry.`
        : failureMessage,
    );

    logger.error(
      {
        operation: "venom_provisioning_error",
        runId: run.id,
        buildRunId: run.buildRunId,
        failureCode,
        durationMs: Date.now() - startedAtMs,
        // Never log err.message — may contain provider details
        errorName: err instanceof Error ? err.name : "UnknownError",
      },
      "Provisioning run failed",
    );
  } finally {
    if (activeProvisioningControllers.get(run.id) === controller) {
      activeProvisioningControllers.delete(run.id);
    }
  }
}

/**
 * Finalize a cancellation. Idempotent: the run→cancelled transition is
 * guarded so only the first caller records the event and invokes the provider
 * cancel. Never transitions a terminal run (published/failed) and always
 * clears cancelRequested so the run does not remain flagged.
 */
async function handleCancellation(
  run: Pick<
    VenomProvisioningRun,
    "id" | "clerkUserId" | "providerProjectId" | "providerBuildId"
  >,
  message: string,
): Promise<void> {
  // Atomically claim the cancellation: only transition from a non-terminal,
  // cancellable state so concurrent checkpoints/catch/route calls do not
  // double-cancel or resurrect a terminal run.
  const [claimed] = await db
    .update(venomProvisioningRunsTable)
    .set({
      status: "cancelled",
      progress: 100,
      cancelRequested: false,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(venomProvisioningRunsTable.id, run.id),
        eq(venomProvisioningRunsTable.clerkUserId, run.clerkUserId),
        inArray(venomProvisioningRunsTable.status, [
          "queued",
          "checking_capability",
          "creating_project",
          "handing_off",
          "building",
          "testing",
        ]),
      ),
    )
    .returning();

  // Another caller already finalized (or the run is terminal) — do nothing else.
  if (!claimed) return;

  // Call provider.cancelOperation once, best-effort, with the latest refs.
  const providerProjectId =
    claimed.providerProjectId ?? run.providerProjectId ?? null;
  const providerBuildId =
    claimed.providerBuildId ?? run.providerBuildId ?? null;
  if (providerProjectId) {
    try {
      const provider = getProvisioningProvider();
      await withProviderTimeout("cancel_operation", 15_000, (signal) =>
        provider.cancelOperation({
          providerProjectId,
          providerBuildId: providerBuildId ?? undefined,
          signal,
        }),
      );
    } catch {
      // Swallow — provider cleanup is best-effort.
    }
  }

  await addProvEvent(run, "cancelled", "cancelled", null, 100, message);
}

// ─── Stale run recovery ───────────────────────────────────────────────────────

async function failStaleProvisioningRuns(): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_HEARTBEAT_AFTER_MS);
  // Build/candidate pipeline stages recover to failed (safe to retry).
  const activeStatuses = [
    "checking_capability",
    "creating_project",
    "handing_off",
    "building",
    "testing",
  ];
  const stale = await db
    .update(venomProvisioningRunsTable)
    .set({
      status: "failed",
      progress: 100,
      failureCode: "provisioning_interrupted",
      failureMessage:
        "Provisioning was interrupted. Retry this run.",
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        inArray(
          venomProvisioningRunsTable.status,
          activeStatuses as never[],
        ),
        lt(venomProvisioningRunsTable.heartbeatAt, cutoff),
      ),
    )
    .returning();

  await Promise.all(
    stale.map((run) =>
      addProvEvent(
        run,
        "failed",
        "failed",
        null,
        100,
        "Provisioning was interrupted and is safe to retry.",
      ),
    ),
  );

  // A stale `publishing` run must NOT be marked failed — an interrupted publish
  // must preserve the existing healthy deployment. Recover it to
  // candidate_ready so the same-key publish can be safely retried. The reserved
  // publish idempotency key is retained on the release for that retry.
  const stalePublishing = await db
    .update(venomProvisioningRunsTable)
    .set({
      status: "candidate_ready",
      stage: "candidate",
      progress: 100,
      failureCode: "publish_interrupted",
      failureMessage:
        "Publish was interrupted. Existing deployment preserved; retry when ready.",
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(venomProvisioningRunsTable.status, "publishing"),
        lt(venomProvisioningRunsTable.heartbeatAt, cutoff),
      ),
    )
    .returning();

  await Promise.all(
    stalePublishing.map(async (run) => {
      // Clear the in-progress marker on any release still reserved for this run
      // so a same-key retry is treated as a fresh attempt, not a completed one.
      await db
        .update(venomCandidateReleasesTable)
        .set({ publishInProgressAt: null, updatedAt: new Date() })
        .where(
          and(
            eq(venomCandidateReleasesTable.provisioningRunId, run.id),
            eq(venomCandidateReleasesTable.status, "candidate"),
          ),
        );
      await addProvEvent(
        run,
        "failed",
        "candidate_ready",
        "publish",
        100,
        "Publish was interrupted. Existing deployment preserved; safe to retry.",
      );
    }),
  );
}

async function reconcileProvisioningQueue(
  now: number = Date.now(),
): Promise<void> {
  await failStaleProvisioningRuns();
  const rescueCutoff = new Date(now - QUEUE_RESCUE_MIN_AGE_MS);
  const queued = await db
    .select({
      id: venomProvisioningRunsTable.id,
      clerkUserId: venomProvisioningRunsTable.clerkUserId,
    })
    .from(venomProvisioningRunsTable)
    .where(
      and(
        eq(venomProvisioningRunsTable.status, "queued"),
        lt(venomProvisioningRunsTable.createdAt, rescueCutoff),
      ),
    )
    .orderBy(venomProvisioningRunsTable.createdAt)
    .limit(100);
  queued.forEach((run) =>
    scheduleProvisioningRunEffect(run.clerkUserId, run.id),
  );
}

function runWorkerReconciliation(): void {
  void reconcileProvisioningQueue().catch((err) => {
    logger.error(
      {
        operation: "venom_provisioning_worker_reconcile",
        errorName: err instanceof Error ? err.name : "UnknownError",
      },
      "Provisioning worker reconciliation failed",
    );
  });
}

export function startVenomProvisioningWorker(): void {
  if (workerTimer) return;
  runWorkerReconciliation();
  workerTimer = setInterval(
    runWorkerReconciliation,
    WORKER_RECONCILE_INTERVAL_MS,
  );
  workerTimer.unref?.();
}

// ─── Test exports ─────────────────────────────────────────────────────────────

export async function processProvisioningRunForTests(
  userId: string,
  runId: string,
): Promise<void> {
  await processProvisioningRun(userId, runId);
}

/**
 * `now` lets a suite prove the rescue path with a *fresh* fixture: a future
 * clock makes the row qualify as aged inside this invocation only, so the
 * fixture is never backdated into the claim window of the dev server's own
 * reconcile loop (both processes share one database).
 */
export async function reconcileProvisioningQueueForTests(
  now?: number,
): Promise<void> {
  await reconcileProvisioningQueue(now);
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// GET /venom/provisioning/capability
router.get("/venom/provisioning/capability", async (req, res): Promise<void> => {
  const userId = userIdFor(req);
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const provider = getProvisioningProvider();
  try {
    // Run capability check and an empty permission summary in parallel. Each is
    // independently guarded so a provider exception never becomes an unhandled
    // 500 — the client always receives a safe unavailable/degraded summary.
    const [capability, permSummary] = await Promise.all([
      provider.checkCapability().catch(() => null),
      provider.validatePermissions([]).catch(() => null),
    ]);

    if (!capability) {
      res.json(
        GetProvisioningCapabilityResponse.parse({
          health: "unavailable",
          summary: "Provisioning capability is temporarily unavailable",
          recoveryGuidance:
            "Please try again in a few minutes. If this persists, ask your workspace admin.",
          supportedTargetTypes: [],
          rollbackSupported: false,
          publishSupported: false,
          permissionSummary: null,
        }),
      );
      return;
    }

    res.json(
      GetProvisioningCapabilityResponse.parse({
        health: capability.health,
        summary: capability.summary,
        recoveryGuidance: capability.recoveryGuidance,
        supportedTargetTypes: capability.supportedTargetTypes,
        rollbackSupported: capability.rollbackSupported,
        publishSupported: capability.publishSupported,
        // Return actual permission summary for empty integrations, or null.
        permissionSummary: permSummary ?? null,
      }),
    );
  } catch (err) {
    // Defensive: never surface an unhandled provider error to the client.
    logger.error(
      {
        operation: "venom_provisioning_capability_error",
        errorName: err instanceof Error ? err.name : "UnknownError",
      },
      "Capability check failed",
    );
    res.json(
      GetProvisioningCapabilityResponse.parse({
        health: "unavailable",
        summary: "Provisioning capability is temporarily unavailable",
        recoveryGuidance:
          "Please try again in a few minutes. If this persists, ask your workspace admin.",
        supportedTargetTypes: [],
        rollbackSupported: false,
        publishSupported: false,
        permissionSummary: null,
      }),
    );
  }
});

// POST /venom/build-runs/:buildRunId/provision
router.post(
  "/venom/build-runs/:buildRunId/provision",
  async (req, res): Promise<void> => {
    const userId = userIdFor(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const params = ProvisionBuildRunParams.safeParse(req.params);
    const parsed = ProvisionBuildRunBody.safeParse(req.body);
    if (!params.success || !parsed.success) {
      res.status(400).json({ error: "Invalid provisioning request" });
      return;
    }

    const { buildRunId } = params.data;
    const {
      approvedRevisionId,
      idempotencyKey,
      targetName,
      requestedIntegrations,
      deploymentIntent,
    } = parsed.data;

    // Validate deployment intent
    if (deploymentIntent !== "create_candidate") {
      res.status(400).json({ error: "deploymentIntent must be create_candidate" });
      return;
    }

    // Reject credential-like integration strings
    if (hasDangerousIntegrationStrings(requestedIntegrations)) {
      req.log.warn(
        { operation: "venom_provisioning_create", buildRunId },
        "Rejected dangerous integration strings in provisioning request",
      );
      res.status(400).json({
        error: "Requested integrations contain credential-like material",
      });
      return;
    }

    // Idempotency check
    const [existing] = await db
      .select()
      .from(venomProvisioningRunsTable)
      .where(
        and(
          eq(venomProvisioningRunsTable.clerkUserId, userId),
          eq(venomProvisioningRunsTable.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);

    if (existing) {
      if (existing.buildRunId !== buildRunId) {
        res.status(409).json({ error: "Idempotency key is already in use" });
        return;
      }
      res
        .status(201)
        .json(ProvisionBuildRunResponse.parse(await runPayload(existing)));
      return;
    }

    // Verify the build run exists, is owned, and has the right approved revision
    const [buildRun] = await db
      .select()
      .from(venomBuildRunsTable)
      .where(
        and(
          eq(venomBuildRunsTable.id, buildRunId),
          eq(venomBuildRunsTable.clerkUserId, userId),
        ),
      )
      .limit(1);

    if (!buildRun) {
      res.status(404).json({ error: "Build run not found" });
      return;
    }

    if (buildRun.status !== "ready_for_provisioning") {
      res.status(400).json({
        error: "Build run package is not approved and ready for provisioning",
      });
      return;
    }

    if (buildRun.approvedRevisionId !== approvedRevisionId) {
      res.status(400).json({ error: "approvedRevisionId does not match" });
      return;
    }

    // Verify the approved revision
    const [revision] = await db
      .select()
      .from(venomBuildPackageRevisionsTable)
      .where(
        and(
          eq(venomBuildPackageRevisionsTable.id, approvedRevisionId),
          eq(venomBuildPackageRevisionsTable.runId, buildRunId),
          eq(venomBuildPackageRevisionsTable.clerkUserId, userId),
        ),
      )
      .limit(1);

    if (!revision || !revision.approvedAt) {
      res.status(404).json({ error: "Approved revision not found" });
      return;
    }

    // Reject unsupported target types
    if (
      buildRun.targetType !== "app" &&
      buildRun.targetType !== "website"
    ) {
      res.status(400).json({
        error: `Target type '${buildRun.targetType}' is not supported for provisioning`,
      });
      return;
    }

    // Verify target name confirmation matches
    if (targetName.trim() !== buildRun.targetName.trim()) {
      res.status(400).json({
        error: "targetName does not match the approved build package target",
      });
      return;
    }

    // Reject unsupported permission requests in the approved package
    if (
      revision.package.permissionRequests &&
      hasUnsupportedPermissionRequests(revision.package.permissionRequests)
    ) {
      res.status(400).json({
        error: "Approved package contains unsupported permission requests",
      });
      return;
    }

    // Enforce requestedIntegrations exactly matches revision.package.integrationNeeds
    // (order-insensitive, deduped) — prevents drift at request time.
    const pkgIntegrationNeeds: string[] = Array.from(
      new Set(revision.package.integrationNeeds ?? []),
    ).sort();
    const reqIntegrationsSorted = Array.from(
      new Set(requestedIntegrations),
    ).sort();
    const integrationsDiffer =
      pkgIntegrationNeeds.length !== reqIntegrationsSorted.length ||
      pkgIntegrationNeeds.some((v, i) => v !== reqIntegrationsSorted[i]);
    if (integrationsDiffer) {
      res.status(400).json({
        error:
          "requestedIntegrations must exactly match the approved package integrationNeeds (order-insensitive)",
      });
      return;
    }

    // Create the provisioning run with advisory lock
    const creation = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${"venom-prov:" + userId}))`,
      );
      // Re-check idempotency under lock
      const [raced] = await tx
        .select()
        .from(venomProvisioningRunsTable)
        .where(
          and(
            eq(venomProvisioningRunsTable.clerkUserId, userId),
            eq(venomProvisioningRunsTable.idempotencyKey, idempotencyKey),
          ),
        )
        .limit(1);
      if (raced) {
        return raced.buildRunId === buildRunId
          ? { kind: "existing" as const, run: raced }
          : { kind: "conflict" as const };
      }

      const [run] = await tx
        .insert(venomProvisioningRunsTable)
        .values({
          clerkUserId: userId,
          buildRunId,
          approvedRevisionId,
          appId: buildRun.appId,
          sourceVersionId: buildRun.sourceVersionId,
          idempotencyKey,
          targetName: buildRun.targetName.trim(),
          deploymentIntent,
          requestedIntegrations,
          status: "queued",
          progress: 0,
        })
        .returning();

      await tx.insert(venomProvisioningEventsTable).values({
        provisioningRunId: run.id,
        clerkUserId: userId,
        eventType: "queued",
        status: "queued",
        stage: null,
        progress: 0,
        message: "Provisioning run queued.",
      });

      return { kind: "created" as const, run };
    });

    if (creation.kind === "conflict") {
      res.status(409).json({ error: "Idempotency key is already in use" });
      return;
    }

    const run = creation.run;

    req.log.info(
      {
        operation: "venom_provisioning_create",
        runId: run.id,
        buildRunId,
        approvedRevisionId,
        targetType: buildRun.targetType,
      },
      "Provisioning run created",
    );

    if (creation.kind === "created") {
      scheduleProvisioningRunEffect(userId, run.id);
    }

    res
      .status(201)
      .json(ProvisionBuildRunResponse.parse(await runPayload(run)));
  },
);

// GET /venom/provisioning/runs
router.get("/venom/provisioning/runs", async (req, res): Promise<void> => {
  const userId = userIdFor(req);
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const query = ListProvisioningRunsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: "Invalid query" });
    return;
  }

  const { buildRunId, appId } = query.data;
  let whereCondition = eq(venomProvisioningRunsTable.clerkUserId, userId);

  if (buildRunId) {
    whereCondition = and(
      whereCondition,
      eq(venomProvisioningRunsTable.buildRunId, buildRunId),
    ) as typeof whereCondition;
  }
  if (appId) {
    whereCondition = and(
      whereCondition,
      eq(venomProvisioningRunsTable.appId, appId),
    ) as typeof whereCondition;
  }

  const runs = await db
    .select()
    .from(venomProvisioningRunsTable)
    .where(whereCondition)
    .orderBy(desc(venomProvisioningRunsTable.updatedAt))
    .limit(200);

  res.json(ListProvisioningRunsResponse.parse(runs.map(runSummaryPayload)));
});

// GET /venom/provisioning/runs/:provisioningRunId
router.get(
  "/venom/provisioning/runs/:provisioningRunId",
  async (req, res): Promise<void> => {
    const userId = userIdFor(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const params = GetProvisioningRunParams.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "Provisioning run not found" });
      return;
    }
    const run = await ownedRun(userId, params.data.provisioningRunId);
    if (!run) {
      res.status(404).json({ error: "Provisioning run not found" });
      return;
    }
    res.json(GetProvisioningRunResponse.parse(await runPayload(run)));
  },
);

// POST /venom/provisioning/runs/:provisioningRunId/cancel
router.post(
  "/venom/provisioning/runs/:provisioningRunId/cancel",
  async (req, res): Promise<void> => {
    const userId = userIdFor(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const params = CancelProvisioningRunParams.safeParse(req.params);
    const parsed = CancelProvisioningRunBody.safeParse(req.body);
    if (!params.success || !parsed.success) {
      res.status(400).json({ error: "Invalid cancellation request" });
      return;
    }

    // candidate_ready is a completed, non-cancellable state (publish/rollback
    // are the follow-on operations, not cancel).
    const terminalStatuses = [
      "published",
      "cancelled",
      "failed",
      "blocked",
      "candidate_ready",
    ];
    const run = await ownedRun(userId, params.data.provisioningRunId);
    if (!run) {
      res.status(404).json({ error: "Provisioning run not found" });
      return;
    }
    if (terminalStatuses.includes(run.status)) {
      res
        .status(409)
        .json({ error: "Provisioning run cannot be cancelled from its current state" });
      return;
    }

    // Record the durable cancel request (survives restarts) and abort any
    // in-process worker so it stops at the next checkpoint / aborts its
    // provider call.
    await db
      .update(venomProvisioningRunsTable)
      .set({
        cancelRequested: true,
        cancelledReason: parsed.data.reason.trim(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(venomProvisioningRunsTable.id, run.id),
          eq(venomProvisioningRunsTable.clerkUserId, userId),
        ),
      );

    const activeController = activeProvisioningControllers.get(run.id);
    activeController?.abort();

    await addProvEvent(
      run,
      "cancel_requested",
      run.status,
      run.stage,
      run.progress,
      "Cancellation requested.",
    );

    // Finalize durable cancelled state now when it is safe to do so from the
    // route: a queued run has no worker, and an active run with no in-process
    // controller (e.g. after a restart) would otherwise linger until stale
    // recovery. When a controller is active, the worker finalizes on abort.
    if (run.status === "queued" || !activeController) {
      await handleCancellation(
        {
          id: run.id,
          clerkUserId: userId,
          providerProjectId: run.providerProjectId,
          providerBuildId: run.providerBuildId,
        },
        "Provisioning run cancelled.",
      );
    }

    const updated = await ownedRun(userId, run.id);
    if (!updated) {
      res.status(404).json({ error: "Provisioning run not found" });
      return;
    }

    req.log.info(
      { operation: "venom_provisioning_cancel", runId: run.id },
      "Provisioning run cancellation requested",
    );

    res.json(CancelProvisioningRunResponse.parse(await runPayload(updated)));
  },
);

// POST /venom/provisioning/runs/:provisioningRunId/retry
router.post(
  "/venom/provisioning/runs/:provisioningRunId/retry",
  async (req, res): Promise<void> => {
    const userId = userIdFor(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const params = RetryProvisioningRunParams.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "Provisioning run not found" });
      return;
    }

    const retryResult = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${"venom-prov:" + userId}))`,
      );
      const [run] = await tx
        .select()
        .from(venomProvisioningRunsTable)
        .where(
          and(
            eq(venomProvisioningRunsTable.id, params.data.provisioningRunId),
            eq(venomProvisioningRunsTable.clerkUserId, userId),
          ),
        )
        .limit(1);
      if (!run) return { kind: "not_found" as const };

      const retryableStatuses = ["failed", "cancelled", "blocked"];
      if (
        !retryableStatuses.includes(run.status) ||
        run.attempt >= MAX_ATTEMPTS
      ) {
        return { kind: "invalid" as const };
      }

      const [updated] = await tx
        .update(venomProvisioningRunsTable)
        .set({
          status: "queued",
          stage: null,
          progress: 0,
          attempt: run.attempt + 1,
          failureCode: null,
          failureMessage: null,
          cancelledReason: null,
          blockedReason: null,
          cancelRequested: false,
          completedAt: null,
          heartbeatAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(venomProvisioningRunsTable.id, run.id),
            eq(venomProvisioningRunsTable.clerkUserId, userId),
            inArray(
              venomProvisioningRunsTable.status,
              retryableStatuses as never[],
            ),
          ),
        )
        .returning();

      if (!updated) return { kind: "invalid" as const };

      await tx.insert(venomProvisioningEventsTable).values({
        provisioningRunId: updated.id,
        clerkUserId: userId,
        eventType: "retried",
        status: "queued",
        stage: null,
        progress: 0,
        message: `Provisioning retry ${updated.attempt} queued.`,
      });

      return { kind: "queued" as const, run: updated };
    });

    if (retryResult.kind === "not_found") {
      res.status(404).json({ error: "Provisioning run not found" });
      return;
    }
    if (retryResult.kind === "invalid") {
      res.status(409).json({ error: "Provisioning run cannot be retried" });
      return;
    }

    const run = retryResult.run;
    scheduleProvisioningRunEffect(userId, run.id);
    res
      .status(202)
      .json(RetryProvisioningRunResponse.parse(await runPayload(run)));
  },
);

// POST /venom/provisioning/runs/:provisioningRunId/publish
router.post(
  "/venom/provisioning/runs/:provisioningRunId/publish",
  async (req, res): Promise<void> => {
    const userId = userIdFor(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const params = PublishProvisioningCandidateParams.safeParse(req.params);
    const parsed = PublishProvisioningCandidateBody.safeParse(req.body);
    if (!params.success || !parsed.success) {
      res.status(400).json({ error: "Invalid publish request" });
      return;
    }

    const run = await ownedRun(userId, params.data.provisioningRunId);
    if (!run) {
      res.status(404).json({ error: "Provisioning run not found" });
      return;
    }

    // Client-facing validation that never depends on race state comes first so
    // it is always returned deterministically. (Target-name confirmation.)
    if (parsed.data.confirmTargetName.trim() !== run.targetName.trim()) {
      res.status(400).json({ error: "confirmTargetName does not match target" });
      return;
    }

    // ── Atomic reservation ──────────────────────────────────────────────────
    // A single transaction holds an advisory lock, performs fresh owner-scoped
    // reads, then decides exactly one outcome: completed replay, conflict,
    // reserve-and-proceed, or a plain state error. Concurrent same-key calls
    // serialize here so only one reserves the run and invokes the provider.
    type Reservation =
      | { kind: "not_found" }
      | { kind: "bad_state" }
      | { kind: "provider_missing" }
      | { kind: "conflict"; message: string }
      | { kind: "replay" }
      | { kind: "proceed" };

    const reservation = await db.transaction(async (tx): Promise<Reservation> => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${"venom-pub:" + run.id}))`,
      );

      const [lockedRun] = await tx
        .select()
        .from(venomProvisioningRunsTable)
        .where(
          and(
            eq(venomProvisioningRunsTable.id, run.id),
            eq(venomProvisioningRunsTable.clerkUserId, userId),
          ),
        )
        .limit(1);
      if (!lockedRun) return { kind: "not_found" };

      const [release] = await tx
        .select()
        .from(venomCandidateReleasesTable)
        .where(
          and(
            eq(venomCandidateReleasesTable.id, parsed.data.candidateReleaseId),
            eq(venomCandidateReleasesTable.provisioningRunId, run.id),
            eq(venomCandidateReleasesTable.clerkUserId, userId),
          ),
        )
        .limit(1);
      if (!release) return { kind: "not_found" };

      // Completed replay: same key + already published → idempotent success.
      if (
        release.status === "published" &&
        release.publishIdempotencyKey === parsed.data.idempotencyKey
      ) {
        return { kind: "replay" };
      }

      // Conflict: already published (with any key that differs, or a different
      // key entirely) — the release is not re-publishable under a new key.
      if (release.status === "published") {
        return {
          kind: "conflict",
          message:
            "This release was already published with a different idempotency key",
        };
      }

      // Only a candidate release may be published.
      if (release.status !== "candidate") return { kind: "not_found" };

      // Conflict: a different key while a publish is already reserved/in-flight.
      if (
        release.publishIdempotencyKey !== null &&
        release.publishIdempotencyKey !== parsed.data.idempotencyKey
      ) {
        return {
          kind: "conflict",
          message: "A publish is already in progress with a different key",
        };
      }

      if (!release.appId) return { kind: "provider_missing" };

      // Every live-deployment mutation for an app shares this lock and durable
      // reservation check. This prevents two different candidate publishes, or
      // a publish and historical rollback, from reaching the provider at once.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${"venom-deploy:" + release.appId}))`,
      );
      const staleBefore = new Date(Date.now() - STALE_HEARTBEAT_AFTER_MS);
      await tx
        .update(venomCandidateReleasesTable)
        .set({ publishInProgressAt: null, updatedAt: new Date() })
        .where(
          and(
            eq(venomCandidateReleasesTable.clerkUserId, userId),
            eq(venomCandidateReleasesTable.appId, release.appId),
            lt(venomCandidateReleasesTable.publishInProgressAt, staleBefore),
          ),
        );
      await tx
        .update(venomCandidateReleasesTable)
        .set({ rollbackInProgressAt: null, updatedAt: new Date() })
        .where(
          and(
            eq(venomCandidateReleasesTable.clerkUserId, userId),
            eq(venomCandidateReleasesTable.appId, release.appId),
            lt(venomCandidateReleasesTable.rollbackInProgressAt, staleBefore),
          ),
        );
      const [activeDeploymentMutation] = await tx
        .select({ id: venomCandidateReleasesTable.id })
        .from(venomCandidateReleasesTable)
        .where(
          and(
            eq(venomCandidateReleasesTable.clerkUserId, userId),
            eq(venomCandidateReleasesTable.appId, release.appId),
            or(
              isNotNull(venomCandidateReleasesTable.publishInProgressAt),
              isNotNull(venomCandidateReleasesTable.rollbackInProgressAt),
            ),
          ),
        )
        .limit(1);
      if (activeDeploymentMutation) {
        return {
          kind: "conflict",
          message: "Another deployment change is already in progress for this app",
        };
      }

      // Run must be publishable and provider refs present.
      if (lockedRun.status !== "candidate_ready") return { kind: "bad_state" };
      if (!lockedRun.providerProjectId || !lockedRun.providerCandidateId) {
        return { kind: "provider_missing" };
      }

      // Reserve the key + mark in-progress + move the run to publishing — all
      // atomically under the lock so a concurrent same-key call cannot also
      // reserve and invoke the provider.
      const now = new Date();
      await tx
        .update(venomCandidateReleasesTable)
        .set({
          publishIdempotencyKey: parsed.data.idempotencyKey,
          publishInProgressAt: now,
          updatedAt: now,
        })
        .where(eq(venomCandidateReleasesTable.id, release.id));
      await tx
        .update(venomProvisioningRunsTable)
        .set({
          status: "publishing",
          stage: "publish",
          progress: 50,
          heartbeatAt: now,
          updatedAt: now,
        })
        .where(eq(venomProvisioningRunsTable.id, run.id));

      return { kind: "proceed" };
    });

    if (reservation.kind === "not_found") {
      res.status(404).json({ error: "Candidate release not found" });
      return;
    }
    if (reservation.kind === "provider_missing") {
      res.status(400).json({ error: "Provider project not set up" });
      return;
    }
    if (reservation.kind === "conflict") {
      res.status(409).json({ error: reservation.message });
      return;
    }
    if (reservation.kind === "bad_state") {
      res
        .status(409)
        .json({ error: "Provisioning run is not in candidate_ready state" });
      return;
    }
    if (reservation.kind === "replay") {
      const cached = await ownedRun(userId, run.id);
      res.json(
        PublishProvisioningCandidateResponse.parse(await runPayload(cached!)),
      );
      return;
    }

    // Re-read the reserved release for provider refs used below.
    const [release] = await db
      .select()
      .from(venomCandidateReleasesTable)
      .where(eq(venomCandidateReleasesTable.id, parsed.data.candidateReleaseId))
      .limit(1);

    await addProvEvent(
      run,
      "publish_started",
      "publishing",
      "publish",
      50,
      "Publishing candidate to primary deployment.",
    );

    const provider = getProvisioningProvider();

    try {
      // First confirm the candidate is still healthy
      const candidateStatus = await withProviderTimeout(
        "candidate_health_check",
        STAGE_TIMEOUT_MS,
        (signal) =>
          provider.getCandidateStatus({
            providerProjectId: run.providerProjectId!,
            providerCandidateId: run.providerCandidateId!,
            signal,
          }),
      );

      if (!candidateStatus.healthy) {
        // Restore to candidate_ready — preserve existing primary deployment
        // link. Keep the release a candidate and RETAIN its idempotency key so
        // a same-key retry is safe; only clear the in-progress marker.
        await db
          .update(venomCandidateReleasesTable)
          .set({ publishInProgressAt: null, updatedAt: new Date() })
          .where(eq(venomCandidateReleasesTable.id, release.id));
        await db
          .update(venomProvisioningRunsTable)
          .set({
            status: "candidate_ready",
            stage: "candidate",
            progress: 100,
            failureCode: "candidate_unhealthy",
            failureMessage: "Candidate is not healthy for publishing",
            updatedAt: new Date(),
          })
          .where(eq(venomProvisioningRunsTable.id, run.id));

        await addProvEvent(
          run,
          "failed",
          "candidate_ready",
          "publish",
          100,
          "Publish aborted: candidate is not healthy. Existing deployment preserved.",
        );

        const updated = await ownedRun(userId, run.id);
        res
          .status(200)
          .json(
            PublishProvisioningCandidateResponse.parse(
              await runPayload(updated!),
            ),
          );
        return;
      }

      // Publish via provider
      const publishResult = await withProviderTimeout(
        "publish",
        STAGE_TIMEOUT_MS,
        (signal) =>
          provider.publishCandidate({
            providerProjectId: run.providerProjectId!,
            providerCandidateId: run.providerCandidateId!,
            idempotencyKey: parsed.data.idempotencyKey,
            signal,
          }),
      );

      if (!publishResult.healthy) {
        // Failed publish — preserve existing primary link. Leave the release a
        // recoverable `candidate` (NOT failed) and RETAIN its idempotency key
        // so a same-key retry is safe; clear only the in-progress marker.
        await db
          .update(venomCandidateReleasesTable)
          .set({
            status: "candidate",
            publishInProgressAt: null,
            updatedAt: new Date(),
          })
          .where(eq(venomCandidateReleasesTable.id, release.id));

        await db
          .update(venomProvisioningRunsTable)
          .set({
            status: "candidate_ready",
            stage: "candidate",
            progress: 100,
            failureCode: "publish_unhealthy",
            failureMessage:
              "Provider reported unhealthy after publish. Existing deployment preserved.",
            updatedAt: new Date(),
          })
          .where(eq(venomProvisioningRunsTable.id, run.id));

        await addProvEvent(
          run,
          "failed",
          "candidate_ready",
          "publish",
          100,
          "Publish failed: provider unhealthy. Existing healthy deployment preserved.",
        );

        const updated = await ownedRun(userId, run.id);
        res
          .status(200)
          .json(
            PublishProvisioningCandidateResponse.parse(
              await runPayload(updated!),
            ),
          );
        return;
      }

      const healthyLaunchUrl = sanitizeLaunchUrl(publishResult.launchUrl);
      if (!healthyLaunchUrl) {
        throw new ProvisioningProviderError(
          "Provider did not return a safe launch URL",
          "provider_invalid_launch_url",
          true,
        );
      }

      // Successful publish — update release, run, supersede older releases,
      // and set app primary deployment URL transactionally.
      const now = new Date();
      const appId = run.appId;

      await db.transaction(async (tx) => {
        await tx
          .update(venomCandidateReleasesTable)
          .set({
            status: "published",
            providerReleaseId: publishResult.providerReleaseId,
            launchUrl: healthyLaunchUrl,
            lastHealthyStatus: "published",
            lastHealthyAt: now,
            publishedAt: now,
            publishInProgressAt: null,
            updatedAt: now,
          })
          .where(eq(venomCandidateReleasesTable.id, release.id));

        // Mark older published releases as superseded
        if (appId) {
          await tx
            .update(venomCandidateReleasesTable)
            .set({ status: "superseded", updatedAt: now })
            .where(
              and(
                eq(venomCandidateReleasesTable.clerkUserId, userId),
                eq(venomCandidateReleasesTable.appId, appId),
                eq(venomCandidateReleasesTable.status, "published"),
                sql`${venomCandidateReleasesTable.id} != ${release.id}`,
              ),
            );
        }

        await tx
          .update(venomProvisioningRunsTable)
          .set({
            status: "published",
            stage: "publish",
            progress: 100,
            completedAt: now,
            updatedAt: now,
          })
          .where(eq(venomProvisioningRunsTable.id, run.id));

        // Set app primary deployment URL
        if (appId) {
          await tx
            .delete(venomPortfolioDeploymentLinksTable)
            .where(
              and(
                eq(venomPortfolioDeploymentLinksTable.appId, appId),
                eq(venomPortfolioDeploymentLinksTable.clerkUserId, userId),
                eq(venomPortfolioDeploymentLinksTable.isPrimary, true),
              ),
            );
          await tx.insert(venomPortfolioDeploymentLinksTable).values({
            appId,
            clerkUserId: userId,
            label: "Live deployment",
            url: healthyLaunchUrl,
            isPrimary: true,
          });

          // Anchor the live pointer on the app record, and stamp the approved
          // package iteration with the release it just shipped as. Both live
          // in this transaction so the pointer can never disagree with the
          // release lifecycle rows.
          await tx
            .update(venomPortfolioAppsTable)
            .set({ liveReleaseId: release.id, updatedAt: now })
            .where(
              and(
                eq(venomPortfolioAppsTable.id, appId),
                eq(venomPortfolioAppsTable.clerkUserId, userId),
              ),
            );
          await tx
            .update(venomPortfolioAppIterationsTable)
            .set({ releaseId: release.id })
            .where(
              and(
                eq(venomPortfolioAppIterationsTable.clerkUserId, userId),
                eq(
                  venomPortfolioAppIterationsTable.buildRunId,
                  release.buildRunId,
                ),
              ),
            );
        }
      });

      await addProvEvent(
        run,
        "published",
        "published",
        "publish",
        100,
        "Candidate published successfully.",
      );

      req.log.info(
        {
          operation: "venom_provisioning_publish",
          runId: run.id,
          releaseId: release.id,
          appId: run.appId,
        },
        "Provisioning candidate published",
      );
    } catch (err) {
      // Failed publish (error/timeout) — preserve existing primary link and app
      // deployment URL. Leave the release a recoverable candidate and RETAIN
      // its key so a same-key retry is safe; clear only the in-progress marker.
      await db
        .update(venomCandidateReleasesTable)
        .set({ publishInProgressAt: null, updatedAt: new Date() })
        .where(eq(venomCandidateReleasesTable.id, parsed.data.candidateReleaseId));
      await db
        .update(venomProvisioningRunsTable)
        .set({
          status: "candidate_ready",
          stage: "candidate",
          progress: 100,
          failureCode: "publish_error",
          failureMessage: "Publish encountered an error. Existing deployment preserved.",
          updatedAt: new Date(),
        })
        .where(eq(venomProvisioningRunsTable.id, run.id));

      await addProvEvent(
        run,
        "failed",
        "candidate_ready",
        "publish",
        100,
        "Publish failed. Existing healthy deployment is preserved.",
      );

      logger.error(
        {
          operation: "venom_provisioning_publish_error",
          runId: run.id,
          errorName: err instanceof Error ? err.name : "UnknownError",
        },
        "Publish encountered an error",
      );
    }

    const updated = await ownedRun(userId, run.id);
    if (!updated) {
      res.status(404).json({ error: "Provisioning run not found" });
      return;
    }

    res.json(
      PublishProvisioningCandidateResponse.parse(await runPayload(updated)),
    );
  },
);

// POST /venom/provisioning/releases/:releaseId/rollback
router.post(
  "/venom/provisioning/releases/:releaseId/rollback",
  async (req, res): Promise<void> => {
    const userId = userIdFor(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const params = RollbackProvisioningReleaseParams.safeParse(req.params);
    const parsed = RollbackProvisioningReleaseBody.safeParse(req.body);
    if (!params.success || !parsed.success) {
      res.status(400).json({ error: "Invalid rollback request" });
      return;
    }

    const [release] = await db
      .select()
      .from(venomCandidateReleasesTable)
      .where(
        and(
          eq(venomCandidateReleasesTable.id, params.data.releaseId),
          eq(venomCandidateReleasesTable.clerkUserId, userId),
        ),
      )
      .limit(1);

    if (!release) {
      res.status(404).json({ error: "Release not found" });
      return;
    }
    if (!release.rollbackSupported) {
      res.status(409).json({ error: "Rollback is not supported for this release" });
      return;
    }
    if (!release.providerReleaseId) {
      res.status(409).json({ error: "No provider release ID for rollback" });
      return;
    }

    // Client-facing target-name confirmation first (deterministic, race-free).
    const [provRun] = await db
      .select()
      .from(venomProvisioningRunsTable)
      .where(
        and(
          eq(venomProvisioningRunsTable.id, release.provisioningRunId),
          eq(venomProvisioningRunsTable.clerkUserId, userId),
        ),
      )
      .limit(1);
    if (!provRun) {
      res.status(404).json({ error: "Provisioning run not found" });
      return;
    }
    if (parsed.data.confirmTargetName.trim() !== provRun.targetName.trim()) {
      res.status(400).json({ error: "confirmTargetName does not match target" });
      return;
    }
    if (!provRun.providerProjectId) {
      res.status(400).json({ error: "Provider project not found" });
      return;
    }

    const providerProjectId = provRun.providerProjectId;
    const providerReleaseId = release.providerReleaseId;

    // ── Atomic reservation ──────────────────────────────────────────────────
    // Rollback restores a SUPERSEDED, previously-healthy release to be the
    // current published release. It is NOT valid for the current published
    // release. A single locked transaction performs fresh reads and decides
    // exactly one outcome, and marks a durable in-progress reservation so
    // concurrent same/different-key calls cannot both invoke the provider.
    const STALE_INPROGRESS_MS = STALE_HEARTBEAT_AFTER_MS;
    type RbReservation =
      | { kind: "not_found" }
      | { kind: "not_rollbackable"; message: string }
      | { kind: "conflict"; message: string }
      | { kind: "replay" }
      | { kind: "proceed" };

    const reservation = await db.transaction(
      async (tx): Promise<RbReservation> => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${"venom-rb:" + release.id}))`,
        );

        const [locked] = await tx
          .select()
          .from(venomCandidateReleasesTable)
          .where(
            and(
              eq(venomCandidateReleasesTable.id, release.id),
              eq(venomCandidateReleasesTable.clerkUserId, userId),
            ),
          )
          .limit(1);
        if (!locked) return { kind: "not_found" };

        // Completed replay: same key + already promoted back to published.
        if (
          locked.rollbackIdempotencyKey === parsed.data.idempotencyKey &&
          locked.rolledBackAt !== null &&
          locked.status === "published"
        ) {
          return { kind: "replay" };
        }

        if (!locked.appId) {
          return {
            kind: "not_rollbackable",
            message: "Release is not linked to an app",
          };
        }

        // Serialize all deployment-changing operations for the app. The
        // reservation markers survive process restarts; stale markers can be
        // recovered only after the provider timeout window has elapsed.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${"venom-deploy:" + locked.appId}))`,
        );
        const staleBefore = new Date(Date.now() - STALE_INPROGRESS_MS);
        await tx
          .update(venomCandidateReleasesTable)
          .set({ publishInProgressAt: null, updatedAt: new Date() })
          .where(
            and(
              eq(venomCandidateReleasesTable.clerkUserId, userId),
              eq(venomCandidateReleasesTable.appId, locked.appId),
              lt(venomCandidateReleasesTable.publishInProgressAt, staleBefore),
            ),
          );
        await tx
          .update(venomCandidateReleasesTable)
          .set({ rollbackInProgressAt: null, updatedAt: new Date() })
          .where(
            and(
              eq(venomCandidateReleasesTable.clerkUserId, userId),
              eq(venomCandidateReleasesTable.appId, locked.appId),
              lt(venomCandidateReleasesTable.rollbackInProgressAt, staleBefore),
            ),
          );
        const [activeDeploymentMutation] = await tx
          .select({ id: venomCandidateReleasesTable.id })
          .from(venomCandidateReleasesTable)
          .where(
            and(
              eq(venomCandidateReleasesTable.clerkUserId, userId),
              eq(venomCandidateReleasesTable.appId, locked.appId),
              or(
                isNotNull(venomCandidateReleasesTable.publishInProgressAt),
                isNotNull(venomCandidateReleasesTable.rollbackInProgressAt),
              ),
            ),
          )
          .limit(1);
        if (activeDeploymentMutation) {
          return {
            kind: "conflict",
            message: "Another deployment change is already in progress for this app",
          };
        }

        // A reservation is "in progress" when the key is set, not completed,
        // and recent. Every request conflicts during that window, including a
        // duplicate with the same key, so only the request that created the
        // reservation can invoke the provider. The same key may resume only
        // after the marker is stale or explicitly cleared after a failure.
        const inProgress =
          locked.rollbackInProgressAt !== null &&
          locked.rollbackInProgressAt.getTime() >
            Date.now() - STALE_INPROGRESS_MS;
        if (locked.rollbackIdempotencyKey !== null && inProgress) {
          return {
            kind: "conflict",
            message: "A rollback is already in progress",
          };
        }

        // Only a superseded, previously-healthy release can be rolled back to.
        // The current published release cannot roll back to itself.
        if (locked.status === "published") {
          return {
            kind: "not_rollbackable",
            message:
              "Cannot roll back the current published release; select a previous release",
          };
        }
        if (locked.status !== "superseded" && locked.status !== "rolled_back") {
          return {
            kind: "not_rollbackable",
            message: "Only a previous healthy release can be rolled back to",
          };
        }
        if (locked.lastHealthyAt === null) {
          return {
            kind: "not_rollbackable",
            message: "Selected release was never confirmed healthy",
          };
        }

        // Reserve: set key + durable in-progress marker atomically.
        const now = new Date();
        await tx
          .update(venomCandidateReleasesTable)
          .set({
            rollbackIdempotencyKey: parsed.data.idempotencyKey,
            rollbackInProgressAt: now,
            updatedAt: now,
          })
          .where(eq(venomCandidateReleasesTable.id, release.id));

        return { kind: "proceed" };
      },
    );

    if (reservation.kind === "not_found") {
      res.status(404).json({ error: "Release not found" });
      return;
    }
    if (reservation.kind === "not_rollbackable") {
      res.status(409).json({ error: reservation.message });
      return;
    }
    if (reservation.kind === "conflict") {
      res.status(409).json({ error: reservation.message });
      return;
    }
    if (reservation.kind === "replay") {
      const [cached] = await db
        .select()
        .from(venomCandidateReleasesTable)
        .where(eq(venomCandidateReleasesTable.id, release.id))
        .limit(1);
      res.json(RollbackProvisioningReleaseResponse.parse(releasePayload(cached!)));
      return;
    }

    const provider = getProvisioningProvider();

    try {
      const rollbackResult = await withProviderTimeout(
        "rollback",
        STAGE_TIMEOUT_MS,
        (signal) =>
          provider.rollback({
            providerProjectId,
            providerReleaseId,
            idempotencyKey: parsed.data.idempotencyKey,
            signal,
          }),
      );

      // Only promote when the provider confirms healthy. On unhealthy, clear
      // the in-progress marker but RETAIN the key so a same-key retry is safe.
      if (!rollbackResult.healthy) {
        await db
          .update(venomCandidateReleasesTable)
          .set({ rollbackInProgressAt: null, updatedAt: new Date() })
          .where(eq(venomCandidateReleasesTable.id, release.id));
        res.status(400).json({
          error: "Provider did not confirm healthy state after rollback",
        });
        return;
      }

      const healthyLaunchUrl = sanitizeLaunchUrl(rollbackResult.launchUrl);
      if (!healthyLaunchUrl) {
        throw new ProvisioningProviderError(
          "Provider did not return a safe launch URL",
          "provider_invalid_launch_url",
          true,
        );
      }

      const now = new Date();
      const appId = release.appId;

      // Transactionally: supersede the prior current published release, promote
      // the selected release to be the new current published release, switch
      // the app primary URL. rolledBackAt records the rollback as audit.
      await db.transaction(async (tx) => {
        if (appId) {
          await tx
            .update(venomCandidateReleasesTable)
            .set({ status: "superseded", updatedAt: now })
            .where(
              and(
                eq(venomCandidateReleasesTable.clerkUserId, userId),
                eq(venomCandidateReleasesTable.appId, appId),
                eq(venomCandidateReleasesTable.status, "published"),
                sql`${venomCandidateReleasesTable.id} != ${release.id}`,
              ),
            );
        }

        await tx
          .update(venomCandidateReleasesTable)
          .set({
            status: "published",
            launchUrl: healthyLaunchUrl,
            lastHealthyStatus: "published",
            lastHealthyAt: now,
            rolledBackAt: now,
            rollbackInProgressAt: null,
            publishedAt: now,
            updatedAt: now,
          })
          .where(eq(venomCandidateReleasesTable.id, release.id));

        if (appId) {
          await tx
            .delete(venomPortfolioDeploymentLinksTable)
            .where(
              and(
                eq(venomPortfolioDeploymentLinksTable.appId, appId),
                eq(venomPortfolioDeploymentLinksTable.clerkUserId, userId),
                eq(venomPortfolioDeploymentLinksTable.isPrimary, true),
              ),
            );
          await tx.insert(venomPortfolioDeploymentLinksTable).values({
            appId,
            clerkUserId: userId,
            label: "Live deployment (rolled back)",
            url: healthyLaunchUrl,
            isPrimary: true,
          });

          // The rollback visibly resets the app's live pointer to the
          // restored release, and (re)stamps the matching package iteration —
          // a no-op for releases stamped at publish time, but it also repairs
          // rows that predate release stamping.
          await tx
            .update(venomPortfolioAppsTable)
            .set({ liveReleaseId: release.id, updatedAt: now })
            .where(
              and(
                eq(venomPortfolioAppsTable.id, appId),
                eq(venomPortfolioAppsTable.clerkUserId, userId),
              ),
            );
          await tx
            .update(venomPortfolioAppIterationsTable)
            .set({ releaseId: release.id })
            .where(
              and(
                eq(venomPortfolioAppIterationsTable.clerkUserId, userId),
                eq(
                  venomPortfolioAppIterationsTable.buildRunId,
                  release.buildRunId,
                ),
              ),
            );
        }
      });

      req.log.info(
        {
          operation: "venom_provisioning_rollback",
          releaseId: release.id,
          provisioningRunId: release.provisioningRunId,
          appId,
        },
        "Provisioning release rolled back and promoted",
      );

      const [updated] = await db
        .select()
        .from(venomCandidateReleasesTable)
        .where(eq(venomCandidateReleasesTable.id, release.id))
        .limit(1);

      res.json(
        RollbackProvisioningReleaseResponse.parse(releasePayload(updated!)),
      );
    } catch (err) {
      // Error/timeout — clear the in-progress marker but RETAIN the key so a
      // same-key retry is safe. Never promote on failure.
      await db
        .update(venomCandidateReleasesTable)
        .set({ rollbackInProgressAt: null, updatedAt: new Date() })
        .where(eq(venomCandidateReleasesTable.id, release.id));
      logger.error(
        {
          operation: "venom_provisioning_rollback_error",
          releaseId: release.id,
          errorName: err instanceof Error ? err.name : "UnknownError",
        },
        "Rollback failed",
      );
      res.status(500).json({ error: "Rollback failed" });
    }
  },
);

export default router;
