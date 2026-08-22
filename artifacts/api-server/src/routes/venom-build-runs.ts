import { getAuth } from "@clerk/express";
import {
  ApproveVenomBuildRunBody,
  ApproveVenomBuildRunParams,
  ApproveVenomBuildRunResponse,
  CancelVenomBuildRunBody,
  CancelVenomBuildRunParams,
  CancelVenomBuildRunResponse,
  CreateVenomBuildRunBody,
  CreateVenomBuildRunResponse,
  ExportVenomBuildRunParams,
  ExportVenomBuildRunResponse,
  GetVenomBuildRunParams,
  GetVenomBuildRunResponse,
  ListVenomBuildRunsQueryParams,
  ListVenomBuildRunsResponse,
  RejectVenomBuildRunBody,
  RejectVenomBuildRunParams,
  RejectVenomBuildRunResponse,
  RetryVenomBuildRunParams,
  RetryVenomBuildRunResponse,
  ReviseVenomBuildRunBody,
  ReviseVenomBuildRunParams,
  ReviseVenomBuildRunResponse,
  type VenomBuildPackage,
  type VenomBuildSourceReference,
  type VenomBuildSopReference,
  type VenomBuildTargetType,
} from "@workspace/api-zod";
import {
  db,
  venomBuildPackageRevisionsTable,
  venomBuildRunEventsTable,
  venomBuildRunsTable,
  venomBuildTemplatesTable,
  venomPortfolioAppIterationsTable,
  venomPortfolioAppsTable,
  venomPortfolioSourceVersionsTable,
  venomSopRevisionsTable,
  type VenomBuildPackageRevision,
  type VenomBuildRun,
  type VenomBuildRunEvent,
} from "@workspace/db";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { Router, type IRouter, type Request } from "express";
import {
  buildPackageChecksum,
  buildPackageMarkdown,
  generateBuildPackage,
} from "../lib/venom-build-package-generator";
import { userTenant } from "../lib/venom-master-ontology";
import {
  contributeTemplateEditSignals,
  deriveTemplateEditSignals,
  getTemplateGuidance,
  type TemplateGuidanceEntry,
} from "../lib/venom-template-learning";
import { recordVenomUsage } from "../lib/venom-usage-store";
import {
  allowanceBlockedBody,
  checkVenomAllowance,
  releaseVenomAllowanceReservation,
} from "../lib/venom-billing-enforcement";
import { logger } from "../lib/logger";

const router: IRouter = Router();
const MAX_ACTIVE_RUNS_PER_ACCOUNT = 2;
const MAX_ATTEMPTS = 5;
const GENERATION_TIMEOUT_MS = 75_000;
const STALE_PREPARING_AFTER_MS = 3 * 60_000;
const WORKER_RECONCILE_INTERVAL_MS = 10_000;
// Reconciliation exists to rescue orphaned work (e.g. after a server restart),
// not to double-schedule runs that were just created: fresh runs are already
// scheduled in-process at creation time. The grace period also keeps a worker
// in one process (the dev server) from claiming rows another process (an
// integration test sharing the same database) created moments ago.
const QUEUE_RESCUE_MIN_AGE_MS = 2 * 60_000;
const activeGenerationControllers = new Map<string, AbortController>();
let workerReconcileTimer: ReturnType<typeof setInterval> | null = null;

class PinnedReferenceError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "PinnedReferenceError";
  }
}

/**
 * Thrown when an app-iteration run's pinned baseline package can no longer be
 * resolved. Raised before any generation happens so an unresolvable baseline
 * fails clearly instead of silently producing a from-scratch package.
 */
class BaselineUnresolvableError extends Error {
  constructor() {
    super("baseline_unresolvable");
    this.name = "BaselineUnresolvableError";
  }
}

/**
 * Bounded projection of a baseline package passed to the generator so the
 * reference bundle stays within its context limit.
 */
function compactBaselinePackage(packageData: VenomBuildPackage) {
  return {
    title: packageData.title,
    targetType: packageData.targetType,
    productBrief: {
      summary: packageData.productBrief.summary.slice(0, 1500),
      audience: packageData.productBrief.audience.slice(0, 8),
      outcomes: packageData.productBrief.outcomes.slice(0, 10),
    },
    functionalScope: packageData.functionalScope.slice(0, 25),
    brandDirection: packageData.brandDirection.slice(0, 12),
    contentRequirements: packageData.contentRequirements.slice(0, 12),
    serviceFlowRequirements: packageData.serviceFlowRequirements.slice(0, 12),
    dataNeeds: packageData.dataNeeds.slice(0, 12),
    integrationNeeds: packageData.integrationNeeds.slice(0, 12),
    acceptanceChecks: packageData.acceptanceChecks.slice(0, 15),
    launchConstraints: packageData.launchConstraints.slice(0, 10),
  };
}

let resolveBuildRunUserId = (request: Request): string | null =>
  getAuth(request).userId;

function userIdFor(request: Request): string | null {
  return resolveBuildRunUserId(request);
}

export function overrideVenomBuildRunUserIdResolverForTests(
  resolver: (request: Request) => string | null,
): () => void {
  const previous = resolveBuildRunUserId;
  resolveBuildRunUserId = resolver;
  return () => {
    resolveBuildRunUserId = previous;
  };
}

export function overrideVenomBuildRunSchedulerForTests(
  scheduler: (userId: string, runId: string) => void,
): () => void {
  const previous = scheduleRunEffect;
  scheduleRunEffect = scheduler;
  return () => {
    scheduleRunEffect = previous;
  };
}

// Injectable generator so integration tests can drive the full
// process → review → approve chain hermetically (no provider call).
let generatePackageEffect = generateBuildPackage;

export function overrideVenomBuildRunGeneratorForTests(
  generator: typeof generateBuildPackage,
): () => void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Build run generator overrides are available only in tests");
  }
  const previous = generatePackageEffect;
  generatePackageEffect = generator;
  return () => {
    generatePackageEffect = previous;
  };
}

function summaryPayload(run: VenomBuildRun) {
  return {
    id: run.id,
    correlationId: run.correlationId,
    appId: run.appId,
    runKind: run.runKind,
    targetType: run.targetType,
    targetName: run.targetName,
    status: run.status,
    progress: run.progress,
    currentRevisionNumber: run.currentRevisionNumber,
    approvedRevisionId: run.approvedRevisionId,
    templateId: run.templateId,
    failureMessage: run.failureMessage,
    cancelledReason: run.cancelledReason,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

function revisionPayload(revision: VenomBuildPackageRevision) {
  return {
    id: revision.id,
    revisionNumber: revision.revisionNumber,
    reason: revision.reason,
    package: revision.package,
    checksumSha256: revision.checksumSha256,
    createdAt: revision.createdAt,
    approvedAt: revision.approvedAt,
  };
}

function eventPayload(event: VenomBuildRunEvent) {
  return {
    id: event.id,
    eventType: event.eventType,
    status: event.status,
    progress: event.progress,
    message: event.message,
    createdAt: event.createdAt,
  };
}

async function ownedRun(userId: string, runId: string) {
  const [run] = await db
    .select()
    .from(venomBuildRunsTable)
    .where(
      and(
        eq(venomBuildRunsTable.id, runId),
        eq(venomBuildRunsTable.clerkUserId, userId),
      ),
    )
    .limit(1);
  return run;
}

export async function runPayload(run: VenomBuildRun) {
  const [revisions, events] = await Promise.all([
    db
      .select()
      .from(venomBuildPackageRevisionsTable)
      .where(
        and(
          eq(venomBuildPackageRevisionsTable.runId, run.id),
          eq(venomBuildPackageRevisionsTable.clerkUserId, run.clerkUserId),
        ),
      )
      .orderBy(desc(venomBuildPackageRevisionsTable.revisionNumber))
      .limit(50),
    db
      .select()
      .from(venomBuildRunEventsTable)
      .where(
        and(
          eq(venomBuildRunEventsTable.runId, run.id),
          eq(venomBuildRunEventsTable.clerkUserId, run.clerkUserId),
        ),
      )
      .orderBy(desc(venomBuildRunEventsTable.createdAt))
      .limit(200),
  ]);
  return {
    ...summaryPayload(run),
    request: {
      targetType: run.targetType,
      targetName: run.targetName,
      requirements: run.requirements,
      constraints: run.constraints,
      brandDirection: run.brandDirection,
      appId: run.appId,
      sourceVersionId: run.sourceVersionId,
      projectId: run.projectId,
      sopRevisionIds: run.sopRevisionIds,
      baselineIterationId: run.baselineIterationId,
      baselineRevisionId: run.baselineRevisionId,
      changesSummary: run.changesSummary,
      templateId: run.templateId,
    },
    revisions: revisions.map(revisionPayload),
    events: events.map(eventPayload),
    attempt: run.attempt,
    failureCode: run.failureCode,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
  };
}

async function addEvent(
  run: Pick<VenomBuildRun, "id" | "clerkUserId">,
  eventType: string,
  status: string,
  progress: number,
  message: string,
): Promise<void> {
  await db.insert(venomBuildRunEventsTable).values({
    runId: run.id,
    clerkUserId: run.clerkUserId,
    eventType,
    status,
    progress,
    message,
  });
}

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Registers an approved, app-pinned package as the next immutable version of
 * that same app — never a new sibling app. Runs inside the approval
 * transaction so approval and version registration are atomic. The per-app
 * advisory lock is always taken after the run-id lock the approve route
 * already holds, keeping lock order consistent for the only path that takes
 * both.
 */
async function registerAppIterationInTransaction(
  transaction: DbTransaction,
  userId: string,
  run: VenomBuildRun,
  revision: VenomBuildPackageRevision,
): Promise<void> {
  if (!run.appId) return;
  await transaction.execute(
    sql`select pg_advisory_xact_lock(hashtext(${"venom-app-iterations:" + run.appId}))`,
  );
  const [app] = await transaction
    .select({ id: venomPortfolioAppsTable.id })
    .from(venomPortfolioAppsTable)
    .where(
      and(
        eq(venomPortfolioAppsTable.id, run.appId),
        eq(venomPortfolioAppsTable.clerkUserId, userId),
      ),
    )
    .limit(1);
  if (!app) {
    logger.warn(
      {
        operation: "venom_app_iteration_register",
        runId: run.id,
        appId: run.appId,
      },
      "Approved run is pinned to an app that no longer exists; no version registered",
    );
    return;
  }
  const [alreadyRegistered] = await transaction
    .select({ id: venomPortfolioAppIterationsTable.id })
    .from(venomPortfolioAppIterationsTable)
    .where(
      and(
        eq(venomPortfolioAppIterationsTable.buildRunId, run.id),
        eq(venomPortfolioAppIterationsTable.clerkUserId, userId),
      ),
    )
    .limit(1);
  if (alreadyRegistered) return;
  const [latest] = await transaction
    .select({
      iterationNumber: venomPortfolioAppIterationsTable.iterationNumber,
    })
    .from(venomPortfolioAppIterationsTable)
    .where(
      and(
        eq(venomPortfolioAppIterationsTable.appId, run.appId),
        eq(venomPortfolioAppIterationsTable.clerkUserId, userId),
      ),
    )
    .orderBy(desc(venomPortfolioAppIterationsTable.iterationNumber))
    .limit(1);
  const reason =
    run.runKind === "app_iteration"
      ? `Improvement iteration requested by the owner: ${run.requirements}`
      : `Approved build package: ${revision.package.title}`;
  await transaction.insert(venomPortfolioAppIterationsTable).values({
    appId: run.appId,
    clerkUserId: userId,
    iterationNumber: (latest?.iterationNumber ?? 0) + 1,
    buildRunId: run.id,
    revisionId: revision.id,
    packageTitle: revision.package.title.slice(0, 160),
    packageChecksum: revision.checksumSha256,
    runKind: run.runKind,
    baselineIterationId: run.baselineIterationId,
    baselineRevisionId: run.baselineRevisionId,
    // Template lineage survives approval: the run's stamp carries into the
    // durable iteration record so the learning loop can trace every
    // approved version back to the template it started from.
    templateId: run.templateId,
    reason: reason.slice(0, 1000),
    changesSummary: run.changesSummary,
    createdBy: userId,
  });
}

function runMatchesCreateInput(
  existing: VenomBuildRun,
  input: {
    targetType: string;
    targetName: string;
    requirements: string;
    constraints: string;
    brandDirection: string;
    appId: string | null;
    sourceVersionId: string | null;
    projectId: string | null;
    sopRevisionIds: string[];
    templateId?: string | null;
  },
): boolean {
  return (
    existing.targetType === input.targetType &&
    existing.targetName === input.targetName.trim() &&
    existing.requirements === input.requirements.trim() &&
    existing.constraints === input.constraints.trim() &&
    existing.brandDirection === input.brandDirection.trim() &&
    existing.appId === input.appId &&
    (!input.sourceVersionId ||
      existing.sourceVersionId === input.sourceVersionId) &&
    existing.projectId === input.projectId &&
    JSON.stringify(existing.sopRevisionIds) ===
      JSON.stringify(input.sopRevisionIds) &&
    // Lineage is compared only when the client asserted it AND the run is
    // not app-pinned: for app-pinned runs the app's own lineage is
    // authoritative, so the stamped value may legitimately differ from
    // what the client sent.
    (input.templateId == null ||
      existing.appId !== null ||
      existing.templateId === input.templateId)
  );
}

async function resolveInputReferences(
  userId: string,
  input: {
    appId: string | null;
    sourceVersionId: string | null;
    sopRevisionIds: string[];
  },
) {
  let app: typeof venomPortfolioAppsTable.$inferSelect | null = null;
  let sourceVersion:
    | typeof venomPortfolioSourceVersionsTable.$inferSelect
    | null = null;
  if (input.appId) {
    [app] = await db
      .select()
      .from(venomPortfolioAppsTable)
      .where(
        and(
          eq(venomPortfolioAppsTable.id, input.appId),
          eq(venomPortfolioAppsTable.clerkUserId, userId),
        ),
      )
      .limit(1);
    if (!app) throw new PinnedReferenceError("source_app_not_found");
    if (input.sourceVersionId) {
      [sourceVersion] = await db
        .select()
        .from(venomPortfolioSourceVersionsTable)
        .where(
          and(
            eq(venomPortfolioSourceVersionsTable.id, input.sourceVersionId),
            eq(venomPortfolioSourceVersionsTable.appId, app.id),
            eq(venomPortfolioSourceVersionsTable.clerkUserId, userId),
          ),
        )
        .limit(1);
      if (!sourceVersion) {
        throw new PinnedReferenceError("source_version_not_found");
      }
    } else if (app.currentSourceVersion > 0) {
      [sourceVersion] = await db
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
    }
  } else if (input.sourceVersionId) {
    throw new PinnedReferenceError("source_app_required");
  }

  const sopRevisions =
    input.sopRevisionIds.length === 0
      ? []
      : await db
          .select()
          .from(venomSopRevisionsTable)
          .where(
            and(
              eq(venomSopRevisionsTable.clerkUserId, userId),
              inArray(venomSopRevisionsTable.id, input.sopRevisionIds),
            ),
          );
  if (sopRevisions.length !== input.sopRevisionIds.length) {
    throw new PinnedReferenceError("sop_revision_not_found");
  }
  const revisionById = new Map(sopRevisions.map((revision) => [revision.id, revision]));
  return {
    app,
    sourceVersion,
    sopRevisions: input.sopRevisionIds.map((id) => revisionById.get(id)!),
  };
}

async function failStalePreparingRuns(userId?: string): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_PREPARING_AFTER_MS);
  const staleCondition = userId
    ? and(
        eq(venomBuildRunsTable.clerkUserId, userId),
        eq(venomBuildRunsTable.status, "preparing"),
        lt(venomBuildRunsTable.updatedAt, cutoff),
      )
    : and(
        eq(venomBuildRunsTable.status, "preparing"),
        lt(venomBuildRunsTable.updatedAt, cutoff),
      );
  const stale = await db
    .update(venomBuildRunsTable)
    .set({
      status: "failed",
      progress: 100,
      failureCode: "generation_interrupted",
      failureMessage:
        "Generation was interrupted before a package was saved. Retry this run.",
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(staleCondition)
    .returning();
  await Promise.all(
    stale.map((run) =>
      addEvent(
        run,
        "failed",
        "failed",
        100,
        "Generation was interrupted and is safe to retry.",
      ),
    ),
  );
}

async function processRun(userId: string, runId: string): Promise<void> {
  const startedAtMs = Date.now();
  const [run] = await db
    .update(venomBuildRunsTable)
    .set({
      status: "preparing",
      progress: 20,
      failureCode: null,
      failureMessage: null,
      cancelledReason: null,
      startedAt: new Date(),
      completedAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(venomBuildRunsTable.id, runId),
        eq(venomBuildRunsTable.clerkUserId, userId),
        eq(venomBuildRunsTable.status, "queued"),
      ),
    )
    .returning();
  if (!run) return;

  // The run row carries the allowance hold that admitted it. The first
  // ledgered usage event settles the hold (spend row in, hold out, under
  // the payer lock); every other outcome — generator failure, timeout,
  // cancel mid-flight, commit conflict — releases it in the finally
  // below. A cancel that wins the queued→cancelled race means no
  // processor ever claims the run, and the age reaper frees its hold.
  let pendingReservationId = run.reservationId ?? null;
  const claimReservation = (): string | null => {
    const reservationId = pendingReservationId;
    pendingReservationId = null;
    return reservationId;
  };

  await addEvent(
    run,
    "preparing",
    "preparing",
    20,
    "Authorized references are being assembled.",
  );
  const controller = new AbortController();
  activeGenerationControllers.set(run.id, controller);
  const timeout = setTimeout(() => controller.abort(), GENERATION_TIMEOUT_MS);

  try {
    const references = await resolveInputReferences(userId, {
      appId: run.appId,
      sourceVersionId: run.sourceVersionId,
      sopRevisionIds: run.sopRevisionIds,
    });
    // App iterations must start from a known, resolvable baseline. This runs
    // before any generation so a lost baseline fails clearly rather than
    // silently producing a from-scratch package.
    let baselineContext: {
      packageTitle: string;
      changesSummary: string | null;
      baselinePackage: unknown;
    } | null = null;
    if (run.runKind === "app_iteration") {
      if (!run.baselineRevisionId) throw new BaselineUnresolvableError();
      const [baselineRevision] = await db
        .select()
        .from(venomBuildPackageRevisionsTable)
        .where(
          and(
            eq(venomBuildPackageRevisionsTable.id, run.baselineRevisionId),
            eq(venomBuildPackageRevisionsTable.clerkUserId, userId),
          ),
        )
        .limit(1);
      if (!baselineRevision) throw new BaselineUnresolvableError();
      baselineContext = {
        packageTitle: baselineRevision.package.title,
        changesSummary: run.changesSummary,
        baselinePackage: compactBaselinePackage(baselineRevision.package),
      };
    }
    // Template-derived runs promise the generator the template's curated
    // material as bounded, untrusted reference data. Lineage must resolve:
    // a stamped template that has vanished fails the run explicitly (same
    // pinned-reference discipline as sources and SOPs) rather than
    // silently generating without the promised context.
    let templateContext: {
      name: string;
      category: string;
      description: string;
      requirementsSkeleton: string;
      suggestedConstraints: string;
      suggestedBrandDirection: string;
      suggestedAcceptanceChecks: string[];
      examplePackage: unknown;
      networkGuidance: string[];
    } | null = null;
    if (run.templateId) {
      const [template] = await db
        .select()
        .from(venomBuildTemplatesTable)
        .where(eq(venomBuildTemplatesTable.id, run.templateId))
        .limit(1);
      if (!template) throw new PinnedReferenceError("template_not_found");
      // Above-threshold lessons from other builders' edits to this
      // template's packages. Read failures fail toward no influence — the
      // run proceeds exactly as if the template had learned nothing.
      let appliedGuidance: TemplateGuidanceEntry[] = [];
      try {
        appliedGuidance = await getTemplateGuidance(run.templateId);
      } catch {
        appliedGuidance = [];
      }
      templateContext = {
        name: template.name.slice(0, 120),
        category: template.category,
        description: template.description.slice(0, 1000),
        requirementsSkeleton: template.requirements.slice(0, 8000),
        suggestedConstraints: template.constraints.slice(0, 4000),
        suggestedBrandDirection: template.brandDirection.slice(0, 3000),
        suggestedAcceptanceChecks: template.acceptanceChecks
          .slice(0, 15)
          .map((check) => check.slice(0, 800)),
        examplePackage: template.examplePackage
          ? compactBaselinePackage(template.examplePackage)
          : null,
        networkGuidance: appliedGuidance.map((entry) => entry.guidance),
      };
      if (appliedGuidance.length > 0) {
        // Recorded before the generator call so it is observable per
        // generation attempt which guidance that attempt saw.
        await addEvent(
          run,
          "network_guidance",
          "preparing",
          25,
          `Applied ${appliedGuidance.length} network lesson${
            appliedGuidance.length === 1 ? "" : "s"
          } from this template's builders: ${appliedGuidance
            .map((entry) => entry.title)
            .join("; ")}.`.slice(0, 240),
        );
      }
    }
    const sourceReferences: VenomBuildSourceReference[] =
      references.app && references.sourceVersion
        ? [
            {
              appId: references.app.id,
              appName: references.app.name,
              sourceVersionId: references.sourceVersion.id,
              versionNumber: references.sourceVersion.versionNumber,
              checksumSha256: references.sourceVersion.checksumSha256,
            },
          ]
        : [];
    const sopReferences: VenomBuildSopReference[] = references.sopRevisions.map(
      (revision) => ({
        sopId: revision.sopId,
        revisionId: revision.id,
        revisionNumber: revision.versionNumber,
        title: revision.title,
        checksumSha256: revision.checksumSha256,
      }),
    );
    const [previousRevision] = await db
      .select()
      .from(venomBuildPackageRevisionsTable)
      .where(
        and(
          eq(venomBuildPackageRevisionsTable.runId, run.id),
          eq(venomBuildPackageRevisionsTable.clerkUserId, userId),
        ),
      )
      .orderBy(desc(venomBuildPackageRevisionsTable.revisionNumber))
      .limit(1);
    const generated = await generatePackageEffect(
      {
        targetType: run.targetType,
        targetName: run.targetName,
        requirements: run.requirements,
        constraints: run.constraints,
        brandDirection: run.brandDirection,
        sourceReferences,
        sopReferences,
        sourceContext:
          references.app && references.sourceVersion
            ? [
                {
                  app: {
                    id: references.app.id,
                    name: references.app.name,
                    purpose: references.app.purpose,
                    brand: references.app.brand,
                    detectedStack: references.app.detectedStack,
                  },
                  immutableVersion: {
                    id: references.sourceVersion.id,
                    versionNumber: references.sourceVersion.versionNumber,
                    checksumSha256: references.sourceVersion.checksumSha256,
                    manifest: references.sourceVersion.manifest,
                  },
                },
              ]
            : [],
        sopContext: references.sopRevisions.map((revision) => ({
          id: revision.id,
          sopId: revision.sopId,
          versionNumber: revision.versionNumber,
          checksumSha256: revision.checksumSha256,
          title: revision.title,
          category: revision.category,
          content: revision.content,
        })),
        revisionInstruction: run.pendingRevisionInstruction,
        previousPackage: previousRevision?.package ?? null,
        baselineContext,
        templateContext,
      },
      controller.signal,
      // Package generation is a user-initiated AI call: charge the account
      // that owns the run (SKU billed under the venom-gpt alias). The
      // first event also settles the run's admission hold atomically.
      (usage) =>
        recordVenomUsage({
          userId,
          modelAlias: "venom-gpt",
          callKind: "build_package",
          promptTokens: usage.promptTokens,
          outputTokens: usage.outputTokens,
          estimated: usage.estimated,
          reservationId: claimReservation(),
        }),
    );
    const checksumSha256 = buildPackageChecksum(generated);
    const completedAt = new Date();
    const revisionNumber = run.currentRevisionNumber + 1;
    const reason =
      run.pendingRevisionInstruction?.trim() ||
      (revisionNumber === 1 ? "Initial generated package" : "Regenerated package");

    const committed = await db.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtext(${run.id}))`,
      );
      const [current] = await transaction
        .select()
        .from(venomBuildRunsTable)
        .where(
          and(
            eq(venomBuildRunsTable.id, run.id),
            eq(venomBuildRunsTable.clerkUserId, userId),
          ),
        )
        .limit(1);
      if (!current || current.status !== "preparing") return null;
      const nextRevisionNumber = current.currentRevisionNumber + 1;
      const [revision] = await transaction
        .insert(venomBuildPackageRevisionsTable)
        .values({
          runId: run.id,
          clerkUserId: userId,
          revisionNumber: nextRevisionNumber,
          reason: reason.slice(0, 1000),
          package: generated,
          checksumSha256,
          // Lineage rides every committed revision so the learning loop
          // can attribute generated packages to their template.
          templateId: run.templateId,
        })
        .returning();
      const [updated] = await transaction
        .update(venomBuildRunsTable)
        .set({
          status: "review_required",
          progress: 100,
          currentRevisionNumber: nextRevisionNumber,
          pendingRevisionInstruction: null,
          completedAt,
          updatedAt: completedAt,
        })
        .where(
          and(
            eq(venomBuildRunsTable.id, run.id),
            eq(venomBuildRunsTable.clerkUserId, userId),
            eq(venomBuildRunsTable.status, "preparing"),
          ),
        )
        .returning();
      if (!updated) return null;
      await transaction.insert(venomBuildRunEventsTable).values({
        runId: run.id,
        clerkUserId: userId,
        eventType: nextRevisionNumber === 1 ? "review_required" : "revised",
        status: "review_required",
        progress: 100,
        message:
          nextRevisionNumber === 1
            ? "Package is ready for human review."
            : `Revision ${nextRevisionNumber} is ready for human review.`,
      });
      return revision;
    });
    if (!committed) return;
    logger.info(
      {
        operation: "venom_build_generation",
        runId: run.id,
        correlationId: run.correlationId,
        revisionNumber,
        durationMs: Date.now() - startedAtMs,
        status: "review_required",
      },
      "Build package generation completed",
    );
  } catch (error) {
    const current = await ownedRun(userId, run.id);
    if (!current || current.status === "cancelled") return;
    const timedOut = controller.signal.aborted;
    const pinnedReferenceUnavailable = error instanceof PinnedReferenceError;
    const baselineUnresolvable = error instanceof BaselineUnresolvableError;
    const failureCode = timedOut
      ? "generation_timeout"
      : baselineUnresolvable
        ? "baseline_unresolvable"
        : pinnedReferenceUnavailable
          ? "pinned_reference_unavailable"
          : "generation_failed";
    const failureMessage = timedOut
      ? "Generation timed out before a package was saved. Retry this run."
      : baselineUnresolvable
        ? "The baseline package this iteration builds on can no longer be resolved. Approve a new build for this app to set a fresh baseline."
        : pinnedReferenceUnavailable
          ? "A source or SOP revision pinned to this run is no longer available. The saved request was preserved."
          : "The package could not be validated and saved. Retry this run.";
    const [failed] = await db
      .update(venomBuildRunsTable)
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
          eq(venomBuildRunsTable.id, run.id),
          eq(venomBuildRunsTable.clerkUserId, userId),
          eq(venomBuildRunsTable.status, "preparing"),
        ),
      )
      .returning();
    if (failed) {
      await addEvent(
        failed,
        "failed",
        "failed",
        100,
        timedOut
          ? "Generation timed out and is safe to retry."
          : baselineUnresolvable
            ? "Iteration stopped because its pinned baseline package could not be resolved."
            : pinnedReferenceUnavailable
              ? "Generation stopped because a pinned reference is unavailable."
              : "Generation failed validation and is safe to retry.",
      );
    }
    logger.error(
      {
        operation: "venom_build_generation",
        runId: run.id,
        correlationId: run.correlationId,
        errorName: error instanceof Error ? error.name : "UnknownError",
        durationMs: Date.now() - startedAtMs,
        status: timedOut ? "timeout" : failureCode,
      },
      "Build package generation failed",
    );
  } finally {
    clearTimeout(timeout);
    if (activeGenerationControllers.get(run.id) === controller) {
      activeGenerationControllers.delete(run.id);
    }
    // Whatever ended this run, an unsettled admission hold must not
    // linger against the payer's allowance.
    const unsettled = claimReservation();
    if (unsettled) void releaseVenomAllowanceReservation(unsettled);
  }
}

function scheduleRun(userId: string, runId: string): void {
  setImmediate(() => {
    void processRun(userId, runId);
  });
}

let scheduleRunEffect = scheduleRun;

async function reconcileBuildRunQueue(
  userId?: string,
  now: number = Date.now(),
): Promise<void> {
  await failStalePreparingRuns(userId);
  const rescueCutoff = new Date(now - QUEUE_RESCUE_MIN_AGE_MS);
  const queued = await db
    .select({
      id: venomBuildRunsTable.id,
      clerkUserId: venomBuildRunsTable.clerkUserId,
    })
    .from(venomBuildRunsTable)
    .where(
      userId
        ? and(
            eq(venomBuildRunsTable.clerkUserId, userId),
            eq(venomBuildRunsTable.status, "queued"),
            lt(venomBuildRunsTable.createdAt, rescueCutoff),
          )
        : and(
            eq(venomBuildRunsTable.status, "queued"),
            lt(venomBuildRunsTable.createdAt, rescueCutoff),
          ),
    )
    .orderBy(venomBuildRunsTable.createdAt)
    .limit(userId ? MAX_ACTIVE_RUNS_PER_ACCOUNT : 200);
  queued.forEach((run) => scheduleRunEffect(run.clerkUserId, run.id));
}

function runWorkerReconciliation(): void {
  void reconcileBuildRunQueue().catch((error) => {
    logger.error(
      {
        operation: "venom_build_worker_reconcile",
        errorName: error instanceof Error ? error.name : "UnknownError",
      },
      "Build package worker reconciliation failed",
    );
  });
}

export function startVenomBuildRunWorker(): void {
  if (workerReconcileTimer) return;
  runWorkerReconciliation();
  workerReconcileTimer = setInterval(
    runWorkerReconciliation,
    WORKER_RECONCILE_INTERVAL_MS,
  );
  workerReconcileTimer.unref?.();
}

/**
 * `now` lets a suite prove the rescue path with a *fresh* fixture: a future
 * clock makes the row qualify as aged inside this invocation only, so the
 * fixture is never backdated into the claim window of the dev server's own
 * reconcile loop (both processes share one database).
 */
export async function reconcileVenomBuildRunQueueForTests(
  now?: number,
): Promise<void> {
  await reconcileBuildRunQueue(undefined, now);
}

export async function processVenomBuildRunForTests(
  userId: string,
  runId: string,
): Promise<void> {
  await processRun(userId, runId);
}

export type CreateVenomBuildRunInput = {
  targetType: VenomBuildTargetType;
  targetName: string;
  requirements: string;
  constraints: string;
  brandDirection: string;
  appId: string | null;
  sourceVersionId: string | null;
  projectId: string | null;
  sopRevisionIds: string[];
  /**
   * Explicit template lineage for runs started from a global template.
   * Optional so existing callers (and the iteration endpoint) are
   * untouched; when the run is pinned to an app that carries lineage, the
   * app's stamp wins over this value.
   */
  templateId?: string | null;
  idempotencyKey: string;
};

type CreateVenomBuildRunExtras = {
  runKind: "standard" | "app_iteration";
  baselineIterationId: string | null;
  baselineRevisionId: string | null;
  changesSummary: string | null;
  /** Allowance hold the created run will own (null = nothing held). */
  reservationId: string | null;
};

export type CreateVenomBuildRunOutcome =
  | { kind: "created"; run: VenomBuildRun }
  | { kind: "existing"; run: VenomBuildRun }
  | { kind: "busy" }
  | { kind: "conflict" }
  | { kind: "invalid_reference" }
  | { kind: "iteration_required" };

/**
 * Shared creation core for build runs. Used by the plain build-run endpoint
 * and by the app improvement-iteration endpoint, so idempotency, capacity
 * limits, reference pinning, and scheduling behave identically everywhere.
 */
export async function createVenomBuildRunForUser(
  userId: string,
  input: CreateVenomBuildRunInput,
  extras?: Partial<CreateVenomBuildRunExtras>,
): Promise<CreateVenomBuildRunOutcome> {
  const resolvedExtras: CreateVenomBuildRunExtras = {
    runKind: "standard",
    baselineIterationId: null,
    baselineRevisionId: null,
    changesSummary: null,
    reservationId: null,
    ...extras,
  };
  const [existing] = await db
    .select()
    .from(venomBuildRunsTable)
    .where(
      and(
        eq(venomBuildRunsTable.clerkUserId, userId),
        eq(venomBuildRunsTable.idempotencyKey, input.idempotencyKey),
      ),
    )
    .limit(1);
  if (existing) {
    return runMatchesCreateInput(existing, input)
      ? { kind: "existing", run: existing }
      : { kind: "conflict" };
  }

  let references: Awaited<ReturnType<typeof resolveInputReferences>>;
  try {
    references = await resolveInputReferences(userId, input);
  } catch {
    return { kind: "invalid_reference" };
  }
  const explicitTemplateId = input.templateId ?? null;
  if (explicitTemplateId) {
    // Lineage must point at a real template row. Retired templates remain
    // valid lineage targets (the catalog never hard-deletes), so status is
    // deliberately not checked here.
    const [template] = await db
      .select({ id: venomBuildTemplatesTable.id })
      .from(venomBuildTemplatesTable)
      .where(eq(venomBuildTemplatesTable.id, explicitTemplateId))
      .limit(1);
    if (!template) return { kind: "invalid_reference" };
  }
  // An app created from a template already carries authoritative lineage;
  // explicit input only matters for runs whose app has none (or no app).
  const templateId = references.app
    ? (references.app.templateId ?? explicitTemplateId)
    : explicitTemplateId;
  const creation = await db.transaction(async (transaction) => {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtext(${"venom-build:" + userId}))`,
    );
    const [racedExisting] = await transaction
      .select()
      .from(venomBuildRunsTable)
      .where(
        and(
          eq(venomBuildRunsTable.clerkUserId, userId),
          eq(venomBuildRunsTable.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);
    if (racedExisting) {
      return runMatchesCreateInput(racedExisting, input)
        ? { kind: "existing" as const, run: racedExisting }
        : { kind: "conflict" as const };
    }
    const [active] = await transaction
      .select({ count: sql<number>`count(*)::int` })
      .from(venomBuildRunsTable)
      .where(
        and(
          eq(venomBuildRunsTable.clerkUserId, userId),
          inArray(venomBuildRunsTable.status, ["queued", "preparing"]),
        ),
      );
    if ((active?.count ?? 0) >= MAX_ACTIVE_RUNS_PER_ACCOUNT) {
      return { kind: "busy" as const };
    }
    if (resolvedExtras.runKind === "standard" && references.app) {
      // Once an app has an approved iteration, its baseline is established.
      // Later work must flow through the iteration endpoint so every new
      // version stays pinned to a resolvable approved-package baseline —
      // a standard run here would silently restart the app from scratch.
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtext(${
          "venom-app-iterations:" + references.app.id
        }))`,
      );
      const [existingIteration] = await transaction
        .select({ id: venomPortfolioAppIterationsTable.id })
        .from(venomPortfolioAppIterationsTable)
        .where(eq(venomPortfolioAppIterationsTable.appId, references.app.id))
        .limit(1);
      if (existingIteration) {
        return { kind: "iteration_required" as const };
      }
    }
    const [createdRun] = await transaction
      .insert(venomBuildRunsTable)
      .values({
        clerkUserId: userId,
        idempotencyKey: input.idempotencyKey,
        reservationId: resolvedExtras.reservationId,
        appId: references.app?.id ?? null,
        sourceVersionId: references.sourceVersion?.id ?? null,
        projectId: input.projectId,
        targetType: input.targetType,
        targetName: input.targetName.trim(),
        requirements: input.requirements.trim(),
        constraints: input.constraints.trim(),
        brandDirection: input.brandDirection.trim(),
        sopRevisionIds: input.sopRevisionIds,
        templateId,
        runKind: resolvedExtras.runKind,
        baselineIterationId: resolvedExtras.baselineIterationId,
        baselineRevisionId: resolvedExtras.baselineRevisionId,
        changesSummary: resolvedExtras.changesSummary,
        status: "queued",
        progress: 0,
      })
      .returning();
    await transaction.insert(venomBuildRunEventsTable).values({
      runId: createdRun.id,
      clerkUserId: userId,
      eventType: "queued",
      status: "queued",
      progress: 0,
      message: "Request saved and queued for package generation.",
    });
    return { kind: "created" as const, run: createdRun };
  });
  if (creation.kind === "created") scheduleRunEffect(userId, creation.run.id);
  return creation;
}

router.get("/venom/build-runs", async (req, res): Promise<void> => {
  const userId = userIdFor(req);
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const query = ListVenomBuildRunsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: "Invalid build run query" });
    return;
  }
  void reconcileBuildRunQueue(userId);
  const appId = query.data.appId ?? undefined;
  const runs = await db
    .select()
    .from(venomBuildRunsTable)
    .where(
      appId
        ? and(
            eq(venomBuildRunsTable.clerkUserId, userId),
            eq(venomBuildRunsTable.appId, appId),
          )
        : eq(venomBuildRunsTable.clerkUserId, userId),
    )
    .orderBy(desc(venomBuildRunsTable.updatedAt))
    .limit(200);
  res.json(ListVenomBuildRunsResponse.parse(runs.map(summaryPayload)));
});

router.post("/venom/build-runs", async (req, res): Promise<void> => {
  const userId = userIdFor(req);
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const parsed = CreateVenomBuildRunBody.safeParse(req.body);
  if (!parsed.success) {
    req.log.warn(
      {
        operation: "venom_build_create",
        validationIssueCount: parsed.error.issues.length,
      },
      "Invalid build generation request",
    );
    res.status(400).json({ error: "Invalid build generation request" });
    return;
  }
  const allowance = await checkVenomAllowance({ userId, reserve: true });
  if (!allowance.allowed) {
    res.status(402).json(allowanceBlockedBody(allowance));
    return;
  }
  // The queued generation spends long after this response ends, so the
  // admission hold must outlive the request: a successful creation stores
  // it on the run row, where the processor settles it into the first
  // ledgered usage event or releases it at a terminal state (crash leaks
  // reap by age). Until that handoff this route owns the hold, and the
  // close hook — which fires on every exit path — frees it.
  let routeOwnsReservation = allowance.reservationId != null;
  if (routeOwnsReservation) {
    res.once("close", () => {
      if (routeOwnsReservation && allowance.reservationId) {
        void releaseVenomAllowanceReservation(allowance.reservationId);
      }
    });
  }

  const creation = await createVenomBuildRunForUser(userId, parsed.data, {
    reservationId: allowance.reservationId ?? null,
  });
  if (creation.kind === "iteration_required") {
    res.status(409).json({
      error:
        "This app already has an approved version. Start an improvement iteration from the app record so the next version builds on its baseline.",
    });
    return;
  }
  if (creation.kind === "invalid_reference") {
    res.status(400).json({
      error: "One or more source or SOP revision references are unavailable",
    });
    return;
  }
  if (creation.kind === "busy") {
    res.status(409).json({
      error: "Two package generations are already active. Wait or cancel one.",
    });
    return;
  }
  if (creation.kind === "conflict") {
    res.status(409).json({ error: "Idempotency key is already in use" });
    return;
  }
  const run = creation.run;
  if (creation.kind === "created") {
    // The run row carries the hold from here. An idempotent replay
    // ("existing") stored nothing, so its fresh hold frees at close.
    routeOwnsReservation = false;
  }
  req.log.info(
    {
      operation: "venom_build_create",
      runId: run.id,
      correlationId: run.correlationId,
      targetType: run.targetType,
      sourceReferenceCount: run.sourceVersionId ? 1 : 0,
      sopReferenceCount: run.sopRevisionIds.length,
    },
    "Build package run created",
  );
  res
    .status(201)
    .json(CreateVenomBuildRunResponse.parse(await runPayload(run)));
});

router.get("/venom/build-runs/:buildRunId", async (req, res): Promise<void> => {
  const userId = userIdFor(req);
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const params = GetVenomBuildRunParams.safeParse(req.params);
  if (!params.success) {
    res.status(404).json({ error: "Build run not found" });
    return;
  }
  await failStalePreparingRuns(userId);
  const run = await ownedRun(userId, params.data.buildRunId);
  if (!run) {
    res.status(404).json({ error: "Build run not found" });
    return;
  }
  if (run.status === "queued") scheduleRunEffect(userId, run.id);
  res.json(GetVenomBuildRunResponse.parse(await runPayload(run)));
});

router.post(
  "/venom/build-runs/:buildRunId/cancel",
  async (req, res): Promise<void> => {
    const userId = userIdFor(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const params = CancelVenomBuildRunParams.safeParse(req.params);
    const parsed = CancelVenomBuildRunBody.safeParse(req.body);
    if (!params.success || !parsed.success) {
      res.status(400).json({ error: "Invalid cancellation request" });
      return;
    }
    const [run] = await db
      .update(venomBuildRunsTable)
      .set({
        status: "cancelled",
        progress: 100,
        cancelledReason: parsed.data.reason.trim(),
        pendingRevisionInstruction: null,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(venomBuildRunsTable.id, params.data.buildRunId),
          eq(venomBuildRunsTable.clerkUserId, userId),
          inArray(venomBuildRunsTable.status, ["queued", "preparing"]),
        ),
      )
      .returning();
    if (!run) {
      if (!(await ownedRun(userId, params.data.buildRunId))) {
        res.status(404).json({ error: "Build run not found" });
      } else {
        res.status(409).json({ error: "Build run cannot be cancelled now" });
      }
      return;
    }
    activeGenerationControllers.get(run.id)?.abort();
    await addEvent(
      run,
      "cancelled",
      "cancelled",
      100,
      "Generation was cancelled before approval.",
    );
    req.log.info(
      { operation: "venom_build_cancel", runId: run.id },
      "Build package run cancelled",
    );
    res.json(CancelVenomBuildRunResponse.parse(await runPayload(run)));
  },
);

router.post(
  "/venom/build-runs/:buildRunId/retry",
  async (req, res): Promise<void> => {
    const userId = userIdFor(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const params = RetryVenomBuildRunParams.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "Build run not found" });
      return;
    }
    const allowance = await checkVenomAllowance({ userId, reserve: true });
    if (!allowance.allowed) {
      res.status(402).json(allowanceBlockedBody(allowance));
      return;
    }
    // The retried run spends after this response ends, so a successful
    // re-queue hands the hold to the run row (the processor settles or
    // releases it; crash leaks reap by age). Until then this route owns
    // it, and the close hook frees it on every exit path.
    let routeOwnsReservation = allowance.reservationId != null;
    if (routeOwnsReservation) {
      res.once("close", () => {
        if (routeOwnsReservation && allowance.reservationId) {
          void releaseVenomAllowanceReservation(allowance.reservationId);
        }
      });
    }
    const retryResult = await db.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtext(${"venom-build:" + userId}))`,
      );
      const [current] = await transaction
        .select()
        .from(venomBuildRunsTable)
        .where(
          and(
            eq(venomBuildRunsTable.id, params.data.buildRunId),
            eq(venomBuildRunsTable.clerkUserId, userId),
          ),
        )
        .limit(1);
      if (!current) return { kind: "not_found" as const };
      if (
        !["failed", "cancelled"].includes(current.status) ||
        current.attempt >= MAX_ATTEMPTS
      ) {
        return { kind: "invalid" as const };
      }
      const [active] = await transaction
        .select({ count: sql<number>`count(*)::int` })
        .from(venomBuildRunsTable)
        .where(
          and(
            eq(venomBuildRunsTable.clerkUserId, userId),
            inArray(venomBuildRunsTable.status, ["queued", "preparing"]),
          ),
        );
      if ((active?.count ?? 0) >= MAX_ACTIVE_RUNS_PER_ACCOUNT) {
        return { kind: "busy" as const };
      }
      const [run] = await transaction
        .update(venomBuildRunsTable)
        .set({
          status: "queued",
          progress: 0,
          attempt: current.attempt + 1,
          reservationId: allowance.reservationId ?? null,
          failureCode: null,
          failureMessage: null,
          cancelledReason: null,
          completedAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(venomBuildRunsTable.id, current.id),
            eq(venomBuildRunsTable.clerkUserId, userId),
            inArray(venomBuildRunsTable.status, ["failed", "cancelled"]),
          ),
        )
        .returning();
      if (!run) return { kind: "invalid" as const };
      await transaction.insert(venomBuildRunEventsTable).values({
        runId: run.id,
        clerkUserId: userId,
        eventType: "retried",
        status: "queued",
        progress: 0,
        message: `Generation retry ${run.attempt} queued.`,
      });
      return { kind: "queued" as const, run };
    });
    if (retryResult.kind === "not_found") {
      res.status(404).json({ error: "Build run not found" });
      return;
    }
    if (retryResult.kind === "busy") {
      res.status(409).json({
        error: "Two package generations are already active. Wait or cancel one.",
      });
      return;
    }
    if (retryResult.kind === "invalid") {
      res.status(409).json({ error: "Build run cannot be retried" });
      return;
    }
    const run = retryResult.run;
    routeOwnsReservation = false; // the re-queued run row carries the hold
    scheduleRunEffect(userId, run.id);
    res
      .status(202)
      .json(RetryVenomBuildRunResponse.parse(await runPayload(run)));
  },
);

router.post(
  "/venom/build-runs/:buildRunId/revise",
  async (req, res): Promise<void> => {
    const userId = userIdFor(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const params = ReviseVenomBuildRunParams.safeParse(req.params);
    const parsed = ReviseVenomBuildRunBody.safeParse(req.body);
    if (!params.success || !parsed.success) {
      res.status(400).json({ error: "Invalid revision request" });
      return;
    }
    const allowance = await checkVenomAllowance({ userId, reserve: true });
    if (!allowance.allowed) {
      res.status(402).json(allowanceBlockedBody(allowance));
      return;
    }
    // The revision run spends after this response ends, so a successful
    // re-queue hands the hold to the run row (the processor settles or
    // releases it; crash leaks reap by age). Until then this route owns
    // it, and the close hook frees it on every exit path.
    let routeOwnsReservation = allowance.reservationId != null;
    if (routeOwnsReservation) {
      res.once("close", () => {
        if (routeOwnsReservation && allowance.reservationId) {
          void releaseVenomAllowanceReservation(allowance.reservationId);
        }
      });
    }
    const revisionResult = await db.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtext(${"venom-build:" + userId}))`,
      );
      const [current] = await transaction
        .select()
        .from(venomBuildRunsTable)
        .where(
          and(
            eq(venomBuildRunsTable.id, params.data.buildRunId),
            eq(venomBuildRunsTable.clerkUserId, userId),
          ),
        )
        .limit(1);
      if (!current) return { kind: "not_found" as const };
      if (
        current.status !== "review_required" ||
        current.approvedRevisionId !== null
      ) {
        return { kind: "invalid" as const };
      }
      const [active] = await transaction
        .select({ count: sql<number>`count(*)::int` })
        .from(venomBuildRunsTable)
        .where(
          and(
            eq(venomBuildRunsTable.clerkUserId, userId),
            inArray(venomBuildRunsTable.status, ["queued", "preparing"]),
          ),
        );
      if ((active?.count ?? 0) >= MAX_ACTIVE_RUNS_PER_ACCOUNT) {
        return { kind: "busy" as const };
      }
      const [run] = await transaction
        .update(venomBuildRunsTable)
        .set({
          status: "queued",
          progress: 0,
          reservationId: allowance.reservationId ?? null,
          pendingRevisionInstruction: parsed.data.instruction.trim(),
          failureCode: null,
          failureMessage: null,
          completedAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(venomBuildRunsTable.id, current.id),
            eq(venomBuildRunsTable.clerkUserId, userId),
            eq(venomBuildRunsTable.status, "review_required"),
            sql`${venomBuildRunsTable.approvedRevisionId} is null`,
          ),
        )
        .returning();
      if (!run) return { kind: "invalid" as const };
      await transaction.insert(venomBuildRunEventsTable).values({
        runId: run.id,
        clerkUserId: userId,
        eventType: "queued",
        status: "queued",
        progress: 0,
        message: "Revision request saved and queued.",
      });
      return { kind: "queued" as const, run };
    });
    if (revisionResult.kind === "not_found") {
      res.status(404).json({ error: "Build run not found" });
      return;
    }
    if (revisionResult.kind === "busy") {
      res.status(409).json({
        error: "Two package generations are already active. Wait or cancel one.",
      });
      return;
    }
    if (revisionResult.kind === "invalid") {
      res.status(409).json({ error: "Build run is not awaiting revision" });
      return;
    }
    const run = revisionResult.run;
    routeOwnsReservation = false; // the re-queued run row carries the hold
    scheduleRunEffect(userId, run.id);
    res
      .status(202)
      .json(ReviseVenomBuildRunResponse.parse(await runPayload(run)));
  },
);

router.post(
  "/venom/build-runs/:buildRunId/approve",
  async (req, res): Promise<void> => {
    const userId = userIdFor(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const params = ApproveVenomBuildRunParams.safeParse(req.params);
    const parsed = ApproveVenomBuildRunBody.safeParse(req.body);
    if (!params.success || !parsed.success) {
      res.status(400).json({ error: "Invalid approval request" });
      return;
    }
    const now = new Date();
    const approved = await db.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtext(${params.data.buildRunId}))`,
      );
      const [run] = await transaction
        .select()
        .from(venomBuildRunsTable)
        .where(
          and(
            eq(venomBuildRunsTable.id, params.data.buildRunId),
            eq(venomBuildRunsTable.clerkUserId, userId),
          ),
        )
        .limit(1);
      if (!run) return { kind: "missing" as const };
      if (run.status !== "review_required" || run.approvedRevisionId) {
        return { kind: "conflict" as const };
      }
      const [revision] = await transaction
        .select()
        .from(venomBuildPackageRevisionsTable)
        .where(
          and(
            eq(venomBuildPackageRevisionsTable.id, parsed.data.revisionId),
            eq(venomBuildPackageRevisionsTable.runId, run.id),
            eq(venomBuildPackageRevisionsTable.clerkUserId, userId),
          ),
        )
        .limit(1);
      if (!revision) return { kind: "revision_missing" as const };
      await transaction
        .update(venomBuildPackageRevisionsTable)
        .set({ approvedAt: now, approvedBy: userId })
        .where(eq(venomBuildPackageRevisionsTable.id, revision.id));
      const [updated] = await transaction
        .update(venomBuildRunsTable)
        .set({
          status: "ready_for_provisioning",
          progress: 100,
          approvedRevisionId: revision.id,
          completedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(venomBuildRunsTable.id, run.id),
            eq(venomBuildRunsTable.clerkUserId, userId),
            eq(venomBuildRunsTable.status, "review_required"),
          ),
        )
        .returning();
      if (!updated) return { kind: "conflict" as const };
      await transaction.insert(venomBuildRunEventsTable).values([
        {
          runId: run.id,
          clerkUserId: userId,
          eventType: "approved",
          status: "approved",
          progress: 100,
          message: `Revision ${revision.revisionNumber} approved by the account owner.`,
        },
        {
          runId: run.id,
          clerkUserId: userId,
          eventType: "ready_for_provisioning",
          status: "ready_for_provisioning",
          progress: 100,
          message:
            "Approved package is immutable and ready for a separate provisioning step.",
        },
      ]);
      if (updated.appId) {
        await registerAppIterationInTransaction(
          transaction,
          userId,
          updated,
          revision,
        );
      }
      return { kind: "approved" as const, run: updated };
    });
    if (approved.kind === "missing") {
      res.status(404).json({ error: "Build run not found" });
      return;
    }
    if (approved.kind === "revision_missing") {
      res.status(404).json({ error: "Package revision not found" });
      return;
    }
    if (approved.kind === "conflict") {
      res.status(409).json({ error: "Build run is not awaiting approval" });
      return;
    }
    // Template learning rides after the commit so it can never fail (or
    // roll back) the approval itself. It is a no-op unless this account
    // has opted in to master-network contribution, and only closed-
    // vocabulary concept keys cross the boundary — requirement text,
    // instruction text, and identifying references have no path through.
    if (approved.run.templateId) {
      try {
        const revisions = await db
          .select({
            id: venomBuildPackageRevisionsTable.id,
            revisionNumber: venomBuildPackageRevisionsTable.revisionNumber,
            reason: venomBuildPackageRevisionsTable.reason,
            package: venomBuildPackageRevisionsTable.package,
          })
          .from(venomBuildPackageRevisionsTable)
          .where(
            and(
              eq(venomBuildPackageRevisionsTable.runId, approved.run.id),
              eq(venomBuildPackageRevisionsTable.clerkUserId, userId),
            ),
          )
          .orderBy(venomBuildPackageRevisionsTable.revisionNumber);
        const firstRevision = revisions.find(
          (revision) => revision.revisionNumber === 1,
        );
        const approvedRevision = revisions.find(
          (revision) => revision.id === parsed.data.revisionId,
        );
        const signalKeys = deriveTemplateEditSignals({
          firstPackage: firstRevision?.package ?? null,
          approvedPackage: approvedRevision?.package ?? null,
          revisionInstructions: revisions
            .filter(
              (revision) =>
                revision.revisionNumber > 1 &&
                revision.reason !== "Regenerated package",
            )
            .map((revision) => revision.reason),
          iterationInstruction:
            approved.run.runKind === "app_iteration"
              ? approved.run.requirements
              : null,
        });
        await contributeTemplateEditSignals({
          tenant: userTenant(userId),
          templateId: approved.run.templateId,
          signalKeys,
        });
      } catch (error) {
        // Learning must never break an approval.
        req.log.error(
          {
            operation: "venom_template_learning",
            runId: approved.run.id,
            errorName: error instanceof Error ? error.name : "UnknownError",
          },
          "Template edit-signal contribution failed",
        );
      }
    }
    req.log.info(
      {
        operation: "venom_build_approve",
        runId: approved.run.id,
        correlationId: approved.run.correlationId,
        revisionId: parsed.data.revisionId,
      },
      "Build package approved",
    );
    res.json(
      ApproveVenomBuildRunResponse.parse(await runPayload(approved.run)),
    );
  },
);

router.post(
  "/venom/build-runs/:buildRunId/reject",
  async (req, res): Promise<void> => {
    const userId = userIdFor(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const params = RejectVenomBuildRunParams.safeParse(req.params);
    const parsed = RejectVenomBuildRunBody.safeParse(req.body);
    if (!params.success || !parsed.success) {
      res.status(400).json({ error: "Invalid rejection request" });
      return;
    }
    const [run] = await db
      .update(venomBuildRunsTable)
      .set({
        status: "cancelled",
        progress: 100,
        cancelledReason: parsed.data.reason.trim(),
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(venomBuildRunsTable.id, params.data.buildRunId),
          eq(venomBuildRunsTable.clerkUserId, userId),
          eq(venomBuildRunsTable.status, "review_required"),
          sql`${venomBuildRunsTable.approvedRevisionId} is null`,
        ),
      )
      .returning();
    if (!run) {
      if (!(await ownedRun(userId, params.data.buildRunId))) {
        res.status(404).json({ error: "Build run not found" });
      } else {
        res.status(409).json({ error: "Build run is not awaiting review" });
      }
      return;
    }
    await addEvent(
      run,
      "rejected",
      "cancelled",
      100,
      "Package was rejected by the account owner.",
    );
    req.log.info(
      { operation: "venom_build_reject", runId: run.id },
      "Build package rejected",
    );
    res.json(RejectVenomBuildRunResponse.parse(await runPayload(run)));
  },
);

router.get(
  "/venom/build-runs/:buildRunId/export/:format",
  async (req, res): Promise<void> => {
    const userId = userIdFor(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const params = ExportVenomBuildRunParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "Invalid package export request" });
      return;
    }
    const run = await ownedRun(userId, params.data.buildRunId);
    if (!run) {
      res.status(404).json({ error: "Build run not found" });
      return;
    }
    const [revision] = await db
      .select()
      .from(venomBuildPackageRevisionsTable)
      .where(
        and(
          run.approvedRevisionId
            ? eq(
                venomBuildPackageRevisionsTable.id,
                run.approvedRevisionId,
              )
            : eq(venomBuildPackageRevisionsTable.runId, run.id),
          eq(venomBuildPackageRevisionsTable.clerkUserId, userId),
        ),
      )
      .orderBy(desc(venomBuildPackageRevisionsTable.revisionNumber))
      .limit(1);
    if (!revision) {
      res.status(404).json({ error: "Package revision not found" });
      return;
    }
    const safeName = run.targetName
      .toLocaleLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60);
    if (params.data.format === "json") {
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${safeName || "build-package"}-r${revision.revisionNumber}.json"`,
      );
      res.json(ExportVenomBuildRunResponse.parse(revision.package));
      return;
    }
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${safeName || "build-package"}-r${revision.revisionNumber}.md"`,
    );
    res.send(
      buildPackageMarkdown(
        revision.package,
        revision.revisionNumber,
        revision.checksumSha256,
      ),
    );
  },
);

export default router;