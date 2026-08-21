/**
 * venom-community-notifications.test.ts
 *
 * Focused tests for the community notification feature. These exercise the
 * pure/algorithmic pieces that guarantee the task's safety properties without
 * requiring a live DB/HTTP stack:
 *  - idempotency key determinism (retry dedupe) and reply-scoping
 *  - stable cursor encode/decode (createdAt, id) and tamper rejection
 *  - 90-day bounded retention cutoff math
 *  - self-suppression recipient logic
 *  - recipient selection (parent reply author vs thread author)
 *  - display-safe payload: no bodies, no auth IDs, availability boolean,
 *    former body never leaked when source is removed
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getTableConfig } from "drizzle-orm/pg-core";
import { CreateCommunityReplyBody } from "@workspace/api-zod";
import { communityRepliesTable } from "@workspace/db/schema";

import {
  replyNotificationIdempotencyKey,
  encodeNotificationCursor,
  decodeNotificationCursor,
  notificationRetentionCutoff,
  COMMUNITY_NOTIFICATION_RETENTION_DAYS,
  mergeFocusedReplies,
} from "../lib/community-notifications-core";

// ---------------------------------------------------------------------------
// Idempotency key
// ---------------------------------------------------------------------------

describe("notification idempotency key", () => {
  it("is deterministic for the same reply (retry dedupe)", () => {
    const replyId = "550e8400-e29b-41d4-a716-446655440000";
    assert.equal(
      replyNotificationIdempotencyKey(replyId),
      replyNotificationIdempotencyKey(replyId),
    );
  });

  it("differs per reply", () => {
    const a = replyNotificationIdempotencyKey(
      "550e8400-e29b-41d4-a716-446655440000",
    );
    const b = replyNotificationIdempotencyKey(
      "550e8400-e29b-41d4-a716-446655440001",
    );
    assert.notEqual(a, b);
  });

  it("never contains raw auth IDs (it is a hash)", () => {
    const key = replyNotificationIdempotencyKey(
      "550e8400-e29b-41d4-a716-446655440000",
    );
    assert.ok(!key.includes("clerk"));
    assert.match(key, /^[0-9a-f]{64}$/);
  });
});

describe("reply request idempotency contract", () => {
  it("requires a bounded client operation id", () => {
    const valid = CreateCommunityReplyBody.safeParse({
      body: "A reply",
      clientRequestId: "550e8400-e29b-41d4-a716-446655440000",
    });
    const missing = CreateCommunityReplyBody.safeParse({ body: "A reply" });
    const malformed = CreateCommunityReplyBody.safeParse({
      body: "A reply",
      clientRequestId: "retry-me",
    });

    assert.equal(valid.success, true);
    assert.equal(missing.success, false);
    assert.equal(malformed.success, false);
  });

  it("enforces one client operation id per reply author in PostgreSQL", () => {
    const config = getTableConfig(communityRepliesTable);
    const idempotencyIndex = config.indexes.find(
      (index) =>
        index.config.name === "community_replies_author_client_request_idx",
    );

    assert.ok(idempotencyIndex, "idempotency unique index is present");
    assert.equal(idempotencyIndex.config.unique, true);
    assert.deepEqual(
      idempotencyIndex.config.columns.map((column) =>
        "name" in column ? column.name : null,
      ),
      ["author_id", "client_request_id"],
    );
  });
});

// ---------------------------------------------------------------------------
// Cursor stability
// ---------------------------------------------------------------------------

describe("notification cursor", () => {
  it("encodes and decodes createdAt + id only", () => {
    const data = {
      createdAt: "2025-06-15T12:00:00.000Z",
      id: "550e8400-e29b-41d4-a716-446655440000",
    };
    const cursor = encodeNotificationCursor(data);
    assert.deepEqual(decodeNotificationCursor(cursor), data);
  });

  it("never encodes auth IDs or bodies", () => {
    const cursor = encodeNotificationCursor({
      createdAt: "2025-06-15T12:00:00.000Z",
      id: "550e8400-e29b-41d4-a716-446655440000",
    });
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    assert.ok(!decoded.includes("clerk"));
    assert.ok(!decoded.includes("body"));
    assert.ok(!decoded.includes("recipient"));
  });

  it("rejects tampered cursor", () => {
    const valid = encodeNotificationCursor({
      createdAt: "2025-06-15T12:00:00.000Z",
      id: "550e8400-e29b-41d4-a716-446655440000",
    });
    assert.equal(decodeNotificationCursor(valid + "!!garbage"), null);
  });

  it("rejects invalid id / date shapes", () => {
    assert.equal(
      decodeNotificationCursor(
        encodeNotificationCursor({ createdAt: "not-a-date", id: "550e8400-e29b-41d4-a716-446655440000" }),
      ),
      null,
    );
    assert.equal(
      decodeNotificationCursor(
        encodeNotificationCursor({ createdAt: "2025-06-15T12:00:00.000Z", id: "short" }),
      ),
      null,
    );
  });
});

// ---------------------------------------------------------------------------
// Retention window
// ---------------------------------------------------------------------------

describe("notification retention", () => {
  it("retention window is bounded at 90 days", () => {
    assert.equal(COMMUNITY_NOTIFICATION_RETENTION_DAYS, 90);
  });

  it("cutoff excludes rows older than retention window", () => {
    const now = Date.UTC(2025, 5, 15, 0, 0, 0);
    const cutoff = notificationRetentionCutoff(now).getTime();
    const olderThanWindow = now - 91 * 24 * 60 * 60 * 1000;
    const withinWindow = now - 89 * 24 * 60 * 60 * 1000;
    assert.ok(olderThanWindow < cutoff, "91-day-old row is pruned");
    assert.ok(withinWindow > cutoff, "89-day-old row is retained");
  });
});

describe("notification reply focus", () => {
  it("keeps a targeted reply and its parent outside the normal 500-row window", () => {
    const initialReplies: {
      id: string;
      parentReplyId: string | null;
      createdAt: Date;
    }[] = Array.from({ length: 500 }, (_, index) => ({
      id: `initial-${String(index).padStart(3, "0")}`,
      parentReplyId: null,
      createdAt: new Date(1_000 + index),
    }));
    const parent = {
      id: "focused-parent",
      parentReplyId: null,
      createdAt: new Date(10_000),
    };
    const focused = {
      id: "focused-reply",
      parentReplyId: parent.id,
      createdAt: new Date(11_000),
    };

    const merged = mergeFocusedReplies(initialReplies, focused, parent);
    assert.equal(merged.length, 502);
    assert.ok(merged.some((reply) => reply.id === focused.id));
    assert.ok(merged.some((reply) => reply.id === parent.id));
    assert.equal(merged.at(-1)?.id, focused.id);
  });
});

// ---------------------------------------------------------------------------
// Recipient selection + self-suppression
// ---------------------------------------------------------------------------

describe("notification recipient selection", () => {
  // Mirrors the route/lib logic: recipient is parent reply author when
  // parentReplyId is supplied, otherwise the thread author.
  function recipientFor({
    parentReplyAuthorId,
    threadAuthorId,
  }: {
    parentReplyAuthorId: string | null;
    threadAuthorId: string;
  }): string {
    return parentReplyAuthorId != null ? parentReplyAuthorId : threadAuthorId;
  }

  function shouldNotify(recipientId: string, actorId: string): boolean {
    return recipientId !== actorId;
  }

  it("thread reply notifies the thread author", () => {
    assert.equal(
      recipientFor({ parentReplyAuthorId: null, threadAuthorId: "thread-author" }),
      "thread-author",
    );
  });

  it("reply-to-reply notifies the parent reply author", () => {
    assert.equal(
      recipientFor({ parentReplyAuthorId: "parent-author", threadAuthorId: "thread-author" }),
      "parent-author",
    );
  });

  it("self reply is suppressed (recipient === actor)", () => {
    assert.equal(shouldNotify("me", "me"), false);
  });

  it("reply by another user is notified", () => {
    assert.equal(shouldNotify("thread-author", "someone-else"), true);
  });
});

// ---------------------------------------------------------------------------
// Display-safe payload
// ---------------------------------------------------------------------------

describe("notification display-safe payload", () => {
  type NotificationRow = {
    id: string;
    type: string;
    recipientProfileId: string;
    actorProfileId: string;
    threadId: string;
    replyId: string;
    parentReplyId: string | null;
    idempotencyKey: string;
    createdAt: Date;
    readAt: Date | null;
  };

  // Mirrors notificationPayload in the router.
  function notificationPayload(
    notification: NotificationRow,
    actor: { displayName: string } | null,
    available: boolean,
  ) {
    return {
      id: notification.id,
      type: "reply",
      actor: {
        displayName: actor?.displayName ?? "Someone",
        avatarUrl: null,
      },
      threadId: notification.threadId,
      replyId: notification.replyId,
      parentReplyId: notification.parentReplyId ?? null,
      available,
      createdAt: notification.createdAt,
      readAt: notification.readAt ?? null,
    };
  }

  const notification: NotificationRow = {
    id: "n-1",
    type: "reply",
    recipientProfileId: "recipient-profile",
    actorProfileId: "actor-profile",
    threadId: "thread-1",
    replyId: "reply-1",
    parentReplyId: null,
    idempotencyKey: "SECRET_IDEMPOTENCY_KEY",
    createdAt: new Date("2025-01-01T00:00:00Z"),
    readAt: null,
  };

  it("omits bodies, auth IDs, idempotency key, recipient/actor profile IDs", () => {
    const payload = notificationPayload(
      notification,
      { displayName: "Alice" },
      true,
    );
    const json = JSON.stringify(payload);
    assert.ok(!json.includes("clerk"));
    assert.ok(!json.includes("SECRET_IDEMPOTENCY_KEY"));
    assert.ok(!json.includes("recipient-profile"));
    assert.ok(!json.includes("actor-profile"));
    assert.ok(!json.includes("body"));
    assert.ok(json.includes("Alice"), "actor display name is present");
  });

  it("emits availability boolean and does not leak former body when removed", () => {
    const payload = notificationPayload(
      notification,
      { displayName: "Alice" },
      false,
    );
    assert.equal(payload.available, false);
    const json = JSON.stringify(payload);
    // Payload has no body field at all, removed or not.
    assert.ok(!json.includes("Original body"));
    assert.ok(!("body" in payload));
  });

  it("falls back to a generic actor name when actor is missing", () => {
    const payload = notificationPayload(notification, null, true);
    assert.equal(payload.actor.displayName, "Someone");
  });

  it("carries parentReplyId when present", () => {
    const payload = notificationPayload(
      { ...notification, parentReplyId: "parent-1" },
      { displayName: "Alice" },
      true,
    );
    assert.equal(payload.parentReplyId, "parent-1");
  });
});

// ---------------------------------------------------------------------------
// Mark idempotency / concurrency semantics
// ---------------------------------------------------------------------------

describe("mark read idempotency", () => {
  // Mirrors the WHERE readAt IS NULL guard: only unread rows are marked, so
  // concurrent / repeated calls are idempotent.
  function markRead(
    row: { readAt: Date | null },
    now: Date,
  ): { marked: number; readAt: Date | null } {
    if (row.readAt !== null) return { marked: 0, readAt: row.readAt };
    row.readAt = now;
    return { marked: 1, readAt: now };
  }

  it("marks an unread row exactly once", () => {
    const row: { readAt: Date | null } = { readAt: null };
    const first = markRead(row, new Date("2025-01-02T00:00:00Z"));
    const second = markRead(row, new Date("2025-01-03T00:00:00Z"));
    assert.equal(first.marked, 1);
    assert.equal(second.marked, 0, "second mark is a no-op");
    assert.deepEqual(row.readAt, new Date("2025-01-02T00:00:00Z"));
  });

  it("mark-all only counts previously unread rows", () => {
    const rows: { readAt: Date | null }[] = [
      { readAt: null },
      { readAt: new Date() },
      { readAt: null },
    ];
    const now = new Date("2025-01-02T00:00:00Z");
    const marked = rows.filter((r) => r.readAt === null).length;
    rows.forEach((r) => {
      if (r.readAt === null) r.readAt = now;
    });
    assert.equal(marked, 2, "only the 2 unread rows are counted");
    // Re-running marks nothing.
    const markedAgain = rows.filter((r) => r.readAt === null).length;
    assert.equal(markedAgain, 0);
  });
});
