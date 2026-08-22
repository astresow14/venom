/**
 * venom-source-sync-alerts.ts
 *
 * Persistence for scheduled source sync alerts. One row per (user, source)
 * tracks the consecutive server-side failure streak; crossing
 * SOURCE_SYNC_ALERT_FAILURE_THRESHOLD stamps `triggeredAt`, which is what
 * makes the alert ride the notification bell. A successful scheduled sync
 * deletes the row outright, and read paths reconcile rows against the stored
 * workspace so client-side fixes (manual refresh, schedule off, source
 * removed) also clear the nudge without a server sync ever running again.
 *
 * `readAt` only silences the unread badge. The alert stays listed while the
 * failure persists, and a fresh streak after a resolution starts a new row —
 * unread again by construction.
 */
import {
  db,
  venomSourceSyncAlertsTable,
  type VenomSourceSyncAlert,
} from "@workspace/db";
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import {
  workspaceSources,
  type StoredProjectSource,
} from "./venom-scheduled-source-sync";
import {
  SOURCE_SYNC_ALERT_FAILURE_THRESHOLD,
  isSourceSyncAlertStillRelevant,
  normalizeSourceSyncAlertError,
  normalizeSourceSyncAlertName,
  sourceSyncAlertProvider,
} from "./venom-source-sync-alerts-core";

/**
 * Loads the user's stored workspace state (the blob the scheduler syncs), or
 * null when there is none. Injected so reconciliation stays testable and the
 * lib does not depend on a concrete store.
 */
export type WorkspaceStateLoader = (
  userId: string,
) => Promise<Record<string, unknown> | null>;

/**
 * Records one failed unattended attempt for a source. Called by the sync
 * worker only after the failure was actually written onto the source card,
 * so the alert streak can never run ahead of what the user would see in
 * Settings.
 */
export async function recordSourceSyncFailureAlert(input: {
  clerkUserId: string;
  source: StoredProjectSource;
  message: string;
  failedAt: number;
}): Promise<void> {
  const provider = sourceSyncAlertProvider(input.source.provider);
  if (!provider) return;

  const failedAt = new Date(input.failedAt);
  const sourceName = normalizeSourceSyncAlertName(input.source.name);
  const lastError = normalizeSourceSyncAlertError(input.message);

  await db
    .insert(venomSourceSyncAlertsTable)
    .values({
      clerkUserId: input.clerkUserId,
      sourceId: input.source.id,
      projectId: input.source.projectId,
      provider,
      sourceName,
      consecutiveFailures: 1,
      lastError,
      firstFailedAt: failedAt,
      lastFailedAt: failedAt,
      triggeredAt: SOURCE_SYNC_ALERT_FAILURE_THRESHOLD <= 1 ? failedAt : null,
      updatedAt: failedAt,
    })
    .onConflictDoUpdate({
      target: [
        venomSourceSyncAlertsTable.clerkUserId,
        venomSourceSyncAlertsTable.sourceId,
      ],
      set: {
        projectId: input.source.projectId,
        provider,
        sourceName,
        lastError,
        lastFailedAt: failedAt,
        consecutiveFailures: sql`${venomSourceSyncAlertsTable.consecutiveFailures} + 1`,
        // Trigger exactly once, when the streak crosses the threshold. An
        // already-triggered alert keeps its original trigger time (and its
        // read state) while the streak keeps counting.
        triggeredAt: sql`COALESCE(
          ${venomSourceSyncAlertsTable.triggeredAt},
          CASE
            WHEN ${venomSourceSyncAlertsTable.consecutiveFailures} + 1 >= ${SOURCE_SYNC_ALERT_FAILURE_THRESHOLD}
            THEN ${failedAt.toISOString()}::timestamptz
          END
        )`,
        updatedAt: failedAt,
      },
    });
}

/**
 * A scheduled sync succeeded: the streak is over, drop the alert entirely.
 * Takes both the previous and the refreshed source id — a refresh can retire
 * one id and continue under another.
 */
export async function clearSourceSyncAlertsForSources(
  clerkUserId: string,
  sourceIds: string[],
): Promise<void> {
  if (sourceIds.length === 0) return;
  await db
    .delete(venomSourceSyncAlertsTable)
    .where(
      and(
        eq(venomSourceSyncAlertsTable.clerkUserId, clerkUserId),
        inArray(venomSourceSyncAlertsTable.sourceId, sourceIds),
      ),
    );
}

/**
 * Reconciles the user's alert rows against the stored workspace, prunes the
 * ones whose failure is no longer visible there, and returns the triggered
 * survivors, newest failure first.
 *
 * The prune-by-row-id has a benign race: if the worker records a fresh
 * failure between our read and the delete, that new streak increment is lost
 * and the streak restarts on the next attempt — one extra hour of patience,
 * never a stuck alert.
 */
export async function listActiveSourceSyncAlerts(
  clerkUserId: string,
  loadWorkspaceState: WorkspaceStateLoader,
): Promise<VenomSourceSyncAlert[]> {
  const rows = await db
    .select()
    .from(venomSourceSyncAlertsTable)
    .where(eq(venomSourceSyncAlertsTable.clerkUserId, clerkUserId))
    .orderBy(
      desc(venomSourceSyncAlertsTable.lastFailedAt),
      asc(venomSourceSyncAlertsTable.sourceId),
    );
  if (rows.length === 0) return [];

  const state = await loadWorkspaceState(clerkUserId);
  const sources = workspaceSources(state ?? {});

  const stale = rows.filter(
    (row) => !isSourceSyncAlertStillRelevant(row.sourceId, sources),
  );
  if (stale.length > 0) {
    await db.delete(venomSourceSyncAlertsTable).where(
      and(
        eq(venomSourceSyncAlertsTable.clerkUserId, clerkUserId),
        inArray(
          venomSourceSyncAlertsTable.id,
          stale.map((row) => row.id),
        ),
      ),
    );
  }

  const staleIds = new Set(stale.map((row) => row.id));
  return rows.filter((row) => !staleIds.has(row.id) && row.triggeredAt !== null);
}

/**
 * Unread triggered alerts for the badge. The cheap indexed count runs on
 * every poll; the workspace blob is only loaded (to reconcile) while a
 * candidate row actually exists, so the steady state costs one count query.
 */
export async function countUnreadSourceSyncAlerts(
  clerkUserId: string,
  loadWorkspaceState: WorkspaceStateLoader,
): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(venomSourceSyncAlertsTable)
    .where(
      and(
        eq(venomSourceSyncAlertsTable.clerkUserId, clerkUserId),
        isNotNull(venomSourceSyncAlertsTable.triggeredAt),
        isNull(venomSourceSyncAlertsTable.readAt),
      ),
    );
  if (!row || row.value === 0) return 0;

  const alerts = await listActiveSourceSyncAlerts(
    clerkUserId,
    loadWorkspaceState,
  );
  return alerts.filter((alert) => alert.readAt === null).length;
}

/**
 * Silences the badge for every currently-triggered alert. Idempotent and
 * concurrency-safe: only unread rows are stamped. Untriggered streak rows are
 * left untouched so they arrive unread if they later cross the threshold.
 */
export async function markAllSourceSyncAlertsRead(
  clerkUserId: string,
): Promise<number> {
  const updated = await db
    .update(venomSourceSyncAlertsTable)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(venomSourceSyncAlertsTable.clerkUserId, clerkUserId),
        isNotNull(venomSourceSyncAlertsTable.triggeredAt),
        isNull(venomSourceSyncAlertsTable.readAt),
      ),
    )
    .returning({ id: venomSourceSyncAlertsTable.id });
  return updated.length;
}
