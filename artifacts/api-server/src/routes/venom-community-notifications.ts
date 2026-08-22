/**
 * venom-community-notifications.ts
 *
 * Private, recipient-scoped community notification endpoints:
 *   GET    /venom/community/notifications              — cursor-paginated list
 *   GET    /venom/community/notifications/unread-count — unread count
 *   POST   /venom/community/notifications/read-all      — mark all read
 *   POST   /venom/community/notifications/:id/read      — mark one read
 *
 * Every endpoint is scoped to the signed-in viewer's profile. Payloads are
 * display-safe: they never contain thread/reply bodies or auth IDs. Removed or
 * unavailable thread/reply sources are reported via an `available` boolean and
 * never leak former content.
 */

import { getAuth } from "@clerk/express";
import {
  GetCommunityNotificationUnreadCountResponse,
  ListCommunityNotificationsQueryParams,
  ListCommunityNotificationsResponse,
  MarkAllCommunityNotificationsReadResponse,
  MarkCommunityNotificationReadParams,
  MarkCommunityNotificationReadResponse,
} from "@workspace/api-zod";
import {
  communityNotificationsTable,
  communityProfilesTable,
  communityRepliesTable,
  communityThreadsTable,
  db,
  type CommunityNotification,
} from "@workspace/db";
import { and, count, desc, eq, gte, isNull, lt, or } from "drizzle-orm";
import {
  Router,
  type IRouter,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import {
  decodeNotificationCursor,
  encodeNotificationCursor,
  notificationRetentionCutoff,
  pruneExpiredNotifications,
} from "../lib/community-notifications";
import { countUnreadSourceSyncAlerts } from "../lib/venom-source-sync-alerts";
import { venomWorkspaceStateLoader } from "./venom-source-alerts";
import { resolveViewerProfile } from "./venom-community-threads";

const router: IRouter = Router();

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

type ActorRow = { displayName: string };

/**
 * Build the display-safe notification payload. Contains no bodies and no auth
 * IDs; `available` is false when the source thread or reply is removed/missing.
 */
function notificationPayload(
  notification: CommunityNotification,
  actor: ActorRow | null,
  available: boolean,
) {
  return {
    id: notification.id,
    type: "reply" as const,
    actor: {
      displayName: actor?.displayName ?? "Someone",
      // No avatar column exists on community profiles yet.
      avatarUrl: null as string | null,
    },
    threadId: notification.threadId,
    replyId: notification.replyId,
    parentReplyId: notification.parentReplyId ?? null,
    available,
    createdAt: notification.createdAt,
    readAt: notification.readAt ?? null,
  };
}

// ---------------------------------------------------------------------------
// GET /venom/community/notifications — cursor-paginated list
// ---------------------------------------------------------------------------

router.get(
  "/venom/community/notifications",
  async (req, res): Promise<void> => {
    const { userId } = getAuth(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    await pruneExpiredNotifications(db);
    const retentionCutoff = notificationRetentionCutoff();

    const query = ListCommunityNotificationsQueryParams.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: "Invalid query parameters" });
      return;
    }

    const viewerProfile = await resolveViewerProfile(userId);
    if (!viewerProfile) {
      // No profile → no notifications. Empty page is safe and stable.
      res.json(
        ListCommunityNotificationsResponse.parse({ items: [], nextCursor: null }),
      );
      return;
    }

    const limit = Math.min(
      Math.max(query.data.limit ?? DEFAULT_LIMIT, 1),
      MAX_LIMIT,
    );

    let cursorCond = undefined as ReturnType<typeof and> | undefined;
    if (query.data.cursor) {
      const cursor = decodeNotificationCursor(query.data.cursor);
      if (!cursor) {
        res.status(400).json({ error: "Invalid query parameters" });
        return;
      }
      const cursorDate = new Date(cursor.createdAt);
      // Stable keyset pagination on (createdAt DESC, id DESC).
      cursorCond = or(
        lt(communityNotificationsTable.createdAt, cursorDate),
        and(
          eq(communityNotificationsTable.createdAt, cursorDate),
          lt(communityNotificationsTable.id, cursor.id),
        ),
      );
    }

    const start = Date.now();

    const rows = await db
      .select({
        notification: communityNotificationsTable,
        actorDisplayName: communityProfilesTable.displayName,
        threadRemovedAt: communityThreadsTable.removedAt,
        replyRemovedAt: communityRepliesTable.removedAt,
      })
      .from(communityNotificationsTable)
      .leftJoin(
        communityProfilesTable,
        eq(communityProfilesTable.id, communityNotificationsTable.actorProfileId),
      )
      .leftJoin(
        communityThreadsTable,
        eq(communityThreadsTable.id, communityNotificationsTable.threadId),
      )
      .leftJoin(
        communityRepliesTable,
        eq(communityRepliesTable.id, communityNotificationsTable.replyId),
      )
      .where(
        and(
          eq(
            communityNotificationsTable.recipientProfileId,
            viewerProfile.id,
          ),
          gte(communityNotificationsTable.createdAt, retentionCutoff),
          cursorCond,
        ),
      )
      .orderBy(
        desc(communityNotificationsTable.createdAt),
        desc(communityNotificationsTable.id),
      )
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;

    const items = pageRows.map((row) => {
      const available =
        row.threadRemovedAt == null && row.replyRemovedAt == null;
      return notificationPayload(
        row.notification,
        row.actorDisplayName != null
          ? { displayName: row.actorDisplayName }
          : null,
        available,
      );
    });

    const last = pageRows[pageRows.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeNotificationCursor({
            createdAt: last.notification.createdAt.toISOString(),
            id: last.notification.id,
          })
        : null;

    req.log.info(
      {
        op: "list_notifications",
        count: items.length,
        hasMore,
        durationMs: Date.now() - start,
      },
      "Community notifications listed",
    );

    res.json(
      ListCommunityNotificationsResponse.parse({ items, nextCursor }),
    );
  },
);

// ---------------------------------------------------------------------------
// GET /venom/community/notifications/unread-count
// ---------------------------------------------------------------------------

router.get(
  "/venom/community/notifications/unread-count",
  async (req, res): Promise<void> => {
    const { userId } = getAuth(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    await pruneExpiredNotifications(db);
    const retentionCutoff = notificationRetentionCutoff();

    // Scheduled source sync alerts ride the same badge, so a persistently
    // failing unattended sync reaches users who never touch the community —
    // including users with no community profile at all. Best-effort: if the
    // alert lookup hiccups, the community badge must keep working.
    let alertCount = 0;
    try {
      alertCount = await countUnreadSourceSyncAlerts(
        userId,
        venomWorkspaceStateLoader,
      );
    } catch (error) {
      req.log.warn(
        {
          op: "notifications_unread_count",
          errorType: error instanceof Error ? error.name : "UnknownError",
        },
        "Source sync alert count unavailable; showing community unread only",
      );
    }

    const viewerProfile = await resolveViewerProfile(userId);
    if (!viewerProfile) {
      res.json(
        GetCommunityNotificationUnreadCountResponse.parse({
          count: alertCount,
        }),
      );
      return;
    }

    const [row] = await db
      .select({ value: count() })
      .from(communityNotificationsTable)
      .where(
        and(
          eq(
            communityNotificationsTable.recipientProfileId,
            viewerProfile.id,
          ),
          isNull(communityNotificationsTable.readAt),
          gte(communityNotificationsTable.createdAt, retentionCutoff),
        ),
      );

    const value = (row?.value ?? 0) + alertCount;

    req.log.info(
      { op: "notifications_unread_count", count: value },
      "Community notification unread count",
    );

    res.json(
      GetCommunityNotificationUnreadCountResponse.parse({ count: value }),
    );
  },
);

// ---------------------------------------------------------------------------
// POST /venom/community/notifications/read-all
// ---------------------------------------------------------------------------

router.post(
  "/venom/community/notifications/read-all",
  async (req, res): Promise<void> => {
    const { userId } = getAuth(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    await pruneExpiredNotifications(db);
    const retentionCutoff = notificationRetentionCutoff();

    const viewerProfile = await resolveViewerProfile(userId);
    if (!viewerProfile) {
      res.json(
        MarkAllCommunityNotificationsReadResponse.parse({ marked: 0 }),
      );
      return;
    }

    const start = Date.now();
    const now = new Date();

    // Idempotent + concurrency-safe: only unread, recipient-scoped rows are
    // updated. Concurrent calls simply mark 0 the second time.
    const updated = await db
      .update(communityNotificationsTable)
      .set({ readAt: now })
      .where(
        and(
          eq(
            communityNotificationsTable.recipientProfileId,
            viewerProfile.id,
          ),
          isNull(communityNotificationsTable.readAt),
          gte(communityNotificationsTable.createdAt, retentionCutoff),
        ),
      )
      .returning({ id: communityNotificationsTable.id });

    req.log.info(
      {
        op: "notifications_read_all",
        marked: updated.length,
        durationMs: Date.now() - start,
      },
      "Community notifications marked all read",
    );

    res.json(
      MarkAllCommunityNotificationsReadResponse.parse({
        marked: updated.length,
      }),
    );
  },
);

// ---------------------------------------------------------------------------
// POST /venom/community/notifications/:notificationId/read
// ---------------------------------------------------------------------------

router.post(
  "/venom/community/notifications/:notificationId/read",
  async (req, res): Promise<void> => {
    const { userId } = getAuth(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    await pruneExpiredNotifications(db);
    const retentionCutoff = notificationRetentionCutoff();

    const params = MarkCommunityNotificationReadParams.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "Notification not found" });
      return;
    }

    const viewerProfile = await resolveViewerProfile(userId);
    if (!viewerProfile) {
      res.status(404).json({ error: "Notification not found" });
      return;
    }

    const start = Date.now();
    const now = new Date();

    // Concurrency-safe idempotent mark: only set readAt when currently unread,
    // scoped to the recipient. Then read the current row back for the response.
    await db
      .update(communityNotificationsTable)
      .set({ readAt: now })
      .where(
        and(
          eq(communityNotificationsTable.id, params.data.notificationId),
          eq(
            communityNotificationsTable.recipientProfileId,
            viewerProfile.id,
          ),
          isNull(communityNotificationsTable.readAt),
          gte(communityNotificationsTable.createdAt, retentionCutoff),
        ),
      );

    // Recipient-scoped fetch — never infer foreign records.
    const [row] = await db
      .select({
        notification: communityNotificationsTable,
        actorDisplayName: communityProfilesTable.displayName,
        threadRemovedAt: communityThreadsTable.removedAt,
        replyRemovedAt: communityRepliesTable.removedAt,
      })
      .from(communityNotificationsTable)
      .leftJoin(
        communityProfilesTable,
        eq(communityProfilesTable.id, communityNotificationsTable.actorProfileId),
      )
      .leftJoin(
        communityThreadsTable,
        eq(communityThreadsTable.id, communityNotificationsTable.threadId),
      )
      .leftJoin(
        communityRepliesTable,
        eq(communityRepliesTable.id, communityNotificationsTable.replyId),
      )
      .where(
        and(
          eq(communityNotificationsTable.id, params.data.notificationId),
          eq(
            communityNotificationsTable.recipientProfileId,
            viewerProfile.id,
          ),
          gte(communityNotificationsTable.createdAt, retentionCutoff),
        ),
      )
      .limit(1);

    if (!row) {
      res.status(404).json({ error: "Notification not found" });
      return;
    }

    const available =
      row.threadRemovedAt == null && row.replyRemovedAt == null;

    req.log.info(
      {
        op: "notification_read",
        notificationId: row.notification.id,
        durationMs: Date.now() - start,
      },
      "Community notification marked read",
    );

    res.json(
      MarkCommunityNotificationReadResponse.parse(
        notificationPayload(
          row.notification,
          row.actorDisplayName != null
            ? { displayName: row.actorDisplayName }
            : null,
          available,
        ),
      ),
    );
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
        op: "community_notifications",
      },
      "Community notification request failed",
    );
    if (res.headersSent) {
      next(error);
      return;
    }
    res.status(500).json({
      error: "Notifications are temporarily unavailable. Please try again.",
    });
  },
);

export default router;
