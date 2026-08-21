import {
  db,
  venomOntologyConceptsTable,
  venomOntologyEvidenceTable,
  venomPortfolioAppIterationsTable,
  venomWorkspacesTable,
  type VenomCandidateRelease,
  type VenomPortfolioApp,
  type VenomPortfolioAppIteration,
  type VenomPortfolioSourceVersion,
} from "@workspace/db";
import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";

/**
 * Parent-layer iteration intelligence for spawned apps.
 *
 * Everything here is computed on read: no cron, no background jobs, and no
 * side effects. Suggestions produced from these helpers are review-first by
 * construction — they are plain payload data that clients render; nothing in
 * this module can start a generation run or touch provisioning.
 */

export type WorkspaceProjectRef = { id: string; name: string };

type WorkspaceSourceRef = {
  projectId: string;
  name: string;
  syncedAtMs: number;
};

export type WorkspaceIterationView = {
  projects: WorkspaceProjectRef[];
  sources: WorkspaceSourceRef[];
};

export const EMPTY_WORKSPACE_VIEW: WorkspaceIterationView = {
  projects: [],
  sources: [],
};

/**
 * Loads the caller's synced workspace blob and narrows it to the two shapes
 * the iteration layer cares about: project identities and connected-source
 * sync times. The blob is client-synced JSON, so every field is treated as
 * untrusted and defensively narrowed.
 */
export async function loadWorkspaceIterationView(
  userId: string,
): Promise<WorkspaceIterationView> {
  const [workspace] = await db
    .select({ state: venomWorkspacesTable.state })
    .from(venomWorkspacesTable)
    .where(eq(venomWorkspacesTable.clerkUserId, userId))
    .limit(1);
  return parseWorkspaceState(workspace?.state);
}

function parseWorkspaceState(state: unknown): WorkspaceIterationView {
  const record =
    state && typeof state === "object" && !Array.isArray(state)
      ? (state as Record<string, unknown>)
      : {};

  const projects: WorkspaceProjectRef[] = [];
  if (Array.isArray(record.projects)) {
    for (const item of record.projects.slice(0, 500)) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const candidate = item as Record<string, unknown>;
      if (
        typeof candidate.id === "string" &&
        candidate.id.length > 0 &&
        typeof candidate.name === "string" &&
        candidate.name.length > 0
      ) {
        projects.push({
          id: candidate.id.slice(0, 120),
          name: candidate.name.slice(0, 120),
        });
      }
    }
  }

  const sources: WorkspaceSourceRef[] = [];
  if (Array.isArray(record.sources)) {
    for (const item of record.sources.slice(0, 500)) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const candidate = item as Record<string, unknown>;
      if (typeof candidate.projectId !== "string" || !candidate.projectId) {
        continue;
      }
      const name =
        typeof candidate.name === "string" && candidate.name.length > 0
          ? candidate.name.slice(0, 120)
          : "Connected source";
      const syncedAtMs =
        typeof candidate.syncedAt === "string"
          ? Date.parse(candidate.syncedAt)
          : Number.NaN;
      sources.push({
        projectId: candidate.projectId.slice(0, 120),
        name,
        syncedAtMs: Number.isFinite(syncedAtMs) ? syncedAtMs : 0,
      });
    }
  }

  return { projects, sources };
}

export function resolveWorkspaceProject(
  view: WorkspaceIterationView,
  projectId: string,
): WorkspaceProjectRef | null {
  return view.projects.find((project) => project.id === projectId) ?? null;
}

/** Per-app latest-iteration facts used by payloads and signal computation. */
export type AppIterationStats = {
  latestIterationNumber: number;
  latestIterationAtMs: number | null;
};

export async function latestIterationStats(
  userId: string,
  appIds: string[],
): Promise<Map<string, AppIterationStats>> {
  const stats = new Map<string, AppIterationStats>();
  if (appIds.length === 0) return stats;
  const rows = await db
    .select({
      appId: venomPortfolioAppIterationsTable.appId,
      latestNumber: sql<number>`max(${venomPortfolioAppIterationsTable.iterationNumber})::int`,
      latestAt: sql<string | Date | null>`max(${venomPortfolioAppIterationsTable.createdAt})`,
    })
    .from(venomPortfolioAppIterationsTable)
    .where(
      and(
        eq(venomPortfolioAppIterationsTable.clerkUserId, userId),
        inArray(venomPortfolioAppIterationsTable.appId, appIds),
      ),
    )
    .groupBy(venomPortfolioAppIterationsTable.appId);
  for (const row of rows) {
    const latestAtMs =
      row.latestAt === null ? null : new Date(row.latestAt).getTime();
    stats.set(row.appId, {
      latestIterationNumber: row.latestNumber ?? 0,
      latestIterationAtMs:
        latestAtMs !== null && Number.isFinite(latestAtMs) ? latestAtMs : null,
    });
  }
  return stats;
}

/** What changed in a linked project since a given moment. */
export type ProjectKnowledgeDelta = {
  knowledgeChanges: number;
  sourceChanges: number;
  conceptLabels: string[];
  sourceNames: string[];
};

const OWNER_TYPE_USER = "user";

/**
 * Exact change counts for one project since `sinceMs`. Knowledge changes are
 * ontology concepts + evidence rows updated after the cutoff; source changes
 * are connected sources whose last sync is after the cutoff.
 */
export async function computeProjectDelta(
  userId: string,
  projectId: string,
  sinceMs: number,
  view: WorkspaceIterationView,
): Promise<ProjectKnowledgeDelta> {
  const conceptWhere = and(
    eq(venomOntologyConceptsTable.ownerType, OWNER_TYPE_USER),
    eq(venomOntologyConceptsTable.ownerId, userId),
    eq(venomOntologyConceptsTable.projectId, projectId),
    gt(venomOntologyConceptsTable.lastUpdatedAt, sinceMs),
  );
  const [conceptLabelRows, conceptCountRows, evidenceCountRows] =
    await Promise.all([
      db
        .select({ label: venomOntologyConceptsTable.label })
        .from(venomOntologyConceptsTable)
        .where(conceptWhere)
        .orderBy(desc(venomOntologyConceptsTable.lastUpdatedAt))
        .limit(5),
      db
        .select({ value: sql<number>`count(*)::int` })
        .from(venomOntologyConceptsTable)
        .where(conceptWhere),
      db
        .select({ value: sql<number>`count(*)::int` })
        .from(venomOntologyEvidenceTable)
        .where(
          and(
            eq(venomOntologyEvidenceTable.ownerType, OWNER_TYPE_USER),
            eq(venomOntologyEvidenceTable.ownerId, userId),
            eq(venomOntologyEvidenceTable.projectId, projectId),
            gt(venomOntologyEvidenceTable.updatedAt, sinceMs),
          ),
        ),
    ]);

  const changedSources = view.sources.filter(
    (source) => source.projectId === projectId && source.syncedAtMs > sinceMs,
  );

  return {
    knowledgeChanges:
      (conceptCountRows[0]?.value ?? 0) + (evidenceCountRows[0]?.value ?? 0),
    sourceChanges: changedSources.length,
    conceptLabels: conceptLabelRows
      .map((row) => row.label)
      .filter((label): label is string => typeof label === "string" && label.length > 0),
    sourceNames: changedSources.slice(0, 3).map((source) => source.name),
  };
}

/** Plain-language, bounded summary of a delta for humans and the generator. */
export function buildChangesSummary(
  delta: ProjectKnowledgeDelta,
  options: { sinceLabel: string; projectName: string },
): string {
  const parts: string[] = [];
  if (delta.knowledgeChanges > 0) {
    const labels =
      delta.conceptLabels.length > 0
        ? ` (topics: ${delta.conceptLabels.slice(0, 5).join(", ")})`
        : "";
    parts.push(
      `${delta.knowledgeChanges} knowledge item${delta.knowledgeChanges === 1 ? "" : "s"} added or updated${labels}`,
    );
  }
  if (delta.sourceChanges > 0) {
    const names =
      delta.sourceNames.length > 0 ? ` (${delta.sourceNames.join(", ")})` : "";
    parts.push(
      `${delta.sourceChanges} connected source${delta.sourceChanges === 1 ? "" : "s"} refreshed${names}`,
    );
  }
  const summary =
    parts.length === 0
      ? `No meaningful knowledge or source changes in "${options.projectName}" since ${options.sinceLabel}.`
      : `Since ${options.sinceLabel}, project "${options.projectName}" has ${parts.join(" and ")}.`;
  return summary.slice(0, 1400);
}

export const IMPROVEMENT_SIGNAL_MIN_KNOWLEDGE_CHANGES = 3;
export const IMPROVEMENT_SIGNAL_MIN_SOURCE_CHANGES = 1;
const MAX_EXACT_SIGNAL_APPS = 10;

export type ImprovementSignalPayload = {
  since: string;
  knowledgeChanges: number;
  sourceChanges: number;
  totalChanges: number;
  summary: string;
  baselineIterationNumber: number;
};

/**
 * Computes review-first improvement suggestions for a batch of apps.
 *
 * An app is a candidate only when it has a linked project that still exists
 * and at least one approved package iteration. The cutoff is the later of the
 * last iteration and the last dismissal, so dismissing hides the current
 * suggestion until genuinely newer data arrives. A cheap grouped
 * latest-change probe per project filters candidates before exact counting,
 * and exact counting is capped to keep list endpoints bounded.
 */
export async function computeImprovementSignals(
  userId: string,
  apps: VenomPortfolioApp[],
  view: WorkspaceIterationView,
  stats: Map<string, AppIterationStats>,
): Promise<Map<string, ImprovementSignalPayload>> {
  const signals = new Map<string, ImprovementSignalPayload>();
  const candidates = apps.filter((app) => {
    if (!app.linkedProjectId) return false;
    const appStats = stats.get(app.id);
    if (!appStats || appStats.latestIterationAtMs === null) return false;
    return resolveWorkspaceProject(view, app.linkedProjectId) !== null;
  });
  if (candidates.length === 0) return signals;

  const projectIds = [
    ...new Set(candidates.map((app) => app.linkedProjectId as string)),
  ];

  // Grouped per-project latest-change probe (no correlated subqueries).
  const [conceptMaxRows, evidenceMaxRows] = await Promise.all([
    db
      .select({
        projectId: venomOntologyConceptsTable.projectId,
        latest: sql<number>`max(${venomOntologyConceptsTable.lastUpdatedAt})`,
      })
      .from(venomOntologyConceptsTable)
      .where(
        and(
          eq(venomOntologyConceptsTable.ownerType, OWNER_TYPE_USER),
          eq(venomOntologyConceptsTable.ownerId, userId),
          inArray(venomOntologyConceptsTable.projectId, projectIds),
        ),
      )
      .groupBy(venomOntologyConceptsTable.projectId),
    db
      .select({
        projectId: venomOntologyEvidenceTable.projectId,
        latest: sql<number>`max(${venomOntologyEvidenceTable.updatedAt})`,
      })
      .from(venomOntologyEvidenceTable)
      .where(
        and(
          eq(venomOntologyEvidenceTable.ownerType, OWNER_TYPE_USER),
          eq(venomOntologyEvidenceTable.ownerId, userId),
          inArray(venomOntologyEvidenceTable.projectId, projectIds),
        ),
      )
      .groupBy(venomOntologyEvidenceTable.projectId),
  ]);

  const latestChangeByProject = new Map<string, number>();
  for (const row of [...conceptMaxRows, ...evidenceMaxRows]) {
    if (!row.projectId) continue;
    const value = Number(row.latest ?? 0);
    latestChangeByProject.set(
      row.projectId,
      Math.max(latestChangeByProject.get(row.projectId) ?? 0, value),
    );
  }
  for (const source of view.sources) {
    latestChangeByProject.set(
      source.projectId,
      Math.max(
        latestChangeByProject.get(source.projectId) ?? 0,
        source.syncedAtMs,
      ),
    );
  }

  let exactComputations = 0;
  for (const app of candidates) {
    if (exactComputations >= MAX_EXACT_SIGNAL_APPS) break;
    const appStats = stats.get(app.id);
    if (!appStats || appStats.latestIterationAtMs === null) continue;
    const projectId = app.linkedProjectId as string;
    const sinceMs = Math.max(
      appStats.latestIterationAtMs,
      app.improvementSuggestionDismissedAt?.getTime() ?? 0,
    );
    if ((latestChangeByProject.get(projectId) ?? 0) <= sinceMs) continue;

    exactComputations += 1;
    const delta = await computeProjectDelta(userId, projectId, sinceMs, view);
    const meaningful =
      delta.knowledgeChanges >= IMPROVEMENT_SIGNAL_MIN_KNOWLEDGE_CHANGES ||
      delta.sourceChanges >= IMPROVEMENT_SIGNAL_MIN_SOURCE_CHANGES;
    if (!meaningful) continue;

    const project = resolveWorkspaceProject(view, projectId);
    if (!project) continue;
    signals.set(app.id, {
      since: new Date(sinceMs).toISOString(),
      knowledgeChanges: delta.knowledgeChanges,
      sourceChanges: delta.sourceChanges,
      totalChanges: delta.knowledgeChanges + delta.sourceChanges,
      summary: buildChangesSummary(delta, {
        sinceLabel: `package v${appStats.latestIterationNumber}`,
        projectName: project.name,
      }),
      baselineIterationNumber: Math.max(appStats.latestIterationNumber, 1),
    });
  }
  return signals;
}

export type TimelineEntryPayload = {
  id: string;
  kind:
    | "source_import"
    | "package_iteration"
    | "release_created"
    | "release_published"
    | "release_rolled_back";
  occurredAt: string;
  title: string;
  detail: string | null;
  actor: string;
  status: string;
  buildRunId: string | null;
  releaseId: string | null;
  sourceVersionId: string | null;
  iterationNumber: number | null;
};

export const TIMELINE_MAX_ENTRIES = 400;

/**
 * Flattens an app's lifecycle — source imports, approved package iterations,
 * and provisioning releases — into one reverse-chronological timeline. Every
 * entry names the actor and carries the reason or data change that drove it.
 * Returns the COMPLETE history; use `assembleAppTimeline` for the bounded
 * initial view embedded in the app-detail response.
 */
export function assembleFullAppTimeline(input: {
  versions: VenomPortfolioSourceVersion[];
  iterations: VenomPortfolioAppIteration[];
  releases: VenomCandidateRelease[];
}): TimelineEntryPayload[] {
  const entries: TimelineEntryPayload[] = [];

  for (const version of input.versions) {
    const manifest = version.manifest as {
      safeFileCount?: number;
      detectedStack?: string[];
    } | null;
    const stack = Array.isArray(manifest?.detectedStack)
      ? manifest.detectedStack.slice(0, 5).join(", ")
      : "";
    const detailParts = [
      version.archiveFilename,
      typeof manifest?.safeFileCount === "number"
        ? `${manifest.safeFileCount} files retained`
        : null,
      stack ? `stack: ${stack}` : null,
    ].filter((part): part is string => Boolean(part));
    entries.push({
      id: `source_import:${version.id}`,
      kind: "source_import",
      occurredAt: version.createdAt.toISOString(),
      title: `Source v${version.versionNumber} imported`,
      detail: detailParts.join(" · ").slice(0, 2000) || null,
      actor: "owner",
      status: "imported",
      buildRunId: null,
      releaseId: null,
      sourceVersionId: version.id,
      iterationNumber: null,
    });
  }

  const iterationNumberById = new Map(
    input.iterations.map((iteration) => [iteration.id, iteration.iterationNumber]),
  );
  for (const iteration of input.iterations) {
    const baselineNumber = iteration.baselineIterationId
      ? (iterationNumberById.get(iteration.baselineIterationId) ?? null)
      : null;
    const detail = [iteration.reason, iteration.changesSummary]
      .filter((part): part is string => Boolean(part))
      .join(" · ")
      .slice(0, 2000);
    entries.push({
      id: `package_iteration:${iteration.id}`,
      kind: "package_iteration",
      occurredAt: iteration.createdAt.toISOString(),
      title: `Package v${iteration.iterationNumber} approved — ${iteration.packageTitle}`.slice(
        0,
        240,
      ),
      detail: detail || null,
      actor: "owner",
      status:
        iteration.runKind === "app_iteration"
          ? baselineNumber !== null
            ? `improves v${baselineNumber}`
            : "improvement"
          : "approved",
      buildRunId: iteration.buildRunId,
      releaseId: null,
      sourceVersionId: null,
      iterationNumber: iteration.iterationNumber,
    });
  }

  for (const release of input.releases) {
    entries.push({
      id: `release_created:${release.id}`,
      kind: "release_created",
      occurredAt: release.createdAt.toISOString(),
      title: "Release candidate created",
      detail: (release.launchUrl
        ? `Candidate for ${release.targetName || "this app"} — ${release.launchUrl}`
        : `Candidate for ${release.targetName || "this app"}`
      ).slice(0, 2000),
      actor: "owner",
      status: release.status,
      buildRunId: release.buildRunId,
      releaseId: release.id,
      sourceVersionId: null,
      iterationNumber: null,
    });
    if (release.publishedAt) {
      entries.push({
        id: `release_published:${release.id}`,
        kind: "release_published",
        occurredAt: release.publishedAt.toISOString(),
        title: "Release published",
        detail: release.launchUrl ? release.launchUrl.slice(0, 2000) : null,
        actor: "owner",
        status: "published",
        buildRunId: release.buildRunId,
        releaseId: release.id,
        sourceVersionId: null,
        iterationNumber: null,
      });
    }
    if (release.rolledBackAt) {
      entries.push({
        id: `release_rolled_back:${release.id}`,
        kind: "release_rolled_back",
        occurredAt: release.rolledBackAt.toISOString(),
        title: "Release rolled back",
        detail: null,
        actor: "owner",
        status: "rolled_back",
        buildRunId: release.buildRunId,
        releaseId: release.id,
        sourceVersionId: null,
        iterationNumber: null,
      });
    }
  }

  return entries.sort((a, b) =>
    a.occurredAt < b.occurredAt
      ? 1
      : a.occurredAt > b.occurredAt
        ? -1
        : a.id.localeCompare(b.id),
  );
}

/**
 * Bounded initial timeline view for the app-detail response. The paged
 * timeline endpoint serves the rest, so nothing is silently unreachable.
 */
export function assembleAppTimeline(input: {
  versions: VenomPortfolioSourceVersion[];
  iterations: VenomPortfolioAppIteration[];
  releases: VenomCandidateRelease[];
}): TimelineEntryPayload[] {
  return assembleFullAppTimeline(input).slice(0, TIMELINE_MAX_ENTRIES);
}
