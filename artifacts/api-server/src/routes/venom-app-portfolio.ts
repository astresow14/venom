import { randomUUID } from "node:crypto";
import { getAuth } from "@clerk/express";
import {
  CompleteVenomAppImportUploadParams,
  CompleteVenomAppImportUploadResponse,
  CreateVenomAppBody,
  CreateVenomAppImportBody,
  CreateVenomAppImportParams,
  CreateVenomAppImportResponse,
  CreateVenomAppIterationBody,
  CreateVenomAppIterationParams,
  CreateVenomAppIterationResponse,
  CreateVenomAppResponse,
  DeleteVenomAppParams,
  DismissVenomAppImprovementSuggestionParams,
  DismissVenomAppImprovementSuggestionResponse,
  GetVenomAppImportParams,
  GetVenomAppImportResponse,
  GetVenomAppIterationContextParams,
  GetVenomAppIterationContextResponse,
  GetVenomAppParams,
  GetVenomAppTimelineParams,
  GetVenomAppTimelineQueryParams,
  GetVenomAppTimelineResponse,
  GetVenomAppResponse,
  ListVenomAppsResponse,
  ListVenomAppVersionsParams,
  ListVenomAppVersionsResponse,
  RetryVenomAppImportParams,
  RetryVenomAppImportResponse,
  UpdateVenomAppBody,
  UpdateVenomAppParams,
  UpdateVenomAppResponse,
} from "@workspace/api-zod";
import {
  db,
  venomBuildPackageRevisionsTable,
  venomCandidateReleasesTable,
  venomPortfolioAppIterationsTable,
  venomPortfolioAppsTable,
  venomPortfolioDeploymentLinksTable,
  venomPortfolioImportJobsTable,
  venomPortfolioSourceConnectionsTable,
  venomPortfolioSourceVersionsTable,
  venomSopRevisionsTable,
  venomSopsTable,
  type VenomCandidateRelease,
  type VenomPortfolioApp,
  type VenomPortfolioAppIteration,
  type VenomPortfolioImportJob,
  type VenomPortfolioSourceVersion,
} from "@workspace/db";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { Router, type IRouter, type Request } from "express";
import { logger } from "../lib/logger";
import {
  allowanceBlockedBody,
  checkVenomAllowance,
  releaseVenomAllowanceReservation,
} from "../lib/venom-billing-enforcement";
import {
  createArchiveUploadUrl,
  createUploadObjectPath,
  deletePrivateObject,
  downloadArchiveBounded,
  MAX_PORTFOLIO_ARCHIVE_BYTES,
  objectExistsWithinLimit,
  retainImmutableArchive,
} from "../lib/portfolio-storage";
import {
  inspectPortfolioZip,
  PortfolioArchiveError,
} from "../lib/portfolio-zip";
import {
  assembleFullAppTimeline,
  TIMELINE_MAX_ENTRIES,
  buildChangesSummary,
  computeImprovementSignals,
  computeProjectDelta,
  EMPTY_WORKSPACE_VIEW,
  latestIterationStats,
  loadLiveReleaseFacts,
  loadWorkspaceIterationView,
  resolveWorkspaceProject,
  type ImprovementSignalPayload,
} from "../lib/venom-app-iterations";
import {
  createVenomBuildRunForUser,
  runPayload as buildRunPayload,
} from "./venom-build-runs";

const router: IRouter = Router();
const STALE_IMPORT_AFTER_MS = 5 * 60 * 1_000;

let resolveAppPortfolioUserId = (request: Request): string | null =>
  getAuth(request).userId;

function userIdFor(request: Request): string | null {
  return resolveAppPortfolioUserId(request);
}

export function overrideVenomAppPortfolioUserIdResolverForTests(
  resolver: (request: Request) => string | null,
): () => void {
  const previous = resolveAppPortfolioUserId;
  resolveAppPortfolioUserId = resolver;
  return () => {
    resolveAppPortfolioUserId = previous;
  };
}

function safeDeploymentUrl(value: unknown): string | null | undefined {
  if (value === undefined || value === null || value === "") {
    return value === undefined ? undefined : null;
  }
  if (typeof value !== "string") return undefined;
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
      parsed.username ||
      parsed.password
    ) {
      return undefined;
    }
    return parsed.toString();
  } catch {
    return undefined;
  }
}

type AppPayloadContext = {
  linkedProjectName: string | null;
  latestIterationNumber: number;
  improvementSignal: ImprovementSignalPayload | null;
  liveIterationNumber: number | null;
  livePublishedAt: string | null;
};

export const EMPTY_APP_CONTEXT: AppPayloadContext = {
  linkedProjectName: null,
  latestIterationNumber: 0,
  improvementSignal: null,
  liveIterationNumber: null,
  livePublishedAt: null,
};

export function appPayload(
  app: VenomPortfolioApp,
  deploymentUrl: string | null,
  context: AppPayloadContext,
) {
  return {
    id: app.id,
    name: app.name,
    purpose: app.purpose,
    brand: app.brand,
    status: app.status,
    detectedStack: app.detectedStack,
    sourceType: app.sourceType,
    sourceVersion: app.currentSourceVersion,
    deploymentUrl,
    importStatus: app.latestImportStatus,
    sourceUpdatedAt: app.sourceUpdatedAt?.toISOString() ?? null,
    linkedProjectId: app.linkedProjectId,
    linkedProjectName: context.linkedProjectName,
    latestIterationNumber: context.latestIterationNumber,
    // The live pointer comes straight off the app record (written only by
    // the provisioning publish/rollback transactions); the derived fields
    // resolve it to a package number so clients can show "approved vN /
    // live vM" without assuming the newest package is serving.
    liveReleaseId: app.liveReleaseId,
    liveIterationNumber: context.liveIterationNumber,
    livePublishedAt: context.livePublishedAt,
    improvementSignal: context.improvementSignal,
    // Template lineage: stamped at creation, immutable, display-safe even
    // if the catalog row is later retired (the name is a snapshot).
    templateId: app.templateId,
    templateName: app.templateName,
    createdAt: app.createdAt.toISOString(),
    updatedAt: app.updatedAt.toISOString(),
  };
}

/**
 * Batch-computes the linked-project and iteration context for app payloads:
 * the live project name (null when the link dangles), the latest approved
 * package number, and the review-first improvement signal. Read-only.
 */
async function appPayloadContexts(
  userId: string,
  apps: VenomPortfolioApp[],
): Promise<Map<string, AppPayloadContext>> {
  const contexts = new Map<string, AppPayloadContext>();
  if (apps.length === 0) return contexts;
  const stats = await latestIterationStats(
    userId,
    apps.map((app) => app.id),
  );
  const needsView = apps.some((app) => app.linkedProjectId !== null);
  const view = needsView
    ? await loadWorkspaceIterationView(userId)
    : EMPTY_WORKSPACE_VIEW;
  const signals = await computeImprovementSignals(userId, apps, view, stats);
  const liveFacts = await loadLiveReleaseFacts(userId, apps);
  for (const app of apps) {
    const live = liveFacts.get(app.id) ?? null;
    contexts.set(app.id, {
      linkedProjectName: app.linkedProjectId
        ? (resolveWorkspaceProject(view, app.linkedProjectId)?.name ?? null)
        : null,
      latestIterationNumber: stats.get(app.id)?.latestIterationNumber ?? 0,
      improvementSignal: signals.get(app.id) ?? null,
      liveIterationNumber: live?.iteration?.iterationNumber ?? null,
      livePublishedAt: live?.release.publishedAt?.toISOString() ?? null,
    });
  }
  return contexts;
}

function iterationPayloads(
  iterations: VenomPortfolioAppIteration[],
  liveReleaseId: string | null,
) {
  const numberById = new Map(
    iterations.map((iteration) => [iteration.id, iteration.iterationNumber]),
  );
  return iterations.map((iteration) => ({
    id: iteration.id,
    iterationNumber: iteration.iterationNumber,
    buildRunId: iteration.buildRunId,
    revisionId: iteration.revisionId,
    packageTitle: iteration.packageTitle,
    packageChecksum: iteration.packageChecksum,
    runKind: iteration.runKind,
    reason: iteration.reason,
    changesSummary: iteration.changesSummary,
    baselineIterationNumber: iteration.baselineIterationId
      ? (numberById.get(iteration.baselineIterationId) ?? null)
      : null,
    // The release this package last shipped as (stamped by provisioning),
    // and whether that release is the one the app is serving right now.
    releaseId: iteration.releaseId,
    isLive:
      iteration.releaseId !== null && iteration.releaseId === liveReleaseId,
    createdBy: iteration.createdBy,
    createdAt: iteration.createdAt.toISOString(),
  }));
}

async function latestAppIteration(userId: string, appId: string) {
  const [iteration] = await db
    .select()
    .from(venomPortfolioAppIterationsTable)
    .where(
      and(
        eq(venomPortfolioAppIterationsTable.appId, appId),
        eq(venomPortfolioAppIterationsTable.clerkUserId, userId),
      ),
    )
    .orderBy(desc(venomPortfolioAppIterationsTable.iterationNumber))
    .limit(1);
  return iteration;
}

async function baselineRevisionFor(userId: string, revisionId: string) {
  const [revision] = await db
    .select()
    .from(venomBuildPackageRevisionsTable)
    .where(
      and(
        eq(venomBuildPackageRevisionsTable.id, revisionId),
        eq(venomBuildPackageRevisionsTable.clerkUserId, userId),
      ),
    )
    .limit(1);
  return revision;
}

async function latestSourceVersionFor(
  userId: string,
  app: VenomPortfolioApp,
): Promise<VenomPortfolioSourceVersion | null> {
  if (app.currentSourceVersion <= 0) return null;
  const [version] = await db
    .select()
    .from(venomPortfolioSourceVersionsTable)
    .where(
      and(
        eq(venomPortfolioSourceVersionsTable.appId, app.id),
        eq(venomPortfolioSourceVersionsTable.clerkUserId, userId),
        eq(
          venomPortfolioSourceVersionsTable.versionNumber,
          app.currentSourceVersion,
        ),
      ),
    )
    .limit(1);
  return version ?? null;
}

/**
 * Maps the baseline package's SOP references to their current active
 * revisions. SOPs that were archived or deleted since the baseline drop out;
 * newer active revisions replace the pinned ones.
 */
async function resolveSuggestedSops(
  userId: string,
  baselinePackage: { sopReferences: { sopId: string }[] },
): Promise<
  { sopId: string; revisionId: string; revisionNumber: number; title: string }[]
> {
  const sopIds = [
    ...new Set(baselinePackage.sopReferences.map((ref) => ref.sopId)),
  ].slice(0, 20);
  if (sopIds.length === 0) return [];
  const sops = await db
    .select()
    .from(venomSopsTable)
    .where(
      and(
        eq(venomSopsTable.clerkUserId, userId),
        inArray(venomSopsTable.id, sopIds),
      ),
    );
  const activeSops = sops.filter(
    (sop) => sop.activeRevisionId !== null && sop.archivedAt === null,
  );
  if (activeSops.length === 0) return [];
  const revisions = await db
    .select()
    .from(venomSopRevisionsTable)
    .where(
      and(
        eq(venomSopRevisionsTable.clerkUserId, userId),
        inArray(
          venomSopRevisionsTable.id,
          activeSops.map((sop) => sop.activeRevisionId as string),
        ),
      ),
    );
  const revisionById = new Map(
    revisions.map((revision) => [revision.id, revision]),
  );
  return activeSops
    .flatMap((sop) => {
      const revision = sop.activeRevisionId
        ? revisionById.get(sop.activeRevisionId)
        : undefined;
      return revision
        ? [
            {
              sopId: sop.id,
              revisionId: revision.id,
              revisionNumber: revision.versionNumber,
              title: revision.title.slice(0, 160),
            },
          ]
        : [];
    })
    .slice(0, 20);
}

function jobPayload(job: VenomPortfolioImportJob) {
  return {
    id: job.id,
    appId: job.appId,
    archiveFilename: job.archiveFilename,
    declaredBytes: job.declaredBytes,
    status: job.status,
    progress: job.progress,
    failureCode: job.failureCode,
    failureMessage: job.failureMessage,
    sourceVersionId: job.sourceVersionId,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
    completedAt: job.completedAt?.toISOString() ?? null,
  };
}

function versionPayload(version: VenomPortfolioSourceVersion) {
  return {
    id: version.id,
    versionNumber: version.versionNumber,
    sourceType: version.sourceType,
    archiveFilename: version.archiveFilename,
    archiveBytes: version.archiveBytes,
    checksumSha256: version.checksumSha256,
    manifest: version.manifest,
    createdAt: version.createdAt.toISOString(),
  };
}

function provisioningReleasePayload(release: VenomCandidateRelease) {
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

async function ownedApp(userId: string, appId: string) {
  const [app] = await db
    .select()
    .from(venomPortfolioAppsTable)
    .where(
      and(
        eq(venomPortfolioAppsTable.id, appId),
        eq(venomPortfolioAppsTable.clerkUserId, userId),
      ),
    )
    .limit(1);
  return app;
}

async function primaryDeploymentUrls(
  userId: string,
  appIds: string[],
): Promise<Map<string, string>> {
  if (appIds.length === 0) return new Map();
  const links = await db
    .select()
    .from(venomPortfolioDeploymentLinksTable)
    .where(
      and(
        eq(venomPortfolioDeploymentLinksTable.clerkUserId, userId),
        inArray(venomPortfolioDeploymentLinksTable.appId, appIds),
        eq(venomPortfolioDeploymentLinksTable.isPrimary, true),
      ),
    );
  return new Map(links.map((link) => [link.appId, link.url]));
}

async function setPrimaryDeployment(
  transaction: Parameters<Parameters<typeof db.transaction>[0]>[0],
  userId: string,
  appId: string,
  deploymentUrl: string | null,
): Promise<void> {
  await transaction
    .delete(venomPortfolioDeploymentLinksTable)
    .where(
      and(
        eq(venomPortfolioDeploymentLinksTable.appId, appId),
        eq(venomPortfolioDeploymentLinksTable.clerkUserId, userId),
        eq(venomPortfolioDeploymentLinksTable.isPrimary, true),
      ),
    );
  if (deploymentUrl) {
    await transaction.insert(venomPortfolioDeploymentLinksTable).values({
      appId,
      clerkUserId: userId,
      label: "Live deployment",
      url: deploymentUrl,
      isPrimary: true,
    });
  }
}

async function importJob(
  userId: string,
  appId: string,
  importJobId: string,
) {
  const [job] = await db
    .select()
    .from(venomPortfolioImportJobsTable)
    .where(
      and(
        eq(venomPortfolioImportJobsTable.id, importJobId),
        eq(venomPortfolioImportJobsTable.appId, appId),
        eq(venomPortfolioImportJobsTable.clerkUserId, userId),
      ),
    )
    .limit(1);
  return job;
}

async function failImport(
  job: VenomPortfolioImportJob,
  code: string,
  message: string,
): Promise<void> {
  const now = new Date();
  await db.transaction(async (transaction) => {
    await transaction
      .update(venomPortfolioImportJobsTable)
      .set({
        status: "failed",
        progress: 100,
        failureCode: code,
        failureMessage: message,
        completedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(venomPortfolioImportJobsTable.id, job.id),
          eq(venomPortfolioImportJobsTable.clerkUserId, job.clerkUserId),
        ),
      );
    await transaction
      .update(venomPortfolioAppsTable)
      .set({
        status: "attention",
        latestImportStatus: "failed",
        updatedAt: now,
      })
      .where(
        and(
          eq(venomPortfolioAppsTable.id, job.appId),
          eq(venomPortfolioAppsTable.clerkUserId, job.clerkUserId),
        ),
      );
  });
  await deletePrivateObject(job.uploadObjectPath).catch((error: unknown) => {
    logger.warn(
      {
        errorName: error instanceof Error ? error.name : "UnknownError",
        appId: job.appId,
        importJobId: job.id,
      },
      "Unable to remove rejected portfolio upload",
    );
  });
  logger.warn(
    { appId: job.appId, importJobId: job.id, failureCode: code },
    "Portfolio import rejected",
  );
}

async function processImportJob(
  userId: string,
  appId: string,
  importJobId: string,
): Promise<void> {
  const job = await importJob(userId, appId, importJobId);
  if (
    !job ||
    (job.status !== "validating" && job.status !== "inspecting")
  ) {
    return;
  }

  let retainedObjectPath: string | null = null;
  try {
    const metadata = await objectExistsWithinLimit(job.uploadObjectPath);
    if (metadata.size !== job.declaredBytes) {
      throw new PortfolioArchiveError(
        "size_mismatch",
        "Uploaded archive size does not match the selected file",
      );
    }
    if (!job.archiveFilename.toLowerCase().endsWith(".zip")) {
      throw new PortfolioArchiveError(
        "invalid_type",
        "Only ZIP archives are supported",
      );
    }

    await db
      .update(venomPortfolioImportJobsTable)
      .set({ status: "inspecting", progress: 55, updatedAt: new Date() })
      .where(
        and(
          eq(venomPortfolioImportJobsTable.id, job.id),
          eq(venomPortfolioImportJobsTable.clerkUserId, userId),
        ),
      );
    await db
      .update(venomPortfolioAppsTable)
      .set({ latestImportStatus: "inspecting", updatedAt: new Date() })
      .where(
        and(
          eq(venomPortfolioAppsTable.id, appId),
          eq(venomPortfolioAppsTable.clerkUserId, userId),
        ),
      );

    const archive = await downloadArchiveBounded(job.uploadObjectPath);
    if (archive.length < 4 || archive[0] !== 0x50 || archive[1] !== 0x4b) {
      throw new PortfolioArchiveError(
        "malformed_zip",
        "Archive is not a valid ZIP file",
      );
    }
    const manifest = inspectPortfolioZip(archive);
    const retained = await retainImmutableArchive(
      job.uploadObjectPath,
      appId,
      archive,
    );
    retainedObjectPath = retained.objectPath;
    const now = new Date();

    const committed = await db.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtext(${appId}))`,
      );
      const [currentJob] = await transaction
        .select({
          sourceVersionId: venomPortfolioImportJobsTable.sourceVersionId,
          status: venomPortfolioImportJobsTable.status,
        })
        .from(venomPortfolioImportJobsTable)
        .where(
          and(
            eq(venomPortfolioImportJobsTable.id, job.id),
            eq(venomPortfolioImportJobsTable.clerkUserId, userId),
          ),
        )
        .limit(1);
      if (
        !currentJob ||
        currentJob.sourceVersionId ||
        (currentJob.status !== "validating" &&
          currentJob.status !== "inspecting")
      ) {
        return false;
      }
      const [currentApp] = await transaction
        .select()
        .from(venomPortfolioAppsTable)
        .where(
          and(
            eq(venomPortfolioAppsTable.id, appId),
            eq(venomPortfolioAppsTable.clerkUserId, userId),
          ),
        )
        .limit(1);
      if (!currentApp) throw new Error("Portfolio app no longer exists");

      const [version] = await transaction
        .insert(venomPortfolioSourceVersionsTable)
        .values({
          appId,
          clerkUserId: userId,
          versionNumber: currentApp.currentSourceVersion + 1,
          sourceType: "zip",
          packageObjectPath: retained.objectPath,
          archiveFilename: job.archiveFilename,
          archiveBytes: archive.byteLength,
          checksumSha256: retained.checksumSha256,
          manifest,
        })
        .returning();

      await transaction
        .update(venomPortfolioImportJobsTable)
        .set({
          status: "complete",
          progress: 100,
          sourceVersionId: version.id,
          failureCode: null,
          failureMessage: null,
          completedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(venomPortfolioImportJobsTable.id, job.id),
            eq(venomPortfolioImportJobsTable.clerkUserId, userId),
          ),
        );
      await transaction
        .update(venomPortfolioAppsTable)
        .set({
          status: "ready",
          detectedStack: manifest.detectedStack,
          sourceType: "zip",
          currentSourceVersion: version.versionNumber,
          latestImportStatus: "complete",
          sourceUpdatedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(venomPortfolioAppsTable.id, appId),
            eq(venomPortfolioAppsTable.clerkUserId, userId),
          ),
        );

      const [connection] = await transaction
        .select({ id: venomPortfolioSourceConnectionsTable.id })
        .from(venomPortfolioSourceConnectionsTable)
        .where(
          and(
            eq(venomPortfolioSourceConnectionsTable.appId, appId),
            eq(venomPortfolioSourceConnectionsTable.clerkUserId, userId),
            eq(venomPortfolioSourceConnectionsTable.sourceType, "zip"),
          ),
        )
        .limit(1);
      if (!connection) {
        await transaction.insert(venomPortfolioSourceConnectionsTable).values({
          appId,
          clerkUserId: userId,
          sourceType: "zip",
          label: "Secure ZIP intake",
          status: "connected",
        });
      }
      return true;
    });
    if (!committed) {
      await deletePrivateObject(retained.objectPath).catch(() => undefined);
      retainedObjectPath = null;
      return;
    }

    logger.info(
      {
        appId,
        importJobId,
        archiveBytes: archive.byteLength,
        detectedStackCount: manifest.detectedStack.length,
        excludedSensitiveFileCount: manifest.excludedSensitiveFileCount,
      },
      "Portfolio import completed",
    );
  } catch (error) {
    if (retainedObjectPath) {
      await deletePrivateObject(retainedObjectPath).catch(() => undefined);
    }
    const archiveError =
      error instanceof PortfolioArchiveError ? error : undefined;
    logger.error(
      {
        errorName: error instanceof Error ? error.name : "UnknownError",
        failureCode: archiveError?.code ?? "processing_failed",
        appId,
        importJobId,
      },
      "Portfolio import processing failed",
    );
    await failImport(
      job,
      archiveError?.code ?? "processing_failed",
      archiveError?.clientMessage ??
        "Import could not be completed safely. Try a different ZIP file.",
    );
  }
}

async function recoverStaleImportJobs(
  userId: string,
  jobs: VenomPortfolioImportJob[],
): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_IMPORT_AFTER_MS);
  for (const job of jobs) {
    if (
      (job.status !== "validating" && job.status !== "inspecting") ||
      job.updatedAt >= cutoff
    ) {
      continue;
    }
    const [claimed] = await db
      .update(venomPortfolioImportJobsTable)
      .set({ status: "validating", progress: 25, updatedAt: new Date() })
      .where(
        and(
          eq(venomPortfolioImportJobsTable.id, job.id),
          eq(venomPortfolioImportJobsTable.clerkUserId, userId),
          inArray(venomPortfolioImportJobsTable.status, [
            "validating",
            "inspecting",
          ]),
          lt(venomPortfolioImportJobsTable.updatedAt, cutoff),
        ),
      )
      .returning({ id: venomPortfolioImportJobsTable.id });
    if (!claimed) continue;
    logger.info(
      { appId: job.appId, importJobId: job.id },
      "Resuming stale portfolio import",
    );
    setImmediate(() => {
      void processImportJob(userId, job.appId, job.id);
    });
  }
}

router.get("/venom/apps", async (req, res): Promise<void> => {
  const userId = userIdFor(req);
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const apps = await db
    .select()
    .from(venomPortfolioAppsTable)
    .where(eq(venomPortfolioAppsTable.clerkUserId, userId))
    .orderBy(desc(venomPortfolioAppsTable.updatedAt))
    .limit(500);
  const [deployments, contexts] = await Promise.all([
    primaryDeploymentUrls(
      userId,
      apps.map((app) => app.id),
    ),
    appPayloadContexts(userId, apps),
  ]);
  res.json(
    ListVenomAppsResponse.parse(
      apps.map((app) =>
        appPayload(
          app,
          deployments.get(app.id) ?? null,
          contexts.get(app.id) ?? EMPTY_APP_CONTEXT,
        ),
      ),
    ),
  );
});

router.post("/venom/apps", async (req, res): Promise<void> => {
  const userId = userIdFor(req);
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const parsed = CreateVenomAppBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid app metadata" });
    return;
  }
  const deploymentUrl = safeDeploymentUrl(parsed.data.deploymentUrl);
  if (parsed.data.deploymentUrl && deploymentUrl === undefined) {
    res.status(400).json({ error: "Deployment URL must use HTTP or HTTPS" });
    return;
  }
  const app = await db.transaction(async (transaction) => {
    const [created] = await transaction
      .insert(venomPortfolioAppsTable)
      .values({
        clerkUserId: userId,
        name: parsed.data.name.trim(),
        purpose: parsed.data.purpose.trim(),
        brand: parsed.data.brand.trim(),
      })
      .returning();
    if (deploymentUrl) {
      await setPrimaryDeployment(transaction, userId, created.id, deploymentUrl);
    }
    return created;
  });
  req.log.info({ appId: app.id }, "Portfolio app created");
  res
    .status(201)
    .json(
      CreateVenomAppResponse.parse(
        appPayload(app, deploymentUrl ?? null, EMPTY_APP_CONTEXT),
      ),
    );
});

router.get("/venom/apps/:appId", async (req, res): Promise<void> => {
  const userId = userIdFor(req);
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const params = GetVenomAppParams.safeParse(req.params);
  if (!params.success) {
    res.status(404).json({ error: "App not found" });
    return;
  }
  const app = await ownedApp(userId, params.data.appId);
  if (!app) {
    res.status(404).json({ error: "App not found" });
    return;
  }
  const [versions, jobs, links, releases, iterations, contexts] =
    await Promise.all([
      db
        .select()
        .from(venomPortfolioSourceVersionsTable)
        .where(
          and(
            eq(venomPortfolioSourceVersionsTable.appId, app.id),
            eq(venomPortfolioSourceVersionsTable.clerkUserId, userId),
          ),
        )
        .orderBy(desc(venomPortfolioSourceVersionsTable.versionNumber)),
      db
        .select()
        .from(venomPortfolioImportJobsTable)
        .where(
          and(
            eq(venomPortfolioImportJobsTable.appId, app.id),
            eq(venomPortfolioImportJobsTable.clerkUserId, userId),
          ),
        )
        .orderBy(desc(venomPortfolioImportJobsTable.createdAt))
        .limit(100),
      db
        .select()
        .from(venomPortfolioDeploymentLinksTable)
        .where(
          and(
            eq(venomPortfolioDeploymentLinksTable.appId, app.id),
            eq(venomPortfolioDeploymentLinksTable.clerkUserId, userId),
          ),
        )
        .orderBy(desc(venomPortfolioDeploymentLinksTable.isPrimary)),
      db
        .select()
        .from(venomCandidateReleasesTable)
        .where(
          and(
            eq(venomCandidateReleasesTable.appId, app.id),
            eq(venomCandidateReleasesTable.clerkUserId, userId),
          ),
        )
        .orderBy(desc(venomCandidateReleasesTable.createdAt)),
      db
        .select()
        .from(venomPortfolioAppIterationsTable)
        .where(
          and(
            eq(venomPortfolioAppIterationsTable.appId, app.id),
            eq(venomPortfolioAppIterationsTable.clerkUserId, userId),
          ),
        )
        .orderBy(desc(venomPortfolioAppIterationsTable.iterationNumber)),
      appPayloadContexts(userId, [app]),
    ]);
  const primary = links.find((link) => link.isPrimary)?.url ?? null;
  await recoverStaleImportJobs(userId, jobs);
  // The timeline is assembled from UNCAPPED history so its total is honest;
  // the embedded view stays bounded and the paged endpoint serves the rest.
  const fullTimeline = assembleFullAppTimeline({
    versions,
    iterations,
    releases,
  });
  res.json(
    GetVenomAppResponse.parse({
      app: appPayload(
        app,
        primary,
        contexts.get(app.id) ?? EMPTY_APP_CONTEXT,
      ),
      versions: versions.slice(0, 500).map(versionPayload),
      importJobs: jobs.map(jobPayload),
      deploymentLinks: links.map((link) => ({
        id: link.id,
        label: link.label,
        url: link.url,
        isPrimary: link.isPrimary,
        createdAt: link.createdAt.toISOString(),
      })),
      provisioningReleases: releases
        .slice(0, 500)
        .map(provisioningReleasePayload),
      iterations: iterationPayloads(iterations.slice(0, 200), app.liveReleaseId),
      timeline: fullTimeline.slice(0, TIMELINE_MAX_ENTRIES),
      timelineTotal: fullTimeline.length,
      timelineTruncated: fullTimeline.length > TIMELINE_MAX_ENTRIES,
    }),
  );
});

router.get(
  "/venom/apps/:appId/timeline",
  async (req, res): Promise<void> => {
    const userId = userIdFor(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const params = GetVenomAppTimelineParams.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "App not found" });
      return;
    }
    const query = GetVenomAppTimelineQueryParams.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: "Invalid cursor or limit" });
      return;
    }
    const app = await ownedApp(userId, params.data.appId);
    if (!app) {
      res.status(404).json({ error: "App not found" });
      return;
    }
    const [versions, releases, iterations] = await Promise.all([
      db
        .select()
        .from(venomPortfolioSourceVersionsTable)
        .where(
          and(
            eq(venomPortfolioSourceVersionsTable.appId, app.id),
            eq(venomPortfolioSourceVersionsTable.clerkUserId, userId),
          ),
        )
        .orderBy(desc(venomPortfolioSourceVersionsTable.versionNumber)),
      db
        .select()
        .from(venomCandidateReleasesTable)
        .where(
          and(
            eq(venomCandidateReleasesTable.appId, app.id),
            eq(venomCandidateReleasesTable.clerkUserId, userId),
          ),
        )
        .orderBy(desc(venomCandidateReleasesTable.createdAt)),
      db
        .select()
        .from(venomPortfolioAppIterationsTable)
        .where(
          and(
            eq(venomPortfolioAppIterationsTable.appId, app.id),
            eq(venomPortfolioAppIterationsTable.clerkUserId, userId),
          ),
        )
        .orderBy(desc(venomPortfolioAppIterationsTable.iterationNumber)),
    ]);
    const full = assembleFullAppTimeline({ versions, iterations, releases });
    const limit = query.data.limit ?? 100;
    const cursor = query.data.cursor ?? null;
    // Keyset cursor `${occurredAt}~${entryId}`: page from the first entry
    // strictly after that position in (occurredAt desc, id asc) order, so
    // paging stays stable even if the cursor entry itself disappears.
    let start = 0;
    if (cursor !== null && cursor !== undefined) {
      const separator = cursor.indexOf("~");
      if (separator <= 0) {
        res.status(400).json({ error: "Invalid cursor or limit" });
        return;
      }
      const cursorAt = cursor.slice(0, separator);
      const cursorId = cursor.slice(separator + 1);
      // The timestamp half must be a canonical ISO instant (timeline entries
      // serialize occurredAt via toISOString) and the id half non-empty;
      // anything else is a malformed cursor, not a seek position.
      const parsedAt = new Date(cursorAt);
      if (
        cursorId.length === 0 ||
        Number.isNaN(parsedAt.getTime()) ||
        parsedAt.toISOString() !== cursorAt
      ) {
        res.status(400).json({ error: "Invalid cursor or limit" });
        return;
      }
      const index = full.findIndex(
        (entry) =>
          entry.occurredAt < cursorAt ||
          (entry.occurredAt === cursorAt &&
            entry.id.localeCompare(cursorId) > 0),
      );
      start = index === -1 ? full.length : index;
    }
    const entries = full.slice(start, start + limit);
    const lastEntry = entries[entries.length - 1];
    const hasMore = start + entries.length < full.length;
    res.json(
      GetVenomAppTimelineResponse.parse({
        entries,
        nextCursor:
          hasMore && lastEntry
            ? `${lastEntry.occurredAt}~${lastEntry.id}`
            : null,
        total: full.length,
      }),
    );
  },
);

router.patch("/venom/apps/:appId", async (req, res): Promise<void> => {
  const userId = userIdFor(req);
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const params = UpdateVenomAppParams.safeParse(req.params);
  const parsed = UpdateVenomAppBody.safeParse(req.body);
  if (
    !params.success ||
    !parsed.success ||
    Object.keys(parsed.data).length === 0
  ) {
    res.status(400).json({ error: "Invalid app metadata" });
    return;
  }
  const deploymentUrl = safeDeploymentUrl(parsed.data.deploymentUrl);
  if (
    Object.hasOwn(parsed.data, "deploymentUrl") &&
    deploymentUrl === undefined
  ) {
    res.status(400).json({ error: "Deployment URL must use HTTP or HTTPS" });
    return;
  }
  // Linking an app to a Venom project is validated server-side against the
  // caller's own workspace projects. Changing or clearing the link resets the
  // suggestion dismissal so signals are recomputed for the new context.
  let linkedProjectPatch: {
    linkedProjectId: string | null;
    improvementSuggestionDismissedAt: null;
  } | null = null;
  if (Object.hasOwn(parsed.data, "linkedProjectId")) {
    const requested = parsed.data.linkedProjectId ?? null;
    if (requested !== null) {
      const view = await loadWorkspaceIterationView(userId);
      if (!resolveWorkspaceProject(view, requested)) {
        res
          .status(400)
          .json({ error: "Linked project was not found in this workspace" });
        return;
      }
    }
    linkedProjectPatch = {
      linkedProjectId: requested,
      improvementSuggestionDismissedAt: null,
    };
  }
  const updated = await db.transaction(async (transaction) => {
    const [app] = await transaction
      .update(venomPortfolioAppsTable)
      .set({
        ...(parsed.data.name === undefined
          ? {}
          : { name: parsed.data.name.trim() }),
        ...(parsed.data.purpose === undefined
          ? {}
          : { purpose: parsed.data.purpose.trim() }),
        ...(parsed.data.brand === undefined
          ? {}
          : { brand: parsed.data.brand.trim() }),
        ...(parsed.data.status === undefined
          ? {}
          : { status: parsed.data.status }),
        ...(linkedProjectPatch ?? {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(venomPortfolioAppsTable.id, params.data.appId),
          eq(venomPortfolioAppsTable.clerkUserId, userId),
        ),
      )
      .returning();
    if (
      app &&
      Object.hasOwn(parsed.data, "deploymentUrl") &&
      deploymentUrl !== undefined
    ) {
      await setPrimaryDeployment(transaction, userId, app.id, deploymentUrl);
    }
    return app;
  });
  if (!updated) {
    res.status(404).json({ error: "App not found" });
    return;
  }
  const [deployments, contexts] = await Promise.all([
    primaryDeploymentUrls(userId, [updated.id]),
    appPayloadContexts(userId, [updated]),
  ]);
  res.json(
    UpdateVenomAppResponse.parse(
      appPayload(
        updated,
        deployments.get(updated.id) ?? null,
        contexts.get(updated.id) ?? EMPTY_APP_CONTEXT,
      ),
    ),
  );
});

router.delete("/venom/apps/:appId", async (req, res): Promise<void> => {
  const userId = userIdFor(req);
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const params = DeleteVenomAppParams.safeParse(req.params);
  if (!params.success) {
    res.status(404).json({ error: "App not found" });
    return;
  }
  const app = await ownedApp(userId, params.data.appId);
  if (!app) {
    res.status(404).json({ error: "App not found" });
    return;
  }
  const [versions, jobs] = await Promise.all([
    db
      .select({ path: venomPortfolioSourceVersionsTable.packageObjectPath })
      .from(venomPortfolioSourceVersionsTable)
      .where(
        and(
          eq(venomPortfolioSourceVersionsTable.appId, app.id),
          eq(venomPortfolioSourceVersionsTable.clerkUserId, userId),
        ),
      ),
    db
      .select({ path: venomPortfolioImportJobsTable.uploadObjectPath })
      .from(venomPortfolioImportJobsTable)
      .where(
        and(
          eq(venomPortfolioImportJobsTable.appId, app.id),
          eq(venomPortfolioImportJobsTable.clerkUserId, userId),
        ),
      ),
  ]);
  const cleanup = await Promise.allSettled(
    [...versions, ...jobs].map(({ path }) => deletePrivateObject(path)),
  );
  const cleanupFailures = cleanup.filter(
    (result) => result.status === "rejected",
  ).length;
  if (cleanupFailures > 0) {
    req.log.warn(
      { appId: app.id, cleanupFailures },
      "Some portfolio objects could not be deleted",
    );
  }
  await db
    .delete(venomPortfolioAppsTable)
    .where(
      and(
        eq(venomPortfolioAppsTable.id, app.id),
        eq(venomPortfolioAppsTable.clerkUserId, userId),
      ),
    );
  req.log.info({ appId: app.id }, "Portfolio app deleted");
  res.sendStatus(204);
});

router.get(
  "/venom/apps/:appId/iteration-context",
  async (req, res): Promise<void> => {
    const userId = userIdFor(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const params = GetVenomAppIterationContextParams.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "App not found" });
      return;
    }
    const app = await ownedApp(userId, params.data.appId);
    if (!app) {
      res.status(404).json({ error: "App not found" });
      return;
    }
    const view = app.linkedProjectId
      ? await loadWorkspaceIterationView(userId)
      : EMPTY_WORKSPACE_VIEW;
    const linkedProject = app.linkedProjectId
      ? (resolveWorkspaceProject(view, app.linkedProjectId) ?? null)
      : null;
    const latestIteration = await latestAppIteration(userId, app.id);
    const baselineRevision = latestIteration
      ? await baselineRevisionFor(userId, latestIteration.revisionId)
      : undefined;
    const latestSourceVersion = await latestSourceVersionFor(userId, app);
    const suggestedSops = baselineRevision
      ? await resolveSuggestedSops(userId, baselineRevision.package)
      : [];
    let changes: {
      knowledgeChanges: number;
      sourceChanges: number;
      summary: string;
      since: string;
    } | null = null;
    if (latestIteration && linkedProject) {
      const sinceMs = latestIteration.createdAt.getTime();
      const delta = await computeProjectDelta(
        userId,
        linkedProject.id,
        sinceMs,
        view,
      );
      changes = {
        knowledgeChanges: delta.knowledgeChanges,
        sourceChanges: delta.sourceChanges,
        summary: buildChangesSummary(delta, {
          sinceLabel: `version ${latestIteration.iterationNumber}`,
          projectName: linkedProject.name,
        }),
        since: latestIteration.createdAt.toISOString(),
      };
    }
    // Live-release anchoring: what the app is actually serving may lag the
    // newest approved package (published earlier, or restored by rollback).
    // Resolve the live pointer and say so explicitly instead of letting the
    // dialog silently assume the newest package is live.
    const liveFacts =
      (await loadLiveReleaseFacts(userId, [app])).get(app.id) ?? null;
    const liveIteration = liveFacts?.iteration ?? null;
    const liveRevision = liveIteration
      ? liveIteration.id === latestIteration?.id
        ? baselineRevision
        : await baselineRevisionFor(userId, liveIteration.revisionId)
      : undefined;
    const divergence = !liveFacts
      ? null
      : !liveIteration || !latestIteration
        ? ("live_unversioned" as const)
        : liveIteration.iterationNumber === latestIteration.iterationNumber
          ? ("in_sync" as const)
          : liveIteration.iterationNumber < latestIteration.iterationNumber
            ? ("live_behind" as const)
            : ("live_ahead" as const);
    let liveChanges: {
      knowledgeChanges: number;
      sourceChanges: number;
      summary: string;
      since: string;
    } | null = null;
    if (
      liveIteration &&
      linkedProject &&
      latestIteration &&
      liveIteration.id !== latestIteration.id
    ) {
      const delta = await computeProjectDelta(
        userId,
        linkedProject.id,
        liveIteration.createdAt.getTime(),
        view,
      );
      liveChanges = {
        knowledgeChanges: delta.knowledgeChanges,
        sourceChanges: delta.sourceChanges,
        summary: buildChangesSummary(delta, {
          sinceLabel: `version ${liveIteration.iterationNumber}`,
          projectName: linkedProject.name,
        }),
        since: liveIteration.createdAt.toISOString(),
      };
    }
    const blockedReason = !latestIteration
      ? ("no_baseline" as const)
      : !baselineRevision
        ? ("baseline_unresolvable" as const)
        : null;
    res.json(
      GetVenomAppIterationContextResponse.parse({
        appId: app.id,
        appName: app.name,
        linkedProject: linkedProject
          ? { id: linkedProject.id, name: linkedProject.name }
          : null,
        baseline: latestIteration
          ? {
              iterationId: latestIteration.id,
              iterationNumber: latestIteration.iterationNumber,
              buildRunId: latestIteration.buildRunId,
              revisionId: latestIteration.revisionId,
              packageTitle: latestIteration.packageTitle,
              resolvable: Boolean(baselineRevision),
              approvedAt: latestIteration.createdAt.toISOString(),
            }
          : null,
        live: liveFacts
          ? {
              releaseId: liveFacts.release.id,
              iterationId: liveIteration?.id ?? null,
              iterationNumber: liveIteration?.iterationNumber ?? null,
              packageTitle: liveIteration?.packageTitle ?? null,
              publishedAt:
                liveFacts.release.publishedAt?.toISOString() ?? null,
              restoredByRollback: liveFacts.release.rolledBackAt !== null,
              resolvable: Boolean(liveRevision),
              baselineSelectable: Boolean(
                liveIteration &&
                  latestIteration &&
                  liveIteration.id !== latestIteration.id &&
                  liveRevision,
              ),
              changes: liveChanges,
            }
          : null,
        divergence,
        latestSourceVersion: latestSourceVersion
          ? {
              id: latestSourceVersion.id,
              versionNumber: latestSourceVersion.versionNumber,
              archiveFilename: latestSourceVersion.archiveFilename,
            }
          : null,
        suggestedSops,
        changes,
        canIterate: blockedReason === null,
        blockedReason,
      }),
    );
  },
);

router.post(
  "/venom/apps/:appId/iterations",
  async (req, res): Promise<void> => {
    const userId = userIdFor(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const params = CreateVenomAppIterationParams.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "App not found" });
      return;
    }
    const parsed = CreateVenomAppIterationBody.safeParse(req.body);
    if (!parsed.success || parsed.data.instruction.trim().length === 0) {
      res.status(400).json({ error: "Invalid iteration request" });
      return;
    }
    const app = await ownedApp(userId, params.data.appId);
    if (!app) {
      res.status(404).json({ error: "App not found" });
      return;
    }
    // Iterations spawn AI build work in the personal space; the caller's
    // personal allowance decides whether the run may start at all.
    const iterationAllowance = await checkVenomAllowance({
      userId,
      reserve: true,
    });
    if (!iterationAllowance.allowed) {
      res.status(402).json(allowanceBlockedBody(iterationAllowance));
      return;
    }
    // The iteration run spends after this response ends, so a successful
    // creation hands the hold to the run row (the processor settles or
    // releases it; crash leaks reap by age). Until then this route owns
    // it, and the close hook frees it on every exit path.
    let routeOwnsReservation = iterationAllowance.reservationId != null;
    if (routeOwnsReservation) {
      res.once("close", () => {
        if (routeOwnsReservation && iterationAllowance.reservationId) {
          void releaseVenomAllowanceReservation(
            iterationAllowance.reservationId,
          );
        }
      });
    }
    const latestIteration = await latestAppIteration(userId, app.id);
    if (!latestIteration) {
      res.status(409).json({
        error:
          "This app has no approved package yet. Approve a build for it first to establish a baseline.",
      });
      return;
    }
    // The baseline defaults to the newest approved package. When what is
    // live lags behind it (approved vN, live vM), the owner may consciously
    // baseline on the live version instead — and only on that one; arbitrary
    // historical baselines are not accepted.
    let baselineIteration = latestIteration;
    if (
      parsed.data.baselineIterationId &&
      parsed.data.baselineIterationId !== latestIteration.id
    ) {
      const liveFacts =
        (await loadLiveReleaseFacts(userId, [app])).get(app.id) ?? null;
      const liveIteration = liveFacts?.iteration ?? null;
      if (
        !liveIteration ||
        liveIteration.id !== parsed.data.baselineIterationId
      ) {
        res.status(409).json({
          error:
            "Baseline must be the newest approved package or the version that is live right now.",
        });
        return;
      }
      baselineIteration = liveIteration;
    }
    const baselineRevision = await baselineRevisionFor(
      userId,
      baselineIteration.revisionId,
    );
    if (!baselineRevision) {
      res.status(409).json({
        error:
          "The selected baseline package can no longer be resolved. Approve a new build for this app to set a fresh baseline.",
      });
      return;
    }
    const view = app.linkedProjectId
      ? await loadWorkspaceIterationView(userId)
      : EMPTY_WORKSPACE_VIEW;
    const linkedProject = app.linkedProjectId
      ? (resolveWorkspaceProject(view, app.linkedProjectId) ?? null)
      : null;
    let changesSummary =
      "No linked Venom project; this iteration is driven by the owner's request only.";
    if (linkedProject) {
      const delta = await computeProjectDelta(
        userId,
        linkedProject.id,
        baselineIteration.createdAt.getTime(),
        view,
      );
      changesSummary = buildChangesSummary(delta, {
        sinceLabel: `version ${baselineIteration.iterationNumber}`,
        projectName: linkedProject.name,
      });
    }
    const latestSourceVersion = await latestSourceVersionFor(userId, app);
    const sopRevisionIds =
      parsed.data.sopRevisionIds ??
      (await resolveSuggestedSops(userId, baselineRevision.package)).map(
        (sop) => sop.revisionId,
      );
    const creation = await createVenomBuildRunForUser(
      userId,
      {
        targetType: baselineRevision.package.targetType,
        targetName: app.name.slice(0, 200),
        requirements: parsed.data.instruction,
        constraints: parsed.data.constraints ?? "",
        brandDirection: baselineRevision.package.brandDirection
          .join("\n")
          .slice(0, 3000),
        appId: app.id,
        sourceVersionId: latestSourceVersion?.id ?? null,
        projectId: linkedProject?.id ?? null,
        sopRevisionIds,
        idempotencyKey: parsed.data.idempotencyKey,
      },
      {
        runKind: "app_iteration",
        baselineIterationId: baselineIteration.id,
        baselineRevisionId: baselineIteration.revisionId,
        changesSummary,
        reservationId: iterationAllowance.reservationId ?? null,
      },
    );
    if (creation.kind === "invalid_reference") {
      res.status(400).json({
        error: "One or more source or SOP revision references are unavailable",
      });
      return;
    }
    if (creation.kind === "busy") {
      res.status(409).json({
        error:
          "Two package generations are already active. Wait or cancel one.",
      });
      return;
    }
    if (creation.kind === "conflict") {
      res.status(409).json({ error: "Idempotency key is already in use" });
      return;
    }
    if (creation.kind === "iteration_required") {
      // Unreachable: the baseline guard only applies to standard runs, and
      // this endpoint always creates app_iteration runs. Kept for exhaustive
      // narrowing so the compiler protects future outcome changes.
      res.status(409).json({
        error: "This app must be improved through an iteration run.",
      });
      return;
    }
    if (creation.kind === "created") {
      // The run row carries the hold from here. An idempotent replay
      // ("existing") stored nothing, so its fresh hold frees at close.
      routeOwnsReservation = false;
    }
    req.log.info(
      {
        operation: "venom_app_iteration_create",
        appId: app.id,
        runId: creation.run.id,
        baselineIterationId: baselineIteration.id,
        baselineWasLiveChoice: baselineIteration.id !== latestIteration.id,
        linkedProjectId: linkedProject?.id ?? null,
      },
      "App improvement iteration started",
    );
    res
      .status(201)
      .json(
        CreateVenomAppIterationResponse.parse(
          await buildRunPayload(creation.run),
        ),
      );
  },
);

router.post(
  "/venom/apps/:appId/improvement-suggestion/dismiss",
  async (req, res): Promise<void> => {
    const userId = userIdFor(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const params = DismissVenomAppImprovementSuggestionParams.safeParse(
      req.params,
    );
    if (!params.success) {
      res.status(404).json({ error: "App not found" });
      return;
    }
    const [updated] = await db
      .update(venomPortfolioAppsTable)
      .set({ improvementSuggestionDismissedAt: new Date() })
      .where(
        and(
          eq(venomPortfolioAppsTable.id, params.data.appId),
          eq(venomPortfolioAppsTable.clerkUserId, userId),
        ),
      )
      .returning();
    if (!updated) {
      res.status(404).json({ error: "App not found" });
      return;
    }
    const [deployments, contexts] = await Promise.all([
      primaryDeploymentUrls(userId, [updated.id]),
      appPayloadContexts(userId, [updated]),
    ]);
    res.json(
      DismissVenomAppImprovementSuggestionResponse.parse(
        appPayload(
          updated,
          deployments.get(updated.id) ?? null,
          contexts.get(updated.id) ?? EMPTY_APP_CONTEXT,
        ),
      ),
    );
  },
);

router.get(
  "/venom/apps/:appId/versions",
  async (req, res): Promise<void> => {
    const userId = userIdFor(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const params = ListVenomAppVersionsParams.safeParse(req.params);
    if (!params.success || !(await ownedApp(userId, params.data.appId))) {
      res.status(404).json({ error: "App not found" });
      return;
    }
    const versions = await db
      .select()
      .from(venomPortfolioSourceVersionsTable)
      .where(
        and(
          eq(venomPortfolioSourceVersionsTable.appId, params.data.appId),
          eq(venomPortfolioSourceVersionsTable.clerkUserId, userId),
        ),
      )
      .orderBy(desc(venomPortfolioSourceVersionsTable.versionNumber))
      .limit(500);
    res.json(
      ListVenomAppVersionsResponse.parse(versions.map(versionPayload)),
    );
  },
);

router.post("/venom/apps/:appId/imports", async (req, res): Promise<void> => {
  const userId = userIdFor(req);
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const params = CreateVenomAppImportParams.safeParse(req.params);
  const parsed = CreateVenomAppImportBody.safeParse(req.body);
  if (!params.success || !parsed.success) {
    res.status(400).json({ error: "Invalid archive metadata" });
    return;
  }
  if (parsed.data.size > MAX_PORTFOLIO_ARCHIVE_BYTES) {
    res.status(413).json({ error: "Archive exceeds the 50 MB limit" });
    return;
  }
  if (!parsed.data.filename.toLowerCase().endsWith(".zip")) {
    res.status(415).json({ error: "Only ZIP archives are supported" });
    return;
  }
  if (!(await ownedApp(userId, params.data.appId))) {
    res.status(404).json({ error: "App not found" });
    return;
  }

  const [existing] = await db
    .select()
    .from(venomPortfolioImportJobsTable)
    .where(
      and(
        eq(venomPortfolioImportJobsTable.clerkUserId, userId),
        eq(
          venomPortfolioImportJobsTable.idempotencyKey,
          parsed.data.idempotencyKey,
        ),
      ),
    )
    .limit(1);
  if (existing) {
    if (
      existing.appId !== params.data.appId ||
      existing.archiveFilename !== parsed.data.filename ||
      existing.declaredBytes !== parsed.data.size ||
      (existing.status !== "awaiting_upload" && existing.status !== "uploading")
    ) {
      res.status(409).json({ error: "Idempotency key is already in use" });
      return;
    }
    res.status(201).json(
      CreateVenomAppImportResponse.parse({
        job: jobPayload(existing),
        uploadUrl: await createArchiveUploadUrl(existing.uploadObjectPath),
        maxBytes: MAX_PORTFOLIO_ARCHIVE_BYTES,
        requiredContentType: "application/zip",
      }),
    );
    return;
  }

  const importJobId = randomUUID();
  const uploadObjectPath = createUploadObjectPath(
    params.data.appId,
    importJobId,
  );
  const now = new Date();
  const [job] = await db
    .insert(venomPortfolioImportJobsTable)
    .values({
      id: importJobId,
      appId: params.data.appId,
      clerkUserId: userId,
      idempotencyKey: parsed.data.idempotencyKey,
      archiveFilename: parsed.data.filename,
      declaredBytes: parsed.data.size,
      uploadObjectPath,
      status: "awaiting_upload",
      progress: 0,
    })
    .returning();
  await db
    .update(venomPortfolioAppsTable)
    .set({
      status: "importing",
      latestImportStatus: "awaiting_upload",
      updatedAt: now,
    })
    .where(
      and(
        eq(venomPortfolioAppsTable.id, params.data.appId),
        eq(venomPortfolioAppsTable.clerkUserId, userId),
      ),
    );
  req.log.info(
    { appId: params.data.appId, importJobId: job.id },
    "Portfolio import created",
  );
  res.status(201).json(
    CreateVenomAppImportResponse.parse({
      job: jobPayload(job),
      uploadUrl: await createArchiveUploadUrl(uploadObjectPath),
      maxBytes: MAX_PORTFOLIO_ARCHIVE_BYTES,
      requiredContentType: "application/zip",
    }),
  );
});

router.get(
  "/venom/apps/:appId/imports/:importJobId",
  async (req, res): Promise<void> => {
    const userId = userIdFor(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const params = GetVenomAppImportParams.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "Import not found" });
      return;
    }
    const job = await importJob(
      userId,
      params.data.appId,
      params.data.importJobId,
    );
    if (!job) {
      res.status(404).json({ error: "Import not found" });
      return;
    }
    await recoverStaleImportJobs(userId, [job]);
    res.json(GetVenomAppImportResponse.parse(jobPayload(job)));
  },
);

router.post(
  "/venom/apps/:appId/imports/:importJobId/complete",
  async (req, res): Promise<void> => {
    const userId = userIdFor(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const params = CompleteVenomAppImportUploadParams.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "Import not found" });
      return;
    }
    const job = await importJob(
      userId,
      params.data.appId,
      params.data.importJobId,
    );
    if (!job) {
      res.status(404).json({ error: "Import not found" });
      return;
    }
    if (job.status !== "awaiting_upload" && job.status !== "uploading") {
      res.status(409).json({ error: "Import is not awaiting an upload" });
      return;
    }
    try {
      await objectExistsWithinLimit(job.uploadObjectPath);
    } catch {
      res.status(422).json({ error: "Uploaded archive is unavailable" });
      return;
    }
    const now = new Date();
    const [validating] = await db
      .update(venomPortfolioImportJobsTable)
      .set({ status: "validating", progress: 25, updatedAt: now })
      .where(
        and(
          eq(venomPortfolioImportJobsTable.id, job.id),
          eq(venomPortfolioImportJobsTable.clerkUserId, userId),
          inArray(venomPortfolioImportJobsTable.status, [
            "awaiting_upload",
            "uploading",
          ]),
        ),
      )
      .returning();
    if (!validating) {
      res.status(409).json({ error: "Import is already being processed" });
      return;
    }
    await db
      .update(venomPortfolioAppsTable)
      .set({ latestImportStatus: "validating", updatedAt: now })
      .where(
        and(
          eq(venomPortfolioAppsTable.id, job.appId),
          eq(venomPortfolioAppsTable.clerkUserId, userId),
        ),
      );
    setImmediate(() => {
      void processImportJob(userId, job.appId, job.id);
    });
    res
      .status(202)
      .json(
        CompleteVenomAppImportUploadResponse.parse(jobPayload(validating)),
      );
  },
);

router.post(
  "/venom/apps/:appId/imports/:importJobId/retry",
  async (req, res): Promise<void> => {
    const userId = userIdFor(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const params = RetryVenomAppImportParams.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "Import not found" });
      return;
    }
    const job = await importJob(
      userId,
      params.data.appId,
      params.data.importJobId,
    );
    if (!job) {
      res.status(404).json({ error: "Import not found" });
      return;
    }
    if (job.status !== "failed") {
      res.status(409).json({ error: "Only failed imports can be retried" });
      return;
    }
    await deletePrivateObject(job.uploadObjectPath).catch(() => undefined);
    const uploadObjectPath = createUploadObjectPath(job.appId, job.id);
    const now = new Date();
    const [retried] = await db
      .update(venomPortfolioImportJobsTable)
      .set({
        uploadObjectPath,
        status: "awaiting_upload",
        progress: 0,
        failureCode: null,
        failureMessage: null,
        sourceVersionId: null,
        completedAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(venomPortfolioImportJobsTable.id, job.id),
          eq(venomPortfolioImportJobsTable.clerkUserId, userId),
        ),
      )
      .returning();
    await db
      .update(venomPortfolioAppsTable)
      .set({
        status: "importing",
        latestImportStatus: "awaiting_upload",
        updatedAt: now,
      })
      .where(
        and(
          eq(venomPortfolioAppsTable.id, job.appId),
          eq(venomPortfolioAppsTable.clerkUserId, userId),
        ),
      );
    res.json(
      RetryVenomAppImportResponse.parse({
        job: jobPayload(retried),
        uploadUrl: await createArchiveUploadUrl(uploadObjectPath),
        maxBytes: MAX_PORTFOLIO_ARCHIVE_BYTES,
        requiredContentType: "application/zip",
      }),
    );
  },
);

export default router;