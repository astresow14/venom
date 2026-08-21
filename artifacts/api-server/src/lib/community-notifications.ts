/**
 * community-notifications.ts
 *
 * DB-touching helpers for the community notification feature:
 *  - bounded (90-day) retention pruning for request and scheduled paths
 *  - notification creation in the same transaction as the triggering reply
 *
 * Pure helpers (idempotency key, cursor) live in community-notifications-core.ts
 * and are re-exported here for a single import surface.
 */

import { lt } from "drizzle-orm";
import { communityNotificationsTable, db } from "@workspace/db";
import { logger } from "./logger";
import {
  notificationRetentionCutoff,
  replyNotificationIdempotencyKey,
} from "./community-notifications-core";

export {
  COMMUNITY_NOTIFICATION_RETENTION_DAYS,
  decodeNotificationCursor,
  encodeNotificationCursor,
  notificationRetentionCutoff,
  replyNotificationIdempotencyKey,
  type NotificationCursorData,
} from "./community-notifications-core";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// ---------------------------------------------------------------------------
// Retention pruning (bounded 90 days)
// ---------------------------------------------------------------------------

/**
 * Delete notifications older than the retention window. Pass a transaction or
 * the db handle. Failures propagate so callers can log and return a generic
 * recoverable error rather than silently allowing retention to drift.
 */
export async function pruneExpiredNotifications(
  runner: {
    delete: (table: typeof communityNotificationsTable) => {
      where: (cond: unknown) => {
        returning: (
          selection: { id: typeof communityNotificationsTable.id },
        ) => Promise<{ id: string }[]>;
      };
    };
  },
): Promise<number> {
  const deleted = await runner
    .delete(communityNotificationsTable)
    .where(
      lt(
        communityNotificationsTable.createdAt,
        notificationRetentionCutoff(),
      ),
    )
    .returning({ id: communityNotificationsTable.id });
  return deleted.length;
}

const RETENTION_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
let retentionJobStarted = false;

/**
 * Physically removes expired metadata at startup and every six hours, so the
 * 90-day retention bound does not depend on inbox traffic.
 */
export function startCommunityNotificationRetentionJob(): void {
  if (retentionJobStarted) return;
  retentionJobStarted = true;

  const sweep = async () => {
    const startedAt = Date.now();
    try {
      const deletedCount = await pruneExpiredNotifications(db);
      logger.info(
        {
          deletedCount,
          durationMs: Date.now() - startedAt,
          op: "prune_community_notifications",
        },
        "Community notification retention sweep finished",
      );
    } catch (error) {
      logger.error(
        {
          durationMs: Date.now() - startedAt,
          errorType: error instanceof Error ? error.name : "UnknownError",
          op: "prune_community_notifications",
        },
        "Community notification retention sweep failed",
      );
    }
  };

  setImmediate(() => void sweep());
  const timer = setInterval(() => void sweep(), RETENTION_SWEEP_INTERVAL_MS);
  timer.unref();
}

// ---------------------------------------------------------------------------
// Notification creation (in the same transaction as the triggering reply)
// ---------------------------------------------------------------------------

export type ReplyNotificationInput = {
  /** The new reply that triggered the notification. */
  replyId: string;
  threadId: string;
  /** Profile id of the reply author (the actor). */
  actorProfileId: string;
  /**
   * Recipient profile id: the directly replied-to resource owner
   * (parent reply author when parentReplyId supplied; otherwise thread author).
   */
  recipientProfileId: string;
  /** Set when replying to a reply; null for a top-level thread reply. */
  parentReplyId: string | null;
};

/**
 * Create exactly one notification for a new reply, in the caller's transaction.
 *
 * - Self replies (recipient === actor) are suppressed (no row).
 * - Duplicate retries collapse via the unique idempotency key (ON CONFLICT).
 *
 * Returns true when a new row was created, false when suppressed or deduped.
 */
export async function createReplyNotification(
  tx: Tx,
  input: ReplyNotificationInput,
): Promise<boolean> {
  // Suppress notifications for self replies.
  if (input.recipientProfileId === input.actorProfileId) return false;

  const inserted = await tx
    .insert(communityNotificationsTable)
    .values({
      type: "reply",
      recipientProfileId: input.recipientProfileId,
      actorProfileId: input.actorProfileId,
      threadId: input.threadId,
      replyId: input.replyId,
      parentReplyId: input.parentReplyId,
      idempotencyKey: replyNotificationIdempotencyKey(input.replyId),
    })
    .onConflictDoNothing({
      target: communityNotificationsTable.idempotencyKey,
    })
    .returning({ id: communityNotificationsTable.id });

  return inserted.length > 0;
}
