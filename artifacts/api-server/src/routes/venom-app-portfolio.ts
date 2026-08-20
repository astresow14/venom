import { randomUUID } from "node:crypto";
import { getAuth } from "@clerk/express";
import {
  CompleteVenomAppImportUploadParams,
  CompleteVenomAppImportUploadResponse,
  CreateVenomAppBody,
  CreateVenomAppImportBody,
  CreateVenomAppImportParams,
  CreateVenomAppImportResponse,
  CreateVenomAppResponse,
  DeleteVenomAppParams,
  GetVenomAppImportParams,
  GetVenomAppImportResponse,
  GetVenomAppParams,
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
  venomPortfolioAppsTable,
  venomPortfolioDeploymentLinksTable,
  venomPortfolioImportJobsTable,
  venomPortfolioSourceConnectionsTable,
  venomPortfolioSourceVersionsTable,
  type VenomPortfolioApp,
  type VenomPortfolioImportJob,
  type VenomPortfolioSourceVersion,
} from "@workspace/db";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { Router, type IRouter, type Request } from "express";
import { logger } from "../lib/logger";
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

const router: IRouter = Router();
const STALE_IMPORT_AFTER_MS = 5 * 60 * 1_000;

function userIdFor(request: Request): string | null {
  return getAuth(request).userId;
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

function appPayload(app: VenomPortfolioApp, deploymentUrl: string | null) {
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
    createdAt: app.createdAt.toISOString(),
    updatedAt: app.updatedAt.toISOString(),
  };
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
  const deployments = await primaryDeploymentUrls(
    userId,
    apps.map((app) => app.id),
  );
  res.json(
    ListVenomAppsResponse.parse(
      apps.map((app) => appPayload(app, deployments.get(app.id) ?? null)),
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
    .json(CreateVenomAppResponse.parse(appPayload(app, deploymentUrl ?? null)));
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
  const [versions, jobs, links] = await Promise.all([
    db
      .select()
      .from(venomPortfolioSourceVersionsTable)
      .where(
        and(
          eq(venomPortfolioSourceVersionsTable.appId, app.id),
          eq(venomPortfolioSourceVersionsTable.clerkUserId, userId),
        ),
      )
      .orderBy(desc(venomPortfolioSourceVersionsTable.versionNumber))
      .limit(500),
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
  ]);
  const primary = links.find((link) => link.isPrimary)?.url ?? null;
  await recoverStaleImportJobs(userId, jobs);
  res.json(
    GetVenomAppResponse.parse({
      app: appPayload(app, primary),
      versions: versions.map(versionPayload),
      importJobs: jobs.map(jobPayload),
      deploymentLinks: links.map((link) => ({
        id: link.id,
        label: link.label,
        url: link.url,
        isPrimary: link.isPrimary,
        createdAt: link.createdAt.toISOString(),
      })),
    }),
  );
});

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
  const deployments = await primaryDeploymentUrls(userId, [updated.id]);
  res.json(
    UpdateVenomAppResponse.parse(
      appPayload(updated, deployments.get(updated.id) ?? null),
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