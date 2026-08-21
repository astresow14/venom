/**
 * community-notifications-core.ts
 *
 * Pure helpers for the community notification feature — no DB imports so they
 * are cheaply unit-testable and safe to bundle in isolation:
 *  - deterministic idempotency key derivation from the triggering reply
 *  - stable opaque cursor (createdAt, id) encode/decode for the notification list
 *
 * None of these encode auth IDs or any private/body content.
 */

import { createHash } from "node:crypto";

/** Bounded retention window for community notifications (days). */
export const COMMUNITY_NOTIFICATION_RETENTION_DAYS = 90;

/**
 * Derive a stable, unique idempotency key for a reply-triggered notification.
 *
 * The key is keyed purely on the reply id (one notification per new reply).
 * Retrying the same reply insert deterministically yields the same key, so a
 * unique constraint collapses duplicates.
 */
export function replyNotificationIdempotencyKey(replyId: string): string {
  return createHash("sha256").update(`reply:${replyId}`).digest("hex");
}

// ---------------------------------------------------------------------------
// Cursor: stable ordering by (createdAt DESC, id DESC)
// ---------------------------------------------------------------------------

export type NotificationCursorData = {
  createdAt: string; // ISO
  id: string; // UUID
};

export function encodeNotificationCursor(
  data: NotificationCursorData,
): string {
  return Buffer.from(JSON.stringify(data), "utf8").toString("base64url");
}

export function decodeNotificationCursor(
  raw: string,
): NotificationCursorData | null {
  try {
    const json = Buffer.from(raw, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;
    if (
      typeof obj["createdAt"] !== "string" ||
      typeof obj["id"] !== "string"
    ) {
      return null;
    }
    const d = new Date(obj["createdAt"]);
    if (Number.isNaN(d.getTime())) return null;
    if (!/^[0-9a-fA-F-]{36}$/.test(obj["id"])) return null;
    return { createdAt: obj["createdAt"], id: obj["id"] };
  } catch {
    return null;
  }
}

/**
 * Compute the retention cutoff instant. Rows created before this instant are
 * eligible for opportunistic pruning.
 */
export function notificationRetentionCutoff(now: number = Date.now()): Date {
  return new Date(
    now - COMMUNITY_NOTIFICATION_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  );
}

type FocusableReply = {
  id: string;
  parentReplyId: string | null;
  createdAt: Date;
};

/**
 * Adds a notification-targeted reply and optional parent context to the normal
 * thread window while preserving deterministic chronological order.
 */
export function mergeFocusedReplies<T extends FocusableReply>(
  initialReplies: readonly T[],
  focusedReply: T | null,
  focusedParent: T | null,
): T[] {
  const byId = new Map(initialReplies.map((reply) => [reply.id, reply]));
  if (focusedReply) byId.set(focusedReply.id, focusedReply);
  if (focusedParent) byId.set(focusedParent.id, focusedParent);
  return [...byId.values()].sort(
    (left, right) =>
      left.createdAt.getTime() - right.createdAt.getTime() ||
      left.id.localeCompare(right.id),
  );
}
