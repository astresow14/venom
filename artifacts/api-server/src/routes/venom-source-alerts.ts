/**
 * venom-source-alerts.ts
 *
 * Push-side surfacing for scheduled source sync failures:
 *   GET  /venom/sources/sync-alerts          — active (triggered) alerts
 *   POST /venom/sources/sync-alerts/read-all — silence the badge
 *
 * A user who schedules a daily GitHub sync precisely because they do not open
 * Venom every day never sees the failure card in Settings. These endpoints
 * feed the same notification bell the community uses (the unread-count
 * endpoint folds alerts in), so a lapsed workspace GitHub connection turns
 * into a nudge instead of weeks of silent failure.
 *
 * Both endpoints reconcile against the stored workspace before answering, so
 * an alert whose source was fixed client-side, removed, or unscheduled is
 * pruned rather than shown. Marking read never hides an alert — only a sync
 * succeeding again (or the source going away) clears it.
 */
import { getAuth } from "@clerk/express";
import {
  ListVenomSourceSyncAlertsResponse,
  MarkAllVenomSourceSyncAlertsReadResponse,
} from "@workspace/api-zod";
import type { VenomSourceSyncAlert } from "@workspace/db";
import {
  Router,
  type IRouter,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import {
  listActiveSourceSyncAlerts,
  markAllSourceSyncAlertsRead,
  type WorkspaceStateLoader,
} from "../lib/venom-source-sync-alerts";
import { databaseWorkspaceStore } from "./venom-workspace";

const router: IRouter = Router();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The stored workspace blob for alert reconciliation — the same rows the
 * scheduler itself reads and writes.
 */
export const venomWorkspaceStateLoader: WorkspaceStateLoader = async (
  userId,
) => {
  const record = await databaseWorkspaceStore.get(userId);
  return record && isRecord(record.state) ? record.state : null;
};

/** Display payload; never includes internal row bookkeeping. */
function alertPayload(alert: VenomSourceSyncAlert) {
  return {
    id: alert.id,
    sourceId: alert.sourceId,
    projectId: alert.projectId,
    provider: alert.provider,
    sourceName: alert.sourceName,
    consecutiveFailures: alert.consecutiveFailures,
    lastError: alert.lastError,
    firstFailedAt: alert.firstFailedAt,
    lastFailedAt: alert.lastFailedAt,
    readAt: alert.readAt ?? null,
  };
}

// ---------------------------------------------------------------------------
// GET /venom/sources/sync-alerts
// ---------------------------------------------------------------------------

router.get(
  "/venom/sources/sync-alerts",
  async (req, res): Promise<void> => {
    const { userId } = getAuth(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const alerts = await listActiveSourceSyncAlerts(
      userId,
      venomWorkspaceStateLoader,
    );

    req.log.info(
      { op: "list_source_sync_alerts", count: alerts.length },
      "Source sync alerts listed",
    );

    res.json(
      ListVenomSourceSyncAlertsResponse.parse({
        alerts: alerts.slice(0, 100).map(alertPayload),
      }),
    );
  },
);

// ---------------------------------------------------------------------------
// POST /venom/sources/sync-alerts/read-all
// ---------------------------------------------------------------------------

router.post(
  "/venom/sources/sync-alerts/read-all",
  async (req, res): Promise<void> => {
    const { userId } = getAuth(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const marked = await markAllSourceSyncAlertsRead(userId);

    req.log.info(
      { op: "source_sync_alerts_read_all", marked },
      "Source sync alerts marked all read",
    );

    res.json(MarkAllVenomSourceSyncAlertsReadResponse.parse({ marked }));
  },
);

router.use(
  (
    error: unknown,
    req: Request,
    res: Response,
    next: NextFunction,
  ): void => {
    req.log.error(
      {
        errorType: error instanceof Error ? error.name : "UnknownError",
        op: "source_sync_alerts",
      },
      "Source sync alert request failed",
    );
    if (res.headersSent) {
      next(error);
      return;
    }
    res.status(500).json({
      error: "Source alerts are temporarily unavailable. Please try again.",
    });
  },
);

export default router;
